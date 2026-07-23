import type { ReactNode } from 'react'
import * as viem from 'viem'
import type { LadderGameRecord, LadderSessionApi } from '../hooks/useLadderSession'
import { StakeInput } from './StakeInput'
import { InfoDot } from './Meta'

const HUNDREDTHS = 100n
export const fmtMult = (x100: bigint): string => `${(Number(x100) / 100).toFixed(2)}x`

/** A finished ladder-game receipt with the provably-fair verify line (seed re-checked). */
export const LadderReceipt = ({ record, noun }: { record: LadderGameRecord; noun: string }) => {
  const won = record.status === 'cashed'
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span>
          <span className="tag">{noun} {record.id}</span>
          {viem.formatEther(record.stake)} staked
          {won ? (
            <span className="tag ok">cashed {fmtMult(record.multiplierX100)}</span>
          ) : (
            <span className="tag">busted</span>
          )}
        </span>
        <span className={record.playerDelta >= 0n ? 'ok' : 'bad'}>
          {record.playerDelta >= 0n ? '+' : ''}
          {viem.formatEther(record.playerDelta)}
        </span>
      </div>
      <p className="card-meta muted">
        {record.steps} step{record.steps === 1 ? '' : 's'} · co-signed move log ({record.moves.length})
      </p>
      <p className="card-meta muted">
        provably fair · commit <span className="mono">{record.commit.slice(0, 10)}…</span> ·{' '}
        {record.verdict.ok ? (
          <span className="ok">verify ✓ (seed re-checked)</span>
        ) : (
          <span className="bad">verify ✗ {record.verdict.reason}</span>
        )}
      </p>
    </div>
  )
}

/**
 * Shared chrome for the stateful ladder screens: stake input + game-specific config row, a start
 * button, the live running multiplier + cash-out button, the seed commit line, and the receipt/history
 * lists. Each game supplies its config controls and in-progress step controls as children.
 */
export const LadderShell = ({
  title, info, noun, startLabel, amount, setAmount, configRow, controls,
  session, canStart, onStart, walletClient, trustAcknowledged, myAddress, stake,
}: {
  title: string
  info: ReactNode
  noun: string
  startLabel: string
  amount: string
  setAmount: (v: string) => void
  configRow: ReactNode
  controls: ReactNode
  session: LadderSessionApi
  canStart: boolean
  onStart: () => void
  walletClient?: viem.WalletClient
  trustAcknowledged: boolean
  myAddress?: viem.Hex
  stake?: bigint
}) => {
  const playing = session.status === 'playing'
  const cashOutValue =
    stake !== undefined && session.step > 0 ? (stake * session.multiplierX100) / HUNDREDTHS : undefined
  const cashed = session.history.filter((g) => g.status === 'cashed').length
  const net = session.history.reduce((sum, g) => sum + g.playerDelta, 0n)

  return (
    <div>
      <div className="card">
        <h3>
          {title}
          <InfoDot>{info}</InfoDot>
        </h3>
        <div className="row">
          <StakeInput value={amount} onChange={setAmount} />
          {configRow}
          <button onClick={onStart} disabled={!canStart}>
            {playing ? 'In progress…' : startLabel}
          </button>
          {playing && (
            <button onClick={() => session.cashOut()} disabled={!session.canCashOut}>
              Cash out {cashOutValue !== undefined ? `(${viem.formatEther(cashOutValue)})` : ''}
            </button>
          )}
          {!walletClient && <span className="muted">connect a wallet to play</span>}
          {walletClient && !trustAcknowledged && (
            <span className="muted">tap "Got it" on the fairness note above first</span>
          )}
        </div>
        {playing && <p className="muted"><span className="ok">now {fmtMult(session.multiplierX100)}</span> · step {session.step}</p>}
        {/* game-specific in-progress controls (tile grid / higher-lower / advance / roll) */}
        {playing && <div style={{ marginTop: '0.5rem' }}>{controls}</div>}
        {session.commit && (
          <p className="card-meta muted">
            layout commit <span className="mono">{session.commit.slice(0, 10)}…</span>
            {session.step > 0 && <> · {fmtMult(session.multiplierX100)}{cashOutValue !== undefined && <> · cash-out {viem.formatEther(cashOutValue)}</>}</>}
          </p>
        )}
        {session.error && <p className="bad">{session.error}</p>}
      </div>

      {session.lastGame && (
        <>
          <h2>Result</h2>
          <LadderReceipt record={session.lastGame} noun={noun} />
        </>
      )}

      <h2>This table</h2>
      {session.status === 'idle' && session.history.length === 0 && (
        <p className="muted">No {noun} yet — set your stake and options, then start one.</p>
      )}
      {[...session.history].reverse().map((record) => (
        <LadderReceipt key={record.id} record={record} noun={noun} />
      ))}

      {myAddress && session.history.length > 0 && (
        <>
          <h2>Your book</h2>
          <details className="history" open>
            <summary>
              {session.history.length} {noun}{session.history.length === 1 ? '' : 's'}
              <span className="muted"> · {cashed}/{session.history.length} cashed · {viem.formatEther(net)} net</span>
            </summary>
            {[...session.history].reverse().map((record) => (
              <LadderReceipt key={record.id} record={record} noun={noun} />
            ))}
          </details>
        </>
      )}
    </div>
  )
}
