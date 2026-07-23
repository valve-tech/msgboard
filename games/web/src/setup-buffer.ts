// MUST be imported before any module that pulls in circomlibjs (via the ZK witness builders):
// circomlibjs → blake-hash references Node's global `Buffer` at module-eval time. This side-effect
// module sets it before those imports evaluate; without it the app crashes on load.
import { Buffer } from 'buffer'

const g = globalThis as unknown as { Buffer?: unknown }
if (!g.Buffer) g.Buffer = Buffer
