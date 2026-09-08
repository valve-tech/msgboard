/**
 * Secret hygiene for any process built on this package.
 *
 * viem puts the whole request URL into the message of every error it throws, and
 * our RPC endpoints carry the access key in the URL path. A relayer that logs a
 * caught error therefore prints a live key to stdout, and container stdout is a
 * durable, widely-readable log. That is how the indexer leaked its key for 17
 * days: `msgboard-indexer: indexing chain 1 via https://…/rpc/<key>/…`.
 *
 * `installConsoleRedactor()` closes the whole class of leak at the console, so a
 * future log line cannot reopen it. Call it first in an entrypoint, before any
 * code that can log.
 *
 * The actor fleet carries its own copy of this in `games/e2e/scripts/redact-console.ts`.
 * That package does not depend on this one, so the two stay separate on purpose.
 */

import { createHash } from 'node:crypto'

/** Replaces the key segment of an RPC URL, and any bare `vk_` token, with a marker. */
export const redactSecrets = (text: string): string =>
  text.replace(/(\/rpc\/)[^/\s"'`)]+/g, '$1<redacted>').replace(/vk_[A-Za-z0-9_-]{4,}/g, 'vk_<redacted>')

const redactArg = (value: unknown): unknown => {
  if (typeof value === 'string') return redactSecrets(value)
  if (value instanceof Error) return redactSecrets(value.stack ?? value.message)
  return value
}

/**
 * Patches `console.log`, `.error`, `.warn` and `.info` so no keyed URL reaches
 * stdout. Idempotent: a second call does not stack another layer of patching.
 */
export const installConsoleRedactor = (): void => {
  const target = console as Console & { __msgboardRedacted?: true }
  if (target.__msgboardRedacted) return
  for (const method of ['log', 'error', 'warn', 'info'] as const) {
    const original = console[method].bind(console)
    console[method] = (...args: unknown[]) => original(...args.map(redactArg))
  }
  target.__msgboardRedacted = true
}

/**
 * A stable, unique, safe-to-store label for an endpoint URL.
 *
 * `redactSecrets` alone is NOT enough to identify an endpoint. Two replicas of one chain
 * are most naturally reached through the same gateway host with different API keys — and
 * those redact to the identical string. Anything keyed on the redacted URL then treats two
 * distinct endpoints as one: in the archivist's heartbeat table both relayers would share a
 * row and overwrite each other, and the replica split the table exists to reveal would
 * become invisible again.
 *
 * So append a short digest of the WHOLE url. It distinguishes endpoints that differ only by
 * key, stays the same across restarts and reordering, and leaks nothing — a truncated
 * SHA-256 of a high-entropy secret cannot be walked back to it.
 */
export const sourceLabel = (url: string): string =>
  `${redactSecrets(url)}#${createHash('sha256').update(url).digest('hex').slice(0, 8)}`
