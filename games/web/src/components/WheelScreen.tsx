import { useState } from 'react'
import * as viem from 'viem'
import {
  wheel,
  wheelFairTableX100,
  wheelEdgedX100,
  SUPPORTED_SEGMENTS,
  type WheelParams,
  type WheelRisk,
} from '@msgboard/games'
import type { GameDeployment } from '../config'
import { useSession, type RoundRecord } from '../hooks/useSession'
import { StakeInput, parseStake } from './StakeInput'
import { TurnTiming } from './TurnTiming'
import { InfoDot } from './Meta'

const RISKS: readonly WheelRisk[] = ['low', 'medium', 'high']
const fmtMult = (x100: bigint): string => `${(Number(x100) / 100).toFixed(2)}x`

/** group the edged segment multipliers into {mult -> count} for a compact distribution view. */
const distributionFor = (risk: WheelRisk, segments: number): { mult: bigint; count: number }[] | undefined => {
  try {
    const fair = wheelFairTableX100(risk, segments)
    const counts = new Map<string, { mult: bigint; count: number }>()
    for (const f of fair) {
      const m = wheelEdgedX100(f)
      const key = m.toString()
      const e = counts.get(key)
      if (e) e.count++
      else counts.set(key, { mult: m, count: 1 })
    }
    return [...counts.values()].sort((a, b) => (a.mult < b.mult ? -1 : a.mult > b.mult ? 1 : 0))
  } catch {
    return undefined
  }
}

/**
 * OFF-CHAIN session-game screen (Wheel). Spin a segmented wheel; the landed segment's multiplier pays.
 * The pointer position is seed-derived (raw % segments). Settles off-chain, co-signed, sealed seed.
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

export const WheelScreen = ({
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
  const [risk, setRisk] = useState<WheelRisk>('medium')
  const [segments, setSegments] = useState<number>(SUPPORTED_SEGMENTS[0])

  const session = useSession<WheelParams>({
    game: wheel,
    walletClient,
    chainId: deployment.chainId,
    boardRpc: deployment.boardRpc,
    gameLabel: 'wheel',
  })

  const stake = parseStake(amount)
  const dist = distributionFor(risk, segments)
  const params: WheelParams | undefined = dist !== undefined ? { risk, segments } : undefined
  const maxMult = dist?.reduce((m, d) => (d.mult > m ? d.mult : m), 0n)

  const busy = session.status === 'opening' || session.status === 'playing'
  const canOpen = walletClient !== undefined && trustAcknowledged && !busy
  const canSpin = session.ready && !busy && stake !== undefined && params !== undefined

  const spin = () => {
    if (stake === undefined || params === undefined) return
    void session.play(stake, params)
  }

  const wins = session.history.filter((r) => r.win).length
  const taken = session.history.reduce((sum, r) => sum + r.playerDelta, 0n)

  return (
    <div>
      <div className="card">
        <h3>
          Wheel
          <InfoDot>
            <strong>Spin the wheel.</strong> The segment under the pointer sets your multiplier — higher
            risk means more empty segments but bigger spikes. (Payout values shown are illustrative.) The
            stopping point is sealed before you play. Instant off-chain settle, no gas.
          </InfoDot>
        </h3>
        <div className="row">
          <StakeInput value={amount} onChange={setAmount} />
          <label className="threshold-label">
            risk
            <span className="row" style={{ gap: '0.25rem' }}>
              {RISKS.map((r) => (
                <button
                  key={r}
                  type="button"
                  className={`chip${risk === r ? ' active' : ''}`}
                  onClick={() => setRisk(r)}
                  aria-label={`risk ${r}`}
                >
                  {r}
                </button>
              ))}
            </span>
          </label>
          <label className="threshold-label">
            segments
            <span className="row" style={{ gap: '0.25rem' }}>
              {SUPPORTED_SEGMENTS.map((n) => (
                <button
                  key={n}
                  type="button"
                  className={`chip${segments === n ? ' active' : ''}`}
                  onClick={() => setSegments(n)}
                  aria-label={`segments ${n}`}
                >
                  {n}
                </button>
              ))}
            </span>
          </label>
          {session.ready ? (
            <button onClick={spin} disabled={!canSpin}>
              {session.status === 'playing' ? 'Spinning…' : 'Spin'}
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
        {dist && (
          <p className="card-meta muted">
            segments{' '}
            {dist.map((d) => (
              <span key={d.mult.toString()} className="tag">
                <span className="mono">{fmtMult(d.mult)}</span> ×{d.count}
              </span>
            ))}
          </p>
        )}
        <p className="muted">
          {amount !== '' && stake === undefined && <span className="bad">enter a positive amount · </span>}
          {dist === undefined && (
            <span className="bad">no paytable for {risk} risk at {segments} segments · </span>
          )}
          {maxMult !== undefined && maxMult > 0n && <span className="ok">up to {fmtMult(maxMult)}</span>}
        </p>
        {session.commit && (
          <p className="card-meta muted">
            server-seed commit <span className="mono">{session.commit.slice(0, 10)}…</span>
            {session.balances && (
              <>
                {' · '}your balance {viem.formatEther(session.balances.player)} · {session.roundsLeft} spins left
              </>
            )}
          </p>
        )}
        {session.error && <p className="bad">{session.error}</p>}
      </div>

      <h2>This table</h2>
      {!session.ready && session.history.length === 0 && (
        <p className="muted">No table open — set your stake and wheel, then open one to start spinning.</p>
      )}
      {[...session.history].reverse().map((record) => (
        <RoundReceipt key={record.round} record={record} />
      ))}

      {myAddress && session.history.length > 0 && (
        <>
          <h2>Your book</h2>
          <details className="history" open>
            <summary>
              {session.history.length} spin{session.history.length === 1 ? '' : 's'}
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
