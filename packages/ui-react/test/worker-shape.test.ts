import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'

// Resolve from the repo source on disk. `import.meta.url` is an http(s) URL under
// the jsdom test environment, so we anchor to the package's `test/` dir via __dirname.
const fromTestDir = (rel: string) => readFileSync(join(__dirname, rel), 'utf8')

/**
 * Off-main-thread tripwire (memory rule #9: PoW NEVER runs on the main thread).
 *
 * This is a cheap source-level regression guard so nobody inlines the grind onto the
 * render thread. It asserts the seam's default worker factory spawns a dedicated
 * ES-module `Worker` (so the grind is bundled OFF the main thread as its own chunk),
 * and that the worker uses the dedicated-worker global scope (not a service worker,
 * not the main `window`). The authoritative behavioral proof is the Task 6 Playwright
 * "main thread responsive during grind" assertion; this is the unit-level tripwire.
 */
describe('PoW grind off-main-thread tripwire', () => {
  it('spawns the grind in a dedicated ES-module worker (never the main thread)', () => {
    const seam = fromTestDir('../src/seams/worker-board.ts')
    // The default factory must construct a dedicated Worker from the pow-worker module URL.
    expect(seam).toMatch(/new Worker\(\s*new URL\(['"]\.\.\/worker\/pow-worker\.ts['"]/)
    // …as an ES module (so Vite emits a separate worker chunk).
    expect(seam).toMatch(/type:\s*['"]module['"]/)

    const worker = fromTestDir('../src/worker/pow-worker.ts')
    // The grind runs in a DedicatedWorkerGlobalScope — never the window/main thread,
    // and never a ServiceWorker (the old Svelte shape we ported away from).
    expect(worker).toMatch(/DedicatedWorkerGlobalScope/)
    expect(worker).not.toMatch(/ServiceWorkerGlobalScope/)
    // The actual grind call lives in the worker module, NOT the seam (main thread).
    expect(worker).toMatch(/\.doPoW\(/)
    expect(seam).not.toMatch(/\.doPoW\(/)
  })
})
