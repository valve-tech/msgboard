import { useState } from 'react'
import type { Address, Hex } from 'viem'
import type { GameDeployment } from '../../config'
import type { TapeEntry } from '../../lib/backroomIndex'
import { fmtToken } from './shared'

const KIND_TAG: Record<TapeEntry['kind'], string> = { settled: 'tag ok', refunded: 'tag', forfeit: 'tag' }
const PAGE = 25

/**
 * 4.4 Settlement tape (POST-ONLY) — a live feed of terminal events: settled (won/lost, payout, seed),
 * refunded, forfeit. Newest first. Full detail is fine here — a round on the tape is already decided
 * and irreversible (spec §5 rule 4).
 *
 * Paged client-side over the hook's accumulate-only cache (`useBackroomData` never truncates the
 * array it hands back — same convention as `useChainData`), rather than a server cursor: there is no
 * paginated tape endpoint to page against, only the in-memory accumulated log.
 */
export const Tape = ({ deployment, tape, tableTokens }: { deployment: GameDeployment; tape: TapeEntry[]; tableTokens: Map<Hex, Address> }) => {
  const [shown, setShown] = useState(PAGE)
  const sorted = [...tape].sort((a, b) => (a.blockNumber > b.blockNumber ? -1 : a.blockNumber < b.blockNumber ? 1 : 0))
  const page = sorted.slice(0, shown)

  return (
    <div className="card">
      <h3>Settlement tape</h3>
      {sorted.length === 0 ? (
        <p className="muted">No settlements yet.</p>
      ) : (
        <>
          <table>
            <thead>
              <tr>
                <th className="muted">kind</th>
                <th className="muted">table</th>
                <th className="muted">round</th>
                <th className="muted">detail</th>
                <th className="muted">block</th>
              </tr>
            </thead>
            <tbody>
              {page.map((e, i) => {
                const token = tableTokens.get(e.tableId) ?? ('0x' as Address)
                return (
                  <tr key={`${e.roundId}-${e.kind}-${i}`}>
                    <td>
                      <span className={KIND_TAG[e.kind]}>{e.kind}</span>
                    </td>
                    <td className="mono muted">{e.tableId.slice(0, 10)}…</td>
                    <td className="mono muted">{e.roundId.slice(0, 10)}…</td>
                    <td className="mono">
                      {e.kind === 'settled' && (
                        <>
                          <span className={e.won ? 'ok' : 'bad'}>{e.won ? 'won' : 'lost'}</span>
                          {' · '}
                          {e.stake !== undefined && <>stake {fmtToken(deployment, token, e.stake)} · </>}
                          {e.payout !== undefined && <>payout {fmtToken(deployment, token, e.payout)} · </>}
                          seed <span className="muted">{e.seed}</span>
                        </>
                      )}
                      {e.kind === 'refunded' && e.stake !== undefined && <>stake returned {fmtToken(deployment, token, e.stake)}</>}
                      {e.kind === 'forfeit' && e.forfeit !== undefined && <>forfeit {fmtToken(deployment, token, e.forfeit)}</>}
                    </td>
                    <td className="mono muted">{e.blockNumber.toString()}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {shown < sorted.length && (
            <button type="button" className="secondary" onClick={() => setShown((n) => n + PAGE)}>
              Show more ({sorted.length - shown} more)
            </button>
          )}
        </>
      )}
    </div>
  )
}
