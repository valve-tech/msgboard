import { useState } from 'react'
import * as viem from 'viem'
import {
  drawVideoPoker, settleVideoPoker, commitVideoPoker, verifyVideoPoker, FiveCardCategory,
} from '@msgboard/games'
import type { GameDeployment } from '../config'
import { parseStake } from './StakeInput'
import { randomDeckSeed, Card, CardBack } from './decisionShared'
import { GameStage } from './shell/GameStage'
import { HowItWorksLink } from './HowItWorks'
import { BetTray } from './shell/BetTray'
import { MetaPanel } from './shell/MetaPanel'
import { FeltTable } from './stages/FeltTable'

const CATEGORY_LABEL: Record<number, string> = {
  [FiveCardCategory.NOTHING]: 'nothing',
  [FiveCardCategory.JACKS_OR_BETTER]: 'jacks or better',
  [FiveCardCategory.TWO_PAIR]: 'two pair',
  [FiveCardCategory.THREE_OF_A_KIND]: 'three of a kind',
  [FiveCardCategory.STRAIGHT]: 'straight',
  [FiveCardCategory.FLUSH]: 'flush',
  [FiveCardCategory.FULL_HOUSE]: 'full house',
  [FiveCardCategory.FOUR_OF_A_KIND]: 'four of a kind',
  [FiveCardCategory.STRAIGHT_FLUSH]: 'straight flush',
  [FiveCardCategory.ROYAL_FLUSH]: 'royal flush',
}

/** The 9/6 Jacks-or-Better paytable (return multiple per winning category), high → low. */
const PAYTABLE: { cat: FiveCardCategory; label: string; mult: number }[] = [
  { cat: FiveCardCategory.ROYAL_FLUSH, label: 'Royal flush', mult: 800 },
  { cat: FiveCardCategory.STRAIGHT_FLUSH, label: 'Straight flush', mult: 50 },
  { cat: FiveCardCategory.FOUR_OF_A_KIND, label: 'Four of a kind', mult: 25 },
  { cat: FiveCardCategory.FULL_HOUSE, label: 'Full house', mult: 9 },
  { cat: FiveCardCategory.FLUSH, label: 'Flush', mult: 6 },
  { cat: FiveCardCategory.STRAIGHT, label: 'Straight', mult: 4 },
  { cat: FiveCardCategory.THREE_OF_A_KIND, label: 'Three of a kind', mult: 3 },
  { cat: FiveCardCategory.TWO_PAIR, label: 'Two pair', mult: 2 },
  { cat: FiveCardCategory.JACKS_OR_BETTER, label: 'Jacks or better', mult: 1 },
]

type Phase = 'idle' | 'hold' | 'done'
interface Hand { seed: bigint; commit: viem.Hex; dealt: number[]; final?: number[]; category?: number; delta?: bigint; verified?: boolean }

/**
 * Video Poker (Jacks or Better) — single-decision draw. Deal 5 into the foreground, tap the cards to
 * HOLD, then Draw: discards are replaced from the same sealed deck (holds chosen blind), the final hand
 * is paid by the 9/6 paytable docked in the tray (winning row lit), and the browser re-checks it against
 * the disclosed seed. In-process house (Blackjack model).
 */
export const VideoPokerScreen = ({ deployment: _d, walletClient, trustAcknowledged, myAddress }: {
  deployment: GameDeployment; walletClient?: viem.WalletClient; trustAcknowledged: boolean; myAddress?: viem.Hex
}) => {
  const [amount, setAmount] = useState('0.1')
  const [phase, setPhase] = useState<Phase>('idle')
  const [hand, setHand] = useState<Hand>()
  const [holds, setHolds] = useState<boolean[]>([false, false, false, false, false])
  const [history, setHistory] = useState<Hand[]>([])

  const stake = parseStake(amount)
  const canDeal = walletClient !== undefined && trustAcknowledged && stake !== undefined && phase !== 'hold'

  const deal = () => {
    if (stake === undefined) return
    const seed = randomDeckSeed()
    const { dealt } = drawVideoPoker(seed, 0b11111) // reveal the dealt 5 (hold-all view)
    setHand({ seed, commit: commitVideoPoker(seed), dealt })
    setHolds([false, false, false, false, false])
    setPhase('hold')
  }

  const draw = () => {
    if (!hand || stake === undefined) return
    const mask = holds.reduce((m, h, i) => (h ? m | (1 << i) : m), 0)
    const res = drawVideoPoker(hand.seed, mask)
    const out = settleVideoPoker(stake, hand.seed, mask)
    const v = verifyVideoPoker({ commit: hand.commit, holdMask: mask, stake, claimedDelta: out.playerDelta }, hand.seed)
    const done: Hand = { ...hand, final: res.final, category: res.category, delta: out.playerDelta, verified: v.ok }
    setHand(done); setHistory((h) => [...h, done]); setPhase('done')
  }

  const toggleHold = (i: number) => setHolds((hs) => hs.map((h, j) => (j === i ? !h : h)))

  const shown = hand ? (phase === 'done' ? hand.final! : hand.dealt) : undefined
  const net = history.reduce((s, h) => s + (h.delta ?? 0n), 0n)

  const handNode = (
    <div className="row" style={{ gap: 8 }}>
      {(shown ?? [null, null, null, null, null]).map((c, i) => (
        <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 7 }}>
          {c === null ? <CardBack big /> : <Card index={c} big />}
          {phase === 'hold' && (
            <button type="button" className={`chip${holds[i] ? ' active' : ''}`} onClick={() => toggleHold(i)}
              style={{ letterSpacing: '0.1em', minWidth: 52 }}>
              {holds[i] ? 'HELD' : 'hold'}
            </button>
          )}
        </div>
      ))}
    </div>
  )

  const cat = phase === 'done' ? hand?.category : undefined
  const wonRow = cat !== undefined ? PAYTABLE.find((p) => p.cat === cat) : undefined
  const arc = cat !== undefined
    ? `${(CATEGORY_LABEL[cat] ?? '').toUpperCase()}${wonRow ? ` · ${wonRow.mult}×` : ''}`
    : undefined

  const action = phase === 'hold'
    ? <button className="primary" onClick={draw}>Draw</button>
    : <button className="primary" onClick={deal} disabled={!canDeal}>{phase === 'done' ? 'Deal again' : 'Deal'}</button>

  return (
    <>
      <GameStage title="VIDEO POKER" subtitle="jacks or better · 9/6" action={<HowItWorksLink />}>
        <FeltTable player={handNode} arc={arc} centerMark={null} />
      </GameStage>

      <div className="tray-col">
        <BetTray amount={amount} onAmount={setAmount} action={action}>
          {/* Paytable ladder — the winning category lights when the hand settles. */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, fontFamily: 'var(--mono)', fontSize: 11.5 }}>
            {PAYTABLE.map((p) => {
              const on = phase === 'done' && hand?.category === p.cat
              return (
                <div key={p.cat} className="row" style={{
                  justifyContent: 'space-between', padding: '2px 7px', borderRadius: 4,
                  color: on ? 'var(--felt-900, #07150d)' : '#b9b09a',
                  background: on ? 'var(--gold-live, #f0c74a)' : 'transparent',
                  fontWeight: on ? 700 : 400,
                }}>
                  <span style={{ fontFamily: 'var(--sans)' }}>{p.label}</span>
                  <span style={{ fontVariantNumeric: 'tabular-nums' }}>{p.mult}×</span>
                </div>
              )
            })}
          </div>
          {phase === 'hold' && <p className="tray-hint">tap cards to hold, then Draw</p>}
          {!walletClient && <p className="tray-hint">connect a wallet to play</p>}
          {walletClient && !trustAcknowledged && <p className="tray-hint">tap "Got it" on the fairness note above first</p>}
          {phase === 'done' && hand?.delta !== undefined && (
            <p className={hand.delta >= 0n ? 'ok' : 'bad'}>
              {CATEGORY_LABEL[hand.category!]} · {hand.delta >= 0n ? '+' : ''}{viem.formatEther(hand.delta)}
              <span className="muted"> · {hand.verified ? 'verify ✓' : 'verify ✗'}</span>
            </p>
          )}
        </BetTray>

        <MetaPanel tabs={['Recent', 'Stats']}>
          {myAddress && history.length > 0 ? (
            <span><b>{net >= 0n ? '+' : ''}{viem.formatEther(net)}</b> net · {history.length} hand{history.length === 1 ? '' : 's'}</span>
          ) : (
            <span className="muted">no hands yet</span>
          )}
        </MetaPanel>
      </div>

      {myAddress && history.length > 0 && (
        <>
          <h2>Your book</h2>
          <details className="history" open>
            <summary>{history.length} hand{history.length === 1 ? '' : 's'}
              <span className="muted"> · {viem.formatEther(net)} net</span>
            </summary>
            {[...history].reverse().map((h, i) => (
              <div className="card" key={i}>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span>{(h.final ?? h.dealt).map((c) => <Card key={c} index={c} />)}</span>
                  <span className={(h.delta ?? 0n) >= 0n ? 'ok' : 'bad'}>{(h.delta ?? 0n) >= 0n ? '+' : ''}{viem.formatEther(h.delta ?? 0n)}</span>
                </div>
                <p className="card-meta muted">{CATEGORY_LABEL[h.category ?? 0]} · {h.verified ? 'verify ✓' : 'verify ✗'}</p>
              </div>
            ))}
          </details>
        </>
      )}
    </>
  )
}
