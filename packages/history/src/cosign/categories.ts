import type { Hex } from 'viem'
import { isoDay, keysForWindow } from '@msgboard/cosign'

/** A resolved category: its hash plus the UTC day it buckets (for the board-vs-archive split). */
export type ResolvedCategory = {
  category: Hex
  /** `YYYY-MM-DD` UTC day this category buckets. */
  isoDay: string
}

/**
 * Expands `(namespace, scope) × {today + prior days-1 UTC days}` into concrete category
 * hashes via the cosign SDK's `keysForWindow` (the single source of truth for the key scheme),
 * tagging each with its UTC `isoDay`. Today-first, descending. Throws when `days < 1`.
 */
export const resolveCategories = (
  namespace: string,
  scope: string,
  days: number,
  now: Date = new Date(),
): ResolvedCategory[] => {
  const categories = keysForWindow(namespace, scope, days, now)
  const dayMs = 24 * 60 * 60 * 1000
  const base = now.getTime()
  return categories.map((category, i) => ({ category, isoDay: isoDay(new Date(base - i * dayMs)) }))
}
