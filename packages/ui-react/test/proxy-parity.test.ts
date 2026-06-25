import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'

/**
 * Byte-diff gate (Task 1): the `/api/rpc-proxy` middleware + its allow-list are the
 * mixed-content lifeline. Their *definitions* MUST be byte-identical between the live
 * Svelte `packages/ui/vite.config.ts` and the ported `packages/ui-react/vite.config.ts`.
 *
 * The four blocks live as top-level `const`/`return`-bearing declarations spanning
 * lines 6–111 of each source (everything from `const readBody` through the end of
 * `rpcProxyPlugin`). We extract that contiguous span by anchoring on the
 * `const readBody` declaration and the final `}` that closes `rpcProxyPlugin`
 * (the line immediately before `export default defineConfig`). The two spans must
 * be identical — an empty diff.
 *
 * (The plan's looser `sed` one-liner over-captures into the config object because
 * `/rpcProxyPlugin/` also matches the `plugins:` array line; that intentionally
 * differs — svelte() vs react(), the worker comment, the vitest `test` block — so
 * this gate is anchored on the *definitions* only, which is what must stay verbatim.)
 */

// vitest runs with cwd at the package root (packages/ui-react), so resolve from there.
const SOURCE = resolve(process.cwd(), '../ui/vite.config.ts')
const PORTED = resolve(process.cwd(), 'vite.config.ts')

/** Extract the proxy/guard/allow-list definition span: `const readBody` … the `}`
 *  that closes `rpcProxyPlugin` (the line directly above `export default`). */
function proxyDefinitions(src: string): string {
  const lines = src.split('\n')
  const start = lines.findIndex((l) => l.startsWith('const readBody'))
  const exportIdx = lines.findIndex((l) => l.startsWith('export default defineConfig'))
  if (start < 0 || exportIdx < 0) throw new Error('anchors not found')
  // walk back from the export to the last non-blank line (the closing `}` of rpcProxyPlugin)
  let end = exportIdx - 1
  while (end > start && lines[end].trim() === '') end--
  return lines.slice(start, end + 1).join('\n')
}

describe('rpc-proxy byte-diff gate', () => {
  it('ports the proxy/guard/allow-list definitions byte-for-byte from packages/ui', () => {
    const sourceBlocks = proxyDefinitions(readFileSync(SOURCE, 'utf8'))
    const portedBlocks = proxyDefinitions(readFileSync(PORTED, 'utf8'))

    // sanity: the extraction actually captured the proxy guts
    expect(sourceBlocks).toContain('ALLOWED_RPC_HOSTS')
    expect(sourceBlocks).toContain("'/api/rpc-proxy'")
    expect(sourceBlocks).toContain("'valve.city'")
    expect(sourceBlocks).toContain('const isAllowedRpcTarget')
    expect(sourceBlocks).toContain('rpcProxyPlugin')

    // the gate: identical (empty diff)
    expect(portedBlocks).toBe(sourceBlocks)
  })
})
