import { useState } from 'react'
import * as viem from 'viem'
import {
  drawVideoPoker, settleVideoPoker, commitVideoPoker, verifyVideoPoker, FiveCardCategory,
} from '@msgboard/games'
import type { GameDeployment } from '../config'
import { StakeInput, parseStake } from './StakeInput'
import { InfoDot } from './Meta'
import { randomDeckSeed, Card } from './decisionShared'

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

type Phase = 'idle' | 'hold' | 'done'
interface Hand { seed: bigint; commit: viem.Hex; dealt: number[]; final?: number[]; category?: number; delta?: bigint; verified?: boolean }

/**
 * Video Poker (Jacks or Better) — single-decision draw game. Deal 5, toggle which to HOLD, then Draw:
 * discards are replaced from the same sealed deck (you choose holds without seeing the replacements),
 * the final hand is paid by the 9/6 paytable, and your browser re-checks it against the disclosed seed.
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

  return (
    <div>
      <div className="card">
        <h3>Video Poker<InfoDot>
          <strong>Jacks or Better.</strong> Tap the cards you want to keep, then Draw — the rest are
          replaced from the sealed deck you can't see ahead. Pairs of jacks or better pay; a royal flush
          pays 800×. Your browser re-checks the draw against the disclosed seed.</InfoDot></h3>
        <div className="row">
          <StakeInput value={amount} onChange={setAmount} />
          <button onClick={deal} disabled={!canDeal}>{phase === 'hold' ? 'In hand…' : 'Deal'}</button>
          {!walletClient && <span className="muted">connect a wallet to play</span>}
          {walletClient && !trustAcknowledged && <span className="muted">tap "Got it" on the fairness note above first</span>}
        </div>

        {hand && (
          <div style={{ marginTop: '0.75rem' }}>
            <div className="row">
              {(phase === 'done' ? hand.final! : hand.dealt).map((c, i) => (
                <span key={i} style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: '0.2rem' }}>
                  <Card index={c} />
                  {phase === 'hold' && (
                    <button type="button" className={`chip${holds[i] ? ' active' : ''}`} onClick={() => setHolds((hs) => hs.map((h, j) => (j === i ? !h : h)))}>
                      {holds[i] ? 'held' : 'hold'}
                    </button>
                  )}
                </span>
              ))}
            </div>
            {phase === 'hold' && <div className="row" style={{ marginTop: '0.6rem' }}><button onClick={draw}>Draw</button></div>}
            {phase === 'done' && hand.delta !== undefined && (
              <p style={{ marginTop: '0.6rem' }} className={hand.delta >= 0n ? 'ok' : 'bad'}>
                {CATEGORY_LABEL[hand.category!]} · {hand.delta >= 0n ? '+' : ''}{viem.formatEther(hand.delta)}{' '}
                <span className="muted">· commit {hand.commit.slice(0, 10)}… · {hand.verified ? 'verify ✓' : 'verify ✗'}</span>
              </p>
            )}
          </div>
        )}
        {phase === 'done' && <div className="row" style={{ marginTop: '0.5rem' }}><button onClick={deal} disabled={!canDeal}>Deal again</button></div>}
      </div>

      {myAddress && history.length > 0 && (
        <>
          <h2>Your book</h2>
          <details className="history" open>
            <summary>{history.length} hand{history.length === 1 ? '' : 's'}
              <span className="muted"> · {viem.formatEther(history.reduce((s, h) => s + (h.delta ?? 0n), 0n))} net</span>
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
    </div>
  )
}
