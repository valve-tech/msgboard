// Petition statements built from headlines.
//
// The fleet's petition bot needs a supply of statements to seed, and a fixed
// list in an environment variable produced the same handful forever. These turn
// whatever a news feed is carrying today into petitions the board can hold.
//
// Two properties matter more than the wording.
//
// DETERMINISM. The petition id derives from the statement, so the same headline
// must always produce the same statement. `petitionsNeedingCreation` then sees
// the petition already exists and skips it. A generator that varied its phrasing
// would recreate the same petition on every tick and flood the board.
//
// UNTRUSTED INPUT. Headlines come from a third party and end up in a
// proof-of-work-stamped board post that anyone can read. They are sanitised
// here, not where they are displayed.

/** The most a generated statement may run to, in characters. */
export const MAX_STATEMENT_LENGTH = 280

/** Below this a headline carries no meaning worth petitioning about. */
const MIN_HEADLINE_LENGTH = 12

const PREFIX = 'We petition the board to take a public position on: '

/** Collapse whitespace and drop control characters. */
const clean = (raw: string): string =>
  raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1F\x7F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** Trim to `limit` on a word boundary, so a statement never ends mid-word. */
const trimToWord = (text: string, limit: number): string => {
  if (text.length <= limit) return text
  const cut = text.slice(0, limit)
  const lastSpace = cut.lastIndexOf(' ')
  return (lastSpace > limit / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()
}

/**
 * Build one petition statement from one headline.
 *
 * Returns null when the headline is too short to mean anything, so callers can
 * filter a feed without deciding what "too short" is.
 */
export const statementFromHeadline = (headline: string): string | null => {
  const subject = clean(headline)
  if (subject.length < MIN_HEADLINE_LENGTH) return null
  const room = MAX_STATEMENT_LENGTH - PREFIX.length
  return `${PREFIX}${trimToWord(subject, room)}`
}

export interface StatementsOptions {
  /** How many statements one call may produce. Keeps a busy feed from
   *  flooding the board in a single tick. */
  max?: number
}

/**
 * Build statements from a feed, in order, dropping the ones that do not qualify
 * and any repeat of a statement already produced.
 */
export const statementsFromHeadlines = (
  headlines: readonly string[],
  { max = 5 }: StatementsOptions = {},
): string[] => {
  const seen = new Set<string>()
  const out: string[] = []
  for (const headline of headlines) {
    if (out.length >= max) break
    const statement = statementFromHeadline(headline)
    if (!statement || seen.has(statement)) continue
    seen.add(statement)
    out.push(statement)
  }
  return out
}
