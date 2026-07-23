/** Format a millisecond duration for humans: `< 1000ms` shows `123ms`, else seconds (`1.23s`). */
export const fmtMs = (ms?: number): string => {
  if (ms === undefined || !Number.isFinite(ms)) return '—'
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`
}

/**
 * Presentation-only per-round timing breakdown (decision · network · total).
 *
 * Renders a compact inline span like `decision 1.2s · network 0.3s · total 1.5s`, omitting any
 * undefined sub-span; renders nothing if every span is undefined. In the in-process driver these
 * deltas are often 0 (the four marks fire ~µs apart) — real delays come from the bot fleet / a real
 * transport. No hooks, no state.
 */
export const TurnTiming = ({
  timing,
  label = 'timing',
}: {
  timing?: { decisionMs?: number; networkMs?: number; totalMs?: number }
  label?: string
}) => {
  if (!timing) return null
  const parts: string[] = []
  if (timing.decisionMs !== undefined) parts.push(`decision ${fmtMs(timing.decisionMs)}`)
  if (timing.networkMs !== undefined) parts.push(`network ${fmtMs(timing.networkMs)}`)
  if (timing.totalMs !== undefined) parts.push(`total ${fmtMs(timing.totalMs)}`)
  if (parts.length === 0) return null

  return (
    <span>
      {label} <span className="mono">{parts.join(' · ')}</span>
    </span>
  )
}

/** One phase boundary of an on-chain round: a human label and the block it landed in (if it has). */
export type RoundPhase = { label: string; block?: bigint }

/**
 * Gross on-chain round timing from BLOCK TIMESTAMPS. On-chain we can only see wall-clock per phase
 * boundary (block timestamps can't separate decision vs network), so this reports the whole-round
 * total plus the delta between each pair of CONSECUTIVE LANDED phases — never interpolating across a
 * phase whose block hasn't landed yet.
 *
 * `timestamps` are unix SECONDS keyed by block number (string); deltas are computed in seconds then
 * surfaced as ms for `fmtMs`. Returns null if fewer than two phases have landed (nothing to time).
 */
export const computeRoundTiming = (
  phases: RoundPhase[],
  timestamps: Record<string, number>,
): { totalMs: number; deltas: { label: string; ms: number }[] } | null => {
  const landed = phases
    .map((p) => ({ label: p.label, ts: p.block !== undefined ? timestamps[p.block.toString()] : undefined }))
    .filter((p): p is { label: string; ts: number } => p.ts !== undefined)
  if (landed.length < 2) return null

  const deltas: { label: string; ms: number }[] = []
  for (let i = 1; i < landed.length; i++) {
    const prev = landed[i - 1]!
    const cur = landed[i]!
    deltas.push({ label: `${prev.label}→${cur.label}`, ms: (cur.ts - prev.ts) * 1000 })
  }
  const first = landed[0]!
  const last = landed[landed.length - 1]!
  const totalMs = (last.ts - first.ts) * 1000
  return { totalMs, deltas }
}

/**
 * Presentation-only GROSS round timing for the on-chain games (Coinflip / Raffle). Renders a compact
 * `<totalLabel> in 24s · commit→reveal 12s · reveal→settle 12s` line; omits any phase delta whose
 * block hasn't landed yet, and renders nothing when fewer than two phases have landed.
 */
export const RoundTiming = ({
  phases,
  timestamps,
  totalLabel,
}: {
  phases: RoundPhase[]
  timestamps: Record<string, number>
  totalLabel: string
}) => {
  const timing = computeRoundTiming(phases, timestamps)
  if (!timing) return null
  const parts = [`${totalLabel} in ${fmtMs(timing.totalMs)}`, ...timing.deltas.map((d) => `${d.label} ${fmtMs(d.ms)}`)]
  return (
    <div className="card-meta muted">
      <span className="mono">{parts.join(' · ')}</span>
    </div>
  )
}
