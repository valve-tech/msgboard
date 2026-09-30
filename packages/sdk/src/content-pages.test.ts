import { describe, it, expect } from 'vitest'
import { MsgBoardClient, type Provider } from './index.js'

const CAT = `0x${'aa'.repeat(32)}`
const h = (n: number) => `0x${n.toString(16).padStart(64, '0')}`
const msgs = Array.from({ length: 25 }, (_, i) => ({ hash: h(i + 1), category: CAT }))
const A1 = `0x${'01'.repeat(20)}`

const provider = (calls: unknown[]): Provider => ({
  request: async ({ method, params }: { method: string; params: unknown[] }) => {
    calls.push({ method, params })
    const r = (params[0] ?? {}) as { limit?: number; after?: string }
    if (method === 'msgboard_contentPage') {
      const rest = msgs.filter((m) => !r.after || m.hash > r.after)
      const page = rest.slice(0, r.limit)
      return { content: page.length ? { [CAT]: page } : {}, next: rest.length > page.length ? page[page.length - 1]!.hash : null } as never
    }
    if (method === 'txpool_contentPage') {
      return (r.after ? { pending: {}, queued: {}, next: null } : { pending: { [A1]: {} }, queued: {}, next: A1 }) as never
    }
    if (method === 'msgboard_content') return {} as never
    throw new Error(`unexpected ${method}`)
  },
})

describe('MsgBoardClient paging', () => {
  it('contentAll walks msgboard_contentPage until next is null and returns one board', async () => {
    const calls: unknown[] = []
    const client = new MsgBoardClient(provider(calls), { stamper: null })
    const content = await client.contentAll({}, { limit: 10 })
    expect(content[CAT as `0x${string}`]!.map((m) => m.hash)).toEqual(msgs.map((m) => m.hash))
    expect(calls[0]).toEqual({ method: 'msgboard_contentPage', params: [{ limit: 10 }] })
    expect(calls.length).toBe(3)
  })

  it('contentPages yields each page with its mode', async () => {
    const client = new MsgBoardClient(provider([]), { stamper: null })
    const modes: string[] = []
    for await (const page of client.contentPages({}, { limit: 10 })) modes.push(page.mode)
    expect(modes).toEqual(['page', 'page', 'page'])
  })

  it('txpoolContentPages walks the pool by sender', async () => {
    const calls: unknown[] = []
    const client = new MsgBoardClient(provider(calls), { stamper: null })
    const pages = []
    for await (const page of client.txpoolContentPages()) pages.push(page)
    expect(pages).toHaveLength(2)
    expect(calls).toEqual([
      { method: 'txpool_contentPage', params: [{}] },
      { method: 'txpool_contentPage', params: [{ after: A1 }] },
    ])
  })

  it('content() stays one msgboard_content call with the filter as given', async () => {
    const calls: unknown[] = []
    const client = new MsgBoardClient(provider(calls), { stamper: null })
    await client.content()
    expect(calls).toEqual([{ method: 'msgboard_content', params: [{}] }])
  })
})
