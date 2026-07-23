import { useState } from 'react'
import * as viem from 'viem'
import {
  lotteryDraw, lotterySettle, participationCommit, lotteryTotalTickets, commitLotterySeed,
  verifyLotteryDraw, type LotteryTicket,
} from '@msgboard/games'
import type { GameDeployment } from '../config'
import { InfoDot } from './Meta'

const TICKET_PRICE = 10n ** 16n // 0.01 eth per ticket
const RAKE_BPS = 500n // 5% house rake; the rest is the pari-mutuel prize
const randomSeed = (): viem.Hex => viem.bytesToHex(crypto.getRandomValues(new Uint8Array(32)))
const randomAddr = (): viem.Hex => viem.getAddress(viem.bytesToHex(crypto.getRandomValues(new Uint8Array(20))))
const short = (a: viem.Hex): string => `${a.slice(0, 6)}…${a.slice(-4)}`
const BOT_NAMES = ['🤖 botA', '🦊 botB', '🐙 botC', '🐳 botD', '🦏 botE']

interface Drawn {
  winningTicket: number
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
  tickets: LotteryTicket[]
  names: Map<string, string>
  drawn?: Drawn
}

const freshRound = (n: bigint): Round => {
  const serverSeed = randomSeed()
  // seed a few bot buyers so there's a pool to win; counts are arbitrary demo entries.
  const bots: LotteryTicket[] = BOT_NAMES.slice(0, 4).map(() => ({ buyer: randomAddr(), count: 1 + Math.floor(Math.random() * 5) }))
  const names = new Map<string, string>()
  bots.forEach((b, i) => names.set(b.buyer.toLowerCase(), BOT_NAMES[i]!))
  return { serverSeed, commit: commitLotterySeed(serverSeed), nonce: n, tickets: bots, names }
}

/**
 * Lottery — a pooled, pari-mutuel raffle. Everyone buys tickets into ONE pool; a single seeded draw
 * picks the winning ticket; the pool minus a small rake is the prize. It's players-vs-players (the house
 * only takes the rake), so it rides the raffle rails with no bankroll risk. The house commits its seed
 * before sales close and the draw is bound to the final ticket list — so neither side can grind it.
 */
export const LotteryScreen = ({ walletClient, trustAcknowledged, myAddress }: {
  deployment: GameDeployment; walletClient?: viem.WalletClient; trustAcknowledged: boolean; myAddress?: viem.Hex
}) => {
  const you = myAddress ?? ('0x0000000000000000000000000000000000000001' as viem.Hex)
  const [qty, setQty] = useState('2')
  const [round, setRound] = useState<Round>(() => freshRound(1n))

  const buyCount = Number.parseInt(qty, 10)
  const canBuy = walletClient !== undefined && trustAcknowledged && Number.isInteger(buyCount) && buyCount > 0 && !round.drawn
  const yourTickets = round.tickets.filter((t) => t.buyer.toLowerCase() === you.toLowerCase()).reduce((a, t) => a + t.count, 0)
  const total = lotteryTotalTickets(round.tickets)
  const pool = BigInt(total) * TICKET_PRICE

  const buy = () => {
    if (!canBuy) return
    setRound((r) => {
      const names = new Map(r.names)
      names.set(you.toLowerCase(), '🫵 you')
      return { ...r, names, tickets: [...r.tickets, { buyer: you, count: buyCount }] }
    })
  }

  const draw = () => {
    if (round.drawn) return
    const d = lotteryDraw(round.serverSeed, round.tickets, round.nonce)
    const s = lotterySettle(round.tickets, TICKET_PRICE, RAKE_BPS)
    const verified = verifyLotteryDraw(round.commit, round.serverSeed, round.tickets, round.nonce, d).ok
    setRound((r) => ({ ...r, drawn: { winningTicket: d.winningTicket, winner: d.winner, prize: s.prize, rake: s.rake, pool: s.pool, verified } }))
  }

  const newRound = () => setRound((r) => freshRound(r.nonce + 1n))
  const youWon = round.drawn && round.drawn.winner.toLowerCase() === you.toLowerCase()

  return (
    <div>
      <div className="card">
        <h3>The Lottery<InfoDot>
          <strong>Pooled, pari-mutuel.</strong> Everyone buys tickets into one pool; a single sealed draw
          picks the winning ticket and pays the pool (minus a {Number(RAKE_BPS) / 100}% rake). The house
          commits its seed <em>before</em> sales close and the draw is bound to the exact ticket list, so
          neither the house nor a late buyer can steer the winner. Anyone re-runs the draw to verify.</InfoDot></h3>

        <div className="row">
          <label className="threshold-label">tickets
            <input className="mono" style={{ width: '4rem' }} value={qty} onChange={(e) => setQty(e.target.value)} inputMode="numeric" />
          </label>
          <button onClick={buy} disabled={!canBuy}>Buy ({viem.formatEther(BigInt(Math.max(0, buyCount || 0)) * TICKET_PRICE)})</button>
          {!round.drawn
            ? <button onClick={draw} disabled={walletClient === undefined || !trustAcknowledged}>Draw winner</button>
            : <button onClick={newRound}>New round</button>}
          {!walletClient && <span className="muted">connect a wallet to play</span>}
          {walletClient && !trustAcknowledged && <span className="muted">tap "Got it" on the fairness note above first</span>}
        </div>

        <p className="muted" style={{ marginTop: '0.5rem' }}>
          pool <strong>{viem.formatEther(pool)}</strong> · {total} ticket{total === 1 ? '' : 's'} · you hold {yourTickets}
          {' · '}commit <span className="mono">{round.commit.slice(0, 10)}…</span>
        </p>

        <div style={{ marginTop: '0.5rem' }}>
          <p className="muted">entrants</p>
          {round.tickets.map((t, i) => {
            const isWinner = round.drawn && round.tickets.slice(0, i).reduce((a, x) => a + x.count, 0) <= round.drawn.winningTicket
              && round.drawn.winningTicket < round.tickets.slice(0, i + 1).reduce((a, x) => a + x.count, 0)
            return (
              <div className="row" key={i} style={{ justifyContent: 'space-between' }}>
                <span>{round.names.get(t.buyer.toLowerCase()) ?? short(t.buyer)} <span className="muted mono">{short(t.buyer)}</span></span>
                <span className={isWinner ? 'ok' : 'muted'}>{t.count} ticket{t.count === 1 ? '' : 's'}{isWinner ? ' · 🏆 winner' : ''}</span>
              </div>
            )
          })}
        </div>

        {round.drawn && (
          <p style={{ marginTop: '0.6rem' }} className={youWon ? 'ok' : ''}>
            winning ticket #{round.drawn.winningTicket} → {round.names.get(round.drawn.winner.toLowerCase()) ?? short(round.drawn.winner)}
            {youWon ? ' — that\'s you! 🎉' : ''}
            {' · '}prize <strong>{viem.formatEther(round.drawn.prize)}</strong> <span className="muted">(rake {viem.formatEther(round.drawn.rake)})</span>
            <span className="muted"> · {round.drawn.verified ? 'verify ✓' : 'verify ✗'}</span>
          </p>
        )}
      </div>
      <p className="muted" style={{ fontSize: '0.8rem' }}>
        The draw is <code>roundRandom(serverSeed, participationCommit, nonce) % {total}</code> — bound to{' '}
        the participation commit <span className="mono">{participationCommit(round.tickets).slice(0, 10)}…</span>, so the
        ticket list itself is part of the entropy.
      </p>
    </div>
  )
}
