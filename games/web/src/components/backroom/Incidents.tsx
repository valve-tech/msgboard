import type { GameDeployment } from '../../config'
import type { OperatorTableView, PitRound, TapeEntry } from '../../lib/backroomIndex'
import { blocksSince, fmtToken, STALE_BLOCKS } from './shared'

type TableIncidents = {
  tableId: `0x${string}`
  token: `0x${string}`
  forfeitCount: number
  forfeitVolume: bigint
  chopRoutedRefunds: number
  plainTimeoutRefunds: number
  staleNoSeed: number
}

/**
 * 4.6 Incident panel (POST-ONLY) — per table: forfeit count + volume, plain-timeout vs chop-routed
 * refunds, rounds past stale with no seed. All-time (not windowed) — see `PnL` for a windowed view of
 * the same tape. Per-validator abort attribution deferred (spec C5: needs the `open()` calldata subset
 * decode, not shipped in v1).
 */
export const computeIncidents = (tables: OperatorTableView[], tape: TapeEntry[], pit: PitRound[], lastBlock: bigint): TableIncidents[] => {
  const forfeitedRoundIds = new Set(tape.filter((e) => e.kind === 'forfeit').map((e) => e.roundId))
  const rows = new Map<`0x${string}`, TableIncidents>()
  const row = (t: OperatorTableView) => {
    let r = rows.get(t.tableId)
    if (!r) {
      r = { tableId: t.tableId, token: t.token, forfeitCount: 0, forfeitVolume: 0n, chopRoutedRefunds: 0, plainTimeoutRefunds: 0, staleNoSeed: 0 }
      rows.set(t.tableId, r)
    }
    return r
  }
  for (const t of tables) row(t)

  for (const e of tape) {
    const r = rows.get(e.tableId)
    if (!r) continue
    if (e.kind === 'forfeit') {
      r.forfeitCount += 1
      r.forfeitVolume += e.forfeit ?? 0n
    } else if (e.kind === 'refunded') {
      if (forfeitedRoundIds.has(e.roundId)) r.chopRoutedRefunds += 1
      else r.plainTimeoutRefunds += 1
    }
  }
  for (const r of pit) {
    const row2 = rows.get(r.tableId)
    if (row2 && blocksSince(lastBlock, r.openedAtBlock) >= STALE_BLOCKS) row2.staleNoSeed += 1
  }

  return [...rows.values()].filter((r) => r.forfeitCount > 0 || r.chopRoutedRefunds > 0 || r.plainTimeoutRefunds > 0 || r.staleNoSeed > 0)
}

export const Incidents = ({
  deployment,
  tables,
  tape,
  pit,
  lastBlock,
}: {
  deployment: GameDeployment
  tables: OperatorTableView[]
  tape: TapeEntry[]
  pit: PitRound[]
  lastBlock: bigint
}) => {
  const rows = computeIncidents(tables, tape, pit, lastBlock)
  return (
    <div className="card">
      <h3>Incidents</h3>
      {rows.length === 0 ? (
        <p className="muted">No forfeits, chop-routed refunds, or stale rounds recorded.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th className="muted">table</th>
              <th className="muted">forfeits</th>
              <th className="muted">forfeit volume</th>
              <th className="muted">chop-routed refunds</th>
              <th className="muted">plain-timeout refunds</th>
              <th className="muted">stale, no seed (now)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.tableId}>
                <td className="mono muted">{r.tableId.slice(0, 10)}…</td>
                <td className="mono">{r.forfeitCount}</td>
                <td className="mono">{fmtToken(deployment, r.token, r.forfeitVolume)}</td>
                <td className="mono">{r.chopRoutedRefunds}</td>
                <td className="mono">{r.plainTimeoutRefunds}</td>
                <td className={`mono${r.staleNoSeed > 0 ? ' bad' : ''}`}>{r.staleNoSeed}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="card-meta muted">
        Policy-change history and per-validator abort attribution aren't surfaced yet — the former needs the raw
        event log this dashboard doesn't retain past its current-value projection, the latter needs the `open()`
        calldata subset decode (spec C5), deferred to a fast-follow.
      </p>
    </div>
  )
}
