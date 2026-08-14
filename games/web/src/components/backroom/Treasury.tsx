import type { GameDeployment } from '../../config'
import type { PitRound, Treasury as TreasuryRow, TreasuryEvent } from '../../lib/backroomIndex'
import { fmtToken, tokenLabel, topTierPrice } from './shared'

const KIND_LABEL: Record<TreasuryEvent['kind'], string> = { deposit: 'deposit', withdraw: 'withdraw', rake: 'rake pull' }
const KIND_TAG: Record<TreasuryEvent['kind'], string> = { deposit: 'tag ok', withdraw: 'tag', rake: 'tag gold' }

/**
 * 4.2 Bankroll & treasury (SAFE-PRE) — per (operator, token): bankroll ("idle / withdrawable"), locked
 * ("escrowed payouts — includes player stakes"), rake, feeBalance, a deposit/withdraw/rake history
 * lane, and a "rounds of fee runway" estimate.
 */
export const Treasury = ({
  deployment,
  treasury,
  treasuryHistory,
  pit,
  tableTokens,
}: {
  deployment: GameDeployment
  treasury: TreasuryRow[]
  treasuryHistory: TreasuryEvent[]
  pit: PitRound[]
  /** tableId -> token, so the fee-runway estimate can find "this token's" in-flight tierPrices. */
  tableTokens: Map<`0x${string}`, `0x${string}`>
}) => {
  if (treasury.length === 0) {
    return (
      <div className="card">
        <h3>Treasury</h3>
        <p className="muted">No bankroll activity found for this operator yet.</p>
      </div>
    )
  }

  return (
    <div className="card">
      <h3>Treasury</h3>
      <table>
        <thead>
          <tr>
            <th className="muted">token</th>
            <th className="muted">bankroll (idle / withdrawable)</th>
            <th className="muted">locked (escrowed payouts — incl. player stakes)</th>
            <th className="muted">rake</th>
            <th className="muted">fee pool</th>
            <th className="muted">fee runway</th>
          </tr>
        </thead>
        <tbody>
          {treasury.map((t) => {
            const tablesForToken = new Set([...tableTokens.entries()].filter(([, tok]) => tok === t.token).map(([id]) => id))
            const top = topTierPrice(pit, tablesForToken)
            const runwayRounds = top && top > 0n ? t.fees / (3n * top) : null
            return (
              <tr key={t.token}>
                <td className="tag gold">{tokenLabel(deployment, t.token)}</td>
                <td className="mono ok">{fmtToken(deployment, t.token, t.bankroll)}</td>
                <td className="mono">{fmtToken(deployment, t.token, t.locked)}</td>
                <td className="mono">{fmtToken(deployment, t.token, t.rake)}</td>
                <td className={`mono${t.fees === 0n ? ' bad' : ''}`}>{fmtToken(deployment, t.token, t.fees)}</td>
                <td className="mono muted">{runwayRounds === null ? 'n/a (no in-flight rounds to estimate from)' : `~${runwayRounds.toString()} rounds`}</td>
              </tr>
            )
          })}
        </tbody>
      </table>

      <details className="history">
        <summary>
          Deposit / withdraw / rake history
          <span className="history-hint muted">{treasuryHistory.length} entries</span>
        </summary>
        {treasuryHistory.length === 0 ? (
          <p className="muted">No bankroll movements recorded yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th className="muted">kind</th>
                <th className="muted">token</th>
                <th className="muted">amount</th>
                <th className="muted">block</th>
              </tr>
            </thead>
            <tbody>
              {treasuryHistory.slice(0, 100).map((h, i) => (
                <tr key={`${h.blockNumber}-${i}`}>
                  <td>
                    <span className={KIND_TAG[h.kind]}>{KIND_LABEL[h.kind]}</span>
                  </td>
                  <td className="mono">{tokenLabel(deployment, h.token)}</td>
                  <td className="mono">{fmtToken(deployment, h.token, h.amount)}</td>
                  <td className="mono muted">{h.blockNumber.toString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </details>
    </div>
  )
}
