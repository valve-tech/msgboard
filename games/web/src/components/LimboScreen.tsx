import { useState } from 'react'
import * as viem from 'viem'
import { limbo, limboWinChanceX100, type LimboParams } from '@msgboard/games'
import type { GameDeployment } from '../config'
import { useSession, type RoundRecord } from '../hooks/useSession'
import { StakeInput, parseStake } from './StakeInput'
import { TurnTiming } from './TurnTiming'
import { InfoDot } from './Meta'

const HUNDREDTHS = 100n

/** target is a payout multiplier; the limbo module's targetX100 is hundredths (2.00x == 200). */
const MIN_TARGET_MULT = 1.01
const MAX_TARGET_MULT = 990000.0

const multToTargetX100 = (mult: number): bigint => BigInt(Math.round(mult * 100))
const fmtMult = (x100: bigint): string => `${(Number(x100) / 100).toFixed(2)}x`
/** win chance comes back as hundredths-of-a-percent (10000 == 100%). */
const fmtWinChance = (x100: bigint): string => `${(Number(x100) / 100).toFixed(2)}%`

/**
 * OFF-CHAIN session-game screen (Limbo) — a near-mechanical adaptation of DiceScreen:
 *   1. `useSession({ game, walletClient, chainId })` drives the HouseSession.
 *   2. a params UI (here: target multiplier / win-chance) → `session.play(stake, params)`.
 *   3. a result/receipt + history list in the CoinFlip/Raffle visual style.
 */
const RoundReceipt = ({ record }: { record: RoundRecord }) => (
  <div className="card">
    <div className="row" style={{ justifyContent: 'space-between' }}>
      <span>
        <span className="tag">round {record.round}</span>
        {viem.formatEther(record.stake)} staked
        {record.win ? (
          <span className="tag ok">won {fmtMult(record.multiplierX100)}</span>
        ) : (
          <span className="tag">lost</span>
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

export const LimboScreen = ({
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
  const [targetMult, setTargetMult] = useState('2.00')

  const session = useSession<LimboParams>({
    game: limbo,
    walletClient,
    chainId: deployment.chainId,
    boardRpc: deployment.boardRpc,
    gameLabel: 'limbo',
  })

  const stake = parseStake(amount)
  const mult = Number(targetMult)
  const targetOk = Number.isFinite(mult) && mult >= MIN_TARGET_MULT && mult <= MAX_TARGET_MULT
  const targetX100 = targetOk ? multToTargetX100(mult) : undefined
  const winChanceX100 = targetX100 !== undefined ? limboWinChanceX100(targetX100) : undefined
  const potentialWin =
    stake !== undefined && targetX100 !== undefined
      ? (stake * targetX100) / HUNDREDTHS - stake
      : undefined

  const busy = session.status === 'opening' || session.status === 'playing'
  const canOpen = walletClient !== undefined && trustAcknowledged && !busy
  const canRoll = session.ready && !busy && stake !== undefined && targetX100 !== undefined

  const roll = () => {
    if (stake === undefined || targetX100 === undefined) return
    void session.play(stake, { targetX100 })
  }

  const wins = session.history.filter((r) => r.win).length
  const taken = session.history.reduce((sum, r) => sum + r.playerDelta, 0n)

  return (
    <div>
      <div className="card">
        <h3>
          Limbo
          <InfoDot>
            <strong>Pick a target multiplier.</strong> A random multiplier is drawn — reach your
            target and you win that multiple. Aim higher for a bigger prize at a smaller chance.
            Instant off-chain settle, no gas, sealed seed you can re-check.
          </InfoDot>
        </h3>
        <div className="row">
          <StakeInput value={amount} onChange={setAmount} />
          <label className="threshold-label">
            target multiplier
            <input
              type="number"
              min={MIN_TARGET_MULT}
              max={MAX_TARGET_MULT}
              step={0.01}
              value={targetMult}
              onChange={(e) => setTargetMult(e.target.value)}
              style={{ width: '5.5rem' }}
              aria-label="target multiplier"
            />
          </label>
          {session.ready ? (
            <button onClick={roll} disabled={!canRoll}>
              {session.status === 'playing' ? 'Rolling…' : 'Roll'}
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
          {targetMult !== '' && !targetOk && (
            <span className="bad">
              target must be between {MIN_TARGET_MULT.toFixed(2)}x and {MAX_TARGET_MULT.toFixed(2)}x ·{' '}
            </span>
          )}
          {targetX100 !== undefined && (
            <span className="ok">pays {fmtMult(targetX100)}</span>
          )}
          {winChanceX100 !== undefined && (
            <span className="muted"> · {fmtWinChance(winChanceX100)} win chance</span>
          )}
          {potentialWin !== undefined && potentialWin > 0n && (
            <span className="muted"> · +{viem.formatEther(potentialWin)} on a win</span>
          )}
        </p>
        {session.commit && (
          <p className="card-meta muted">
            server-seed commit <span className="mono">{session.commit.slice(0, 10)}…</span>
            {session.balances && (
              <>
                {' · '}your balance {viem.formatEther(session.balances.player)} · {session.roundsLeft} rolls left
              </>
            )}
          </p>
        )}
        {session.error && <p className="bad">{session.error}</p>}
      </div>

      <h2>This table</h2>
      {!session.ready && session.history.length === 0 && (
        <p className="muted">No table open — set your stake and target, then open one to start rolling.</p>
      )}
      {[...session.history].reverse().map((record) => (
        <RoundReceipt key={record.round} record={record} />
      ))}

      {myAddress && session.history.length > 0 && (
        <>
          <h2>Your book</h2>
          <details className="history" open>
            <summary>
              {session.history.length} roll{session.history.length === 1 ? '' : 's'}
              <span className="muted">
                {' '}
                · {wins}/{session.history.length} won · {viem.formatEther(taken)} net
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
