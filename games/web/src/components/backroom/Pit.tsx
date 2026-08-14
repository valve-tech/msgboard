import type { Address, Hex } from 'viem'
import type { GameDeployment } from '../../config'
import type { PitRound } from '../../lib/backroomIndex'
import { AddressLink } from '../Meta'
import { blocksSince, fmtToken, Lamp, STALE_BLOCKS } from './shared'

const SIDE_LABEL: Record<number, string> = { 0: 'heads', 1: 'tails' }

/**
 * 4.3 The pit (SAFE-PRE by construction) — the security-camera wall. One row per `PitRound`: table,
 * player, side, stake, payout, exposure, tierPrice, age in blocks with a countdown to `STALE_BLOCKS`,
 * and a status lamp.
 *
 * THIS COMPONENT RENDERS STRICTLY FROM `PitRound` (spec §5). The type carries no `seed`/`won`/
 * `validators`/reveal field, so there is nothing here to accidentally surface — a leak would be a
 * TypeScript compile error, not a runtime bug. Do not import anything else round-shaped into this file.
 *
 * A row's lamp is always `pending`: a round in `pit` is, by construction of `reduceBackroom`, one whose
 * seed has NOT finalized yet (rounds leave `pit` the instant `seedFinalized(roundId)` is true — spec §5
 * rule 3). So "decided — settling" is never a state an individual pit ROW can be in; it's what happened
 * to a row that just disappeared. `decidedUnsettled` (a count, not round detail — see useBackroomData)
 * reports that as a pinned line instead of a per-row transition, which keeps the boundary honest: the
 * pit never claims to know which specific round decided, only how many did.
 */
export const Pit = ({
  deployment,
  pit,
  lastBlock,
  decidedUnsettled,
  tableTokens,
}: {
  deployment: GameDeployment
  pit: PitRound[]
  lastBlock: bigint
  decidedUnsettled: number
  tableTokens: Map<Hex, Address>
}) => (
  <div className="card">
    <h3>The pit</h3>
    {decidedUnsettled > 0 && (
      <p className="row">
        <Lamp state="settling" />
        <span>
          {decidedUnsettled} round{decidedUnsettled === 1 ? '' : 's'} decided — settling (irreversible; terminal event
          not yet posted)
        </span>
      </p>
    )}
    {pit.length === 0 ? (
      <p className="muted">No rounds in flight.</p>
    ) : (
      <table>
        <thead>
          <tr>
            <th className="muted">table</th>
            <th className="muted">player</th>
            <th className="muted">side</th>
            <th className="muted">stake</th>
            <th className="muted">payout</th>
            <th className="muted">exposure</th>
            <th className="muted">tier price</th>
            <th className="muted">age</th>
            <th className="muted">status</th>
          </tr>
        </thead>
        <tbody>
          {pit.map((r) => {
            const token = tableTokens.get(r.tableId) ?? ('0x' as Address)
            const age = blocksSince(lastBlock, r.openedAtBlock)
            const remaining = STALE_BLOCKS - age
            const stale = remaining <= 0n
            const exposure = r.payout - r.stake
            return (
              <tr key={r.roundId}>
                <td className="mono muted">{r.tableId.slice(0, 10)}…</td>
                <td className="mono">
                  <AddressLink deployment={deployment} address={r.player} />
                </td>
                <td>{SIDE_LABEL[r.side] ?? `side ${r.side}`}</td>
                <td className="mono">{fmtToken(deployment, token, r.stake)}</td>
                <td className="mono">{fmtToken(deployment, token, r.payout)}</td>
                <td className="mono">{fmtToken(deployment, token, exposure)}</td>
                <td className="mono">{fmtToken(deployment, token, r.tierPrice)}</td>
                <td className={`mono${stale ? ' bad' : ''}`}>
                  {age.toString()} blocks{stale ? ' — STALE (no seed)' : ` (stale in ${remaining.toString()})`}
                </td>
                <td>
                  <Lamp state="pending" />
                  <span className="muted"> pending</span>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    )}
  </div>
)
