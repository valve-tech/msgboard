/**
 * Resolves the `SPAM_WORKERS` environment value into a worker count.
 *
 * Proof-of-work grinding is CPU-bound and single-threaded per process, so the only way
 * to use more than one core is to run multiple grinders. `SPAM_WORKERS` controls how many
 * worker threads each spam container spawns (each an independent grind→post loop). Defaults
 * to 1 (the original single-grinder behaviour). Any non-positive, fractional, or unparseable
 * value is clamped to a sane positive integer.
 *
 * @param raw the raw `process.env.SPAM_WORKERS` value (or undefined)
 * @returns an integer >= 1
 */
export const resolveWorkerCount = (raw: string | undefined): number => {
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return 1
  return Math.max(1, Math.floor(parsed))
}
