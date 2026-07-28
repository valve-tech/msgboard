import type { Hex } from 'viem'
import { INDEX_SCOPE, PETITION_NS, signScope } from '@msgboard/petition'
import { resolveCategories, type ResolvedCategory } from '../cosign/categories.js'

export type { ResolvedCategory }

/**
 * Expands the petition index's rolling `days`-window into concrete category hashes
 * via the cosign-backed `resolveCategories` (the single source of truth for the key
 * scheme), under the shared `PETITION_NS`/`INDEX_SCOPE`.
 */
export const resolveIndexCategories = (days: number, now: Date = new Date()): ResolvedCategory[] =>
  resolveCategories(PETITION_NS, INDEX_SCOPE, days, now)

/**
 * Expands a specific petition `id`'s signature scope over the rolling `days`-window
 * into concrete category hashes, via the same `resolveCategories`.
 */
export const resolveSignatureCategories = (
  id: Hex,
  days: number,
  now: Date = new Date(),
): ResolvedCategory[] => resolveCategories(PETITION_NS, signScope(id), days, now)
