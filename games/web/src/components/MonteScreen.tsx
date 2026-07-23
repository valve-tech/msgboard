import { useState } from 'react'
import * as viem from 'viem'
import { monte, monteMultiplierX100, SLOTS, type MonteParams } from '@msgboard/games'
import type { GameDeployment } from '../config'
import { useSession, type RoundRecord } from '../hooks/useSession'
import { StakeInput, parseStake } from './StakeInput'
import { TurnTiming } from './TurnTiming'
import { InfoDot } from './Meta'

const HUNDREDTHS = 100n
const fmtMult = (x100: bigint): string => `${(Number(x100) / 100).toFixed(2)}x`

/**
 * OFF-CHAIN session-game screen (Three-Card Monte). Pick one of three face-down cards; the winning
 * position is seed-derived (raw % 3), so the house cannot move the card after seeing your pick. A
 * correct guess pays ~2.97x (3x edged). Settles off-chain, co-signed, sealed seed.
 */
const RoundReceipt = ({ record }: { record: RoundRecord }) => (
  <div className="card">
    <div className="row" style={{ justifyContent: 'space-between' }}>
      <span>
        <span className="tag">round {record.round}</span>
        {viem.formatEther(record.stake)} staked
        {record.win ? (
          <span className="tag ok">found it · {fmtMult(record.multiplierX100)}</span>
        ) : (
          <span className="tag">missed</span>
        )}
      </span>
      <span className={record.playerDelta >= 0n ? 'ok' : 'bad'}>
        {record.playerDelta >= 0n ? '+' : ''}
        {viem.formatEther(record.playerDelta)}
      </span>
    </div>
    <p className="card-meta muted">
      balance {viem.formatEther(record.balancePlayer)} · co-signed by both parties
    </p>
    {record.timing && (
      <p className="card-meta muted">
        <TurnTiming timing={record.timing} />
      </p>
    )}
  </div>
)

export const MonteScreen = ({
  deployment,
  walletClient,
  trustAcknowledged,
  myAddress,
}: {
  deployment: GameDeployment
  walletClient?: viem.WalletClient
  trustAcknowledged: boolean
  myAddress?: viem.Hex
}) => {
  const [amount, setAmount] = useState('0.1')
  const [pick, setPick] = useState<number>(0)

  const session = useSession<MonteParams>({
    game: monte,
    walletClient,
    chainId: deployment.chainId,
    boardRpc: deployment.boardRpc,
    gameLabel: 'monte',
  })

  const stake = parseStake(amount)
  const multiplierX100 = monteMultiplierX100()
  const potentialWin = stake !== undefined ? (stake * multiplierX100) / HUNDREDTHS - stake : undefined

  const busy = session.status === 'opening' || session.status === 'playing'
  const canOpen = walletClient !== undefined && trustAcknowledged && !busy
  const canPlay = session.ready && !busy && stake !== undefined

  const play = () => {
    if (stake === undefined) return
    void session.play(stake, { pick })
  }

  const wins = session.history.filter((r) => r.win).length
  const taken = session.history.reduce((sum, r) => sum + r.playerDelta, 0n)

  return (
    <div>
      <div className="card">
        <h3>
          Three-Card Monte
          <InfoDot>
            <strong>Find the lady.</strong> Pick one of three face-down cards. The winning card's
            position is sealed before you play — the house can't move it once you've chosen. Find it and
            win {fmtMult(multiplierX100)}. Instant off-chain settle, no gas.
          </InfoDot>
        </h3>
        <div className="row">
          <StakeInput value={amount} onChange={setAmount} />
          <label className="threshold-label">
            your card
            <span className="row" style={{ gap: '0.25rem' }}>
              {Array.from({ length: SLOTS }, (_, i) => i).map((i) => (
                <button
                  key={i}
                  type="button"
                  className={`chip${pick === i ? ' active' : ''}`}
                  onClick={() => setPick(i)}
                  aria-label={`card ${i + 1}`}
                >
                  {i + 1}
                </button>
              ))}
            </span>
          </label>
          {session.ready ? (
            <button onClick={play} disabled={!canPlay}>
              {session.status === 'playing' ? 'Flipping…' : 'Flip'}
            </button>
          ) : (
            <button onClick={() => void session.start()} disabled={!canOpen}>
              {session.status === 'opening' ? 'Opening…' : 'Open table'}
            </button>
          )}
          {!walletClient && <span className="muted">connect a wallet to play</span>}
          {walletClient && !trustAcknowledged && (
            <span className="muted">tap "Got it" on the fairness note above first</span>
          )}
        </div>
        <p className="muted">
          {amount !== '' && stake === undefined && <span className="bad">enter a positive amount · </span>}
          <span className="ok">pays {fmtMult(multiplierX100)}</span>
          <span className="muted"> · 1 in {SLOTS} chance</span>
          {potentialWin !== undefined && potentialWin > 0n && (
            <span className="muted"> · +{viem.formatEther(potentialWin)} on a win</span>
          )}
        </p>
        {session.commit && (
          <p className="card-meta muted">
            server-seed commit <span className="mono">{session.commit.slice(0, 10)}…</span>
            {session.balances && (
              <>
                {' · '}your balance {viem.formatEther(session.balances.player)} · {session.roundsLeft} flips left
              </>
            )}
          </p>
        )}
        {session.error && <p className="bad">{session.error}</p>}
      </div>

      <h2>This table</h2>
      {!session.ready && session.history.length === 0 && (
        <p className="muted">No table open — set your stake and pick a card, then open one to start.</p>
      )}
      {[...session.history].reverse().map((record) => (
        <RoundReceipt key={record.round} record={record} />
      ))}

      {myAddress && session.history.length > 0 && (
        <>
          <h2>Your book</h2>
          <details className="history" open>
            <summary>
              {session.history.length} flip{session.history.length === 1 ? '' : 's'}
              <span className="muted">
                {' '}
                · {wins}/{session.history.length} found · {viem.formatEther(taken)} net
              </span>
            </summary>
            {[...session.history].reverse().map((record) => (
              <RoundReceipt key={record.round} record={record} />
            ))}
          </details>
        </>
      )}
    </div>
  )
}
