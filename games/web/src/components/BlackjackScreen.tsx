import { useState } from 'react'
import * as viem from 'viem'
import {
  blackjackPlayerView, settleBlackjack, handTotal, commitBlackjack, verifyBlackjack,
  type BlackjackAction, type BlackjackResult,
} from '@msgboard/games'
import type { GameDeployment } from '../config'
import { StakeInput, parseStake } from './StakeInput'
import { InfoDot } from './Meta'
import { randomDeckSeed, Card, CardBack } from './decisionShared'

type Phase = 'idle' | 'player' | 'done'
interface Game { seed: bigint; commit: viem.Hex; actions: BlackjackAction[]; result?: BlackjackResult; verified?: boolean }

/**
 * Blackjack — the multi-decision dealer game. Deal shows your two cards and the dealer's up card; the
 * hole + shoe stay committed (hidden) while you Hit / Stand / Double. On finish the dealer plays to 17
 * and your browser re-checks the whole hand against the disclosed seed. In-process house (Mines model).
 */
export const BlackjackScreen = ({ deployment: _d, walletClient, trustAcknowledged, myAddress }: {
  deployment: GameDeployment; walletClient?: viem.WalletClient; trustAcknowledged: boolean; myAddress?: viem.Hex
}) => {
  const [amount, setAmount] = useState('0.1')
  const [phase, setPhase] = useState<Phase>('idle')
  const [game, setGame] = useState<Game>()
  const [history, setHistory] = useState<Game[]>([])

  const stake = parseStake(amount)
  const canDeal = walletClient !== undefined && trustAcknowledged && stake !== undefined && phase !== 'player'

  const finish = (g: Game) => {
    if (stake === undefined) return
    const result = settleBlackjack(stake, g.seed, g.actions)
    const v = verifyBlackjack({ commit: g.commit, actions: g.actions, stake, claimedDelta: result.playerDelta }, g.seed)
    const done: Game = { ...g, result, verified: v.ok }
    setGame(done); setHistory((h) => [...h, done]); setPhase('done')
  }

  const deal = () => {
    if (stake === undefined) return
    const seed = randomDeckSeed()
    const g: Game = { seed, commit: commitBlackjack(seed), actions: [] }
    setGame(g)
    if (blackjackPlayerView(seed, []).finished) finish(g) // natural blackjack — no actions
    else setPhase('player')
  }

  const act = (action: BlackjackAction) => {
    if (!game) return
    const actions = [...game.actions, action]
    const view = blackjackPlayerView(game.seed, actions)
    const g: Game = { ...game, actions }
    setGame(g)
    if (action === 'stand' || action === 'double' || view.finished) finish(g)
    // else stay in player phase (hit again)
  }

  const view = game && phase === 'player' ? blackjackPlayerView(game.seed, game.actions) : undefined
  const r = game?.result
  return (
    <div>
      <div className="card">
        <h3>Blackjack<InfoDot>
          <strong>Beat the dealer to 21 without busting.</strong> Hit for another card, Stand to hold, or
          Double for one final card at twice the bet. The dealer's hole card stays sealed until you act,
          then the dealer draws to 17. Blackjack pays 3:2. Your browser re-checks the hand after.</InfoDot></h3>
        <div className="row">
          <StakeInput value={amount} onChange={setAmount} />
          <button onClick={deal} disabled={!canDeal}>{phase === 'player' ? 'In hand…' : 'Deal'}</button>
          {!walletClient && <span className="muted">connect a wallet to play</span>}
          {walletClient && !trustAcknowledged && <span className="muted">tap "Got it" on the fairness note above first</span>}
        </div>

        {game && (
          <div style={{ marginTop: '0.75rem' }}>
            <p className="muted">dealer</p>
            <div className="row">
              {phase === 'player' && view ? <><Card index={view.dealerUp} /><CardBack /></>
                : r?.dealerCards.map((c, i) => <Card key={i} index={c} />)}
              {r && <span className="muted">({r.dealerTotal})</span>}
            </div>
            <p className="muted" style={{ marginTop: '0.5rem' }}>you</p>
            <div className="row">
              {(phase === 'player' && view ? view.playerCards : r!.playerCards).map((c, i) => <Card key={i} index={c} />)}
              <span className="muted">({phase === 'player' && view ? view.playerTotal : handTotal(r!.playerCards).total})</span>
            </div>
            {phase === 'player' && (
              <div className="row" style={{ marginTop: '0.6rem' }}>
                <button onClick={() => act('hit')}>Hit</button>
                <button onClick={() => act('stand')}>Stand</button>
                {game.actions.length === 0 && <button className="secondary" onClick={() => act('double')}>Double</button>}
              </div>
            )}
            {phase === 'done' && r && (
              <p style={{ marginTop: '0.6rem' }} className={r.playerDelta >= 0n ? 'ok' : 'bad'}>
                {r.playerDelta > 0n ? 'win' : r.playerDelta < 0n ? 'lose' : 'push'} · {r.playerDelta >= 0n ? '+' : ''}{viem.formatEther(r.playerDelta)}
                {r.doubled ? ' (doubled)' : ''}{' '}
                <span className="muted">· commit {game.commit.slice(0, 10)}… · {game.verified ? 'verify ✓' : 'verify ✗'}</span>
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
              <span className="muted"> · {viem.formatEther(history.reduce((s, g) => s + (g.result?.playerDelta ?? 0n), 0n))} net</span>
            </summary>
            {[...history].reverse().map((g, i) => (
              <div className="card" key={i}>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span>{g.result!.playerCards.map((c) => <Card key={c} index={c} />)} <span className="muted">vs</span> {g.result!.dealerCards.map((c) => <Card key={`d${c}`} index={c} dim />)}</span>
                  <span className={(g.result?.playerDelta ?? 0n) >= 0n ? 'ok' : 'bad'}>{(g.result?.playerDelta ?? 0n) >= 0n ? '+' : ''}{viem.formatEther(g.result?.playerDelta ?? 0n)}</span>
                </div>
                <p className="card-meta muted">you {g.result!.playerTotal} · dealer {g.result!.dealerTotal} · {g.verified ? 'verify ✓' : 'verify ✗'}</p>
              </div>
            ))}
          </details>
        </>
      )}
    </div>
  )
}
