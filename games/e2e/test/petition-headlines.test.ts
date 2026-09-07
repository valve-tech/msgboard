import { describe, it, expect } from 'vitest'

import { fetchHeadlines, type HeadlineDeps } from '../scripts/petition-headlines.js'

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })

/** A fetcher standing in for Hacker News: an id list, then one item each. */
const hn = (titles: Record<number, unknown>): HeadlineDeps['fetcher'] => async (url) => {
  const u = String(url)
  if (u.includes('topstories')) return json(Object.keys(titles).map(Number))
  const id = Number(u.match(/item\/(\d+)/)?.[1])
  return json(titles[id])
}

describe('fetchHeadlines', () => {
  it('returns the story titles, newest first', async () => {
    const out = await fetchHeadlines({
      fetcher: hn({ 1: { title: 'First real headline here' }, 2: { title: 'Second real headline' } }),
      env: {},
    })
    expect(out).toEqual(['First real headline here', 'Second real headline'])
  })

  it('asks for no more items than the limit', async () => {
    const asked: string[] = []
    const titles = Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => [i, { title: `Headline ${i} about something` }]),
    )
    await fetchHeadlines({
      fetcher: async (url) => {
        asked.push(String(url))
        return hn(titles)(url)
      },
      env: {},
      limit: 3,
    })
    // one list call plus one call per item, never the whole front page
    expect(asked.filter((u) => u.includes('item/'))).toHaveLength(3)
  })

  it('skips an item that carries no title instead of failing the batch', async () => {
    const out = await fetchHeadlines({
      fetcher: hn({ 1: { title: 'A real headline here' }, 2: { deleted: true }, 3: null }),
      env: {},
    })
    expect(out).toEqual(['A real headline here'])
  })

  it('returns nothing when the feed is unreachable, rather than throwing', async () => {
    // The bot must survive a dead feed. No statements is a fine tick; a thrown
    // error would take the whole capture loop down with it.
    const out = await fetchHeadlines({
      fetcher: async () => { throw new Error('ENOTFOUND') },
      env: {},
    })
    expect(out).toEqual([])
  })

  it('returns nothing on a non-200 from the feed', async () => {
    const out = await fetchHeadlines({
      fetcher: async () => new Response('nope', { status: 503 }),
      env: {},
    })
    expect(out).toEqual([])
  })
})

describe('fetchHeadlines — the optional X source', () => {
  it('uses X when a bearer token is present', async () => {
    const seen: string[] = []
    const out = await fetchHeadlines({
      env: { X_BEARER_TOKEN: 'secret' },
      fetcher: async (url, init) => {
        seen.push(String(url))
        const auth = (init?.headers as Record<string, string> | undefined)?.Authorization
        expect(auth).toBe('Bearer secret')
        return json({ data: [{ text: 'A headline from X about something' }] })
      },
    })
    expect(seen.every((u) => u.includes('x.com'))).toBe(true)
    expect(out).toEqual(['A headline from X about something'])
  })

  it('falls back to the keyless feed when X fails, rather than giving up', async () => {
    // A billing lapse or a revoked key must not stop the bot. X is the optional
    // half; the keyless feed is the one that has to keep working.
    const out = await fetchHeadlines({
      env: { X_BEARER_TOKEN: 'expired' },
      fetcher: async (url) => {
        if (String(url).includes('x.com')) return new Response('unauthorized', { status: 401 })
        return hn({ 1: { title: 'The keyless fallback headline' } })(url)
      },
    })
    expect(out).toEqual(['The keyless fallback headline'])
  })

  it('never sends an Authorization header to the keyless feed', async () => {
    // The token belongs to X. It must not leak to a third-party endpoint.
    let leaked = false
    await fetchHeadlines({
      env: { X_BEARER_TOKEN: 'secret' },
      fetcher: async (url, init) => {
        const auth = (init?.headers as Record<string, string> | undefined)?.Authorization
        if (!String(url).includes('x.com') && auth) leaked = true
        if (String(url).includes('x.com')) return new Response('', { status: 500 })
        return hn({ 1: { title: 'The keyless fallback headline' } })(url)
      },
    })
    expect(leaked).toBe(false)
  })
})
