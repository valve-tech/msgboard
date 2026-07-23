import { useState } from 'react'
import * as viem from 'viem'
import { crash, type CrashParams } from '@msgboard/games'
import type { GameDeployment } from '../config'
import { useSession, type RoundRecord } from '../hooks/useSession'
import { StakeInput, parseStake } from './StakeInput'
import { TurnTiming } from './TurnTiming'
import { InfoDot } from './Meta'

const HUNDREDTHS = 100n

/** auto-cashout is a payout multiplier; crash's autoCashoutX100 is hundredths (2.00x == 200). */
const MIN_CASHOUT_MULT = 1.01
const MAX_CASHOUT_MULT = 990000.0

const multToX100 = (mult: number): bigint => BigInt(Math.round(mult * 100))
const fmtMult = (x100: bigint): string => `${(Number(x100) / 100).toFixed(2)}x`

/**
 * OFF-CHAIN session-game screen (Crash) — the pre-committed auto-cashout form. Structurally identical
 * to Limbo: the player locks an auto-cashout multiplier before the round, the seed-derived crash point
 * is the same curve, and a win pays the locked multiplier. Settles off-chain, co-signed, sealed seed.
 */
const RoundReceipt = ({ record }: { record: RoundRecord }) => (
  <div className="card">
    <div className="row" style={{ justifyContent: 'space-between' }}>
      <span>
        <span className="tag">round {record.round}</span>
        {viem.formatEther(record.stake)} staked
        {record.win ? (
          <span className="tag ok">cashed {fmtMult(record.multiplierX100)}</span>
        ) : (
          <span className="tag">crashed early</span>
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

export const CrashScreen = ({
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
  const [cashoutMult, setCashoutMult] = useState('2.00')

  const session = useSession<CrashParams>({
    game: crash,
    walletClient,
    chainId: deployment.chainId,
    boardRpc: deployment.boardRpc,
    gameLabel: 'crash',
  })

  const stake = parseStake(amount)
  const mult = Number(cashoutMult)
  const cashoutOk = Number.isFinite(mult) && mult >= MIN_CASHOUT_MULT && mult <= MAX_CASHOUT_MULT
  const autoCashoutX100 = cashoutOk ? multToX100(mult) : undefined
  // win chance ≈ (1 - edge) / target — same as limbo. Shown for orientation.
  const winChancePct = autoCashoutX100 !== undefined ? (99 * 10000) / Number(autoCashoutX100) / 100 : undefined
  const potentialWin =
    stake !== undefined && autoCashoutX100 !== undefined
      ? (stake * autoCashoutX100) / HUNDREDTHS - stake
      : undefined

  const busy = session.status === 'opening' || session.status === 'playing'
  const canOpen = walletClient !== undefined && trustAcknowledged && !busy
  const canRun = session.ready && !busy && stake !== undefined && autoCashoutX100 !== undefined

  const run = () => {
    if (stake === undefined || autoCashoutX100 === undefined) return
    void session.play(stake, { autoCashoutX100 })
  }

  const wins = session.history.filter((r) => r.win).length
  const taken = session.history.reduce((sum, r) => sum + r.playerDelta, 0n)

  return (
    <div>
      <div className="card">
        <h3>
          Crash
          <InfoDot>
            <strong>Set an auto-cashout, then watch the rocket climb.</strong> If the multiplier reaches
            your target before it crashes, you win that multiple. The crash point is sealed before you
            play — your browser re-checks it. Instant off-chain settle, no gas.
          </InfoDot>
        </h3>
        <div className="row">
          <StakeInput value={amount} onChange={setAmount} />
          <label className="threshold-label">
            auto-cashout ×
            <input
              type="number"
              min={MIN_CASHOUT_MULT}
              max={MAX_CASHOUT_MULT}
              step={0.01}
              value={cashoutMult}
              onChange={(e) => setCashoutMult(e.target.value)}
              style={{ width: '5.5rem' }}
              aria-label="auto-cashout multiplier"
            />
          </label>
          {session.ready ? (
            <button onClick={run} disabled={!canRun}>
              {session.status === 'playing' ? 'Launching…' : 'Launch'}
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
          {cashoutMult !== '' && !cashoutOk && (
            <span className="bad">
              auto-cashout {MIN_CASHOUT_MULT.toFixed(2)}x–{MAX_CASHOUT_MULT.toFixed(2)}x ·{' '}
            </span>
          )}
          {autoCashoutX100 !== undefined && <span className="ok">pays {fmtMult(autoCashoutX100)}</span>}
          {winChancePct !== undefined && (
            <span className="muted"> · {winChancePct.toFixed(2)}% reach chance</span>
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
                {' · '}your balance {viem.formatEther(session.balances.player)} · {session.roundsLeft} rounds left
              </>
            )}
          </p>
        )}
        {session.error && <p className="bad">{session.error}</p>}
      </div>

      <h2>This table</h2>
      {!session.ready && session.history.length === 0 && (
        <p className="muted">No table open — set your stake and auto-cashout, then open one to start.</p>
      )}
      {[...session.history].reverse().map((record) => (
        <RoundReceipt key={record.round} record={record} />
      ))}

      {myAddress && session.history.length > 0 && (
        <>
          <h2>Your book</h2>
          <details className="history" open>
            <summary>
              {session.history.length} round{session.history.length === 1 ? '' : 's'}
              <span className="muted">
                {' '}
                · {wins}/{session.history.length} cashed · {viem.formatEther(taken)} net
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
