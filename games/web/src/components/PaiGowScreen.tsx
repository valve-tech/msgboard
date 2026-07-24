import { useState } from 'react'
import * as viem from 'viem'
import {
  dealPaiGow, settlePaiGow, commitPaiGow, verifyPaiGow, playerHouseWayPositions,
  type PaiGowResult,
} from '@msgboard/games'
import type { GameDeployment } from '../config'
import { StakeInput, parseStake } from './StakeInput'
import { InfoDot } from './Meta'
import { randomDeckSeed, Card, CardBack } from './decisionShared'

type Phase = 'idle' | 'set' | 'done'
interface Hand {
  seed: bigint; commit: viem.Hex; player: number[]
  front?: number[]; playerBack?: number[]; dealerFront?: number[]; dealerBack?: number[]
  result?: PaiGowResult; delta?: bigint; verified?: boolean
}

const RESULT_LABEL: Record<PaiGowResult, string> = { lose: 'lost', push: 'push', win: 'won' }

/**
 * Pai Gow Poker — single-decision dealer game. Deal reveals YOUR 7 cards (the dealer's stay committed,
 * face down); you split them by tapping exactly 2 for the low "front" hand — the other 5 form the "back"
 * — or auto-set by the house way. Settling reveals the dealer (set by house way), compares both hands
 * (dealer wins copies), and your browser re-checks the split against the disclosed seed (provably fair).
 * In-process house, same trust model as Mines.
 */
export const PaiGowScreen = ({ deployment: _d, walletClient, trustAcknowledged, myAddress }: {
  deployment: GameDeployment; walletClient?: viem.WalletClient; trustAcknowledged: boolean; myAddress?: viem.Hex
}) => {
  const [amount, setAmount] = useState('0.1')
  const [phase, setPhase] = useState<Phase>('idle')
  const [hand, setHand] = useState<Hand>()
  const [picks, setPicks] = useState<number[]>([])
  const [history, setHistory] = useState<Hand[]>([])

  const stake = parseStake(amount)
  const canDeal = walletClient !== undefined && trustAcknowledged && stake !== undefined && phase !== 'set'

  const deal = () => {
    if (stake === undefined) return
    const seed = randomDeckSeed()
    const { player } = dealPaiGow(seed)
    setHand({ seed, commit: commitPaiGow(seed), player })
    setPicks([])
    setPhase('set')
  }

  const togglePick = (pos: number) => {
    setPicks((p) => (p.includes(pos) ? p.filter((x) => x !== pos) : p.length < 2 ? [...p, pos] : p))
  }

  const settle = (frontPositions: number[]) => {
    if (!hand || stake === undefined) return
    const out = settlePaiGow(stake, hand.seed, frontPositions)
    const v = verifyPaiGow({ commit: hand.commit, frontPositions, stake, claimedDelta: out.playerDelta }, hand.seed)
    const done: Hand = {
      ...hand, front: out.playerFront, playerBack: out.playerBack,
      dealerFront: out.dealerFront, dealerBack: out.dealerBack,
      result: out.result, delta: out.playerDelta, verified: v.ok,
    }
    setHand(done)
    setHistory((h) => [...h, done])
    setPhase('done')
  }

  const set = () => picks.length === 2 && settle(picks)
  const autoSet = () => hand && settle([...playerHouseWayPositions(hand.seed)])

  return (
    <div>
      <div className="card">
        <h3>Pai Gow Poker<InfoDot>
          <strong>Split seven cards into two hands.</strong> Tap 2 cards for your low "front" hand — the
          other 5 form the high "back". Win the bet only by beating the dealer on BOTH hands (the dealer
          sets by the house way and wins copies); win neither and you lose; split and you push. Setting the
          front higher than the back fouls and loses. Your browser re-checks the deal against the sealed
          seed.</InfoDot></h3>
        <div className="row">
          <StakeInput value={amount} onChange={setAmount} />
          <button onClick={deal} disabled={!canDeal}>{phase === 'set' ? 'In hand…' : 'Deal'}</button>
          {!walletClient && <span className="muted">connect a wallet to play</span>}
          {walletClient && !trustAcknowledged && <span className="muted">tap "Got it" on the fairness note above first</span>}
        </div>

        {hand && (
          <div style={{ marginTop: '0.75rem' }}>
            <p className="muted">your seven cards{phase === 'set' ? ` · tap 2 for the front (${picks.length}/2)` : ''}</p>
            <div className="row">
              {(phase === 'done' ? hand.player : hand.player).map((c, i) => (
                <span key={i} style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: '0.2rem' }}>
                  <Card index={c} dim={phase === 'done' && !hand.front!.includes(c)} />
                  {phase === 'set' && (
                    <button type="button" className={`chip${picks.includes(i) ? ' active' : ''}`} onClick={() => togglePick(i)}>
                      {picks.includes(i) ? 'front' : 'set'}
                    </button>
                  )}
                </span>
              ))}
            </div>
            {phase === 'set' && (
              <div className="row" style={{ marginTop: '0.6rem' }}>
                <button onClick={set} disabled={picks.length !== 2}>Set hand</button>
                <button className="secondary" onClick={autoSet}>House way</button>
              </div>
            )}
            {phase === 'done' && (
              <>
                <p className="muted" style={{ marginTop: '0.5rem' }}>you · front {hand.front!.map((c) => <Card key={c} index={c} />)} back {hand.playerBack!.map((c) => <Card key={c} index={c} />)}</p>
                <p className="muted" style={{ marginTop: '0.25rem' }}>dealer · front {hand.dealerFront!.map((c) => <Card key={`df${c}`} index={c} />)} back {hand.dealerBack!.map((c) => <Card key={`db${c}`} index={c} />)}</p>
              </>
            )}
            {phase === 'set' && (
              <p className="muted" style={{ marginTop: '0.5rem' }}>dealer <CardBack /><CardBack /><CardBack /><CardBack /><CardBack /><CardBack /><CardBack /></p>
            )}
            {phase === 'done' && hand.delta !== undefined && (
              <p style={{ marginTop: '0.6rem' }} className={hand.delta >= 0n ? 'ok' : 'bad'}>
                {RESULT_LABEL[hand.result!]} · {hand.delta >= 0n ? '+' : ''}{viem.formatEther(hand.delta)}{' '}
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
                  <span>{h.front!.map((c) => <Card key={c} index={c} />)} <span className="muted">/</span> {h.playerBack!.map((c) => <Card key={`b${c}`} index={c} />)}</span>
                  <span className={(h.delta ?? 0n) >= 0n ? 'ok' : 'bad'}>{(h.delta ?? 0n) >= 0n ? '+' : ''}{viem.formatEther(h.delta ?? 0n)}</span>
                </div>
                <p className="card-meta muted">{RESULT_LABEL[h.result ?? 'lose']} · {h.verified ? 'verify ✓' : 'verify ✗'}</p>
              </div>
            ))}
          </details>
        </>
      )}
    </div>
  )
}
