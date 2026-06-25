import { defineConfig } from 'vite'

/**
 * Dedicated Vite config for the Task-6 PoW-responsiveness e2e harness
 * (`e2e/harness/`). It serves ONLY the harness page — a tiny driver that spawns the
 * REAL `@msgboard/sdk` grind in a Web Worker so the spec can assert the main thread stays
 * responsive. The full ui-react app is served separately by its own `vite preview` (or
 * the parity suite's webServer); this config exists so the responsiveness test doesn't
 * depend on the whole app booting or any chain reads.
 *
 * `worker.format: 'es'` mirrors the production `vite.config.ts` so the harness worker is
 * spawned with `{ type: 'module' }` — exactly as the real PoW worker is.
 */
export default defineConfig({
  root: 'e2e/harness',
  base: './',
  resolve: { preserveSymlinks: true },
  server: { port: 4320, strictPort: true },
  preview: { port: 4320, strictPort: true },
  worker: { format: 'es' },
})
