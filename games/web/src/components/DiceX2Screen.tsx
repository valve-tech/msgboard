import { useState } from 'react'
import * as viem from 'viem'
import { dicex2, diceX2MultiplierX100, type DiceX2Params, type DiceX2Mode } from '@msgboard/games'
import type { GameDeployment } from '../config'
import { useSession, type RoundRecord } from '../hooks/useSession'
import { StakeInput, parseStake } from './StakeInput'
import { TurnTiming } from './TurnTiming'
import { InfoDot } from './Meta'

const HUNDREDTHS = 100n

/** target is a per-roll roll-under win chance in percent (module targetX100 is hundredths-of-a-percent). */
const MIN_TARGET_PCT = 1.0
const MAX_TARGET_PCT = 98.99
const MODES: readonly DiceX2Mode[] = ['both', 'either']

const pctToTargetX100 = (pct: number): bigint => BigInt(Math.round(pct * 100))
const fmtMult = (x100: bigint): string => `${(Number(x100) / 100).toFixed(2)}x`

/**
 * OFF-CHAIN session-game screen (Dice X2). Two independent rolls are derived from one sealed seed.
 * In "both" mode you win only if BOTH rolls land under your target (harder, pays more); in "either"
 * mode at least one suffices (easier, pays less). One fixed payout per mode. Off-chain, co-signed.
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

export const DiceX2Screen = ({
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
  const [targetPct, setTargetPct] = useState('50')
  const [mode, setMode] = useState<DiceX2Mode>('both')

  const session = useSession<DiceX2Params>({
    game: dicex2,
    walletClient,
    chainId: deployment.chainId,
    boardRpc: deployment.boardRpc,
    gameLabel: 'dicex2',
  })

  const stake = parseStake(amount)
  const pct = Number(targetPct)
  const targetOk = Number.isFinite(pct) && pct >= MIN_TARGET_PCT && pct <= MAX_TARGET_PCT
  const targetX100 = targetOk ? pctToTargetX100(pct) : undefined
  const multiplierX100 = targetX100 !== undefined ? diceX2MultiplierX100(targetX100, mode) : undefined
  const potentialWin =
    stake !== undefined && multiplierX100 !== undefined
      ? (stake * multiplierX100) / HUNDREDTHS - stake
      : undefined

  const busy = session.status === 'opening' || session.status === 'playing'
  const canOpen = walletClient !== undefined && trustAcknowledged && !busy
  const canRoll = session.ready && !busy && stake !== undefined && targetX100 !== undefined

  const roll = () => {
    if (stake === undefined || targetX100 === undefined) return
    void session.play(stake, { targetX100, mode })
  }

  const wins = session.history.filter((r) => r.win).length
  const taken = session.history.reduce((sum, r) => sum + r.playerDelta, 0n)

  return (
    <div>
      <div className="card">
        <h3>
          Dice X2
          <InfoDot>
            <strong>Two rolls, one seed.</strong> Pick a per-roll win chance and a rule: <em>both</em>{' '}
            rolls under your target (harder, pays more) or <em>either</em> one (easier, pays less). Both
            rolls are derived from the seal you can re-check. Instant off-chain settle, no gas.
          </InfoDot>
        </h3>
        <div className="row">
          <StakeInput value={amount} onChange={setAmount} />
          <label className="threshold-label">
            per-roll win chance %
            <input
              type="number"
              min={MIN_TARGET_PCT}
              max={MAX_TARGET_PCT}
              step={0.5}
              value={targetPct}
              onChange={(e) => setTargetPct(e.target.value)}
              style={{ width: '5.5rem' }}
              aria-label="per-roll win chance percent"
            />
          </label>
          <label className="threshold-label">
            rule
            <span className="row" style={{ gap: '0.25rem' }}>
              {MODES.map((m) => (
                <button
                  key={m}
                  type="button"
                  className={`chip${mode === m ? ' active' : ''}`}
                  onClick={() => setMode(m)}
                  aria-label={`mode ${m}`}
                >
                  {m}
                </button>
              ))}
            </span>
          </label>
          {session.ready ? (
            <button onClick={roll} disabled={!canRoll}>
              {session.status === 'playing' ? 'Rolling…' : 'Roll ×2'}
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
          {targetPct !== '' && !targetOk && (
            <span className="bad">
              win chance {MIN_TARGET_PCT}–{MAX_TARGET_PCT}% ·{' '}
            </span>
          )}
          {multiplierX100 !== undefined && <span className="ok">pays {fmtMult(multiplierX100)}</span>}
          {multiplierX100 !== undefined && (
            <span className="muted"> · {mode === 'both' ? 'both rolls must land' : 'either roll wins'}</span>
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
        <p className="muted">No table open — set your stake, odds and rule, then open one to start.</p>
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
