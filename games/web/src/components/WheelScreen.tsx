import { useState } from 'react'
import * as viem from 'viem'
import {
  wheel,
  wheelMultiplierX100,
  wheelSegment,
  SUPPORTED_SEGMENTS,
  type WheelParams,
  type WheelRisk,
} from '@msgboard/games'
import type { GameDeployment } from '../config'
import { useSession, type RoundRecord } from '../hooks/useSession'
import { parseStake } from './StakeInput'
import { TurnTiming } from './TurnTiming'
import { GameStage } from './shell/GameStage'
import { BetTray } from './shell/BetTray'
import { MetaPanel } from './shell/MetaPanel'
import { DiffChips, fmtMult } from './ladderShared'
import { MultiWheel, type WheelSeg } from './stages/MultiWheel'

const RISKS: readonly WheelRisk[] = ['low', 'medium', 'high']

/** payout tier for a segment: a loss (<1x), a modest win (~1x), or a spike/jackpot (>=2x). */
const tierOf = (x100: bigint): WheelSeg['tier'] => (x100 >= 200n ? 'hi' : x100 >= 100n ? 'mid' : 'lo')

/** the ordered per-segment edged multipliers for a (risk, segments) pair, or undefined if unsupported. */
const perSegment = (risk: WheelRisk, segments: number): bigint[] | undefined => {
  try {
    return Array.from({ length: segments }, (_, i) => wheelMultiplierX100(risk, segments, i))
  } catch {
    return undefined
  }
}

/** collapse the segment multipliers to {mult -> count} for the tray's distribution line. */
const distribution = (mults: bigint[]): { mult: bigint; count: number }[] => {
  const by = new Map<string, { mult: bigint; count: number }>()
  for (const m of mults) {
    const e = by.get(m.toString())
    if (e) e.count++
    else by.set(m.toString(), { mult: m, count: 1 })
  }
  return [...by.values()].sort((a, b) => (a.mult < b.mult ? -1 : a.mult > b.mult ? 1 : 0))
}

const RoundReceipt = ({ record }: { record: RoundRecord }) => (
  <div className="card">
    <div className="row" style={{ justifyContent: 'space-between' }}>
      <span>
        <span className="tag">round {record.round}</span>
        {viem.formatEther(record.stake)} staked
        {record.win ? <span className="tag ok">won {fmtMult(record.multiplierX100)}</span> : <span className="tag">lost</span>}
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

/**
 * OFF-CHAIN session-game screen (Wheel), on the shared MultiWheel surface. Spin a segmented wheel; the
 * segment under the pointer sets the multiplier. The stopping point is the round's real seed-derived
 * segment (`raw % segments`, recomputed from the sealed `raw`), so the rotor lands where settle says.
 */
export const WheelScreen = ({ deployment, walletClient, trustAcknowledged, myAddress }: {
  deployment: GameDeployment; walletClient?: viem.WalletClient; trustAcknowledged: boolean; myAddress?: viem.Hex
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
  const mults = perSegment(risk, segments)
  const params: WheelParams | undefined = mults !== undefined ? { risk, segments } : undefined
  const maxMult = mults?.reduce((m, x) => (x > m ? x : m), 0n)
  const segs: WheelSeg[] = mults ? mults.map((x) => ({ tier: tierOf(x) })) : []
  const dist = mults ? distribution(mults) : []

  const busy = session.status === 'opening' || session.status === 'playing'
  const canOpen = walletClient !== undefined && trustAcknowledged && !busy
  const canSpin = session.ready && !busy && stake !== undefined && params !== undefined

  const spin = () => {
    if (stake === undefined || params === undefined) return
    void session.play(stake, params)
  }

  const last = session.history.length > 0 ? session.history[session.history.length - 1] : undefined
  const landed = last ? wheelSegment(last.raw, segments) : undefined
  const wins = session.history.filter((r) => r.win).length
  const net = session.history.reduce((sum, r) => sum + r.playerDelta, 0n)

  const spinLabel = session.status === 'playing' ? 'Spinning…' : 'Spin'
  const openLabel = session.status === 'opening' ? 'Opening…' : 'Open table'

  const hub = last ? (
    <span>
      <b style={{ fontSize: 'clamp(20px, 3.4vw, 34px)', color: last.win ? '#6fe0a4' : '#e0796d' }}>{fmtMult(last.multiplierX100)}</b>
      <span style={{ display: 'block', fontSize: 10, letterSpacing: '.14em', color: '#8fa093' }}>{last.win ? 'PAID' : 'NO PAY'}</span>
    </span>
  ) : (
    <span style={{ fontSize: 12, letterSpacing: '.2em', color: '#8fa093' }}>SPIN</span>
  )

  return (
    <>
      <GameStage title="WHEEL" subtitle={`${segments} segments · ${risk} risk`}>
        <MultiWheel segs={segs} landed={landed} spinId={session.history.length} hub={hub} idleHint="set your risk & segments, then spin" />
      </GameStage>

      <div className="tray-col">
        <BetTray
          amount={amount}
          onAmount={setAmount}
          action={
            session.ready ? (
              <button className="primary" onClick={spin} disabled={!canSpin}>{spinLabel}</button>
            ) : (
              <button className="primary" onClick={() => void session.start()} disabled={!canOpen}>{openLabel}</button>
            )
          }
        >
          <DiffChips label="risk" options={RISKS} value={risk} onChange={setRisk} disabled={busy} />
          <DiffChips label="segments" options={SUPPORTED_SEGMENTS.map(String)} value={String(segments)} onChange={(v) => setSegments(Number(v))} disabled={busy} />
          {dist.length > 0 ? (
            <p className="tray-hint">
              {dist.map((d) => (
                <span key={d.mult.toString()} className="tag" style={{ marginRight: 4 }}>
                  <span className="mono">{fmtMult(d.mult)}</span> ×{d.count}
                </span>
              ))}
              {maxMult !== undefined && maxMult > 0n && <span className="muted"> · up to {fmtMult(maxMult)} · illustrative</span>}
            </p>
          ) : (
            <p className="tray-hint"><span className="bad">no paytable for {risk} risk at {segments} segments</span></p>
          )}
          {!walletClient && <p className="tray-hint">connect a wallet to play</p>}
          {walletClient && !trustAcknowledged && <p className="tray-hint">tap "Got it" on the fairness note above first</p>}
          {last && (
            <p className={last.win ? 'ok' : 'bad'}>
              landed {fmtMult(last.multiplierX100)} · {last.playerDelta >= 0n ? '+' : ''}{viem.formatEther(last.playerDelta)}
            </p>
          )}
          {session.error && <p className="bad">{session.error}</p>}
        </BetTray>

        <MetaPanel tabs={['Recent', 'Stats']}>
          {myAddress && session.history.length > 0 ? (
            <span>
              <b>{net >= 0n ? '+' : ''}{viem.formatEther(net)}</b> net · {wins}/{session.history.length} won
              {session.commit && <span className="muted"> · commit {session.commit.slice(0, 10)}…</span>}
            </span>
          ) : (
            <span className="muted">{session.ready ? 'table open — set the wheel and Spin' : 'no spins yet'}</span>
          )}
        </MetaPanel>
      </div>

      {myAddress && session.history.length > 0 && (
        <>
          <h2>Your book</h2>
          <details className="history">
            <summary>
              {session.history.length} spin{session.history.length === 1 ? '' : 's'}
              <span className="muted"> · {wins}/{session.history.length} won · {viem.formatEther(net)} net</span>
            </summary>
            {[...session.history].reverse().map((record) => <RoundReceipt key={record.round} record={record} />)}
          </details>
        </>
      )}
    </>
  )
}
