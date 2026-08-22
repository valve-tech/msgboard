/**
 * Secret hygiene, installed as a side effect on import: patch console.{log,error,warn,info} so the
 * keyed valve RPC URL can never reach stdout. viem embeds the full request URL (VALVE_RPC_KEY is in
 * its path) in thrown-error messages, and the actors log those — which leaked the key into the
 * containers' Docker logs. This scrubs the /rpc/<key>/ path segment and any vk_ token at the source.
 *
 * Import this FIRST in every actor entrypoint, before any code that might log.
 */
const scrubSecret = (s: string): string =>
  s.replace(/(\/rpc\/)[^/\s"'`)]+/g, '$1<redacted>').replace(/vk_[A-Za-z0-9_-]{4,}/g, 'vk_<redacted>')

const redactArg = (v: unknown): unknown =>
  typeof v === 'string' ? scrubSecret(v) : v instanceof Error ? scrubSecret(v.stack || v.message) : v

for (const method of ['log', 'error', 'warn', 'info'] as const) {
  const original = console[method].bind(console)
  console[method] = (...args: unknown[]) => original(...args.map(redactArg))
}
