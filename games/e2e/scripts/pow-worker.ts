import { parentPort } from 'node:worker_threads'
import { stamp as nativeStamp } from '@msgboard/pow-grinder'

/**
 * Node worker_threads grinder — a PURE STAMPER. It mints the MsgBoard proof-of-work stamp (the heavy
 * ~0.7s native grind, in Rust via @msgboard/pow-grinder) off the bot's main event loop, so the game loops
 * never starve it (and vice versa). It receives ONLY encoded bytes (category, data, block hash) + the
 * difficulty factors — never a private key, never the RPC. The main thread does the status/block read
 * and the submit (the `post` orchestration); this thread only stamps.
 */
if (!parentPort) throw new Error('pow-worker must be spawned as a worker_threads worker')

type Job = { id: number; category: string; data: string; wm: number; wd: number; blockHash: string; maxIters: number }
const buf = (hex: string): Buffer => Buffer.from(hex.slice(2), 'hex')

parentPort.on('message', (job: Job) => {
  try {
    const out = nativeStamp({
      category: buf(job.category),
      data: buf(job.data),
      workMultiplier: job.wm,
      workDivisor: job.wd,
      blockHash: buf(job.blockHash),
      startNonce: 0,
      maxIters: job.maxIters,
    })
    if (!out) {
      parentPort!.postMessage({ id: job.id, error: 'stamp: maxIters exhausted' })
      return
    }
    // out = nonce_be(8) ‖ hash(32)
    const nonce = `0x${Buffer.from(out.subarray(0, 8)).toString('hex')}`
    const hash = `0x${Buffer.from(out.subarray(8)).toString('hex')}`
    parentPort!.postMessage({ id: job.id, nonce, hash })
  } catch (e) {
    parentPort!.postMessage({ id: job.id, error: e instanceof Error ? e.message : String(e) })
  }
})
