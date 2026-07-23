import * as viem from 'viem'
import type { GameDeployment } from '../config'
import { useStandings } from '../hooks/useStandings'
import { AddressLink, InfoDot, fmtAmount } from './Meta'

const GAME_LABEL: Record<string, string> = {
  coinflip: '🪙',
  raffle: '🎟',
  flipbook: '🎭',
  flipbookx: '✍️',
}

const SOLVE_LABEL: Record<string, string> = {
  sudoku: '🧩',
  wordle: '🔤',
}

/**
 * The venue's cross-game standings: who is collecting, folded from the indexer's terminal events
 * (validator coinflip settles, numbers finalisations, both flip books' reveals and default claims).
 * Gross collections, straight from receipts — every row is re-derivable from public events.
 */
export const StandingsScreen = ({ deployment, myAddress }: { deployment: GameDeployment; myAddress?: viem.Hex }) => {
  const standings = useStandings(deployment.gamesIndexer ? deployment : null)

  if (!deployment.gamesIndexer) {
    return (
      <div className="card">
        <h3>Standings</h3>
        <p className="muted">No games indexer is configured for {deployment.label} — standings need one.</p>
      </div>
    )
  }

  return (
    <div className="card">
      <h3>
        Standings{' '}
        <InfoDot label="how standings are computed">
          <strong>Gross collections across every wagered table</strong> — validator coin flips, the numbers,
          and both P2P flip books (escrowed and signed-offer) — folded from the venue&apos;s indexed settlement
          events. Each entry is a pot or default claim an address actually collected on-chain; x402PLS amounts
          count 1:1 as PLS (it&apos;s wrapped native). Not net P&amp;L: stakes paid in aren&apos;t netted out,
          only what the receipts show coming back.
        </InfoDot>
        {standings.loading && <span className="muted"> refreshing…</span>}
      </h3>
      {standings.error && <p className="bad">indexer read failed: {standings.error}</p>}
      {standings.rows.length === 0 && !standings.loading && (
        <p className="muted">No settlements yet on {deployment.label}.</p>
      )}
      {standings.rows.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ textAlign: 'left' }}>
              <th className="muted">#</th>
              <th className="muted">player</th>
              <th className="muted">wins</th>
              <th className="muted">collected</th>
              <th className="muted">games</th>
            </tr>
          </thead>
          <tbody>
            {standings.rows.slice(0, 50).map((row) => {
              const mine = myAddress && row.player.toLowerCase() === myAddress.toLowerCase()
              return (
                <tr key={row.player}>
                  <td>{row.rank}</td>
                  <td className="mono">
                    <AddressLink deployment={deployment} address={row.player} />
                    {mine && <span className="tag ok" style={{ marginLeft: '0.4rem' }}>you</span>}
                  </td>
                  <td>{row.wins}</td>
                  <td>{fmtAmount(deployment, row.collected)}</td>
                  <td>
                    {Object.entries(row.byGame).map(([g, n]) => (
                      <span key={g} className="tag" title={`${g}: ${n} wins`} style={{ marginRight: '0.25rem' }}>
                        {GAME_LABEL[g] ?? g} {n}
                      </span>
                    ))}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}

      <h3 style={{ marginTop: '1.25rem' }}>
        Proven solves{' '}
        <InfoDot label="how solves are proven">
          <strong>The facts rail:</strong> every row counts EAS attestations whose resolver
          <em> recomputed the solve on-chain</em> before letting the attestation exist — a sudoku
          grid checked cell-by-cell, a wordle chain replayed against the day&apos;s commitment. No
          wagers, no trust in a server: an entry here is a skill receipt anyone can re-verify from
          the attestation uid.
        </InfoDot>
      </h3>
      {standings.solvers.length === 0 && !standings.loading && (
        <p className="muted">No attested solves yet on {deployment.label}.</p>
      )}
      {standings.solvers.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ textAlign: 'left' }}>
              <th className="muted">#</th>
              <th className="muted">solver</th>
              <th className="muted">solves</th>
              <th className="muted">puzzles</th>
              <th className="muted">last solve</th>
            </tr>
          </thead>
          <tbody>
            {standings.solvers.slice(0, 50).map((row) => {
              const mine = myAddress && row.player.toLowerCase() === myAddress.toLowerCase()
              return (
                <tr key={row.player}>
                  <td>{row.rank}</td>
                  <td className="mono">
                    <AddressLink deployment={deployment} address={row.player} />
                    {mine && <span className="tag ok" style={{ marginLeft: '0.4rem' }}>you</span>}
                  </td>
                  <td>{row.solves}</td>
                  <td>
                    {Object.entries(row.byGame).map(([g, n]) => (
                      <span key={g} className="tag" title={`${g}: ${n} proven solves`} style={{ marginRight: '0.25rem' }}>
                        {SOLVE_LABEL[g] ?? g} {n}
                      </span>
                    ))}
                  </td>
                  <td className="muted">{new Date(row.lastAt * 1000).toLocaleDateString()}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}
