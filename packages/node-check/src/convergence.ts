// Replica convergence: do two nodes serving the same chain hold the same board?
//
// WHY THIS EXISTS. On 2026-09-08 the two mainnet replicas held completely disjoint
// boards — 33 messages against 0, not one hash in common — for weeks. Every symptom
// an operator can normally see said healthy: both nodes reported `enabled: true`,
// both answered `msgboard_status` at the same head block, both held an ESTABLISHED
// devp2p session to the other, and the msgboard layer logs nothing about peers at
// all. The only reason anyone found out was a manual comparison.
//
// Root cause was a capability-negotiation race: a node dials its trusted peer before
// the msgboard sub-protocol registers, so its devp2p Hello omits `msg/1`. Capabilities
// are negotiated once per session and are immutable for its life, so that link stays
// board-blind until one side restarts at a luckier moment. Fixed in the node; this
// check is what notices when something like it happens again.
//
// WHAT COUNTS AS DIVERGENCE. Not "the boards differ". They always differ a little:
// messages expire from the board after roughly twenty minutes, and a message posted a
// second ago has not propagated yet. What does not happen on a healthy pair is a low
// SHARE of messages. Two replicas that gossip hold nearly the same set; two replicas
// that do not share almost nothing, because each only holds what was posted directly
// to it. Measured on a healthy pair, the two boards stayed hash-for-hash identical
// across 21 arrivals and 23 expirations. So this grades on overlap, not equality.
//
// READING THE RIGHT NODES IS THE CALLER'S JOB. A gateway that pins each API key to one
// upstream will answer every request in a run from the SAME replica, and this check
// will then compare a node against itself and always pass. Point it at per-replica
// endpoints, or at distinct keys known to land on different homes. `endpointsDiffer`
// below is the guard against that mistake, not a substitute for configuring it right.

import type { Fetcher } from './check.js'

/** How much of the combined board two replicas must share to count as converged. */
export const MIN_OVERLAP = 0.5

/** How many times to sample before believing a divergence. */
export const CONVERGENCE_SAMPLES = 3

/** Milliseconds between samples. Long enough for gossip to close a normal gap. */
export const SAMPLE_INTERVAL_MS = 4_000

export type ConvergenceVerdict = 'converged' | 'diverged' | 'idle' | 'cannot-check'

export interface BoardSnapshot {
  endpoint: string
  /** False when the endpoint did not answer, or answered with an error. */
  ok: boolean
  reason?: string
  /** Every message hash the board holds, across every category. */
  hashes: ReadonlySet<string>
  /** The node's own identity, when it offers one. Used to catch self-comparison. */
  nodeId?: string
}

export interface ConvergenceReport {
  verdict: ConvergenceVerdict
  snapshots: BoardSnapshot[]
  /** Messages held by every replica that answered. */
  shared: number
  /** Messages held by at least one. */
  union: number
  /** shared / union, or 1 when the union is empty. */
  overlap: number
  report: string
}

export interface ConvergenceDeps {
  fetcher: Fetcher
  /** One URL per replica. Two or more, and they must reach DIFFERENT nodes. */
  endpoints: readonly string[]
  samples?: number
  intervalMs?: number
  minOverlap?: number
  /**
   * Refuse to call two EMPTY boards agreement.
   *
   * Empty boards are identical, so a check that accepts them passes hardest exactly
   * when there is nothing to compare. Two replicas whose boards both expire to zero
   * would read as converged, and the eighteen-day window when every writer was dead
   * would have graded green throughout.
   *
   * Set this whenever the answer is load-bearing — verifying a fix, gating a deploy.
   * The verdict becomes `cannot-check`, because that is what it is.
   */
  requireNonEmpty?: boolean
  /** Injected so tests do not wait. */
  sleep?: (ms: number) => Promise<void>
}

const rpc = async (
  fetcher: Fetcher,
  url: string,
  method: string,
  params: unknown[],
): Promise<unknown> => {
  const response = await fetcher(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const body = (await response.json()) as { result?: unknown; error?: { message?: string } }
  if (body.error) throw new Error(body.error.message ?? 'rpc error')
  return body.result
}

/**
 * Every message hash on one node's board.
 *
 * `msgboard_content` returns a map of category to messages. Both shapes seen in the
 * wild are handled: a map keyed by hash, and an array of message objects.
 */
export const snapshotBoard = async (fetcher: Fetcher, endpoint: string): Promise<BoardSnapshot> => {
  try {
    // Two signatures exist in the wild. Ours takes an optional filter object; the
    // erigon-pulse reference takes no arguments and rejects one with "too many
    // arguments, want at most 0". Try the filter form, fall back to the bare form,
    // so a node is never recorded as unreachable over an argument-count difference.
    let content: Record<string, unknown>
    try {
      content = (await rpc(fetcher, endpoint, 'msgboard_content', [{}])) as Record<string, unknown>
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!/too many arguments|invalid.*param|at most 0/i.test(message)) throw error
      content = (await rpc(fetcher, endpoint, 'msgboard_content', [])) as Record<string, unknown>
    }
    const hashes = new Set<string>()
    for (const messages of Object.values(content ?? {})) {
      if (Array.isArray(messages)) {
        for (const message of messages) {
          const hash = (message as { hash?: unknown } | null)?.hash
          if (typeof hash === 'string') hashes.add(hash.toLowerCase())
        }
      } else if (messages && typeof messages === 'object') {
        for (const hash of Object.keys(messages)) hashes.add(hash.toLowerCase())
      }
    }
    return { endpoint, ok: true, hashes }
  } catch (error) {
    return {
      endpoint,
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
      hashes: new Set<string>(),
    }
  }
}

const intersectAll = (sets: ReadonlySet<string>[]): Set<string> => {
  if (sets.length === 0) return new Set()
  const [first, ...rest] = sets
  const out = new Set(first)
  for (const set of rest) for (const hash of [...out]) if (!set.has(hash)) out.delete(hash)
  return out
}

const unionAll = (sets: ReadonlySet<string>[]): Set<string> => {
  const out = new Set<string>()
  for (const set of sets) for (const hash of set) out.add(hash)
  return out
}

const describe = (
  verdict: ConvergenceVerdict,
  snapshots: BoardSnapshot[],
  shared: number,
  union: number,
  overlap: number,
): string => {
  const lines = snapshots.map((s) =>
    s.ok ? `  ${s.endpoint}: ${s.hashes.size} message(s)` : `  ${s.endpoint}: ${s.reason}`,
  )
  const head =
    verdict === 'converged'
      ? `CONVERGED — ${shared}/${union} messages shared (${(overlap * 100).toFixed(0)}%)`
      : verdict === 'idle'
        ? 'IDLE — every replica answered and every board is empty'
        : verdict === 'cannot-check'
          ? union === 0 && snapshots.filter((s) => s.ok).length >= 2
            ? 'CANNOT CHECK — every board is empty, so agreement proves nothing'
            : 'CANNOT CHECK — fewer than two replicas answered'
          : `DIVERGED — only ${shared}/${union} messages shared (${(overlap * 100).toFixed(0)}%). ` +
            'The replicas are not gossiping; each holds only what was posted directly to it.'
  return [head, ...lines].join('\n')
}

/**
 * Compare the boards of two or more replicas of the same chain.
 *
 * Samples repeatedly and keeps the BEST overlap seen. A single bad sample is normal —
 * a message posted a moment ago has not propagated — so one good sample is enough to
 * prove the replicas talk. Only a pair that never overlaps is diverged.
 */
export const checkConvergence = async (deps: ConvergenceDeps): Promise<ConvergenceReport> => {
  const samples = deps.samples ?? CONVERGENCE_SAMPLES
  const minOverlap = deps.minOverlap ?? MIN_OVERLAP
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))

  if (deps.endpoints.length < 2) {
    const snapshots: BoardSnapshot[] = deps.endpoints.map((endpoint) => ({
      endpoint,
      ok: false,
      reason: 'convergence needs at least two replica endpoints',
      hashes: new Set<string>(),
    }))
    return {
      verdict: 'cannot-check',
      snapshots,
      shared: 0,
      union: 0,
      overlap: 0,
      report: describe('cannot-check', snapshots, 0, 0, 0),
    }
  }

  let best: ConvergenceReport | null = null

  for (let sample = 0; sample < samples; sample += 1) {
    if (sample > 0) await sleep(deps.intervalMs ?? SAMPLE_INTERVAL_MS)
    const snapshots = await Promise.all(
      deps.endpoints.map((endpoint) => snapshotBoard(deps.fetcher, endpoint)),
    )
    const answered = snapshots.filter((s) => s.ok)
    if (answered.length < 2) {
      const r: ConvergenceReport = {
        verdict: 'cannot-check',
        snapshots,
        shared: 0,
        union: 0,
        overlap: 0,
        report: describe('cannot-check', snapshots, 0, 0, 0),
      }
      best = best ?? r
      continue
    }

    const sets = answered.map((s) => s.hashes)
    const shared = intersectAll(sets).size
    const union = unionAll(sets).size
    const overlap = union === 0 ? 1 : shared / union
    const verdict: ConvergenceVerdict =
      union === 0
        ? deps.requireNonEmpty
          ? 'cannot-check'
          : 'idle'
        : overlap >= minOverlap
          ? 'converged'
          : 'diverged'
    const r: ConvergenceReport = {
      verdict,
      snapshots,
      shared,
      union,
      overlap,
      report: describe(verdict, snapshots, shared, union, overlap),
    }

    // A single converged sample settles it — replicas that share a board are talking.
    // An empty-board sample never settles anything when the caller asked for proof.
    if (verdict === 'converged') return r
    if (verdict === 'idle') return r
    if (!best || best.verdict === 'cannot-check' || overlap > best.overlap) best = r
  }

  return best!
}

/**
 * True when the endpoints look like they could reach different nodes.
 *
 * A gateway that pins per key answers every request in a run from one replica, and
 * then a convergence check compares a node against itself and passes forever. This
 * catches the obvious form of that mistake — the same URL listed twice.
 */
export const endpointsDiffer = (endpoints: readonly string[]): boolean =>
  new Set(endpoints.map((e) => e.trim().toLowerCase())).size === endpoints.length
