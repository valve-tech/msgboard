import { useState } from 'react'
import * as viem from 'viem'
import {
  dealThreeCard, settleThreeCard, commitThreeCard, verifyThreeCard, type ThreeCardDecision,
} from '@msgboard/games'
import type { GameDeployment } from '../config'
import { parseStake } from './StakeInput'
import { randomDeckSeed, Card, CardBack } from './decisionShared'
import { GameStage } from './shell/GameStage'
import { BetTray } from './shell/BetTray'
import { MetaPanel } from './shell/MetaPanel'
import { FeltTable } from './stages/FeltTable'

type Phase = 'idle' | 'decide' | 'done'
interface Hand {
  seed: bigint; commit: viem.Hex; player: number[]; dealer: number[]
  decision?: ThreeCardDecision; delta?: bigint; verified?: boolean
}

/**
 * Three Card Poker — single-decision dealer game on the felt. Deal reveals YOUR 3 cards in the
 * foreground; the dealer's 3 stay face-down at the far end (committed). Play (match your ante) or Fold;
 * settling flips the dealer and your browser re-checks the deal against the disclosed seed. The dealer
 * qualifies on Queen-high; straights/trips/straight-flushes earn an ante bonus. In-process (Mines model).
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
  const net = history.reduce((s, h) => s + (h.delta ?? 0n), 0n)

  const dealerNode = hand && (
    <div className="row" style={{ gap: 6 }}>
      {phase === 'decide' ? <><CardBack /><CardBack /><CardBack /></> : hand.dealer.map((c) => <Card key={c} index={c} />)}
    </div>
  )
  const playerNode = hand && (
    <div className="row" style={{ gap: 8 }}>{hand.player.map((c) => <Card key={c} index={c} big />)}</div>
  )
  const spotsNode = <div className="spot main">{amount}<span style={{ display: 'block', fontSize: 9, opacity: 0.7, fontWeight: 400 }}>ante</span></div>

  const dealLabel = phase === 'decide' ? 'In hand…' : phase === 'done' ? 'Deal again' : 'Deal'

  return (
    <>
      <GameStage title="THREE CARD POKER" subtitle="beat the dealer · queen-high qualifies">
        <FeltTable dealer={dealerNode} player={playerNode} spots={spotsNode} centerMark={null} />
      </GameStage>

      <div className="tray-col">
        <BetTray
          amount={amount}
          onAmount={setAmount}
          action={<button className="primary" onClick={deal} disabled={!canDeal}>{dealLabel}</button>}
        >
          {phase === 'decide' && (
            <>
              <div className="acts">
                <button className="b-hit" onClick={() => decide('play')}>Play · +{amount}</button>
                <button className="b-stand" onClick={() => decide('fold')}>Fold</button>
              </div>
              <p className="tray-hint">straights · trips · straight flush pay an ante bonus</p>
            </>
          )}
          {!walletClient && <p className="tray-hint">connect a wallet to play</p>}
          {walletClient && !trustAcknowledged && <p className="tray-hint">tap "Got it" on the fairness note above first</p>}
          {phase === 'done' && hand?.delta !== undefined && (
            <p className={hand.delta >= 0n ? 'ok' : 'bad'}>
              {folded ? 'folded · ' : ''}{hand.delta >= 0n ? '+' : ''}{viem.formatEther(hand.delta)}
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
          <details className="history">
            <summary>{history.length} hand{history.length === 1 ? '' : 's'}
              <span className="muted"> · {viem.formatEther(net)} net</span>
            </summary>
            {[...history].reverse().map((h, i) => (
              <div className="card" key={i}>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span>{h.player.map((c) => <Card key={c} index={c} />)} <span className="muted">vs</span> {h.dealer.map((c) => <Card key={`d${c}`} index={c} dim />)}</span>
                  <span className={(h.delta ?? 0n) >= 0n ? 'ok' : 'bad'}>{(h.delta ?? 0n) >= 0n ? '+' : ''}{viem.formatEther(h.delta ?? 0n)}</span>
                </div>
                <p className="card-meta muted">{h.decision} · {h.verified ? 'verify ✓' : 'verify ✗'}</p>
              </div>
            ))}
          </details>
        </>
      )}
    </>
  )
}
