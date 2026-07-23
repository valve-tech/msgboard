import { useEffect, useState } from 'react'
import * as viem from 'viem'
import {
  cascade, resolveCascade, commitSeed, roundRandom, COLS, ROWS, SYMBOLS, MAX_MULT_X100,
  type CascadeResult,
} from '@msgboard/games'
import type { GameDeployment } from '../config'
import { StakeInput, parseStake } from './StakeInput'
import { InfoDot } from './Meta'

const SYMBOL_EMOJI = ['🍒', '🍋', '🍇', '🔔', '⭐', '💎', '👑', '🎰'] // index 0..7, ascending pay
const fmtMult = (x100: bigint): string => `${(Number(x100) / 100).toFixed(2)}x`
const randomSeed = (): viem.Hex => viem.bytesToHex(crypto.getRandomValues(new Uint8Array(32)))

interface Round {
  serverSeed: viem.Hex
  commit: viem.Hex
  raw: bigint
  result: CascadeResult
  totalX100: bigint
  playerDelta: bigint
  verified: boolean
}

/** One 6×5 grid frame; cells matched this tumble pulse before they clear. */
const Grid = ({ grid, removed }: { grid: number[]; removed?: boolean[] }) => (
  <div style={{ display: 'grid', gridTemplateColumns: `repeat(${COLS}, 1fr)`, gap: '0.25rem', maxWidth: '20rem' }}>
    {grid.map((s, i) => (
      <span
        key={i}
        style={{
          fontSize: '1.5rem', textAlign: 'center', padding: '0.25rem', borderRadius: '0.4rem',
          background: removed?.[i] ? 'rgba(80,220,120,0.35)' : 'rgba(255,255,255,0.04)',
          transition: 'background 0.2s', opacity: removed?.[i] ? 1 : 0.95,
        }}
      >
        {SYMBOL_EMOJI[s]}
      </span>
    ))}
  </div>
)

/**
 * Cascade — a tumbling-grid slot. A single seeded round determines the WHOLE tumble: matching symbols
 * (8+ of a kind, scatter-pays) clear, survivors fall, fresh symbols drop in, and it repeats until no
 * match. The total multiplier is the sum of every tumble's pay, hard-capped at {MAX}. The outcome is a
 * pure function of the revealed seed — your browser replays the exact tumble to verify it.
 */
export const CascadeScreen = ({ walletClient, trustAcknowledged, myAddress }: {
  deployment: GameDeployment; walletClient?: viem.WalletClient; trustAcknowledged: boolean; myAddress?: viem.Hex
}) => {
  const [amount, setAmount] = useState('0.1')
  const [nonce, setNonce] = useState(0)
  const [round, setRound] = useState<Round>()
  const [frame, setFrame] = useState(0) // which tumble we're showing; steps.length === settled
  const [history, setHistory] = useState<Round[]>([])

  const stake = parseStake(amount)
  const canSpin = walletClient !== undefined && trustAcknowledged && stake !== undefined

  // auto-advance the tumble animation one frame at a time until we reach the settled grid.
  useEffect(() => {
    if (!round || frame >= round.result.steps.length) return
    const t = setTimeout(() => setFrame((f) => f + 1), 650)
    return () => clearTimeout(t)
  }, [round, frame])

  const spin = () => {
    if (stake === undefined) return
    const serverSeed = randomSeed()
    const clientSeed = randomSeed()
    const n = nonce + 1
    setNonce(n)
    const commit = commitSeed(serverSeed) // published before the spin; the player commits clientSeed too
    const raw = roundRandom(serverSeed, clientSeed, BigInt(n))
    const result = resolveCascade(raw)
    const out = cascade.settleRound(stake, {}, raw)
    // verify (what an auditor does from the revealed seeds): the disclosed serverSeed hashes to the
    // published commit, raw is exactly roundRandom(serverSeed, clientSeed, nonce), and replaying the
    // tumble reproduces the settled multiplier.
    const verified = commitSeed(serverSeed) === commit &&
      roundRandom(serverSeed, clientSeed, BigInt(n)) === raw &&
      resolveCascade(raw).totalX100 === out.multiplierX100
    const r: Round = { serverSeed, commit, raw, result, totalX100: result.totalX100, playerDelta: out.playerDelta, verified }
    setRound(r)
    setFrame(0)
    setHistory((h) => [...h, r])
  }

  // the grid + removal mask to show for the current frame.
  const showStep = round && frame < round.result.steps.length ? round.result.steps[frame] : undefined
  const settled = round !== undefined && frame >= round.result.steps.length
  const runningPay = round ? round.result.steps.slice(0, frame).reduce((a, s) => a + s.payX100, 0n) : 0n

  return (
    <div>
      <div className="card">
        <h3>Cascade<InfoDot>
          <strong>Tumbling grid.</strong> Land 8 or more of a symbol anywhere and it pays and clears;
          the rest fall and new symbols drop in, tumbling on until no match. Pays add up, capped at
          {' '}{fmtMult(MAX_MULT_X100)}. One sealed seed fixes the entire tumble — your browser replays it
          to prove the result.</InfoDot></h3>
        <div className="row">
          <StakeInput value={amount} onChange={setAmount} />
          <button onClick={spin} disabled={!canSpin || (round !== undefined && !settled)}>
            {round !== undefined && !settled ? 'Tumbling…' : 'Spin'}
          </button>
          {!walletClient && <span className="muted">connect a wallet to play</span>}
          {walletClient && !trustAcknowledged && <span className="muted">tap "Got it" on the fairness note above first</span>}
        </div>

        {round && (
          <div style={{ marginTop: '0.75rem' }}>
            <Grid grid={showStep ? showStep.grid : round.result.finalGrid} removed={showStep?.removed} />
            <p className="muted" style={{ marginTop: '0.5rem' }}>
              {settled ? (
                <>
                  tumbles: {round.result.steps.length} · total{' '}
                  <span className={round.totalX100 >= 100n ? 'ok' : ''}>{fmtMult(round.totalX100)}</span>
                  {' · '}
                  <span className={round.playerDelta >= 0n ? 'ok' : 'bad'}>
                    {round.playerDelta >= 0n ? '+' : ''}{viem.formatEther(round.playerDelta)}
                  </span>
                  <span className="muted"> · commit {round.commit.slice(0, 10)}… · {round.verified ? 'verify ✓' : 'verify ✗'}</span>
                </>
              ) : (
                <>tumble {frame + 1}/{round.result.steps.length} · paid {fmtMult(showStep?.payX100 ?? 0n)} · running {fmtMult(runningPay)}</>
              )}
            </p>
          </div>
        )}
      </div>

      {myAddress && history.length > 0 && (
        <>
          <h2>Your book</h2>
          <details className="history" open>
            <summary>{history.length} spin{history.length === 1 ? '' : 's'}
              <span className="muted"> · {viem.formatEther(history.reduce((s, r) => s + r.playerDelta, 0n))} net</span>
            </summary>
            {[...history].reverse().map((r, i) => (
              <div className="card" key={i}>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span>{fmtMult(r.totalX100)} <span className="muted">· {r.result.steps.length} tumble{r.result.steps.length === 1 ? '' : 's'}</span></span>
                  <span className={r.playerDelta >= 0n ? 'ok' : 'bad'}>{r.playerDelta >= 0n ? '+' : ''}{viem.formatEther(r.playerDelta)}</span>
                </div>
                <p className="card-meta muted">commit {r.commit.slice(0, 10)}… · {r.verified ? 'verify ✓' : 'verify ✗'}</p>
              </div>
            ))}
          </details>
        </>
      )}
      <p className="muted" style={{ fontSize: '0.8rem' }}>{SYMBOLS} symbols · {COLS}×{ROWS} grid · scatter-pays at 8+</p>
    </div>
  )
}
