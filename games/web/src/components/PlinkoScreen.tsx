import { useState } from 'react'
import * as viem from 'viem'
import {
  plinko,
  plinkoFairTableX100,
  plinkoMultiplierX100,
  DEFAULT_ROWS,
  type PlinkoParams,
  type PlinkoRisk,
} from '@msgboard/games'
import type { GameDeployment } from '../config'
import { useSession, type RoundRecord } from '../hooks/useSession'
import { parseStake } from './StakeInput'
import { TurnTiming } from './TurnTiming'
import { GameStage } from './shell/GameStage'
import { HowItWorksLink } from './HowItWorks'
import { BetTray } from './shell/BetTray'
import { MetaPanel } from './shell/MetaPanel'
import { DiffChips, fmtMult, fmtMultShort } from './ladderShared'
import { DropBoard, type DropBucket } from './stages/DropBoard'

/** the row counts this screen offers; default 16 matches the package's DEFAULT_ROWS. */
const ALLOWED_ROWS = [8, 12, 16] as const
const RISKS: readonly PlinkoRisk[] = ['low', 'medium', 'high']

/** the edged per-bucket multiplier ladder for a (risk, rows) pair, straight from the package helpers. */
const ladderFor = (risk: PlinkoRisk, rows: number): bigint[] | undefined => {
  try {
    const fair = plinkoFairTableX100(risk, rows)
    return fair.map((_, bucket) => plinkoMultiplierX100(risk, rows, bucket))
  } catch {
    return undefined
  }
}

/** payout tier for a bucket: a loss (<1x), near-even (~1x), or a real multiplier (>=2x). */
const tierOf = (x100: bigint): DropBucket['tier'] => (x100 >= 200n ? 'hi' : x100 >= 100n ? 'mid' : 'lo')

/** the committed deflections of a settled drop, low bit = first (top) row — the same bits settle counts. */
const pathOf = (raw: bigint, rows: number): number[] =>
  Array.from({ length: rows }, (_, i) => Number((raw >> BigInt(i)) & 1n))

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
 * OFF-CHAIN session-game screen (Plinko), on the shared DropBoard surface. Drop a ball through the
 * pegs; the bucket it settles in sets the multiplier. The descent is the round's real committed path
 * (recomputed from the sealed `raw`), not decoration — the ball walks the same deflections settle counts.
 */
export const PlinkoScreen = ({ deployment, walletClient, trustAcknowledged, myAddress }: {
  deployment: GameDeployment; walletClient?: viem.WalletClient; trustAcknowledged: boolean; myAddress?: viem.Hex
}) => {
  const [amount, setAmount] = useState('0.1')
  const [risk, setRisk] = useState<PlinkoRisk>('medium')
  const [rows, setRows] = useState<number>(DEFAULT_ROWS)

  const session = useSession<PlinkoParams>({
    game: plinko,
    walletClient,
    chainId: deployment.chainId,
    boardRpc: deployment.boardRpc,
    gameLabel: 'plinko',
  })

  const stake = parseStake(amount)
  const rowsOk = (ALLOWED_ROWS as readonly number[]).includes(rows)
  const ladder = rowsOk ? ladderFor(risk, rows) : undefined
  const params: PlinkoParams | undefined = rowsOk && ladder !== undefined ? { rows, risk } : undefined
  const maxMult = ladder?.reduce((m, x) => (x > m ? x : m), 0n)
  const buckets: DropBucket[] = ladder ? ladder.map((x) => ({ mult: fmtMultShort(x), tier: tierOf(x) })) : []

  const busy = session.status === 'opening' || session.status === 'playing'
  const canOpen = walletClient !== undefined && trustAcknowledged && !busy
  const canDrop = session.ready && !busy && stake !== undefined && params !== undefined

  const drop = () => {
    if (stake === undefined || params === undefined) return
    void session.play(stake, params)
  }

  const last = session.history.length > 0 ? session.history[session.history.length - 1] : undefined
  const path = last ? pathOf(last.raw, rows) : undefined
  const wins = session.history.filter((r) => r.win).length
  const net = session.history.reduce((sum, r) => sum + r.playerDelta, 0n)

  const dropLabel = session.status === 'playing' ? 'Dropping…' : 'Drop'
  const openLabel = session.status === 'opening' ? 'Opening…' : 'Open table'

  return (
    <>
      <GameStage title="PLINKO" subtitle={`${rows} rows · ${risk} risk`} action={<HowItWorksLink />}>
        <DropBoard rows={rows} buckets={buckets} path={path} dropId={session.history.length} idleHint="set your risk & rows, then drop" />
      </GameStage>

      <div className="tray-col">
        <BetTray
          amount={amount}
          onAmount={setAmount}
          action={
            session.ready ? (
              <button className="primary" onClick={drop} disabled={!canDrop}>{dropLabel}</button>
            ) : (
              <button className="primary" onClick={() => void session.start()} disabled={!canOpen}>{openLabel}</button>
            )
          }
        >
          <DiffChips label="risk" options={RISKS} value={risk} onChange={setRisk} disabled={busy} />
          <DiffChips label="rows" options={ALLOWED_ROWS.map(String)} value={String(rows)} onChange={(v) => setRows(Number(v))} disabled={busy} />
          <p className="tray-hint">
            {maxMult !== undefined && maxMult > 0n
              ? <>edge buckets pay up to <b style={{ color: 'var(--gold-live)' }}>{fmtMult(maxMult)}</b><span className="muted"> · payouts illustrative</span></>
              : <span className="bad">no paytable for {risk} risk at {rows} rows</span>}
          </p>
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
            <span className="muted">{session.ready ? 'table open — set risk & rows and Drop' : 'no drops yet'}</span>
          )}
        </MetaPanel>
      </div>

      {myAddress && session.history.length > 0 && (
        <>
          <h2>Your book</h2>
          <details className="history">
            <summary>
              {session.history.length} drop{session.history.length === 1 ? '' : 's'}
              <span className="muted"> · {wins}/{session.history.length} won · {viem.formatEther(net)} net</span>
            </summary>
            {[...session.history].reverse().map((record) => <RoundReceipt key={record.round} record={record} />)}
          </details>
        </>
      )}
    </>
  )
}
