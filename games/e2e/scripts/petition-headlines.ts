/**
 * petition-headlines.ts — where the petition bot gets something to petition about.
 *
 * The bot used to seed from a fixed `PETITION_STATEMENTS` list, which produced
 * the same handful of petitions forever, and on the box that list was never set
 * at all. This fetches what the world is talking about today and lets
 * `statementsFromHeadlines` turn it into petitions.
 *
 * KEYLESS BY DEFAULT. Hacker News' Firebase API needs no key, no account and no
 * billing relationship, so the bot cannot be stopped by an expired credential.
 *
 * X IS OPTIONAL. Set `X_BEARER_TOKEN` and recent posts are used instead. Absent,
 * revoked, or failing for any reason, the keyless feed answers and the bot does
 * not notice. Reading X needs a paid API tier, so the keyless path is what
 * actually runs unless someone has funded one.
 *
 * NOTHING HERE THROWS. A dead feed returns no headlines, which is a fine tick.
 * Taking the capture loop down because a news site is having a bad afternoon
 * would be a worse bug than the one this replaces.
 */

const HN_TOP = 'https://hacker-news.firebaseio.com/v0/topstories.json'
const HN_ITEM = (id: number) => `https://hacker-news.firebaseio.com/v0/item/${id}.json`
const X_RECENT = 'https://api.x.com/2/tweets/search/recent'

/** How many headlines to pull when the caller does not say. */
const DEFAULT_LIMIT = 10

/** Per-request budget. The bot ticks every five minutes; a slow feed must not
 *  eat the tick it was supposed to decorate. */
const DEFAULT_TIMEOUT_MS = 8_000

export interface HeadlineDeps {
  fetcher: (url: string, init?: RequestInit) => Promise<Response>
  env: Record<string, string | undefined>
  /** How many headlines to return. */
  limit?: number
  timeoutMs?: number
}

const withTimeout = async (
  deps: HeadlineDeps,
  run: (signal: AbortSignal) => Promise<Response>,
): Promise<Response> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  try {
    return await run(controller.signal)
  } finally {
    clearTimeout(timer)
  }
}

/** Recent posts from X. Only reached when a bearer token is configured. */
const fromX = async (deps: HeadlineDeps, limit: number, token: string): Promise<string[]> => {
  const url = `${X_RECENT}?query=${encodeURIComponent('news -is:retweet lang:en')}&max_results=${Math.max(10, limit)}`
  const response = await withTimeout(deps, (signal) =>
    // The token goes to X and nowhere else.
    deps.fetcher(url, { headers: { Authorization: `Bearer ${token}` }, signal }),
  )
  if (!response.ok) return []
  const body = (await response.json()) as { data?: { text?: unknown }[] }
  return (body.data ?? [])
    .map((post) => (typeof post.text === 'string' ? post.text : null))
    .filter((t): t is string => !!t)
    .slice(0, limit)
}

/** Front-page story titles from Hacker News. No key, no account. */
const fromHackerNews = async (deps: HeadlineDeps, limit: number): Promise<string[]> => {
  const listed = await withTimeout(deps, (signal) => deps.fetcher(HN_TOP, { signal }))
  if (!listed.ok) return []
  const ids = (await listed.json()) as unknown
  if (!Array.isArray(ids)) return []

  const titles: string[] = []
  // Sequential and capped: this asks a free service for exactly what it needs.
  for (const id of ids.slice(0, limit)) {
    if (typeof id !== 'number') continue
    try {
      const item = await withTimeout(deps, (signal) => deps.fetcher(HN_ITEM(id), { signal }))
      if (!item.ok) continue
      const story = (await item.json()) as { title?: unknown } | null
      if (story && typeof story.title === 'string') titles.push(story.title)
    } catch {
      continue // one bad item must not lose the rest
    }
  }
  return titles
}

/**
 * Fetch today's headlines: X when a token is configured, Hacker News otherwise
 * and whenever X does not answer.
 *
 * Returns an empty array rather than throwing, on any failure.
 */
export const fetchHeadlines = async (deps: HeadlineDeps): Promise<string[]> => {
  const limit = deps.limit ?? DEFAULT_LIMIT
  const token = deps.env.X_BEARER_TOKEN?.trim()

  if (token) {
    try {
      const viaX = await fromX(deps, limit, token)
      if (viaX.length > 0) return viaX
    } catch {
      // fall through to the keyless feed
    }
  }

  try {
    return await fromHackerNews(deps, limit)
  } catch {
    return []
  }
}
