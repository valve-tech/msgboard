import { useState } from 'react'
import * as viem from 'viem'
import {
  dealThreeCard, settleThreeCard, commitThreeCard, verifyThreeCard, type ThreeCardDecision,
} from '@msgboard/games'
import type { GameDeployment } from '../config'
import { StakeInput, parseStake } from './StakeInput'
import { InfoDot } from './Meta'
import { randomDeckSeed, Card, CardBack, fmtMultD } from './decisionShared'

type Phase = 'idle' | 'decide' | 'done'
interface Hand {
  seed: bigint; commit: viem.Hex; player: number[]; dealer: number[]
  decision?: ThreeCardDecision; delta?: bigint; verified?: boolean
}

/**
 * Three Card Poker — single-decision dealer game. Deal reveals YOUR 3 cards (the dealer's stay face
 * down, committed); you Play or Fold; settling reveals the dealer and your browser re-checks the deal
 * against the disclosed seed (provably fair). In-process house, same trust model as Mines.
 */
export const ThreeCardPokerScreen = ({ deployment: _d, walletClient, trustAcknowledged, myAddress }: {
  deployment: GameDeployment; walletClient?: viem.WalletClient; trustAcknowledged: boolean; myAddress?: viem.Hex
}) => {
  const [amount, setAmount] = useState('0.1')
  const [phase, setPhase] = useState<Phase>('idle')
  const [hand, setHand] = useState<Hand>()
  const [history, setHistory] = useState<Hand[]>([])

  const stake = parseStake(amount)
  const canDeal = walletClient !== undefined && trustAcknowledged && stake !== undefined && phase !== 'decide'

  const deal = () => {
    if (stake === undefined) return
    const seed = randomDeckSeed()
    const d = dealThreeCard(seed)
    setHand({ seed, commit: commitThreeCard(seed), player: d.player, dealer: d.dealer })
    setPhase('decide')
  }

  const decide = (decision: ThreeCardDecision) => {
    if (!hand || stake === undefined) return
    const out = settleThreeCard(stake, hand.seed, decision)
    const v = verifyThreeCard({ commit: hand.commit, decision, stake, claimedDelta: out.playerDelta }, hand.seed)
    const done: Hand = { ...hand, decision, delta: out.playerDelta, verified: v.ok }
    setHand(done)
    setHistory((h) => [...h, done])
    setPhase('done')
  }

  const folded = hand?.decision === 'fold'
  return (
    <div>
      <div className="card">
        <h3>Three Card Poker<InfoDot>
          <strong>Beat the dealer with three cards.</strong> See your hand, then Play (match your ante) or
          Fold. The dealer qualifies on Queen-high or better; straights, trips and straight flushes earn an
          ante bonus. Your browser re-checks the deal against the sealed seed.</InfoDot></h3>
        <div className="row">
          <StakeInput value={amount} onChange={setAmount} />
          <button onClick={deal} disabled={!canDeal}>{phase === 'decide' ? 'In hand…' : 'Deal'}</button>
          {!walletClient && <span className="muted">connect a wallet to play</span>}
          {walletClient && !trustAcknowledged && <span className="muted">tap "Got it" on the fairness note above first</span>}
        </div>

        {hand && (
          <div style={{ marginTop: '0.75rem' }}>
            <p className="muted">your hand</p>
            <div className="row">{hand.player.map((c) => <Card key={c} index={c} />)}</div>
            <p className="muted" style={{ marginTop: '0.5rem' }}>dealer</p>
            <div className="row">
              {phase === 'decide' ? <><CardBack /><CardBack /><CardBack /></> : hand.dealer.map((c) => <Card key={c} index={c} />)}
            </div>
            {phase === 'decide' && (
              <div className="row" style={{ marginTop: '0.6rem' }}>
                <button onClick={() => decide('play')}>Play (+{amount} ante)</button>
                <button className="secondary" onClick={() => decide('fold')}>Fold</button>
              </div>
            )}
            {phase === 'done' && hand.delta !== undefined && (
              <p style={{ marginTop: '0.6rem' }} className={hand.delta >= 0n ? 'ok' : 'bad'}>
                {folded ? 'folded · ' : ''}{hand.delta >= 0n ? '+' : ''}{viem.formatEther(hand.delta)}{' '}
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
                  <span>{h.player.map((c) => <Card key={c} index={c} />)} <span className="muted">vs</span> {h.dealer.map((c) => <Card key={`d${c}`} index={c} dim />)}</span>
                  <span className={(h.delta ?? 0n) >= 0n ? 'ok' : 'bad'}>{(h.delta ?? 0n) >= 0n ? '+' : ''}{viem.formatEther(h.delta ?? 0n)}</span>
                </div>
                <p className="card-meta muted">{h.decision} · {h.verified ? 'verify ✓' : 'verify ✗'} · {fmtMultD(100n)} ante</p>
              </div>
            ))}
          </details>
        </>
      )}
    </div>
  )
}
