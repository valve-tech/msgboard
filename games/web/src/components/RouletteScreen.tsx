import { useState } from 'react'
import * as viem from 'viem'
import {
  roulette, RouletteBetType, rouletteWinningPocket, rouletteBetPayoutX100, isRed,
  commitSeed, roundRandom, type RouletteParams,
} from '@msgboard/games'
import type { GameDeployment } from '../config'
import { StakeInput, parseStake } from './StakeInput'
import { InfoDot } from './Meta'
import { Menu } from './Menu'

const fmtMult = (x100: bigint): string => `${(Number(x100) / 100).toFixed(2)}x`
const randomSeed = (): viem.Hex => viem.bytesToHex(crypto.getRandomValues(new Uint8Array(32)))

/** kind: 'none' = no selection, 'straight' = pocket 0..36, 'group' = dozen/column bucket 0..2. */
type BetKind = 'none' | 'straight' | 'group'
const BET_TYPES: readonly { type: RouletteBetType; label: string; kind: BetKind; groups?: string[] }[] = [
  { type: RouletteBetType.RED, label: 'Red', kind: 'none' },
  { type: RouletteBetType.BLACK, label: 'Black', kind: 'none' },
  { type: RouletteBetType.ODD, label: 'Odd', kind: 'none' },
  { type: RouletteBetType.EVEN, label: 'Even', kind: 'none' },
  { type: RouletteBetType.LOW, label: 'Low (1–18)', kind: 'none' },
  { type: RouletteBetType.HIGH, label: 'High (19–36)', kind: 'none' },
  { type: RouletteBetType.DOZEN, label: 'Dozen', kind: 'group', groups: ['1–12', '13–24', '25–36'] },
  { type: RouletteBetType.COLUMN, label: 'Column', kind: 'group', groups: ['col 1', 'col 2', 'col 3'] },
  { type: RouletteBetType.STRAIGHT, label: 'Straight (single number)', kind: 'straight' },
]

/** The wheel's colour for a spun pocket. */
const pocketColor = (p: number): { name: string; css: string } =>
  p === 0 ? { name: 'green', css: '#2a7' } : isRed(p) ? { name: 'red', css: '#d44' } : { name: 'black', css: '#888' }

interface Spin {
  serverSeed: viem.Hex; commit: viem.Hex; raw: bigint; pocket: number
  betLabel: string; multiplierX100: bigint; playerDelta: bigint; win: boolean; verified: boolean
}

/**
 * Roulette — European single-zero wheel (37 pockets). Decisionless: place a bet, and the winning pocket
 * is a pure function of the sealed round seed (raw % 37). One seed fixes the spin; your browser re-derives
 * the pocket from the disclosed seed to prove it. The house edge is structural (the single green zero),
 * not the shared 1% edge — payouts are the true European multiples. Same provably-fair rails as the wheel.
 */
export const RouletteScreen = ({ walletClient, trustAcknowledged, myAddress }: {
  deployment: GameDeployment; walletClient?: viem.WalletClient; trustAcknowledged: boolean; myAddress?: viem.Hex
}) => {
  const [amount, setAmount] = useState('0.1')
  const [betIndex, setBetIndex] = useState(0)
  const [selection, setSelection] = useState(0)
  const [straightRaw, setStraightRaw] = useState('0')
  const [nonce, setNonce] = useState(0)
  const [spin, setSpin] = useState<Spin>()
  const [history, setHistory] = useState<Spin[]>([])

  const betDef = BET_TYPES[betIndex]!
  const straightNum = Number.parseInt(straightRaw, 10)
  const straightValid = Number.isInteger(straightNum) && straightNum >= 0 && straightNum <= 36
  const activeSelection = betDef.kind === 'straight' ? (straightValid ? straightNum : -1) : betDef.kind === 'group' ? selection : 0

  const stake = parseStake(amount)
  const selectionOk = betDef.kind !== 'straight' || straightValid
  const canSpin = walletClient !== undefined && trustAcknowledged && stake !== undefined && selectionOk

  const betLabel = betDef.kind === 'straight'
    ? `straight ${straightValid ? straightNum : '?'}`
    : betDef.kind === 'group'
      ? `${betDef.label.toLowerCase()} ${betDef.groups![selection]}`
      : betDef.label.toLowerCase()

  const spinWheel = () => {
    if (stake === undefined || !selectionOk) return
    const serverSeed = randomSeed()
    const clientSeed = randomSeed()
    const n = nonce + 1
    setNonce(n)
    const commit = commitSeed(serverSeed) // published before the spin; the player commits clientSeed too
    const raw = roundRandom(serverSeed, clientSeed, BigInt(n))
    const params: RouletteParams = { bets: [{ type: betDef.type, selection: activeSelection, stake }] }
    const out = roulette.settleRound(stake, params, raw)
    const pocket = rouletteWinningPocket(raw)
    // verify (what an auditor does from the revealed seeds): the disclosed serverSeed hashes to the
    // published commit, raw is exactly roundRandom(serverSeed, clientSeed, nonce), and re-settling the
    // same bet against that raw reproduces the delta.
    const verified = commitSeed(serverSeed) === commit &&
      roundRandom(serverSeed, clientSeed, BigInt(n)) === raw &&
      roulette.settleRound(stake, params, raw).playerDelta === out.playerDelta
    const s: Spin = {
      serverSeed, commit, raw, pocket, betLabel,
      multiplierX100: out.multiplierX100, playerDelta: out.playerDelta, win: out.win, verified,
    }
    setSpin(s)
    setHistory((h) => [...h, s])
  }

  const payoutX100 = rouletteBetPayoutX100(betDef.type)
  const wins = history.filter((s) => s.win).length
  const net = history.reduce((sum, s) => sum + s.playerDelta, 0n)

  return (
    <div>
      <div className="card">
        <h3>Roulette<InfoDot>
          <strong>European single-zero wheel.</strong> Place a bet, spin, and the winning pocket is
          raw % 37 from the sealed seed. Straight up pays 35:1; dozens and columns 2:1; red/black, odd/even
          and high/low 1:1. The only edge is the green zero. Your browser re-derives the pocket from the
          disclosed seed to prove the spin.</InfoDot></h3>
        <div className="row">
          <StakeInput value={amount} onChange={setAmount} />
          <label className="threshold-label">
            bet
            <Menu
              label="bet"
              options={BET_TYPES.map((b) => b.label)}
              value={betIndex}
              onChange={(i) => { setBetIndex(i); setSelection(0) }}
            />
          </label>
          {betDef.kind === 'group' && (
            <label className="threshold-label">
              pick
              <span className="row" style={{ gap: '0.25rem' }}>
                {betDef.groups!.map((g, i) => (
                  <button key={g} type="button" className={`chip${selection === i ? ' active' : ''}`}
                    onClick={() => setSelection(i)} aria-label={`group ${g}`}>
                    {g}
                  </button>
                ))}
              </span>
            </label>
          )}
          {betDef.kind === 'straight' && (
            <label className="threshold-label">
              number
              <input
                inputMode="numeric"
                value={straightRaw}
                onChange={(e) => setStraightRaw(e.target.value)}
                style={{ width: '4rem' }}
                aria-label="straight number 0 to 36"
              />
            </label>
          )}
          <button onClick={spinWheel} disabled={!canSpin}>Spin</button>
          {!walletClient && <span className="muted">connect a wallet to play</span>}
          {walletClient && !trustAcknowledged && <span className="muted">tap "Got it" on the fairness note above first</span>}
        </div>
        <p className="muted">
          {amount !== '' && stake === undefined && <span className="bad">enter a positive amount · </span>}
          {betDef.kind === 'straight' && !straightValid && <span className="bad">number must be 0–36 · </span>}
          <span className="ok">{betLabel} pays {fmtMult(payoutX100)}</span>
        </p>

        {spin && (
          <div style={{ marginTop: '0.75rem' }}>
            <p className="muted">
              landed on{' '}
              <span className="tag mono" style={{ fontSize: '1.1rem', color: pocketColor(spin.pocket).css }}>
                {spin.pocket} {pocketColor(spin.pocket).name}
              </span>
              {' · '}
              <span className={spin.playerDelta >= 0n ? 'ok' : 'bad'}>
                {spin.win ? `won ${fmtMult(spin.multiplierX100)}` : 'lost'} · {spin.playerDelta >= 0n ? '+' : ''}
                {viem.formatEther(spin.playerDelta)}
              </span>
              <span className="muted"> · commit {spin.commit.slice(0, 10)}… · {spin.verified ? 'verify ✓' : 'verify ✗'}</span>
            </p>
          </div>
        )}
      </div>

      {myAddress && history.length > 0 && (
        <>
          <h2>Your book</h2>
          <details className="history" open>
            <summary>{history.length} spin{history.length === 1 ? '' : 's'}
              <span className="muted"> · {wins}/{history.length} won · {viem.formatEther(net)} net</span>
            </summary>
            {[...history].reverse().map((s, i) => (
              <div className="card" key={i}>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span>
                    <span className="tag mono" style={{ color: pocketColor(s.pocket).css }}>{s.pocket}</span>{' '}
                    <span className="muted">{s.betLabel}</span>
                  </span>
                  <span className={s.playerDelta >= 0n ? 'ok' : 'bad'}>{s.playerDelta >= 0n ? '+' : ''}{viem.formatEther(s.playerDelta)}</span>
                </div>
                <p className="card-meta muted">commit {s.commit.slice(0, 10)}… · {s.verified ? 'verify ✓' : 'verify ✗'}</p>
              </div>
            ))}
          </details>
        </>
      )}
    </div>
  )
}
