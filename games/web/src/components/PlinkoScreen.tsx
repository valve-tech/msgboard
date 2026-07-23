import { useState } from 'react'
import * as viem from 'viem'
import {
  plinko,
  plinkoFairTableX100,
  plinkoMultiplierX100,
  DEFAULT_ROWS,
  type PlinkoParams,
  type PlinkoRisk,
} from '@msgboard/games'
import type { GameDeployment } from '../config'
import { useSession, type RoundRecord } from '../hooks/useSession'
import { StakeInput, parseStake } from './StakeInput'
import { TurnTiming } from './TurnTiming'
import { InfoDot } from './Meta'

/** the row counts this screen offers; default 16 matches the package's DEFAULT_ROWS. */
const ALLOWED_ROWS = [8, 12, 16] as const
const RISKS: readonly PlinkoRisk[] = ['low', 'medium', 'high']

const fmtMult = (x100: bigint): string => `${(Number(x100) / 100).toFixed(2)}x`

/**
 * Render the edged per-bucket multiplier ladder for a (risk, rows) pair, straight from the package's
 * own helpers — `plinkoFairTableX100` to size the table and `plinkoMultiplierX100` per bucket. The
 * underlying paytables may be PLACEHOLDER values pending real data; we render whatever the module
 * returns and never invent numbers. Returns undefined when the package has no table for the pair.
 */
const ladderFor = (risk: PlinkoRisk, rows: number): bigint[] | undefined => {
  try {
    const fair = plinkoFairTableX100(risk, rows)
    return fair.map((_, bucket) => plinkoMultiplierX100(risk, rows, bucket))
  } catch {
    return undefined
  }
}

/**
 * OFF-CHAIN session-game screen (Plinko). Same shape as the reference DiceScreen:
 *   1. `useSession({ game, walletClient, chainId })` drives the HouseSession.
 *   2. a params UI (here: risk + rows, with a live multiplier ladder) → `session.play(stake, params)`.
 *   3. a result/receipt + history list in the shared CoinFlip/Raffle visual style.
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

export const PlinkoScreen = ({
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
  const [risk, setRisk] = useState<PlinkoRisk>('medium')
  const [rows, setRows] = useState<number>(DEFAULT_ROWS)

  const session = useSession<PlinkoParams>({
    game: plinko,
    walletClient,
    chainId: deployment.chainId,
    boardRpc: deployment.boardRpc,
    gameLabel: 'plinko',
  })

  const stake = parseStake(amount)
  const rowsOk = (ALLOWED_ROWS as readonly number[]).includes(rows)
  const ladder = rowsOk ? ladderFor(risk, rows) : undefined
  const paramsOk = rowsOk && ladder !== undefined
  const params: PlinkoParams | undefined = paramsOk ? { rows, risk } : undefined
  const maxMult = ladder?.reduce((m, x) => (x > m ? x : m), 0n)

  const busy = session.status === 'opening' || session.status === 'playing'
  const canOpen = walletClient !== undefined && trustAcknowledged && !busy
  const canDrop = session.ready && !busy && stake !== undefined && params !== undefined

  const drop = () => {
    if (stake === undefined || params === undefined) return
    void session.play(stake, params)
  }

  const wins = session.history.filter((r) => r.win).length
  const taken = session.history.reduce((sum, r) => sum + r.playerDelta, 0n)

  return (
    <div>
      <div className="card">
        <h3>
          Drop the ball
          <InfoDot>
            <strong>Drop a ball through the pegs.</strong> Where it lands sets your multiplier — more
            rows and higher risk spread the payouts wider, and the edge buckets pay the most. (Payout
            values shown are illustrative.) Instant off-chain settle, no gas.
          </InfoDot>
        </h3>
        <div className="row">
          <StakeInput value={amount} onChange={setAmount} />
          <label className="threshold-label">
            risk
            <span className="row" style={{ gap: '0.25rem' }}>
              {RISKS.map((r) => (
                <button
                  key={r}
                  type="button"
                  className={`chip${risk === r ? ' active' : ''}`}
                  onClick={() => setRisk(r)}
                  aria-label={`risk ${r}`}
                >
                  {r}
                </button>
              ))}
            </span>
          </label>
          <label className="threshold-label">
            rows
            <span className="row" style={{ gap: '0.25rem' }}>
              {ALLOWED_ROWS.map((n) => (
                <button
                  key={n}
                  type="button"
                  className={`chip${rows === n ? ' active' : ''}`}
                  onClick={() => setRows(n)}
                  aria-label={`rows ${n}`}
                >
                  {n}
                </button>
              ))}
            </span>
          </label>
          {session.ready ? (
            <button onClick={drop} disabled={!canDrop}>
              {session.status === 'playing' ? 'Dropping…' : 'Drop'}
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
        {ladder && (
          <p className="card-meta muted">
            payout ladder{' '}
            {ladder.map((x, bucket) => (
              <span key={bucket} className="tag">
                {bucket}
                <span className="mono"> {fmtMult(x)}</span>
              </span>
            ))}
          </p>
        )}
        <p className="muted">
          {amount !== '' && stake === undefined && <span className="bad">enter a positive amount · </span>}
          {!rowsOk && (
            <span className="bad">rows must be one of {ALLOWED_ROWS.join(' / ')} · </span>
          )}
          {rowsOk && ladder === undefined && (
            <span className="bad">no paytable for {risk} risk at {rows} rows · </span>
          )}
          {maxMult !== undefined && maxMult > 0n && (
            <span className="ok">up to {fmtMult(maxMult)}</span>
          )}
        </p>
        {session.commit && (
          <p className="card-meta muted">
            server-seed commit <span className="mono">{session.commit.slice(0, 10)}…</span>
            {session.balances && (
              <>
                {' · '}your balance {viem.formatEther(session.balances.player)} · {session.roundsLeft} drops left
              </>
            )}
          </p>
        )}
        {session.error && <p className="bad">{session.error}</p>}
      </div>

      <h2>This table</h2>
      {!session.ready && session.history.length === 0 && (
        <p className="muted">No table open — set your stake and board, then open one to start dropping.</p>
      )}
      {[...session.history].reverse().map((record) => (
        <RoundReceipt key={record.round} record={record} />
      ))}

      {myAddress && session.history.length > 0 && (
        <>
          <h2>Your book</h2>
          <details className="history" open>
            <summary>
              {session.history.length} drop{session.history.length === 1 ? '' : 's'}
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
