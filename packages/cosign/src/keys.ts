import { type Hex, keccak256, toBytes } from 'viem'

/**
 * Formats a Date as a UTC `YYYY-MM-DD` string — the day bucket for a category key.
 * UTC is intentional: every participant and the archivist must agree on the bucket
 * regardless of local timezone.
 */
export function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/**
 * The canonical category key for a (namespace, scope, isoDate) triple.
 * Equals `keccak256(toBytes(\`${namespace}:${scope}:${isoDate}\`))`.
 *
 * NOTE: for string inputs this is byte-for-byte identical to `@msgboard/core`'s
 * `categoryHash(keyString)` (both keccak256 the UTF-8 bytes). We compute it here
 * directly so the key scheme is self-contained and importable without a core dep.
 *
 * Order is law (the archivist mirrors this): `namespace:scope:isoDate`.
 */
export function categoryKey(namespace: string, scope: string, isoDate: string): Hex {
  return keccak256(toBytes(`${namespace}:${scope}:${isoDate}`))
}

/** The category key for the current UTC day. `now` is injectable for deterministic tests. */
export function currentKey(namespace: string, scope: string, now: Date = new Date()): Hex {
  return categoryKey(namespace, scope, isoDay(now))
}

/**
 * The rolling window of category keys: today plus the prior `days - 1` UTC days,
 * today-first then descending. This is the shared set readers and the archivist sweep.
 * @throws if `days < 1`.
 */
export function keysForWindow(
  namespace: string,
  scope: string,
  days: number,
  now: Date = new Date(),
): Hex[] {
  if (days < 1) throw new Error('keysForWindow: days >= 1 required')
  const dayMs = 24 * 60 * 60 * 1000
  const base = now.getTime()
  const keys: Hex[] = []
  for (let i = 0; i < days; i++) {
    keys.push(categoryKey(namespace, scope, isoDay(new Date(base - i * dayMs))))
  }
  return keys
}
