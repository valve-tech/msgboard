import type { GameDeployment } from '../../config'
import type { OperatorTableView, PitRound, TapeEntry, Treasury } from '../../lib/backroomIndex'
import type { Reconciliation as ReconciliationData } from '../../hooks/useBackroomData'
import { fmtToken, tokenLabel } from './shared'

/**
 * A single reconciliation figure's verdict. Pure and total: any nonzero delta is `'drift'`, full stop.
 * Nothing here ever rounds, clamps, or "corrects" a delta toward either source (spec §4.8 "the reducer
 * never silently corrects toward either source" — this is that rule at the render layer).
 */
export const rowStatus = (delta: bigint): 'ok' | 'drift' => (delta === 0n ? 'ok' : 'drift')

const Tick = ({ delta }: { delta: bigint }) =>
  rowStatus(delta) === 'ok' ? (
    <span className="tag ok">✓ reconciled</span>
  ) : (
    <span className="tag bad" style={{ borderColor: 'var(--bad)' }}>
      ⚠ drift {delta > 0n ? '+' : ''}
      {delta.toString()} wei
    </span>
  )

/**
 * 4.8 Reconciliation strip (SAFE-PRE) — the security room watching itself. Event-derived `tableLocked`
 * vs the view; event-derived escrow ledger vs `bankrollOf + lockedOf + rakeOf`; `Random.balanceOf`
 * (this game's whole fee custody) vs Σ `feeBalance` (this operator's slice); indexer head vs RPC head.
 * Green ticks or a loud amber drift badge — a disagreement is DISPLAYED, never silently corrected.
 */
export const Reconciliation = ({
  deployment,
  reconciliation,
  tables,
  pit,
  tape,
  treasury,
  status,
}: {
  deployment: GameDeployment
  reconciliation: ReconciliationData
  tables: OperatorTableView[]
  pit: PitRound[]
  tape: TapeEntry[]
  treasury: Treasury[]
  status: 'live' | 'degraded' | 'loading'
}) => {
  const noActivity = tables.length === 0 && pit.length === 0 && tape.length === 0 && treasury.every((t) => t.bankroll === 0n && t.fees === 0n)

  return (
    <div className="card">
      <h3>Reconciliation</h3>

      {status === 'degraded' && (
        <div className="banner">degraded — reading the chain directly (last known block {reconciliation.rpcHead.toString()})</div>
      )}

      {noActivity && (
        <div className="banner">
          No on-chain activity found for this address on {deployment.label}. If it isn't registered yet, run{' '}
          <span className="mono">operator-ops.ts register</span> and deposit a bankroll + fee pool before opening a
          table.
        </div>
      )}

      <table>
        <thead>
          <tr>
            <th className="muted">check</th>
            <th className="muted">event-derived</th>
            <th className="muted">view / live</th>
            <th className="muted">status</th>
          </tr>
        </thead>
        <tbody>
          {reconciliation.tables.map((t) => (
            <tr key={t.tableId}>
              <td className="mono muted">tableLocked — {t.tableId.slice(0, 10)}…</td>
              <td className="mono">{t.eventLocked.toString()}</td>
              <td className="mono">{t.viewLocked.toString()}</td>
              <td>
                <Tick delta={t.delta} />
              </td>
            </tr>
          ))}
          {reconciliation.tokens.map((tr) => (
            <tr key={`ledger-${tr.token}`}>
              <td className="mono muted">escrow ledger — {tokenLabel(deployment, tr.token)}</td>
              <td className="mono">{fmtToken(deployment, tr.token, tr.eventLedger)}</td>
              <td className="mono">{fmtToken(deployment, tr.token, tr.viewLedger)}</td>
              <td>
                <Tick delta={tr.ledgerDelta} />
              </td>
            </tr>
          ))}
          {reconciliation.tokens.map((tr) => (
            <tr key={`fee-${tr.token}`}>
              <td className="mono muted">Random custody vs feeBalance — {tokenLabel(deployment, tr.token)}</td>
              <td className="mono">{fmtToken(deployment, tr.token, tr.randomBalance)}</td>
              <td className="mono">{fmtToken(deployment, tr.token, tr.feeBalance)}</td>
              <td>
                {tr.feeDelta === 0n ? (
                  <span className="tag ok">✓ reconciled</span>
                ) : (
                  <span className="tag gold" title="Random.balanceOf is the WHOLE game's custody; a nonzero gap is expected once other operators share this token.">
                    Δ {tr.feeDelta > 0n ? '+' : ''}
                    {tr.feeDelta.toString()} wei (scope note, not necessarily drift)
                  </span>
                )}
              </td>
            </tr>
          ))}
          <tr>
            <td className="mono muted">indexer head vs RPC head</td>
            <td className="mono">{reconciliation.indexerHead === null ? 'n/a — no indexer configured' : reconciliation.indexerHead.toString()}</td>
            <td className="mono">{reconciliation.rpcHead.toString()}</td>
            <td>
              {reconciliation.headDelta === null ? (
                <span className="tag">n/a</span>
              ) : (
                <Tick delta={reconciliation.headDelta} />
              )}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}
