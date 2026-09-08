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
