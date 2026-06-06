import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { RelayerSource } from '../types.js'

/** 64 KiB — generous ceiling for any single RLP payload. */
const MAX_BODY_BYTES = 65_536

export type HttpQueueSourceOptions<T> = {
  /** Port to listen on. Defaults to 3001. */
  port?: number
  /**
   * Host / interface to bind. Defaults to `'127.0.0.1'` (loopback only).
   * Set to `'0.0.0.0'` for LAN/Internet exposure — requires `token` to be
   * set, or the server refuses to start.
   */
  host?: string
  /**
   * Parses the raw JSON body into a typed item. Throw to reject.
   * The returned item is added to the next poll batch.
   */
  parse: (body: unknown) => T
  /**
   * Optional bearer token — requests without `Authorization: Bearer <token>`
   * receive a 401 and are not queued.
   */
  token?: string
  /**
   * Maximum number of items held in memory before new submissions are
   * rejected with 429. Defaults to 1000. Set to 0 to disable the cap.
   */
  maxQueueSize?: number
  /**
   * Maximum number of items drained per poll tick. Defaults to 100.
   * Prevents a single heartbeat from firing an unbounded burst of on-chain
   * transactions if the queue fills up.
   */
  maxBatchSize?: number
}

export type HttpQueueSource<T> = RelayerSource<T> & {
  /** Closes the HTTP server. Call after `relayer.stop()` to free the port. */
  close(): Promise<void>
}

const readBody = (req: IncomingMessage): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const contentLength = Number(req.headers['content-length'] ?? 0)
    if (contentLength > MAX_BODY_BYTES) {
      req.resume()
      return reject(new Error('request body too large'))
    }
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        req.destroy()
        return reject(new Error('request body too large'))
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())) } catch { reject(new Error('invalid JSON')) }
    })
    req.on('error', reject)
  })

const respond = (res: ServerResponse, status: number, body: unknown): void => {
  const json = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json) })
  res.end(json)
}

/**
 * Opens an HTTP server that accepts `POST /submit` requests. Each accepted
 * item is held in memory until the next `poll()` cycle drains the queue.
 *
 * Clients POST JSON matching whatever shape `parse` expects. On success they
 * receive `{ ok: true, queued: true }` immediately — they don't wait for the
 * relayer to process the item.
 *
 * Security defaults:
 * - Binds to `127.0.0.1` (loopback only) unless `host` is set.
 * - Non-loopback binds require `token` to be set; the server throws otherwise.
 * - Queue is capped at 1000 items (429 when full).
 * - Each poll drains at most 100 items.
 * - Request bodies are rejected above 64 KiB.
 * - `server.headersTimeout` and `server.requestTimeout` are set to 10 s
 *   to bound slow-loris connections.
 */
export const httpQueueSource = <T>(options: HttpQueueSourceOptions<T>): HttpQueueSource<T> => {
  const host = options.host ?? '127.0.0.1'
  const maxQueueSize = options.maxQueueSize ?? 1000
  const maxBatchSize = options.maxBatchSize ?? 100

  const isNonLoopback = host !== '127.0.0.1' && host !== 'localhost' && host !== '::1'
  if (isNonLoopback && !options.token) {
    throw new Error(
      `httpQueueSource: non-loopback bind (${host}) requires a token to be set — ` +
      `pass token or set host to '127.0.0.1'`,
    )
  }

  const queue: T[] = []

  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/submit') {
      return respond(res, 404, { ok: false, error: 'not found' })
    }
    if (options.token) {
      const auth = req.headers['authorization']
      if (auth !== `Bearer ${options.token}`) {
        return respond(res, 401, { ok: false, error: 'unauthorized' })
      }
    }
    if (maxQueueSize > 0 && queue.length >= maxQueueSize) {
      return respond(res, 429, { ok: false, error: 'queue full — try again later' })
    }
    try {
      const body = await readBody(req)
      const item = options.parse(body)
      queue.push(item)
      respond(res, 200, { ok: true, queued: true })
    } catch (err) {
      respond(res, 400, { ok: false, error: err instanceof Error ? err.message : 'bad request' })
    }
  })

  // Bound slow-loris connections.
  server.headersTimeout = 10_000
  server.requestTimeout = 10_000

  server.listen(options.port ?? 3001, host)

  return {
    poll: async () => {
      const batch = queue.splice(0, maxBatchSize)
      return batch
    },
    close: () => new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve())),
  }
}
