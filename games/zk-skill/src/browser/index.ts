// Browser entrypoint for @msgboard/zk-skill — the proving-key loader + in-worker PLONK prover.
//
// Exposed as a SEPARATE package subpath (`@msgboard/zk-skill/browser`) rather than from the package root
// (src/index.ts). The root re-exports the node-only harness (child_process/fs/crypto); mixing DOM code
// into it would drag node builds into DOM globals and vice-versa. Keeping this subpath distinct lets a
// web app import the browser side without ever pulling in the node harness.
export { loadArtifact, loadCircuit } from './browserLoader.js'
export type { ArtifactEntry, CircuitManifestEntry } from './browserLoader.js'
export { proveInWorker } from './prover.js'
export type { WorkerFactory } from './prover.js'
export type { ProveRequest, ProveResult } from './prover.worker.js'
