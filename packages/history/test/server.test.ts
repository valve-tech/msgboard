import { afterEach, describe, expect, it } from 'vitest'
import { archiveServer, type ArchiveServer } from '../src/server.js'
import type { Archive, ArchiveQuery, ArchivedMessage } from '../src/archive.js'

/** A stub archive that records the last query and returns canned rows. */
const stubArchive = (rows: ArchivedMessage[] = []): Archive & { lastQuery?: ArchiveQuery } => {
  const archive = {
    lastQuery: undefined as ArchiveQuery | undefined,
    migrate: async () => {},
    record: async () => {},
    prune: async () => {},
    query: async (filter: ArchiveQuery) => {
      archive.lastQuery = filter
      return rows
    },
  }
  return archive
}

let nextPort = 34210
const open = new Set<ArchiveServer>()

const start = (archive: Archive, token?: string) => {
  const port = nextPort++
  const server = archiveServer({ archive, port, token })
  open.add(server)
  return { server, base: `http://127.0.0.1:${port}` }
}

const get = async (url: string, headers: Record<string, string> = {}): Promise<Response> => {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      return await fetch(url, { headers })
    } catch (err) {
      if (!(err instanceof Error && /ECONNREFUSED|fetch failed/.test(err.message))) throw err
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  throw new Error(`server at ${url} never accepted a connection`)
}

afterEach(async () => {
  await Promise.all([...open].map((server) => server.close()))
  open.clear()
})

describe('archiveServer', () => {
  it('GET /health returns ok', async () => {
    const { base } = start(stubArchive())
    const res = await get(`${base}/health`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('GET /messages returns the archive rows', async () => {
    const rows = [{ hash: '0x1', chain_id: 943 } as ArchivedMessage]
    const { base } = start(stubArchive(rows))
    const res = await get(`${base}/messages`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ messages: rows })
  })

  it('GET /messages parses filters from the query string', async () => {
    const archive = stubArchive()
    const { base } = start(archive)
    await get(`${base}/messages?chainId=943&category=lorem&contains=hello&limit=5&offset=2&since=2026-01-01T00:00:00Z`)
    expect(archive.lastQuery?.chainId).toBe(943)
    expect(archive.lastQuery?.category).toBe('lorem')
    expect(archive.lastQuery?.contains).toBe('hello')
    expect(archive.lastQuery?.limit).toBe(5)
    expect(archive.lastQuery?.offset).toBe(2)
    expect(archive.lastQuery?.since).toBeInstanceOf(Date)
  })

  it('ignores an unparseable date filter rather than failing', async () => {
    const archive = stubArchive()
    const { base } = start(archive)
    const res = await get(`${base}/messages?since=not-a-date`)
    expect(res.status).toBe(200)
    expect(archive.lastQuery?.since).toBeUndefined()
  })

  it('returns 404 for unknown routes', async () => {
    const { base } = start(stubArchive())
    expect((await get(`${base}/nope`)).status).toBe(404)
  })

  it('returns 500 with a message when the archive query throws', async () => {
    const archive = stubArchive()
    archive.query = async () => {
      throw new Error('db down')
    }
    const { base } = start(archive)
    const res = await get(`${base}/messages`)
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('db down')
  })

  describe('token auth', () => {
    it('rejects /messages without the bearer token', async () => {
      const { base } = start(stubArchive(), 'secret')
      expect((await get(`${base}/messages`)).status).toBe(401)
      expect((await get(`${base}/messages`, { Authorization: 'Bearer nope' })).status).toBe(401)
    })

    it('accepts /messages with the correct token, leaves /health open', async () => {
      const { base } = start(stubArchive(), 'secret')
      expect((await get(`${base}/messages`, { Authorization: 'Bearer secret' })).status).toBe(200)
      expect((await get(`${base}/health`)).status).toBe(200)
    })
  })

  it('refuses to construct a non-loopback bind without a token', () => {
    expect(() => archiveServer({ archive: stubArchive(), host: '0.0.0.0', port: 34999 })).toThrow(/non-loopback bind/)
  })
})
