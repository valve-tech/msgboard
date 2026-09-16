// MUST be imported before circomlibjs/snarkjs: circomlibjs → blake-hash references Node's global
// `Buffer` at module-eval time, which a browser Web Worker does not define. This side-effect module
// sets it first; without it the ZK worker crashes on load with "Buffer is not defined" (mirrors
// games/web's identical shim for its PLONK prover).
import { Buffer } from 'buffer'

const g = globalThis as unknown as { Buffer?: unknown }
if (!g.Buffer) g.Buffer = Buffer
