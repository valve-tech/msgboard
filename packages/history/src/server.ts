import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Archive, ArchiveQuery } from './archive.js'

export type ArchiveServerOptions = {
  /** The archive to serve. */
  archive: Archive
  /** Port to listen on. Defaults to 4040. */
  port?: number
  /**
   * Host / interface to bind. Defaults to `'127.0.0.1'` (loopback only).
   * Set to `'0.0.0.0'` for LAN/Internet exposure — requires `token`, or the
   * server refuses to start (the archive is read-only, but still yours to gate).
   */
  host?: string
  /**
   * Optional bearer token. When set, `/messages` requests without
   * `Authorization: Bearer <token>` receive a 401.
   */
  token?: string
}

export type ArchiveServer = {
  /** Closes the HTTP server. */
  close(): Promise<void>
}

const respond = (res: ServerResponse, status: number, body: unknown): void => {
  const json = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json) })
  res.end(json)
}

/** Parses the `/messages` query string into an ArchiveQuery, ignoring unparseable values. */
const parseQuery = (params: URLSearchParams): ArchiveQuery => {
  const query: ArchiveQuery = {}

  const chainId = params.get('chainId')
  if (chainId !== null && Number.isFinite(Number(chainId))) query.chainId = Number(chainId)

  const category = params.get('category')
  if (category) query.category = category

  const contains = params.get('contains')
  if (contains) query.contains = contains

  const since = params.get('since')
  if (since && !Number.isNaN(Date.parse(since))) query.since = new Date(since)

  const until = params.get('until')
  if (until && !Number.isNaN(Date.parse(until))) query.until = new Date(until)

  const limit = params.get('limit')
  if (limit !== null && Number.isFinite(Number(limit))) query.limit = Number(limit)

  const offset = params.get('offset')
  if (offset !== null && Number.isFinite(Number(offset))) query.offset = Number(offset)

  return query
}

/**
 * Serves an {@link Archive} over HTTP, read-only:
 *
 * - `GET /health`   → `{ ok: true }`
 * - `GET /messages` → `{ messages: ArchivedMessage[] }`, filtered by query params:
 *   `chainId`, `category` (hex or decoded text), `since`/`until` (ISO dates),
 *   `contains` (substring on decoded data text), `limit` (≤ 1000), `offset`.
 *
 * Security defaults mirror the relayer's push source: binds to `127.0.0.1`
 * unless `host` is set, and a non-loopback bind requires `token`. Slow
 * connections are bounded by 10 s header/request timeouts.
 */
export const archiveServer = (options: ArchiveServerOptions): ArchiveServer => {
  const host = options.host ?? '127.0.0.1'
  const port = options.port ?? 4040

  const isNonLoopback = host !== '127.0.0.1' && host !== 'localhost' && host !== '::1'
  if (isNonLoopback && !options.token) {
    throw new Error(
      `archiveServer: non-loopback bind (${host}) requires a token to be set — pass token or set host to '127.0.0.1'`,
    )
  }

  const authorized = (req: IncomingMessage): boolean =>
    !options.token || req.headers['authorization'] === `Bearer ${options.token}`

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${host}:${port}`)

    if (req.method === 'GET' && url.pathname === '/health') {
      return respond(res, 200, { ok: true })
    }

    if (req.method === 'GET' && url.pathname === '/messages') {
      if (!authorized(req)) return respond(res, 401, { ok: false, error: 'unauthorized' })
      try {
        const messages = await options.archive.query(parseQuery(url.searchParams))
        return respond(res, 200, { messages })
      } catch (error) {
        return respond(res, 500, { ok: false, error: error instanceof Error ? error.message : 'query failed' })
      }
    }

    return respond(res, 404, { ok: false, error: 'not found' })
  })

  // Bound slow connections.
  server.headersTimeout = 10_000
  server.requestTimeout = 10_000

  server.listen(port, host)

  return {
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  }
}
