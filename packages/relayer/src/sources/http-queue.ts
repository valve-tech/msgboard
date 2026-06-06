import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { RelayerSource } from '../types.js'

export type HttpQueueSourceOptions<T> = {
  /** Port to listen on. Defaults to 3001. */
  port?: number
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
}

export type HttpQueueSource<T> = RelayerSource<T> & {
  /** Closes the HTTP server. Call after `relayer.stop()` to free the port. */
  close(): Promise<void>
}

const readBody = (req: IncomingMessage): Promise<unknown> =>
  new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk: string) => { raw += chunk })
    req.on('end', () => {
      try { resolve(JSON.parse(raw)) } catch { reject(new Error('invalid JSON')) }
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
 */
export const httpQueueSource = <T>(options: HttpQueueSourceOptions<T>): HttpQueueSource<T> => {
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
    try {
      const body = await readBody(req)
      const item = options.parse(body)
      queue.push(item)
      respond(res, 200, { ok: true, queued: true })
    } catch (err) {
      respond(res, 400, { ok: false, error: err instanceof Error ? err.message : 'bad request' })
    }
  })

  server.listen(options.port ?? 3001)

  return {
    poll: async () => {
      const batch = queue.splice(0)
      return batch
    },
    close: () => new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve())),
  }
}
