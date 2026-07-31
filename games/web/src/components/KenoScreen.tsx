import { useEffect, useState } from 'react'
import * as viem from 'viem'
import {
  keno,
  kenoDraw,
  kenoHits,
  BASE_PAYTABLE_X100,
  applyEdgeX100,
  MAX_PICKS,
  POOL,
  DEFAULT_DRAWN,
  type KenoParams,
} from '@msgboard/games'
import type { GameDeployment } from '../config'
import { useSession, type RoundRecord } from '../hooks/useSession'
import { parseStake } from './StakeInput'
import { TurnTiming } from './TurnTiming'
import { GameStage } from './shell/GameStage'
import { HowItWorksLink } from './HowItWorks'
import { BetTray } from './shell/BetTray'
import { MetaPanel } from './shell/MetaPanel'
import { fmtMult } from './ladderShared'
import { NumberBoard } from './stages/NumberBoard'

/** the edge-applied {hits → multiplier} ladder for a pick-count, straight from the module paytable. */
const payoutLadder = (pickCount: number): { hits: number; multiplierX100: bigint }[] => {
  const row = BASE_PAYTABLE_X100[pickCount]
  if (!row) return []
  const ladder: { hits: number; multiplierX100: bigint }[] = []
  for (let hits = 0; hits < row.length; hits++) {
    const fair = row[hits] ?? 0n
    if (fair > 0n) ladder.push({ hits, multiplierX100: applyEdgeX100(fair) })
  }
  return ladder
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
 * OFF-CHAIN session-game screen (Keno), on the shared NumberBoard surface. Pick 1–10 of 40; the round
 * draws 10 and pays by how many you match. The reveal lights up the round's real draw (`kenoDraw(raw)`,
 * recomputed from the sealed `raw` — the same set settle counts hits against), not a random light show.
 */
export const KenoScreen = ({ deployment, walletClient, trustAcknowledged, myAddress }: {
  deployment: GameDeployment; walletClient?: viem.WalletClient; trustAcknowledged: boolean; myAddress?: viem.Hex
}) => {
  const [amount, setAmount] = useState('0.1')
  const [picks, setPicks] = useState<number[]>([])
  // show the last draw over the grid until the player edits their picks for the next round.
  const [showResult, setShowResult] = useState(false)

  const session = useSession<KenoParams>({
    game: keno,
    walletClient,
    chainId: deployment.chainId,
    boardRpc: deployment.boardRpc,
    gameLabel: 'keno',
  })

  const stake = parseStake(amount)
  const picksOk = picks.length >= 1 && picks.length <= MAX_PICKS
  const ladder = picksOk ? payoutLadder(picks.length) : []
  const capReached = picks.length >= MAX_PICKS

  const busy = session.status === 'opening' || session.status === 'playing'
  const canOpen = walletClient !== undefined && trustAcknowledged && !busy
  const canRoll = session.ready && !busy && stake !== undefined && picksOk

  // reveal the draw whenever a new round lands.
  useEffect(() => {
    if (session.history.length > 0) setShowResult(true)
  }, [session.history.length])

  const togglePick = (n: number) => {
    if (busy) return
    setShowResult(false) // editing picks starts a fresh selection — drop the stale draw overlay
    setPicks((prev) =>
      prev.includes(n) ? prev.filter((p) => p !== n) : prev.length >= MAX_PICKS ? prev : [...prev, n],
    )
  }
  const clearPicks = () => {
    setShowResult(false)
    setPicks([])
  }

  const roll = () => {
    if (stake === undefined || !picksOk) return
    void session.play(stake, { picks: [...picks].sort((a, b) => a - b) })
  }

  const last = session.history.length > 0 ? session.history[session.history.length - 1] : undefined
  const drawn = showResult && last ? [...kenoDraw(last.raw, DEFAULT_DRAWN)] : undefined
  const hits = drawn ? kenoHits(picks, new Set(drawn)) : undefined
  const wins = session.history.filter((r) => r.win).length
  const net = session.history.reduce((sum, r) => sum + r.playerDelta, 0n)

  const rollLabel = session.status === 'playing' ? 'Rolling…' : 'Roll'
  const openLabel = session.status === 'opening' ? 'Opening…' : 'Open table'

  const header = drawn ? (
    <>
      <b style={{ color: last!.win ? '#6fe0a4' : '#e0796d' }}>{hits} hit{hits === 1 ? '' : 's'}</b>
      <span>·</span>
      <span>{last!.win ? <span className="ok">won {fmtMult(last!.multiplierX100)}</span> : 'no pay'}</span>
      <span className="muted">· drew {DEFAULT_DRAWN} of {POOL}</span>
    </>
  ) : (
    <>
      <b>{picks.length}/{MAX_PICKS}</b>
      <span className="muted">picked · pick 1–{MAX_PICKS} of {POOL}, draws {DEFAULT_DRAWN}</span>
    </>
  )

  return (
    <>
      <GameStage title="KENO" subtitle={`pick up to ${MAX_PICKS} · 10-of-${POOL} draw`} action={<HowItWorksLink />}>
        <NumberBoard
          pool={POOL}
          columns={8}
          picks={picks}
          drawn={drawn}
          onToggle={togglePick}
          disabled={busy}
          capReached={capReached}
          drawId={session.history.length}
          header={header}
          idleHint="tap numbers to build your card, then Roll"
        />
      </GameStage>

      <div className="tray-col">
        <BetTray
          amount={amount}
          onAmount={setAmount}
          action={
            session.ready ? (
              <button className="primary" onClick={roll} disabled={!canRoll}>{rollLabel}</button>
            ) : (
              <button className="primary" onClick={() => void session.start()} disabled={!canOpen}>{openLabel}</button>
            )
          }
        >
          <p className="tray-hint">
            <b style={{ color: 'var(--gold-live)' }}>{picks.length}/{MAX_PICKS}</b> picked
            {picks.length > 0 && (
              <> · <button type="button" className="b-link" onClick={clearPicks} disabled={busy}>clear</button></>
            )}
          </p>
          {picksOk && (
            <p className="tray-hint">
              pays by hits:{' '}
              {ladder.length === 0
                ? <span className="bad">no paying hit-count for {picks.length} pick{picks.length === 1 ? '' : 's'}</span>
                : ladder.map(({ hits: h, multiplierX100 }) => (
                    <span key={h} className="tag" style={{ marginRight: 4 }}>{h}→{fmtMult(multiplierX100)}</span>
                  ))}
            </p>
          )}
          {!picksOk && <p className="tray-hint"><span className="bad">pick at least one number</span></p>}
          {!walletClient && <p className="tray-hint">connect a wallet to play</p>}
          {walletClient && !trustAcknowledged && <p className="tray-hint">tap "Got it" on the fairness note above first</p>}
          {last && showResult && (
            <p className={last.win ? 'ok' : 'bad'}>
              {hits} hit{hits === 1 ? '' : 's'} · {fmtMult(last.multiplierX100)} · {last.playerDelta >= 0n ? '+' : ''}{viem.formatEther(last.playerDelta)}
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
            <span className="muted">{session.ready ? 'table open — build your card and Roll' : 'no rolls yet'}</span>
          )}
        </MetaPanel>
      </div>

      {myAddress && session.history.length > 0 && (
        <>
          <h2>Your book</h2>
          <details className="history">
            <summary>
              {session.history.length} roll{session.history.length === 1 ? '' : 's'}
              <span className="muted"> · {wins}/{session.history.length} won · {viem.formatEther(net)} net</span>
            </summary>
            {[...session.history].reverse().map((record) => <RoundReceipt key={record.round} record={record} />)}
          </details>
        </>
      )}
    </>
  )
}
