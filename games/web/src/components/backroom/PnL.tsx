import { useState } from 'react'
import type { Address, Hex } from 'viem'
import type { GameDeployment } from '../../config'
import type { TapeEntry, Treasury } from '../../lib/backroomIndex'
import { Menu } from '../Menu'
import { fmtToken, tokenLabel } from './shared'

const WINDOWS: { label: string; blocks: bigint | null }[] = [
  { label: 'Last 1,000 blocks', blocks: 1_000n },
  { label: 'Last 10,000 blocks', blocks: 10_000n },
  { label: 'All time', blocks: null },
]

type TokenPnL = {
  token: Address
  winCount: number
  winPayout: bigint
  lossCount: number
  lossStake: bigint
  forfeitIncome: bigint
  /** Settled rounds counted for `winCount`/`lossCount` but excluded from the net figure below because
   *  the tape entry's `stake` wasn't populated (an accumulated-cache row from before this dashboard
   *  build started attaching it). Net P&L is honest about what it could and couldn't price. */
  unpriced: number
  net: bigint
}

/**
 * Windowed per-token operator P&L, computed from `won ? -(payout - stake) : +stake` per settled round
 * (EscrowLib semantics: a win costs the house its locked exposure, a loss keeps the stake) plus forfeit
 * income (`ForfeitRouted` routes the slashed tierPrice into the operator's own bankroll — spec C1).
 * Refunds are P&L-neutral (the stake just goes back) and excluded.
 *
 * `TapeEntry` has no `token` field, so this is computed against ONE token's slice of the tape at a
 * time — the caller resolves tableId -> token first (same pattern as Pit/Tape/Incidents).
 */
export const computeTokenPnL = (token: Address, entries: TapeEntry[], lastBlock: bigint, windowBlocks: bigint | null): TokenPnL => {
  const floor = windowBlocks === null ? -1n : lastBlock - windowBlocks
  const r: TokenPnL = { token, winCount: 0, winPayout: 0n, lossCount: 0, lossStake: 0n, forfeitIncome: 0n, unpriced: 0, net: 0n }
  for (const e of entries) {
    if (e.blockNumber <= floor) continue
    if (e.kind === 'settled') {
      if (e.won) {
        r.winCount += 1
        r.winPayout += e.payout ?? 0n
        if (e.stake !== undefined) r.net -= (e.payout ?? 0n) - e.stake
        else r.unpriced += 1
      } else {
        r.lossCount += 1
        if (e.stake !== undefined) {
          r.lossStake += e.stake
          r.net += e.stake
        } else {
          r.unpriced += 1
        }
      }
    } else if (e.kind === 'forfeit') {
      r.forfeitIncome += e.forfeit ?? 0n
      r.net += e.forfeit ?? 0n
    }
  }
  return r
}

/**
 * 4.7 P&L and rake (POST-ONLY) — win/loss volume, rake accrued, forfeit income, net operator P&L per
 * token over a selectable window.
 */
export const PnL = ({
  deployment,
  tape,
  treasury,
  tableTokens,
  lastBlock,
}: {
  deployment: GameDeployment
  tape: TapeEntry[]
  treasury: Treasury[]
  tableTokens: Map<Hex, Address>
  lastBlock: bigint
}) => {
  const [windowIdx, setWindowIdx] = useState(2) // default "All time"
  const windowBlocks = WINDOWS[windowIdx]?.blocks ?? null

  const byToken = new Map<Address, TapeEntry[]>()
  for (const e of tape) {
    const token = tableTokens.get(e.tableId)
    if (!token) continue
    byToken.set(token, [...(byToken.get(token) ?? []), e])
  }
  const rows = [...byToken.entries()].map(([token, entries]) => computeTokenPnL(token, entries, lastBlock, windowBlocks))

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h3>P&amp;L</h3>
        <Menu label="window" options={WINDOWS.map((w) => w.label)} value={windowIdx} onChange={setWindowIdx} />
      </div>
      {rows.length === 0 ? (
        <p className="muted">No settlements in this window.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th className="muted">token</th>
              <th className="muted">wins (paid out)</th>
              <th className="muted">losses (kept)</th>
              <th className="muted">forfeit income</th>
              <th className="muted">rake (current balance)</th>
              <th className="muted">net (approx.)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const rake = treasury.find((t) => t.token === r.token)?.rake ?? 0n
              return (
                <tr key={r.token}>
                  <td className="tag gold">{tokenLabel(deployment, r.token)}</td>
                  <td className="mono">
                    {r.winCount} · {fmtToken(deployment, r.token, r.winPayout)}
                  </td>
                  <td className="mono">
                    {r.lossCount} · {fmtToken(deployment, r.token, r.lossStake)}
                  </td>
                  <td className="mono">{fmtToken(deployment, r.token, r.forfeitIncome)}</td>
                  <td className="mono muted">{fmtToken(deployment, r.token, rake)}</td>
                  <td className={`mono${r.net >= 0n ? ' ok' : ' bad'}`}>{fmtToken(deployment, r.token, r.net)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
      <p className="card-meta muted">
        Net is a settle-level approximation (win payout minus locked exposure, loss keeps the stake, plus forfeit
        income); refunds are P&amp;L-neutral and excluded. Rake is the current running balance, not a per-window
        flow — it only falls when withdrawn.
      </p>
    </div>
  )
}
