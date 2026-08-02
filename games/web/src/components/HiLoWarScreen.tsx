import { useState } from 'react'
import * as viem from 'viem'
import { cardName } from '@msgboard/zk-cards-core'
import type { Bet } from '@msgboard/hilo-war'
import type { GameDeployment } from '../config'
import { useWarSession, type FlipRecord } from '../hooks/useWarSession'
import { TurnTiming } from './TurnTiming'
import { Card, CardBack } from './decisionShared'
import { GameStage } from './shell/GameStage'
import { HowItWorksLink } from './HowItWorks'
import { ControlTray } from './shell/ControlTray'
import { MetaPanel } from './shell/MetaPanel'
import { FeltTable } from './stages/FeltTable'

/** hidden-card glyph for a folded / unrevealed opponent card (compact history log only). */
const CARD_BACK = '🂠'
const renderCard = (i: number | null): string => (i === null ? CARD_BACK : cardName(i))

const winnerLabel = (r: FlipRecord): { text: string; cls: string } => {
  if (r.folded) return r.winner === 'A' ? { text: 'house folded', cls: 'ok' } : { text: 'you folded', cls: 'bad' }
  if (r.winner === null) return { text: 'tie — war carry', cls: 'tag' }
  return r.winner === 'A' ? { text: 'you won', cls: 'ok' } : { text: 'house won', cls: 'bad' }
}

const FlipReceipt = ({ record }: { record: FlipRecord }) => {
  const w = winnerLabel(record)
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span>
          <span className="tag">flip {record.flip}</span>
          <span className="mono">{renderCard(record.myCard)}</span> you · house{' '}
          <span className="mono">{renderCard(record.opponentCard)}</span>
          <span className={`tag ${w.cls === 'tag' ? '' : w.cls}`}> {w.text}</span>
          <span className="tag">bet {record.bet}</span>
        </span>
        <span className={record.deltaA >= 0n ? 'ok' : 'bad'}>
          {record.deltaA >= 0n ? '+' : ''}
          {viem.formatEther(record.deltaA)}
        </span>
      </div>
      <p className="card-meta muted">
        your balance {viem.formatEther(record.balanceA)} · house {viem.formatEther(record.balanceB)}
        {record.pot > 0n && <> · war carry {viem.formatEther(record.pot)}</>} · co-signed by both peers
      </p>
      {record.timing && <p className="card-meta muted"><TurnTiming timing={record.timing} /></p>}
    </div>
  )
}

/** A seat on the felt — a card (or face-down back) over a name caption that lights on a win. */
const Seat = ({ card, label, won, big }: { card: number | null | undefined; label: string; won?: boolean; big?: boolean }) => (
  <div className="row" style={{ flexDirection: 'column', alignItems: 'center', gap: big ? 8 : 6 }}>
    {typeof card === 'number' ? <Card index={card} big={big} /> : <CardBack big={big} />}
    <span className={won ? 'ok' : 'muted'} style={{ letterSpacing: '0.16em', fontSize: big ? 13 : 11, fontWeight: won ? 700 : 400 }}>
      {label}
    </span>
  </div>
)

/** A labelled pair of toggle chips (Hold/Raise, Call/Fold) for the control tray. */
const Toggle = <T extends string>({ label, value, options, onChange, disabled }: {
  label: string; value: T; options: readonly T[]; onChange: (v: T) => void; disabled?: boolean
}) => (
  <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
    <span className="muted" style={{ fontSize: 12, minWidth: 92 }}>{label}</span>
    {options.map((o) => (
      <button key={o} type="button" disabled={disabled} onClick={() => onChange(o)}
        className={o === value ? 'tag ok' : 'tag'} aria-pressed={o === value}
        style={{ cursor: disabled ? 'default' : 'pointer', textTransform: 'capitalize' }}>
        {o.toLowerCase()}
      </button>
    ))}
  </div>
)

/**
 * Hi-Lo War — the two-peer ZK-masked-deck duel. Higher card wins the pot; ties carry a war pot to the
 * next flip. Your card stands up big in the foreground; the house card sits at the far end, face-down
 * until the showdown (or stays hidden on a fold). Hold to ante or Raise to push, and pre-set whether
 * you Call or Fold if the house raises. One shuffle sealed at genesis; no per-flip gas.
 */
export const HiLoWarScreen = ({
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
  const [bet, setBet] = useState<Bet>('HOLD')
  const [onRaise, setOnRaise] = useState<'CALL' | 'FOLD'>('CALL')

  const session = useWarSession({ chainId: deployment.chainId, boardRpc: deployment.boardRpc })

  const busy = session.status === 'opening' || session.status === 'playing' || session.status === 'settling'
  const canOpen = walletClient !== undefined && trustAcknowledged && !busy
  const canFlip = session.ready && !busy
  const settled = session.status === 'settled'

  const flip = () => void session.playFlip({ bet, onRaise })

  const wins = session.history.filter((r) => r.winner === 'A').length
  const net = session.history.reduce((sum, r) => sum + r.deltaA, 0n)
  const last = session.history.length > 0 ? session.history[session.history.length - 1] : undefined
  const pot = session.state?.pot ?? 0n

  const houseNode = <Seat card={last?.opponentCard} label="House" won={last?.winner === 'B'} />
  const youNode = <Seat card={last?.myCard} label="You" won={last?.winner === 'A'} big />

  const primary = session.ready ? (
    <button className="primary" onClick={flip} disabled={!canFlip}>{session.status === 'playing' ? 'Flipping…' : 'Flip'}</button>
  ) : (
    <button className="primary" onClick={() => void session.start()} disabled={!canOpen}>
      {session.status === 'opening' ? 'Shuffling…' : settled ? 'Open new table' : 'Open table'}
    </button>
  )

  return (
    <>
      <GameStage title="HI-LO WAR" subtitle="higher card takes the pot" action={<HowItWorksLink />}>
        <FeltTable
          dealer={houseNode}
          player={youNode}
          centerMark={null}
          spots={pot > 0n ? <div className="spot main" style={{ fontVariantNumeric: 'tabular-nums' }}>war<span style={{ display: 'block', fontSize: 11 }}>◈{viem.formatEther(pot)}</span></div> : undefined}
        />
      </GameStage>

      <div className="tray-col">
        <ControlTray
          title="Your move"
          hint={session.deckCommitment ? <span className="mono">deck {session.deckCommitment.slice(0, 8)}…</span> : undefined}
          action={primary}
        >
          <Toggle label="your bet" value={bet} options={['HOLD', 'RAISE'] as const} onChange={setBet} disabled={busy} />
          <Toggle label="if house raises" value={onRaise} options={['CALL', 'FOLD'] as const} onChange={setOnRaise} disabled={busy} />
          {session.ready && (
            <button className="secondary" onClick={() => void session.settle()} disabled={!canFlip} style={{ width: '100%' }}>
              {session.status === 'settling' ? 'Settling…' : 'Cash out / settle'}
            </button>
          )}
          {!walletClient && <p className="tray-hint">connect a wallet to play</p>}
          {walletClient && !trustAcknowledged && <p className="tray-hint">tap "Got it" on the fairness note above first</p>}
          {last && (
            <p className={last.winner === 'A' ? 'ok' : last.winner === 'B' ? 'bad' : ''}>
              {winnerLabel(last).text} · {last.deltaA >= 0n ? '+' : ''}{viem.formatEther(last.deltaA)}
              {pot > 0n && <span className="muted"> · war carry ◈{viem.formatEther(pot)}</span>}
            </p>
          )}
          {session.error && <p className="bad">{session.error}</p>}
        </ControlTray>

        <MetaPanel tabs={['Recent', 'Stats']}>
          {myAddress && session.history.length > 0 ? (
            <span>
              <b>{net >= 0n ? '+' : ''}{viem.formatEther(net)}</b> net · {wins}/{session.history.length} won
              {session.state && <span className="muted"> · balance {viem.formatEther(session.state.balanceA)}</span>}
            </span>
          ) : (
            <span className="muted">{session.ready ? 'table open — Hold or Raise, then Flip' : 'no flips yet'}</span>
          )}
        </MetaPanel>
      </div>

      {myAddress && session.history.length > 0 && (
        <>
          <h2>Your book</h2>
          <details className="history">
            <summary>
              {session.history.length} flip{session.history.length === 1 ? '' : 's'}
              <span className="muted"> · {wins}/{session.history.length} won · {viem.formatEther(net)} net</span>
            </summary>
            {[...session.history].reverse().map((record) => (
              <FlipReceipt key={record.nonce.toString()} record={record} />
            ))}
          </details>
        </>
      )}
    </>
  )
}
