import { useState } from 'react'
import * as viem from 'viem'
import { monte, monteMultiplierX100, monteWinningSlot, SLOTS, type MonteParams } from '@msgboard/games'
import type { GameDeployment } from '../config'
import { useSession, type RoundRecord } from '../hooks/useSession'
import { parseStake } from './StakeInput'
import { TurnTiming } from './TurnTiming'
import { Card, CardBack } from './decisionShared'
import { GameStage } from './shell/GameStage'
import { BetTray } from './shell/BetTray'
import { MetaPanel } from './shell/MetaPanel'
import { FeltTable } from './stages/FeltTable'

const QUEEN_HEARTS = 42 // (Q=12-2)*4 + hearts(2) — "the lady"
const fmtMult = (x100: bigint): string => `${(Number(x100) / 100).toFixed(2)}x`

const RoundReceipt = ({ record }: { record: RoundRecord }) => (
  <div className="card">
    <div className="row" style={{ justifyContent: 'space-between' }}>
      <span>
        <span className="tag">round {record.round}</span>
        {viem.formatEther(record.stake)} staked
        {record.win ? <span className="tag ok">found her · {fmtMult(record.multiplierX100)}</span> : <span className="tag">missed</span>}
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
  const busy = session.status === 'opening' || session.status === 'playing'
  const canOpen = walletClient !== undefined && trustAcknowledged && !busy
  const canPlay = session.ready && !busy && stake !== undefined

  const play = () => {
    if (stake === undefined) return
    void session.play(stake, { pick })
  }

  const last = session.history.length > 0 ? session.history[session.history.length - 1] : undefined
  const winning = last ? monteWinningSlot(last.raw) : undefined
  const wins = session.history.filter((r) => r.win).length
  const net = session.history.reduce((sum, r) => sum + r.playerDelta, 0n)

  // Three tappable cards on the felt: pick one, then Flip reveals the lady (Q♥) at the winning slot.
  const cardsNode = (
    <div className="row" style={{ gap: 'clamp(12px, 3vw, 34px)', alignItems: 'flex-start' }}>
      {Array.from({ length: SLOTS }, (_, i) => {
        const isWin = winning === i
        const isPick = pick === i
        const ring = winning !== undefined
          ? (isWin ? '#5cc98f' : isPick ? '#e0574a' : undefined)
          : (isPick ? 'var(--gold-live)' : undefined)
        return (
          <button
            key={i}
            type="button"
            onClick={() => setPick(i)}
            style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, borderRadius: 12, outline: ring ? `2px solid ${ring}` : 'none', outlineOffset: 6 }}
            aria-label={`card ${i + 1}${isPick ? ', your pick' : ''}`}
          >
            {winning !== undefined && isWin ? <Card index={QUEEN_HEARTS} big /> : <CardBack big />}
            <span className={isWin && winning !== undefined ? 'ok' : 'muted'} style={{ letterSpacing: '0.12em', fontSize: 12 }}>
              {isWin && winning !== undefined ? '♛ the lady' : isPick ? '▲ your pick' : `card ${i + 1}`}
            </span>
          </button>
        )
      })}
    </div>
  )

  const flipLabel = session.status === 'playing' ? 'Flipping…' : 'Flip'
  const openLabel = session.status === 'opening' ? 'Opening…' : 'Open table'

  return (
    <>
      <GameStage title="THREE-CARD MONTE" subtitle="find the lady">
        <FeltTable player={cardsNode} arc={`FIND THE LADY · PAYS ${fmtMult(multiplierX100)}`} centerMark={null} />
      </GameStage>

      <div className="tray-col">
        <BetTray
          amount={amount}
          onAmount={setAmount}
          action={
            session.ready ? (
              <button className="primary" onClick={play} disabled={!canPlay}>{flipLabel}</button>
            ) : (
              <button className="primary" onClick={() => void session.start()} disabled={!canOpen}>{openLabel}</button>
            )
          }
        >
          <p className="tray-hint">
            tap a card, then Flip · <b style={{ color: 'var(--gold)' }}>pays {fmtMult(multiplierX100)}</b>
            <span className="muted"> · 1 in {SLOTS}</span>
          </p>
          {!walletClient && <p className="tray-hint">connect a wallet to play</p>}
          {walletClient && !trustAcknowledged && <p className="tray-hint">tap "Got it" on the fairness note above first</p>}
          {last && winning !== undefined && (
            <p className={last.win ? 'ok' : 'bad'}>
              {last.win ? `found her! +${viem.formatEther(last.playerDelta)}` : `she was card ${winning + 1} · ${viem.formatEther(last.playerDelta)}`}
            </p>
          )}
          {session.error && <p className="bad">{session.error}</p>}
        </BetTray>

        <MetaPanel tabs={['Recent', 'Stats']}>
          {myAddress && session.history.length > 0 ? (
            <span>
              <b>{net >= 0n ? '+' : ''}{viem.formatEther(net)}</b> net · {wins}/{session.history.length} found
              {session.commit && <span className="muted"> · commit {session.commit.slice(0, 10)}…</span>}
            </span>
          ) : (
            <span className="muted">{session.ready ? 'table open — tap a card and Flip' : 'no flips yet'}</span>
          )}
        </MetaPanel>
      </div>

      {myAddress && session.history.length > 0 && (
        <>
          <h2>Your book</h2>
          <details className="history">
            <summary>
              {session.history.length} flip{session.history.length === 1 ? '' : 's'}
              <span className="muted"> · {wins}/{session.history.length} found · {viem.formatEther(net)} net</span>
            </summary>
            {[...session.history].reverse().map((record) => (
              <RoundReceipt key={record.round} record={record} />
            ))}
          </details>
        </>
      )}
    </>
  )
}
