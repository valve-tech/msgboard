import { useState } from 'react'
import * as viem from 'viem'
import {
  blackjackPlayerView, settleBlackjack, handTotal, commitBlackjack, verifyBlackjack,
  type BlackjackAction, type BlackjackResult,
} from '@msgboard/games'
import type { GameDeployment } from '../config'
import { parseStake } from './StakeInput'
import { randomDeckSeed, Card, CardBack } from './decisionShared'
import { GameStage } from './shell/GameStage'
import { HowItWorksLink } from './HowItWorks'
import { BetTray } from './shell/BetTray'
import { MetaPanel } from './shell/MetaPanel'
import { FeltTable } from './stages/FeltTable'

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

  // dealer/player slots for FeltTable — same card/total expressions as before, just relocated.
  const dealerNode = game && (
    <div className="row">
      {phase === 'player' && view ? <><Card index={view.dealerUp} /><CardBack /></>
        : r?.dealerCards.map((c, i) => <Card key={i} index={c} />)}
      {r && <span className="muted">({r.dealerTotal})</span>}
    </div>
  )
  const playerNode = game && (
    <div className="row">
      {(phase === 'player' && view ? view.playerCards : r!.playerCards).map((c, i) => <Card key={i} index={c} />)}
      <span className="muted">({phase === 'player' && view ? view.playerTotal : handTotal(r!.playerCards).total})</span>
    </div>
  )
  const spotsNode = <div className="spot main">{amount}</div>

  const dealLabel = phase === 'player' ? 'In hand…' : phase === 'done' ? 'Deal again' : 'Deal'
  const netHistory = history.reduce((s, g) => s + (g.result?.playerDelta ?? 0n), 0n)

  return (
    <>
      <GameStage title="BLACKJACK" subtitle="sealed before you play" action={<HowItWorksLink />}>
        <FeltTable dealer={dealerNode} player={playerNode} spots={spotsNode} arc="BLACKJACK PAYS 3 TO 2 · INSURANCE PAYS 2 TO 1" />
      </GameStage>

      <div className="tray-col">
        <BetTray amount={amount} onAmount={setAmount} action={<button className="primary" onClick={deal} disabled={!canDeal}>{dealLabel}</button>}>
          {phase === 'player' && game && (
            <div className="acts">
              <button className="b-hit" onClick={() => act('hit')}>Hit</button>
              <button className="b-stand" onClick={() => act('stand')}>Stand</button>
              {game.actions.length === 0 && <button className="b-double" onClick={() => act('double')}>Double</button>}
            </div>
          )}
          {!walletClient && <p className="tray-hint">connect a wallet to play</p>}
          {walletClient && !trustAcknowledged && <p className="tray-hint">tap "Got it" on the fairness note above first</p>}
          {phase === 'done' && r && game && (
            <p className={r.playerDelta >= 0n ? 'ok' : 'bad'}>
              {r.playerDelta > 0n ? 'win' : r.playerDelta < 0n ? 'lose' : 'push'} · {r.playerDelta >= 0n ? '+' : ''}{viem.formatEther(r.playerDelta)}
              {r.doubled ? ' (doubled)' : ''}{' '}
              <span className="muted">· commit {game.commit.slice(0, 10)}… · {game.verified ? 'verify ✓' : 'verify ✗'}</span>
            </p>
          )}
        </BetTray>

        <MetaPanel tabs={['Recent', 'Stats']}>
          {myAddress && history.length > 0 ? (
            <span>
              <b>{netHistory >= 0n ? '+' : ''}{viem.formatEther(netHistory)}</b>
              net · {history.length} hand{history.length === 1 ? '' : 's'}
            </span>
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
              <span className="muted"> · {viem.formatEther(netHistory)} net</span>
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
    </>
  )
}
