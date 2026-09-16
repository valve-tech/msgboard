/**
 * zk-prover — the main-thread SEAM over the ZK Web Worker (worker/zk-worker.ts).
 *
 * All heavy crypto (Poseidon identity/tree + Groth16 prove/verify) runs in the worker; this
 * seam only marshals typed requests and correlates replies by id. It exposes a small, clean
 * contract that degrades gracefully: if the worker can't initialise (circuit assets or
 * snarkjs/circomlibjs unavailable in this build), `whenReady()` rejects and the UI shows a
 * visible "proving unavailable" state. The seam NEVER fabricates a proof or a verification
 * result — a proof either really comes back from snarkjs or the call rejects.
 *
 * Injectable `workerFactory` mirrors the PoW seam so headless tests can supply a fake Worker.
 */
import type { Hex } from 'viem'
import type { ZkIdentity } from '../lib/zk-identity'
import type { ZkPost } from '../lib/zk-post'
import type { ZkWorkerRequest, ZkWorkerResponse } from '../worker/zk-types'

export type ZkProver = {
  /** Resolves once the worker has loaded its assets/libs; rejects if init failed. */
  whenReady: () => Promise<void>
  /** True once the worker signalled ready; false while pending or after an init failure. */
  isReady: () => boolean
  /** Produce a real membership proof bound to `payload` in `scope`. Rejects if unavailable. */
  prove: (args: { identity: ZkIdentity; payload: Hex; scope: string }) => Promise<ZkPost>
  /** Real Groth16 verification of a decoded post. Resolves false on any failure. */
  verify: (post: ZkPost) => Promise<boolean>
  /** Tear down the worker. */
  dispose: () => void
}

const defaultWorkerFactory = (): Worker =>
  new Worker(new URL('../worker/zk-worker.ts', import.meta.url), { type: 'module' })

export function makeZkProver(workerFactory: () => Worker = defaultWorkerFactory): ZkProver {
  let worker: Worker | null = null
  let ready = false
  let nextId = 1
  const pending = new Map<
    number,
    { resolve: (value: never) => void; reject: (reason: unknown) => void }
  >()

  let resolveReady!: () => void
  let rejectReady!: (reason: unknown) => void
  const readyPromise = new Promise<void>((res, rej) => {
    resolveReady = res
    rejectReady = rej
  })

  const spawn = (): Worker => {
    if (worker) return worker
    const w = workerFactory()
    w.addEventListener('message', (e: MessageEvent<ZkWorkerResponse>) => {
      const msg = e.data
      switch (msg.type) {
        case 'ready':
          ready = true
          resolveReady()
          break
        case 'init-error':
          ready = false
          rejectReady(new Error(msg.message))
          break
        case 'prove-ok': {
          const p = pending.get(msg.id)
          if (p) {
            pending.delete(msg.id)
            ;(p.resolve as (v: ZkPost) => void)(msg.post)
          }
          break
        }
        case 'prove-err': {
          const p = pending.get(msg.id)
          if (p) {
            pending.delete(msg.id)
            p.reject(new Error(msg.message))
          }
          break
        }
        case 'verify-res': {
          const p = pending.get(msg.id)
          if (p) {
            pending.delete(msg.id)
            ;(p.resolve as (v: boolean) => void)(msg.valid)
          }
          break
        }
      }
    })
    w.addEventListener('error', (err: ErrorEvent) => {
      if (!ready) rejectReady(new Error(err.message || 'zk worker crashed'))
    })
    worker = w
    return w
  }

  const request = <T>(build: (id: number) => ZkWorkerRequest): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const w = spawn()
      const id = nextId++
      pending.set(id, { resolve: resolve as (value: never) => void, reject })
      w.postMessage(build(id))
    })

  // Kick the worker to life immediately so `whenReady()` reflects real init state.
  spawn()

  return {
    whenReady: () => readyPromise,
    isReady: () => ready,
    prove: ({ identity, payload, scope }) =>
      request<ZkPost>((id) => ({
        type: 'prove',
        id,
        identityNullifier: identity.nullifier.toString(),
        identityTrapdoor: identity.trapdoor.toString(),
        payload,
        scope,
      })),
    verify: (post) => request<boolean>((id) => ({ type: 'verify', id, post })).catch(() => false),
    dispose: () => {
      worker?.terminate()
      worker = null
    },
  }
}
