import * as viem from 'viem'
import type { GameDeployment } from '../../config'
import type { OperatorTableView, Treasury } from '../../lib/backroomIndex'
import { AddressLink } from '../Meta'
import { available, blocksSince, fmtMult, fmtToken, tokenLabel } from './shared'

/**
 * 4.1 Floor overview (SAFE-PRE) — a grid of table tiles: token, open/closed, stake ladder, multiplier,
 * cap, locked, headroom, in-flight count, policy summary, last-activity age. Every field here comes
 * straight off `TableCreated`/`OpenSet`/`TableCapSet`/`ValidatorPolicySet` plus the live `tableCap`/
 * `tableLocked`/`tables` views — none of it is a function of any round's outcome.
 */
export const FloorOverview = ({
  deployment,
  tables,
  treasury,
  lastBlock,
}: {
  deployment: GameDeployment
  tables: OperatorTableView[]
  treasury: Treasury[]
  lastBlock: bigint
}) => {
  if (tables.length === 0) {
    return (
      <div className="card">
        <h3>Floor</h3>
        <p className="muted">No tables yet for this operator. Open one with `operator-ops.ts` to see it here.</p>
      </div>
    )
  }

  const bankrollOf = new Map(treasury.map((t) => [t.token.toLowerCase(), t.bankroll]))

  return (
    <div className="card">
      <h3>Floor</h3>
      <div className="brm-grid">
        {tables.map((t) => {
          const bankroll = bankrollOf.get(t.token.toLowerCase()) ?? 0n
          const headroom = available(t.cap, t.locked, bankroll)
          const age = blocksSince(lastBlock, t.lastActiveBlock)
          const hasPolicy = t.validatorPolicy && t.validatorPolicy !== viem.zeroAddress
          return (
            <div className="brm-tile" key={t.tableId}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span className={t.open ? 'tag ok' : 'tag'}>{t.open ? 'open' : 'closed'}</span>
                <span className="tag gold">{tokenLabel(deployment, t.token)}</span>
              </div>
              <p className="mono muted card-meta" style={{ margin: '0.4rem 0' }}>
                {t.tableId.slice(0, 10)}…{t.tableId.slice(-6)}
              </p>
              <table>
                <tbody>
                  <tr>
                    <td className="muted">stake ladder</td>
                    <td className="mono">
                      {fmtToken(deployment, t.token, t.minStake)} – {fmtToken(deployment, t.token, t.maxStake)}
                    </td>
                  </tr>
                  <tr>
                    <td className="muted">multiplier</td>
                    <td className="mono">{fmtMult(t.maxMultiplierX100)}</td>
                  </tr>
                  <tr>
                    <td className="muted">cap</td>
                    <td className="mono">{t.cap === 0n ? '∞' : fmtToken(deployment, t.token, t.cap)}</td>
                  </tr>
                  <tr>
                    <td className="muted">locked</td>
                    <td className="mono">{fmtToken(deployment, t.token, t.locked)}</td>
                  </tr>
                  <tr>
                    <td className="muted">headroom</td>
                    <td className="mono ok">{fmtToken(deployment, t.token, headroom)}</td>
                  </tr>
                  <tr>
                    <td className="muted">in flight</td>
                    <td className="mono">{t.inFlight}</td>
                  </tr>
                  <tr>
                    <td className="muted">policy</td>
                    <td className="mono">
                      {hasPolicy ? <AddressLink deployment={deployment} address={t.validatorPolicy!} /> : 'floor only'}
                    </td>
                  </tr>
                  <tr>
                    <td className="muted">last active</td>
                    <td className="mono">{age.toString()} blocks ago</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )
        })}
      </div>
    </div>
  )
}
