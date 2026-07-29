import { useState } from 'react'
import * as viem from 'viem'
import { commitSeed } from '@msgboard/games'
import type { GameDeployment } from '../config'
import {
  lotteryPoolDraw, lotteryPoolSettle, lotteryPoolTotal, participationCommitByStake, verifyLotteryPoolDraw,
  type LotteryEntry,
} from '../model/lottery-pool'
import { StakeInput, parseStake } from './StakeInput'
import { InfoDot } from './Meta'

const RAKE_BPS = 500n // 5% house rake; the rest is the pari-mutuel prize
const randomSeed = (): viem.Hex => viem.bytesToHex(crypto.getRandomValues(new Uint8Array(32)))
const randomAddr = (): viem.Hex => viem.getAddress(viem.bytesToHex(crypto.getRandomValues(new Uint8Array(20))))
const short = (a: viem.Hex): string => `${a.slice(0, 6)}…${a.slice(-4)}`
const BOT_NAMES = ['🤖 botA', '🦊 botB', '🐙 botC', '🐳 botD', '🦏 botE']
const randomStake = (): bigint => viem.parseEther((0.05 + Math.random() * 0.95).toFixed(4)) // arbitrary demo entries

interface Drawn {
  winningPoint: bigint
  winner: viem.Hex
  prize: bigint
  rake: bigint
  pool: bigint
  verified: boolean
}
interface Round {
  serverSeed: viem.Hex
  commit: viem.Hex
  nonce: bigint
  entries: LotteryEntry[]
  names: Map<string, string>
  drawn?: Drawn
}

const freshRound = (n: bigint): Round => {
  const serverSeed = randomSeed()
  // seed a few bot buyers so there's a pool to win; stakes are arbitrary demo entries.
  const bots: LotteryEntry[] = BOT_NAMES.slice(0, 4).map(() => ({ buyer: randomAddr(), stake: randomStake() }))
  const names = new Map<string, string>()
  bots.forEach((b, i) => names.set(b.buyer.toLowerCase(), BOT_NAMES[i]!))
  return { serverSeed, commit: commitSeed(serverSeed), nonce: n, entries: bots, names }
}

/**
 * Lottery — a pooled, pari-mutuel raffle. Everyone wagers a continuous stake into ONE pool; a single
 * seeded draw picks a stake-weighted winning point; the pool minus a small rake is the prize. It's
 * players-vs-players (the house only takes the rake), so it rides the raffle rails with no bankroll
 * risk. The house commits its seed before entries close and the draw is bound to the final entry
 * list — so neither side can grind it. Your odds are exactly your stake ÷ the pool: no fixed ticket
 * price or integer quantity — wager any amount, same as the other games.
 */
export const LotteryScreen = ({ walletClient, trustAcknowledged, myAddress }: {
  deployment: GameDeployment; walletClient?: viem.WalletClient; trustAcknowledged: boolean; myAddress?: viem.Hex
}) => {
  const you = myAddress ?? ('0x0000000000000000000000000000000000000001' as viem.Hex)
  const [amount, setAmount] = useState('0.1')
  const [round, setRound] = useState<Round>(() => freshRound(1n))

  const stake = parseStake(amount)
  const canBuy = walletClient !== undefined && trustAcknowledged && stake !== undefined && !round.drawn
  const yourStake = round.entries
    .filter((e) => e.buyer.toLowerCase() === you.toLowerCase())
    .reduce((a, e) => a + e.stake, 0n)
  const pool = lotteryPoolTotal(round.entries)

  const buy = () => {
    if (!canBuy || stake === undefined) return
    setRound((r) => {
      const names = new Map(r.names)
      names.set(you.toLowerCase(), '🫵 you')
      return { ...r, names, entries: [...r.entries, { buyer: you, stake }] }
    })
  }

  const draw = () => {
    if (round.drawn) return
    const d = lotteryPoolDraw(round.serverSeed, round.entries, round.nonce)
    const s = lotteryPoolSettle(round.entries, RAKE_BPS)
    const verified = verifyLotteryPoolDraw(round.commit, round.serverSeed, round.entries, round.nonce, d).ok
    setRound((r) => ({
      ...r,
      drawn: { winningPoint: d.winningPoint, winner: d.winner, prize: s.prize, rake: s.rake, pool: s.pool, verified },
    }))
  }

  const newRound = () => setRound((r) => freshRound(r.nonce + 1n))
  const youWon = round.drawn && round.drawn.winner.toLowerCase() === you.toLowerCase()

  return (
    <div>
      <div className="card">
        <h3>The Lottery<InfoDot>
          <strong>Pooled, pari-mutuel.</strong> Everyone wagers a stake into one pool; a single sealed
          draw picks a stake-weighted winning point and pays the pool (minus a {Number(RAKE_BPS) / 100}%
          rake). The house commits its seed <em>before</em> entries close and the draw is bound to the
          exact entry list, so neither the house nor a late entrant can steer the winner. Anyone re-runs
          the draw to verify.</InfoDot></h3>

        <div className="row">
          <StakeInput value={amount} onChange={setAmount} />
          <button onClick={buy} disabled={!canBuy}>Enter pool</button>
          {!round.drawn
            ? <button onClick={draw} disabled={walletClient === undefined || !trustAcknowledged}>Draw winner</button>
            : <button onClick={newRound}>New round</button>}
          {!walletClient && <span className="muted">connect a wallet to play</span>}
          {walletClient && !trustAcknowledged && <span className="muted">tap "Got it" on the fairness note above first</span>}
        </div>
        <p className="muted">
          {amount !== '' && stake === undefined && <span className="bad">enter a positive stake</span>}
        </p>

        <p className="muted" style={{ marginTop: '0.5rem' }}>
          pool <strong>{viem.formatEther(pool)}</strong> · {round.entries.length} entr{round.entries.length === 1 ? 'y' : 'ies'} · your stake {viem.formatEther(yourStake)}
          {' · '}commit <span className="mono">{round.commit.slice(0, 10)}…</span>
        </p>

        <div style={{ marginTop: '0.5rem' }}>
          <p className="muted">entrants</p>
          {round.entries.map((e, i) => {
            const before = round.entries.slice(0, i).reduce((a, x) => a + x.stake, 0n)
            const after = before + e.stake
            const isWinner = round.drawn && round.drawn.winningPoint >= before && round.drawn.winningPoint < after
            return (
              <div className="row" key={i} style={{ justifyContent: 'space-between' }}>
                <span>{round.names.get(e.buyer.toLowerCase()) ?? short(e.buyer)} <span className="muted mono">{short(e.buyer)}</span></span>
                <span className={isWinner ? 'ok' : 'muted'}>{viem.formatEther(e.stake)} staked{isWinner ? ' · 🏆 winner' : ''}</span>
              </div>
            )
          })}
        </div>

        {round.drawn && (
          <p style={{ marginTop: '0.6rem' }} className={youWon ? 'ok' : ''}>
            winning stake at {viem.formatEther(round.drawn.winningPoint)} → {round.names.get(round.drawn.winner.toLowerCase()) ?? short(round.drawn.winner)}
            {youWon ? ' — that\'s you! 🎉' : ''}
            {' · '}prize <strong>{viem.formatEther(round.drawn.prize)}</strong> <span className="muted">(rake {viem.formatEther(round.drawn.rake)})</span>
            <span className="muted"> · {round.drawn.verified ? 'verify ✓' : 'verify ✗'}</span>
          </p>
        )}
      </div>
      <p className="muted" style={{ fontSize: '0.8rem' }}>
        The draw is <code>roundRandom(serverSeed, participationCommit, nonce) % pool</code> — bound to{' '}
        the participation commit <span className="mono">{participationCommitByStake(round.entries).slice(0, 10)}…</span>, so
        the entry list itself (who wagered what) is part of the entropy.
      </p>
    </div>
  )
}
