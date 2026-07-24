import { useState } from 'react'
import * as viem from 'viem'
import {
  keno,
  BASE_PAYTABLE_X100,
  applyEdgeX100,
  MAX_PICKS,
  POOL,
  DEFAULT_DRAWN,
  type KenoParams,
} from '@msgboard/games'
import type { GameDeployment } from '../config'
import { useSession, type RoundRecord } from '../hooks/useSession'
import { StakeInput, parseStake } from './StakeInput'
import { TurnTiming } from './TurnTiming'
import { InfoDot } from './Meta'

/** keno multipliers come back from the module's paytable in hundredths (2.00x == 200). */
const fmtMult = (x100: bigint): string => `${(Number(x100) / 100).toFixed(2)}x`

/** the 1..POOL grid, materialised once. */
const GRID: number[] = Array.from({ length: POOL }, (_, i) => i + 1)

/**
 * The edge-applied payout ladder for a given pick-count: each (hits → multiplier) cell from the
 * module's BASE_PAYTABLE_X100, with the house edge applied via the module's own helper. We never
 * invent multipliers — the table is read straight from the game module (and is flagged PLACEHOLDER
 * there). Cells that pay nothing (0n) are dropped so the ladder only shows winning hit-counts.
 */
const payoutLadder = (pickCount: number): { hits: number; multiplierX100: bigint }[] => {
  const row = BASE_PAYTABLE_X100[pickCount]
  if (!row) return []
  const ladder: { hits: number; multiplierX100: bigint }[] = []
  for (let hits = 0; hits < row.length; hits++) {
    const fair = row[hits] ?? 0n
    if (fair <= 0n) continue
    ladder.push({ hits, multiplierX100: applyEdgeX100(fair) })
  }
  return ladder
}

/**
 * OFF-CHAIN session-game screen (Keno) — same shape as DiceScreen/LimboScreen:
 *   1. `useSession({ game, walletClient, chainId })` drives the HouseSession.
 *   2. a params UI (here: a MULTI-SELECT 1..40 number grid) → `session.play(stake, params)`.
 *   3. a result/receipt + history list in the CoinFlip/Raffle visual style.
 * The one meaningful UI difference from Dice is the picks grid in place of a single numeric input.
 */
const RoundReceipt = ({ record }: { record: RoundRecord }) => (
  <div className="card">
    <div className="row" style={{ justifyContent: 'space-between' }}>
      <span>
        <span className="tag">round {record.round}</span>
        {viem.formatEther(record.stake)} staked
        {record.win ? (
          <span className="tag ok">won {fmtMult(record.multiplierX100)}</span>
        ) : (
          <span className="tag">lost</span>
        )}
      </span>
      <span className={record.playerDelta >= 0n ? 'ok' : 'bad'}>
        {record.playerDelta >= 0n ? '+' : ''}
        {viem.formatEther(record.playerDelta)}
      </span>
    </div>
    <p className="card-meta muted">
      balance {viem.formatEther(record.balancePlayer)} · co-signed by both parties
    </p>
    {record.timing && (
      <p className="card-meta muted">
        <TurnTiming timing={record.timing} />
      </p>
    )}
  </div>
)

export const KenoScreen = ({
  deployment,
  walletClient,
  trustAcknowledged,
  myAddress,
}: {
  deployment: GameDeployment
  walletClient?: viem.WalletClient
  trustAcknowledged: boolean
  myAddress?: viem.Hex
}) => {
  const [amount, setAmount] = useState('0.1')
  const [picks, setPicks] = useState<number[]>([])

  const session = useSession<KenoParams>({
    game: keno,
    walletClient,
    chainId: deployment.chainId,
    boardRpc: deployment.boardRpc,
    gameLabel: 'keno',
  })

  const stake = parseStake(amount)
  const picksOk = picks.length >= 1 && picks.length <= MAX_PICKS
  const ladder = picksOk ? payoutLadder(picks.length) : []
  const capReached = picks.length >= MAX_PICKS

  const busy = session.status === 'opening' || session.status === 'playing'
  const canOpen = walletClient !== undefined && trustAcknowledged && !busy
  const canRoll = session.ready && !busy && stake !== undefined && picksOk

  const togglePick = (n: number) => {
    setPicks((prev) =>
      prev.includes(n) ? prev.filter((p) => p !== n) : prev.length >= MAX_PICKS ? prev : [...prev, n],
    )
  }
  const clearPicks = () => setPicks([])

  const roll = () => {
    if (stake === undefined || !picksOk) return
    // KenoParams shape: { picks: number[] } — the round always draws DEFAULT_DRAWN (10) of 40.
    void session.play(stake, { picks: [...picks].sort((a, b) => a - b) })
  }

  const wins = session.history.filter((r) => r.win).length
  const taken = session.history.reduce((sum, r) => sum + r.playerDelta, 0n)

  return (
    <div>
      <div className="card">
        <h3>
          Keno
          <InfoDot>
            <strong>Pick your numbers.</strong> The round draws its own set and pays by how many you
            match — more matches, bigger payout. (Payout values shown are illustrative.) Instant
            off-chain settle, no gas.
          </InfoDot>
        </h3>
        <div className="row">
          <StakeInput value={amount} onChange={setAmount} />
          {session.ready ? (
            <button onClick={roll} disabled={!canRoll}>
              {session.status === 'playing' ? 'Rolling…' : 'Roll'}
            </button>
          ) : (
            <button onClick={() => void session.start()} disabled={!canOpen}>
              {session.status === 'opening' ? 'Opening…' : 'Open table'}
            </button>
          )}
          {!walletClient && <span className="muted">connect a wallet to play</span>}
          {walletClient && !trustAcknowledged && (
            <span className="muted">tap "Got it" on the fairness note above first</span>
          )}
        </div>

        <label className="threshold-label">
          your numbers
          <span className="muted">
            {' '}
            {picks.length}/{MAX_PICKS} picked
            {picks.length > 0 && (
              <>
                {' · '}
                <button onClick={clearPicks} disabled={busy}>
                  clear
                </button>
              </>
            )}
          </span>
        </label>
        <div
          className="row"
          role="group"
          aria-label="keno number grid"
          style={{ flexWrap: 'wrap', gap: '0.25rem', marginTop: '0.5rem' }}
        >
          {GRID.map((n) => {
            const selected = picks.includes(n)
            return (
              <button
                key={n}
                onClick={() => togglePick(n)}
                disabled={busy || (!selected && capReached)}
                aria-pressed={selected}
                className={selected ? 'tag ok' : 'tag'}
                style={{ width: '2.25rem' }}
              >
                {n}
              </button>
            )
          })}
        </div>

        {picksOk && (
          <p className="card-meta muted">
            pays by hits ({picks.length} pick{picks.length === 1 ? '' : 's'}, draws {DEFAULT_DRAWN} of {POOL}):{' '}
            {ladder.length === 0 ? (
              <span className="bad">no paying hit-count for this selection</span>
            ) : (
              ladder.map(({ hits, multiplierX100 }) => (
                <span key={hits} className="tag" style={{ marginRight: '0.25rem' }}>
                  {hits} → {fmtMult(multiplierX100)}
                </span>
              ))
            )}
          </p>
        )}

        <p className="muted">
          {amount !== '' && stake === undefined && <span className="bad">enter a positive amount · </span>}
          {picks.length === 0 && <span className="bad">pick at least one number · </span>}
        </p>
        {session.commit && (
          <p className="card-meta muted">
            server-seed commit <span className="mono">{session.commit.slice(0, 10)}…</span>
            {session.balances && (
              <>
                {' · '}your balance {viem.formatEther(session.balances.player)} · {session.roundsLeft} rolls left
              </>
            )}
          </p>
        )}
        {session.error && <p className="bad">{session.error}</p>}
      </div>

      <h2>This table</h2>
      {!session.ready && session.history.length === 0 && (
        <p className="muted">No table open — set your stake and numbers, then open one to start rolling.</p>
      )}
      {[...session.history].reverse().map((record) => (
        <RoundReceipt key={record.round} record={record} />
      ))}

      {myAddress && session.history.length > 0 && (
        <>
          <h2>Your book</h2>
          <details className="history" open>
            <summary>
              {session.history.length} roll{session.history.length === 1 ? '' : 's'}
              <span className="muted">
                {' '}
                · {wins}/{session.history.length} won · {viem.formatEther(taken)} net
              </span>
            </summary>
            {[...session.history].reverse().map((record) => (
              <RoundReceipt key={record.round} record={record} />
            ))}
          </details>
        </>
      )}
    </div>
  )
}
