// Browser stub for `node:module`, aliased in vite.config.ts. The only consumer in the bundle is
// zk-core/src/zypherDeck.ts (the GPL secret-engine prover), which is Node-only and never invoked in
// the browser — but its top-level `import { createRequire } from 'node:module'` must resolve for the
// browser build to succeed. This provides a `createRequire` named export that throws if ever called.
export function createRequire(_url?: string | URL): never {
  throw new Error('node:module createRequire is not available in the browser')
}

export default { createRequire }
