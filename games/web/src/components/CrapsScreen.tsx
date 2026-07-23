import { useState } from 'react'
import * as viem from 'viem'
import { craps, type CrapsParams, type CrapsBet } from '@msgboard/games'
import type { GameDeployment } from '../config'
import { useSession, type RoundRecord } from '../hooks/useSession'
import { StakeInput, parseStake } from './StakeInput'
import { TurnTiming } from './TurnTiming'
import { InfoDot } from './Meta'

const BETS: readonly CrapsBet[] = ['pass', 'dontpass']
const fmtMult = (x100: bigint): string => `${(Number(x100) / 100).toFixed(2)}x`

/** Craps can PUSH (don't-pass bar 12): delta 0, not a win — show it distinctly. */
const RoundReceipt = ({ record }: { record: RoundRecord }) => {
  const push = !record.win && record.playerDelta === 0n
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span>
          <span className="tag">roll {record.round}</span>
          {viem.formatEther(record.stake)} staked
          {record.win ? (
            <span className="tag ok">won {fmtMult(record.multiplierX100)}</span>
          ) : push ? (
            <span className="tag">push (bar 12)</span>
          ) : (
            <span className="tag">lost</span>
          )}
        </span>
        <span className={record.playerDelta >= 0n ? 'ok' : 'bad'}>
          {record.playerDelta >= 0n ? '+' : ''}
          {viem.formatEther(record.playerDelta)}
        </span>
      </div>
      <p className="card-meta muted">balance {viem.formatEther(record.balancePlayer)} · co-signed by both parties</p>
      {record.timing && <p className="card-meta muted"><TurnTiming timing={record.timing} /></p>}
    </div>
  )
}

export const CrapsScreen = ({ deployment, walletClient, trustAcknowledged, myAddress }: {
  deployment: GameDeployment; walletClient?: viem.WalletClient; trustAcknowledged: boolean; myAddress?: viem.Hex
}) => {
  const [amount, setAmount] = useState('0.1')
  const [bet, setBet] = useState<CrapsBet>('pass')

  const session = useSession<CrapsParams>({
    game: craps,
    walletClient,
    chainId: deployment.chainId,
    boardRpc: deployment.boardRpc,
    gameLabel: 'craps',
  })

  const stake = parseStake(amount)
  const busy = session.status === 'opening' || session.status === 'playing'
  const canOpen = walletClient !== undefined && trustAcknowledged && !busy
  const canRoll = session.ready && !busy && stake !== undefined

  const roll = () => {
    if (stake === undefined) return
    void session.play(stake, { bet })
  }

  const wins = session.history.filter((r) => r.win).length
  const taken = session.history.reduce((sum, r) => sum + r.playerDelta, 0n)

  return (
    <div>
      <div className="card">
        <h3>
          Craps
          <InfoDot>
            <strong>Bet the Pass or Don't-Pass line, then roll.</strong> Come-out 7/11 wins the pass line,
            2/3/12 loses it; any other number is the POINT and you roll until the point (win) or a 7
            (lose). Don't-Pass is the mirror (12 is a push). Every roll is drawn from the sealed seed, so
            you can re-check the whole shoot. Even money; instant off-chain settle, no gas.
          </InfoDot>
        </h3>
        <div className="row">
          <StakeInput value={amount} onChange={setAmount} />
          <label className="threshold-label">
            line
            <span className="row" style={{ gap: '0.25rem' }}>
              {BETS.map((b) => (
                <button key={b} type="button" className={`chip${bet === b ? ' active' : ''}`}
                  onClick={() => setBet(b)} aria-label={`bet ${b}`}>
                  {b === 'pass' ? 'Pass' : "Don't Pass"}
                </button>
              ))}
            </span>
          </label>
          {session.ready ? (
            <button onClick={roll} disabled={!canRoll}>{session.status === 'playing' ? 'Rolling…' : 'Roll'}</button>
          ) : (
            <button onClick={() => void session.start()} disabled={!canOpen}>
              {session.status === 'opening' ? 'Opening…' : 'Open table'}
            </button>
          )}
          {!walletClient && <span className="muted">connect a wallet to play</span>}
          {walletClient && !trustAcknowledged && <span className="muted">tap "Got it" on the fairness note above first</span>}
        </div>
        <p className="muted">
          {amount !== '' && stake === undefined && <span className="bad">enter a positive amount · </span>}
          <span className="ok">{bet === 'pass' ? 'Pass' : "Don't Pass"} pays 2.00x</span>
        </p>
        {session.commit && (
          <p className="card-meta muted">
            server-seed commit <span className="mono">{session.commit.slice(0, 10)}…</span>
            {session.balances && <>{' · '}your balance {viem.formatEther(session.balances.player)} · {session.roundsLeft} rolls left</>}
          </p>
        )}
        {session.error && <p className="bad">{session.error}</p>}
      </div>

      <h2>This table</h2>
      {!session.ready && session.history.length === 0 && (
        <p className="muted">No table open — set your stake and line, then open one to start rolling.</p>
      )}
      {[...session.history].reverse().map((record) => <RoundReceipt key={record.round} record={record} />)}

      {myAddress && session.history.length > 0 && (
        <>
          <h2>Your book</h2>
          <details className="history" open>
            <summary>
              {session.history.length} roll{session.history.length === 1 ? '' : 's'}
              <span className="muted"> · {wins}/{session.history.length} won · {viem.formatEther(taken)} net</span>
            </summary>
            {[...session.history].reverse().map((record) => <RoundReceipt key={record.round} record={record} />)}
          </details>
        </>
      )}
    </div>
  )
}
