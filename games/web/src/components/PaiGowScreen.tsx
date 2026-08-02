import { useState } from 'react'
import * as viem from 'viem'
import {
  dealPaiGow, settlePaiGow, commitPaiGow, verifyPaiGow, playerHouseWayPositions,
  type PaiGowResult,
} from '@msgboard/games'
import type { GameDeployment } from '../config'
import { parseStake } from './StakeInput'
import { randomDeckSeed, Card, CardBack } from './decisionShared'
import { GameStage } from './shell/GameStage'
import { HowItWorksLink } from './HowItWorks'
import { BetTray } from './shell/BetTray'
import { MetaPanel } from './shell/MetaPanel'
import { FeltTable } from './stages/FeltTable'

type Phase = 'idle' | 'set' | 'done'
interface Hand {
  seed: bigint; commit: viem.Hex; player: number[]
  front?: number[]; playerBack?: number[]; dealerFront?: number[]; dealerBack?: number[]
  result?: PaiGowResult; delta?: bigint; verified?: boolean
}

const RESULT_LABEL: Record<PaiGowResult, string> = { lose: 'lost', push: 'push', win: 'won' }

/**
 * Pai Gow Poker — single-decision dealer game, on the shared FeltTable surface. Deal reveals YOUR 7
 * cards (the dealer's stay committed, face down); you split them by tapping exactly 2 for the low
 * "front" hand — the other 5 form the "back" — or auto-set by the house way. Settling reveals the
 * dealer (set by house way), compares both hands (dealer wins copies), and your browser re-checks the
 * split against the disclosed seed (provably fair). In-process house, same trust model as Mines.
 *
 * The two split hands read best from different angles, so the felt's camera switcher (Seat / Aerial /
 * Rail) earns its keep here — flip to Aerial to see your front/back and the dealer's laid out together.
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

  const net = history.reduce((s, h) => s + (h.delta ?? 0n), 0n)
  const wins = history.filter((h) => h.result === 'win').length

  // ── the player's 7 cards in the foreground: tappable in `set`, front lifted + ringed in both phases ──
  const playerSeat = hand && (
    <div className="pg-seat">
      {hand.player.map((c, i) => {
        const isFront = phase === 'done' ? hand.front!.includes(c) : picks.includes(i)
        const tap = phase === 'set'
        return (
          <button
            key={i}
            type="button"
            className={`pg-pick${isFront ? ' on' : ''}${tap ? ' tap' : ''}`}
            onClick={tap ? () => togglePick(i) : undefined}
            disabled={!tap}
            aria-label={`card ${i + 1}${isFront ? ' (front)' : ''}`}
          >
            {isFront && <span className="pg-tag">front</span>}
            <Card index={c} big />
          </button>
        )
      })}
    </div>
  )

  // ── the dealer's 7 across the far felt: face-down until settled, then front(2)+back(5) revealed ──
  const dealerSeat = hand && (
    <div className="pg-dealer">
      {phase === 'done' ? (
        <>
          {hand.dealerFront!.map((c) => (
            <span key={`df${c}`} className="pg-pick on"><span className="pg-tag">front</span><Card index={c} /></span>
          ))}
          {hand.dealerBack!.map((c) => (
            <span key={`db${c}`} className="pg-pick"><Card index={c} /></span>
          ))}
        </>
      ) : (
        Array.from({ length: 7 }).map((_, i) => <CardBack key={i} />)
      )}
    </div>
  )

  const dealLabel = phase === 'done' ? 'Deal again' : 'Deal'

  return (
    <>
      <GameStage title="PAI GOW POKER" subtitle="split seven · beat both hands" action={<HowItWorksLink />}>
        <FeltTable
          dealer={dealerSeat}
          player={playerSeat}
          arc={<span>PAI GOW · BEAT BOTH HANDS TO WIN · DEALER WINS COPIES</span>}
        />
      </GameStage>

      <div className="tray-col">
        <BetTray
          amount={amount}
          onAmount={setAmount}
          action={
            phase === 'set' ? (
              <button className="primary" disabled>In hand…</button>
            ) : (
              <button className="primary" onClick={deal} disabled={!canDeal}>{dealLabel}</button>
            )
          }
        >
          {phase === 'set' && (
            <div className="acts">
              <button className="b-double" onClick={set} disabled={picks.length !== 2}>Set · {picks.length}/2</button>
              <button className="b-stand" onClick={autoSet}>House way</button>
            </div>
          )}
          <p className="tray-hint">
            {phase === 'set' ? 'tap 2 cards for your low front hand' : 'beat the dealer on BOTH hands to win · split pushes'}
          </p>
          {!walletClient && <p className="tray-hint">connect a wallet to play</p>}
          {walletClient && !trustAcknowledged && <p className="tray-hint">tap "Got it" on the fairness note above first</p>}
          {phase === 'done' && hand?.delta !== undefined && (
            <p className={hand.delta >= 0n ? 'ok' : 'bad'}>
              {RESULT_LABEL[hand.result!]} · {hand.delta >= 0n ? '+' : ''}{viem.formatEther(hand.delta)}
              <span className="muted"> · commit {hand.commit.slice(0, 10)}… · {hand.verified ? 'verify ✓' : 'verify ✗'}</span>
            </p>
          )}
        </BetTray>

        <MetaPanel tabs={['Hand', 'Stats']}>
          {myAddress && history.length > 0 ? (
            <span><b>{net >= 0n ? '+' : ''}{viem.formatEther(net)}</b> net · {wins}/{history.length} won</span>
          ) : (
            <span className="muted">
              {phase === 'set' ? `tap 2 for the front (${picks.length}/2)` : phase === 'done' ? 'deal again to play on' : 'deal to see your seven'}
            </span>
          )}
        </MetaPanel>
      </div>

      {myAddress && history.length > 0 && (
        <>
          <h2>Your book</h2>
          <details className="history">
            <summary>
              {history.length} hand{history.length === 1 ? '' : 's'}
              <span className="muted"> · {wins}/{history.length} won · {viem.formatEther(net)} net</span>
            </summary>
            {[...history].reverse().map((h, i) => (
              <div className="card" key={i}>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span>
                    {h.front!.map((c) => <Card key={c} index={c} />)} <span className="muted">/</span>{' '}
                    {h.playerBack!.map((c) => <Card key={`b${c}`} index={c} />)}
                  </span>
                  <span className={(h.delta ?? 0n) >= 0n ? 'ok' : 'bad'}>{(h.delta ?? 0n) >= 0n ? '+' : ''}{viem.formatEther(h.delta ?? 0n)}</span>
                </div>
                <p className="card-meta muted">{RESULT_LABEL[h.result ?? 'lose']} · {h.verified ? 'verify ✓' : 'verify ✗'}</p>
              </div>
            ))}
          </details>
        </>
      )}
    </>
  )
}
