import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // zk-core's GPL secret-engine prover (zypherDeck.ts) statically imports `node:module` for a
      // Node-only `createRequire`. It is never called in the browser, but the named import must
      // resolve for the browser build — map it to a throwing stub. See src/browser-shims/node-module.ts.
      'node:module': fileURLToPath(new URL('./src/browser-shims/node-module.ts', import.meta.url)),
    },
  },
  // The MsgBoard PoW grinder runs in a Web Worker (powWorker.ts) that imports @msgboard/sdk, so the
  // worker bundle code-splits — which requires the ES module format (Vite's default 'iife' can't).
  worker: { format: 'es' },
  test: {
    include: ['test/**/*.test.ts'],
  },
})
