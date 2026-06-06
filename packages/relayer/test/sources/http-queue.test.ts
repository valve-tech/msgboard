import { afterEach, describe, expect, it } from 'vitest'
import { httpQueueSource, type HttpQueueSource } from '../../src/sources/http-queue.js'
import type { HttpQueueSourceOptions } from '../../src/sources/http-queue.js'
import type { RelayerContext } from '../../src/types.js'

const ctx = {} as RelayerContext

type Item = { value: number }

/** Parses { value: number }; throws otherwise (exercises the 400 path). */
const parseItem = (body: unknown): Item => {
  if (typeof body !== 'object' || body === null || typeof (body as Item).value !== 'number') {
    throw new Error('body must be { value: number }')
  }
  return { value: (body as Item).value }
}

// Each test binds its own port so a leaked server never poisons the next test.
let nextPort = 34110
const open = new Set<HttpQueueSource<unknown>>()

const start = (options: Partial<HttpQueueSourceOptions<Item>> = {}) => {
  const port = nextPort++
  const source = httpQueueSource<Item>({ port, parse: parseItem, ...options })
  open.add(source as HttpQueueSource<unknown>)
  return { source, url: `http://127.0.0.1:${port}/submit` }
}

/**
 * POSTs JSON, retrying on connection-refused while the server finishes binding
 * (httpQueueSource calls server.listen() but does not expose a ready signal).
 */
const post = async (url: string, body: string, headers: Record<string, string> = {}): Promise<Response> => {
  const init = { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body }
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      return await fetch(url, init)
    } catch (err) {
      const isRefused = err instanceof Error && /ECONNREFUSED|fetch failed/.test(err.message)
      if (!isRefused) throw err
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  throw new Error(`server at ${url} never accepted a connection`)
}

afterEach(async () => {
  await Promise.all([...open].map((source) => source.close()))
  open.clear()
})

describe('httpQueueSource', () => {
  it('queues a valid POST and drains it on the next poll', async () => {
    const { source, url } = start()
    const res = await post(url, JSON.stringify({ value: 7 }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, queued: true })

    expect(await source.poll(ctx)).toEqual([{ value: 7 }])
    // Draining empties the queue: a second poll yields nothing.
    expect(await source.poll(ctx)).toEqual([])
  })

  it('rejects a body that parse() refuses with 400 and queues nothing', async () => {
    const { source, url } = start()
    const res = await post(url, JSON.stringify({ wrong: 1 }))
    expect(res.status).toBe(400)
    expect(await source.poll(ctx)).toEqual([])
  })

  it('returns 404 for the wrong method or path', async () => {
    const { url } = start()
    const wrongPath = await post(url.replace('/submit', '/nope'), JSON.stringify({ value: 1 }))
    expect(wrongPath.status).toBe(404)
    const getRoot = await fetch(url, { method: 'GET' })
    expect(getRoot.status).toBe(404)
  })

  describe('token auth', () => {
    it('rejects a missing or wrong token with 401', async () => {
      const { source, url } = start({ token: 'secret' })
      expect((await post(url, JSON.stringify({ value: 1 }))).status).toBe(401)
      expect((await post(url, JSON.stringify({ value: 1 }), { Authorization: 'Bearer nope' })).status).toBe(401)
      expect(await source.poll(ctx)).toEqual([])
    })

    it('accepts a correct bearer token', async () => {
      const { source, url } = start({ token: 'secret' })
      const res = await post(url, JSON.stringify({ value: 9 }), { Authorization: 'Bearer secret' })
      expect(res.status).toBe(200)
      expect(await source.poll(ctx)).toEqual([{ value: 9 }])
    })
  })

  it('rejects submissions with 429 once the queue is full', async () => {
    const { source, url } = start({ maxQueueSize: 1 })
    expect((await post(url, JSON.stringify({ value: 1 }))).status).toBe(200)
    // queue is now at capacity (1) — the next submission is shed, not buffered.
    expect((await post(url, JSON.stringify({ value: 2 }))).status).toBe(429)
    expect(await source.poll(ctx)).toEqual([{ value: 1 }])
  })

  it('drains at most maxBatchSize items per poll, leaving the rest queued', async () => {
    const { source, url } = start({ maxBatchSize: 2 })
    for (const value of [1, 2, 3]) {
      expect((await post(url, JSON.stringify({ value }))).status).toBe(200)
    }
    // First tick fires at most 2 on-chain submissions; the third waits its turn.
    expect(await source.poll(ctx)).toEqual([{ value: 1 }, { value: 2 }])
    expect(await source.poll(ctx)).toEqual([{ value: 3 }])
    expect(await source.poll(ctx)).toEqual([])
  })

  it('rejects an oversized body (>64 KiB) and queues nothing', async () => {
    const { source, url } = start()
    const huge = JSON.stringify({ value: 1, pad: 'x'.repeat(70_000) })
    const res = await post(url, huge)
    expect(res.status).toBe(400)
    expect(await source.poll(ctx)).toEqual([])
  })

  it('refuses to construct a non-loopback bind without a token', () => {
    expect(() => httpQueueSource<Item>({ host: '0.0.0.0', port: 34999, parse: parseItem })).toThrow(
      /non-loopback bind/,
    )
  })
})
