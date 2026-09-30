import { describe, it, expect } from 'vitest'
import {
  MSGBOARD_PAGE_MAX_LIMIT,
  contentAll,
  contentPages,
  keysetPages,
  txpoolContentPages,
  txpoolInspectPages,
  type RpcCall,
} from './pages.js'

const CAT_A = `0x${'aa'.repeat(32)}` as const
const CAT_B = `0x${'bb'.repeat(32)}` as const
type M = { hash: string; category: string }
type Sent = { method: string; params: unknown[] }
type Req = { limit?: number; after?: string; category?: string }

const h = (n: number) => `0x${n.toString(16).padStart(64, '0')}`
// 7919 is prime and shares no factor with 1,000, so i -> (i * 7919) % 1000
// gives distinct hashes whose order is not the insertion order.
const board = (n: number): M[] =>
  Array.from({ length: n }, (_, i) => ({ hash: h(((i * 7919) % 1000) + 1), category: i % 2 ? CAT_A : CAT_B }))
const group = (msgs: M[]) => {
  const out: Record<string, M[]> = {}
  for (const m of msgs) (out[m.category] ??= []).push(m)
  return out
}
const notFound = () =>
  Object.assign(new Error('the method msgboard_contentPage does not exist/is not available'), { code: -32601 })

/** reth v2.7.0.2, as the maintainers' tests pin msgboard_contentPage. `cutAt` makes the node send short pages. */
const pageNode = (msgs: M[], sent: Sent[] = [], cutAt = Infinity): RpcCall => async (method, params) => {
  sent.push({ method, params })
  if (method !== 'msgboard_contentPage') throw new Error(`unexpected ${method}`)
  const r = (params[0] ?? {}) as Req
  if (!Number.isInteger(r.limit) || r.limit! < 1 || r.limit! > 1000) {
    throw Object.assign(new Error('invalid limit'), { code: -32602 })
  }
  const sorted = msgs.filter((m) => !r.category || m.category === r.category).sort((a, b) => (a.hash < b.hash ? -1 : 1))
  const rest = r.after ? sorted.filter((m) => m.hash > r.after!) : sorted
  const page = rest.slice(0, Math.min(r.limit!, cutAt))
  return { content: group(page), next: rest.length > page.length ? page[page.length - 1]!.hash : null }
}

/** erigon-pulse or reth up to v2.7.0.1: no msgboard_contentPage; msgboard_content keyed by hash. */
const legacyNode = (msgs: M[], sent: Sent[] = [], refusesArgs = false): RpcCall => async (method, params) => {
  sent.push({ method, params })
  if (method === 'msgboard_contentPage') throw notFound()
  if (refusesArgs && params.length > 0) throw new Error('too many arguments, want at most 0')
  const out: Record<string, Record<string, object>> = {}
  for (const m of msgs) (out[m.category] ??= {})[m.hash] = { category: m.category }
  return out
}

const collect = async <T>(it: AsyncIterable<T>): Promise<T[]> => {
  const out: T[] = []
  for await (const x of it) out.push(x)
  return out
}
const hashesIn = (content: Record<string, unknown>): string[] =>
  Object.values(content)
    .flatMap((g) => (Array.isArray(g) ? g.map((m) => (m as M).hash) : Object.keys(g as object)))
    .map((x) => x.toLowerCase())
    .sort()
const all = (msgs: M[]) => msgs.map((m) => m.hash).sort()

describe('keysetPages', () => {
  it('stops only when next is null: a short page and an empty page do not end the walk', async () => {
    const answers = [
      { content: { [CAT_A]: [{ hash: h(1) }] }, next: h(1) },
      { content: {}, next: h(5) },
      { content: { [CAT_A]: [{ hash: h(9) }] }, next: null },
    ]
    const sent: unknown[] = []
    const call: RpcCall = async (_m, params) => { sent.push(params[0]); return answers.shift() }
    const pages = await collect(keysetPages(call, 'msgboard_contentPage', { limit: 10 }))
    expect(pages).toHaveLength(3)
    expect(sent).toEqual([{ limit: 10 }, { limit: 10, after: h(1) }, { limit: 10, after: h(5) }])
  })

  it('passes next back unchanged, mixed case included', async () => {
    const mixed = `0x${'Ab'.repeat(20)}`
    const answers = [{ next: mixed }, { next: null }]
    const sent: unknown[] = []
    const call: RpcCall = async (_m, params) => { sent.push(params[0]); return answers.shift() }
    await collect(keysetPages(call, 'txpool_contentPage', {}))
    expect(sent).toEqual([{}, { after: mixed }])
  })

  it('throws when next does not move past after, and never loops', async () => {
    let n = 0
    const call: RpcCall = async () => { n += 1; return { next: h(5) } }
    await expect(collect(keysetPages(call, 'msgboard_contentPage', { limit: 1 }))).rejects.toThrow(/did not move past/)
    expect(n).toBe(2)
  })

  it('throws on an answer with no next field', async () => {
    const call: RpcCall = async () => ({ [CAT_A]: [] })
    await expect(collect(keysetPages(call, 'msgboard_contentPage', { limit: 1 }))).rejects.toThrow(/no "next"/)
  })

  it('stops at maxPages on a walk that never ends', async () => {
    let n = 0
    const call: RpcCall = async () => { n += 1; return { next: h(n) } }
    await expect(collect(keysetPages(call, 'msgboard_contentPage', { limit: 1 }, { maxPages: 50 }))).rejects.toThrow('50')
  })
})

describe('contentPages on reth v2.7.0.2', () => {
  it('returns every message once, in pages of at most limit, and starts with no after', async () => {
    const msgs = board(237)
    const sent: Sent[] = []
    const pages = await collect(contentPages(pageNode(msgs, sent), {}, { limit: 50 }))
    expect(pages).toHaveLength(5)
    expect(pages.every((p) => p.mode === 'page')).toBe(true)
    expect(pages.flatMap((p) => hashesIn(p.content)).sort()).toEqual(all(msgs))
    expect(sent[0]).toEqual({ method: 'msgboard_contentPage', params: [{ limit: 50 }] })
    expect(sent.every((s) => s.method === 'msgboard_contentPage')).toBe(true)
    expect(pages[pages.length - 1]!.next).toBeNull()
  })

  it('a node that sends short pages still gives every message', async () => {
    const msgs = board(100)
    const pages = await collect(contentPages(pageNode(msgs, [], 7), {}, { limit: 50 }))
    expect(pages.flatMap((p) => hashesIn(p.content)).sort()).toEqual(all(msgs))
  })

  it('asks for the node bound when the caller names no limit', async () => {
    const sent: Sent[] = []
    await collect(contentPages(pageNode(board(10), sent)))
    expect(sent).toEqual([{ method: 'msgboard_contentPage', params: [{ limit: MSGBOARD_PAGE_MAX_LIMIT }] }])
  })

  it('keeps the filter on every page, with block numbers as JSON numbers', async () => {
    const sent: Sent[] = []
    await collect(contentPages(pageNode(board(120), sent), { category: CAT_A, fromBlock: 10n, toBlock: 20n }, { limit: 25 }))
    expect(sent[0]!.params).toEqual([{ limit: 25, category: CAT_A, fromBlock: 10, toBlock: 20 }])
    for (const s of sent) expect(s.params[0]).toMatchObject({ category: CAT_A, fromBlock: 10, toBlock: 20 })
  })

  it.each([0, 1001, 2.5])('refuses limit %s before any call', async (limit) => {
    const sent: Sent[] = []
    await expect(collect(contentPages(pageNode(board(5), sent), {}, { limit }))).rejects.toThrow(RangeError)
    expect(sent).toEqual([])
  })
})

describe('contentPages on a node without msgboard_contentPage', () => {
  it('reth up to v2.7.0.1: one whole-board call, the same call content() makes today', async () => {
    const msgs = board(30)
    const sent: Sent[] = []
    const pages = await collect(contentPages(legacyNode(msgs, sent), {}, { limit: 10 }))
    expect(pages).toHaveLength(1)
    expect(pages[0]).toMatchObject({ mode: 'whole', next: null })
    expect(hashesIn(pages[0]!.content)).toEqual(all(msgs))
    expect(sent).toEqual([
      { method: 'msgboard_contentPage', params: [{ limit: 10 }] },
      { method: 'msgboard_content', params: [{}] },
    ])
  })

  it('erigon-pulse: an empty filter falls back to a call with no params', async () => {
    const sent: Sent[] = []
    const pages = await collect(contentPages(legacyNode(board(3), sent, true)))
    expect(pages[0]!.mode).toBe('whole')
    expect(sent.map((s) => s.params)).toEqual([[{ limit: 1000 }], [{}], []])
  })

  it('erigon-pulse: a filter it cannot apply is an error, not a whole board', async () => {
    await expect(collect(contentPages(legacyNode(board(3), [], true), { category: CAT_A }))).rejects.toThrow(/too many arguments/)
  })

  it('reads -32601 through a wrapped cause, as viem wraps it', async () => {
    const inner = legacyNode(board(4))
    const call: RpcCall = async (method, params) => {
      if (method === 'msgboard_contentPage') throw Object.assign(new Error('Request failed'), { cause: { code: -32601 } })
      return inner(method, params)
    }
    const pages = await collect(contentPages(call))
    expect(pages[0]!.mode).toBe('whole')
  })

  it('any other first error is thrown, with no fallback', async () => {
    const sent: Sent[] = []
    const call: RpcCall = async (method, params) => {
      sent.push({ method, params })
      throw Object.assign(new Error('boom'), { code: -32603 })
    }
    await expect(collect(contentPages(call))).rejects.toThrow('boom')
    expect(sent).toHaveLength(1)
  })
})

describe('mixed fleet: page 1 from v2.7.0.2, page 2 from an older node', () => {
  const mixed = (msgs: M[], sent: Sent[]): RpcCall => {
    const fresh = pageNode(msgs, sent)
    const old = legacyNode(msgs, sent)
    let pages = 0
    return async (method, params) => {
      if (method === 'msgboard_contentPage') {
        pages += 1
        return pages === 1 ? fresh(method, params) : old(method, params)
      }
      return old(method, params)
    }
  }

  it('the iterator throws; it never skips the rest of the board', async () => {
    await expect(collect(contentPages(mixed(board(30), []), {}, { limit: 10 }))).rejects.toThrow(/does not exist/)
  })

  it('contentAll starts again once with the whole board', async () => {
    const msgs = board(30)
    const sent: Sent[] = []
    const content = await contentAll(mixed(msgs, sent), {}, { limit: 10 })
    expect(hashesIn(content)).toEqual(all(msgs))
    expect(sent.map((s) => s.method)).toEqual(['msgboard_contentPage', 'msgboard_contentPage', 'msgboard_content'])
  })
})

describe('contentAll', () => {
  it('merges every page into one board, each message once, grouped by category', async () => {
    const msgs = board(237)
    const content = await contentAll(pageNode(msgs), {}, { limit: 50 })
    expect(hashesIn(content)).toEqual(all(msgs))
    expect(Object.keys(content).sort()).toEqual([CAT_A, CAT_B])
    expect(Array.isArray(content[CAT_A])).toBe(true)
  })

  it('turns an erigon board keyed by hash into lists that carry the hash', async () => {
    const content = await contentAll(legacyNode(board(3), [], true))
    for (const list of Object.values(content)) for (const m of list) expect(m.hash).toMatch(/^0x/)
  })
})

describe('txpool pages', () => {
  it.each([
    ['txpool_contentPage', txpoolContentPages],
    ['txpool_inspectPage', txpoolInspectPages],
  ] as const)('%s walks until next is null, and sends no limit unless asked', async (method, walk) => {
    const a1 = `0x${'01'.repeat(20)}`
    const sent: Sent[] = []
    const call: RpcCall = async (m, params) => {
      sent.push({ method: m, params })
      const r = (params[0] ?? {}) as Req
      return r.after ? { pending: {}, queued: {}, next: null } : { pending: { [a1]: {} }, queued: {}, next: a1 }
    }
    const pages = await collect(walk(call))
    expect(pages).toHaveLength(2)
    expect(sent).toEqual([{ method, params: [{}] }, { method, params: [{ after: a1 }] }])
  })

  it('refuses a txpool limit above the node bound', () => {
    expect(() => txpoolContentPages(async () => ({ next: null }), { limit: 1001 })).toThrow(RangeError)
  })
})
