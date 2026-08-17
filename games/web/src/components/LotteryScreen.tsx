import { useState } from 'react'
import * as viem from 'viem'
import { commitSeed } from '@msgboard/games'
import type { GameDeployment } from '../config'
import {
  lotteryPoolDraw, lotteryPoolSettle, lotteryPoolTotal, participationCommitByStake, verifyLotteryPoolDraw,
  type LotteryEntry,
} from '../model/lottery-pool'
import { parseStake } from './StakeInput'
import { GameStage } from './shell/GameStage'
import { BetTray } from './shell/BetTray'
import { MetaPanel } from './shell/MetaPanel'
import { PoolLedger, type PoolSeat } from './stages/PoolLedger'

const RAKE_BPS = 500n // 5% house rake; the rest is the pari-mutuel prize
const randomSeed = (): viem.Hex => viem.bytesToHex(crypto.getRandomValues(new Uint8Array(32)))
const randomAddr = (): viem.Hex => viem.getAddress(viem.bytesToHex(crypto.getRandomValues(new Uint8Array(20))))
const short = (a: viem.Hex): string => `${a.slice(0, 6)}…${a.slice(-4)}`
const fmt = (wei: bigint): string => parseFloat(viem.formatEther(wei)).toFixed(3)
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
/** a finished draw kept for the "Your book" feed. */
interface Past extends Drawn {
  nonce: bigint
  entries: number
  youWon: boolean
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
 * Lottery — a pooled, pari-mutuel raffle, on the shared PoolLedger surface. Everyone wagers a
 * continuous stake into ONE pool; a single sealed draw picks a stake-weighted winning point, and the
 * pool minus a small rake is the prize. It's players-vs-players (the house only takes the rake). The
 * house commits its seed before entries close and the draw is bound to the final entry list, so neither
 * side can grind it — your odds are exactly your stake ÷ the pool, which is literally your slice of the
 * bar. The marker lands on the real winning point; anyone re-runs the draw to verify.
 */
export const LotteryScreen = ({ walletClient, trustAcknowledged, myAddress }: {
  deployment: GameDeployment; walletClient?: viem.WalletClient; trustAcknowledged: boolean; myAddress?: viem.Hex
}) => {
  const you = myAddress ?? ('0x0000000000000000000000000000000000000001' as viem.Hex)
  const [amount, setAmount] = useState('0.1')
  const [round, setRound] = useState<Round>(() => freshRound(1n))
  const [history, setHistory] = useState<Past[]>([])
  const [drawId, setDrawId] = useState(0)

  const stake = parseStake(amount)
  const canBuy = walletClient !== undefined && trustAcknowledged && stake !== undefined && !round.drawn
  const canDraw = walletClient !== undefined && trustAcknowledged && !round.drawn
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
    const drawn: Drawn = { winningPoint: d.winningPoint, winner: d.winner, prize: s.prize, rake: s.rake, pool: s.pool, verified }
    setRound((r) => ({ ...r, drawn }))
    setDrawId((n) => n + 1)
    setHistory((h) => [
      ...h,
      { ...drawn, nonce: round.nonce, entries: round.entries.length, youWon: d.winner.toLowerCase() === you.toLowerCase() },
    ])
  }

  const newRound = () => {
    setRound((r) => freshRound(r.nonce + 1n))
    setDrawId(0)
  }

  const youWon = round.drawn !== undefined && round.drawn.winner.toLowerCase() === you.toLowerCase()
  const seats: PoolSeat[] = round.entries.map((e, i) => ({
    key: `${e.buyer}-${i}`,
    label: round.names.get(e.buyer.toLowerCase()) ?? short(e.buyer),
    sub: short(e.buyer),
    stake: e.stake,
    mine: e.buyer.toLowerCase() === you.toLowerCase(),
  }))
  const yourOdds = pool > 0n ? Number((yourStake * 10000n) / pool) / 100 : 0
  const wonCount = history.filter((h) => h.youWon).length

  return (
    <>
      <GameStage title="THE LOTTERY" subtitle={`${Number(RAKE_BPS) / 100}% rake · winner takes the pool`}>
        <PoolLedger
          seats={seats}
          pool={pool}
          winningPoint={round.drawn?.winningPoint}
          drawId={drawId}
          fmt={fmt}
          unit="PLS"
          idleHint="enter the pool — the draw picks a stake-weighted winner"
        />
      </GameStage>

      <div className="tray-col">
        <BetTray
          amount={amount}
          onAmount={setAmount}
          action={
            round.drawn ? (
              <button className="primary" onClick={newRound}>New round</button>
            ) : (
              <button className="primary" onClick={buy} disabled={!canBuy}>Enter pool</button>
            )
          }
        >
          {!round.drawn && (
            <button className="secondary" style={{ width: '100%', marginTop: 8 }} onClick={draw} disabled={!canDraw}>
              Draw winner · {round.entries.length} in
            </button>
          )}
          <p className="tray-hint">
            your stake <b style={{ color: 'var(--gold-live)' }}>{fmt(yourStake)}</b>
            <span className="muted"> · odds {yourOdds.toFixed(1)}% · commit {round.commit.slice(0, 10)}…</span>
          </p>
          {amount !== '' && stake === undefined && <p className="bad">enter a positive stake</p>}
          {!walletClient && <p className="tray-hint">connect a wallet to play</p>}
          {walletClient && !trustAcknowledged && <p className="tray-hint">tap "Got it" on the fairness note above first</p>}
          {round.drawn && (
            <p className={youWon ? 'ok' : ''}>
              winner {round.names.get(round.drawn.winner.toLowerCase()) ?? short(round.drawn.winner)}
              {youWon ? " — that's you! 🎉" : ''} · prize {fmt(round.drawn.prize)}
              <span className="muted"> · {round.drawn.verified ? 'verify ✓' : 'verify ✗'}</span>
            </p>
          )}
        </BetTray>

        <MetaPanel tabs={['Pool', 'Fairness']}>
          <span>
            <b>{fmt(pool)}</b> pooled · {round.entries.length} in
            {round.drawn && <span className="muted"> · prize {fmt(round.drawn.prize)} (rake {fmt(round.drawn.rake)})</span>}
          </span>
          <p className="pool-fair muted">
            draw = <code>roundRandom(seed, participationCommit, nonce) % pool</code>, bound to the entry list{' '}
            <span className="mono">{participationCommitByStake(round.entries).slice(0, 10)}…</span>
          </p>
        </MetaPanel>
      </div>

      {myAddress && history.length > 0 && (
        <>
          <h2>Your book</h2>
          <details className="history">
            <summary>
              {history.length} draw{history.length === 1 ? '' : 's'}
              <span className="muted"> · {wonCount}/{history.length} won</span>
            </summary>
            {[...history].reverse().map((h) => (
              <div className="card" key={h.nonce.toString()}>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span>
                    <span className="tag">round {h.nonce.toString()}</span>
                    {h.entries} entries · pool {fmt(h.pool)}
                    {h.youWon ? <span className="tag ok">you won {fmt(h.prize)}</span> : <span className="tag">lost</span>}
                  </span>
                  <span className={h.youWon ? 'ok' : 'muted'}>{short(h.winner)}</span>
                </div>
                <p className="card-meta muted">prize {fmt(h.prize)} · rake {fmt(h.rake)} · {h.verified ? 'verify ✓' : 'verify ✗'}</p>
              </div>
            ))}
          </details>
        </>
      )}
    </>
  )
}
