import { useState } from 'react'
import * as viem from 'viem'
import {
  pachinko,
  pachinkoFairTableX100,
  pachinkoMultiplierX100,
  PACHINKO_DEFAULT_ROWS,
  type PachinkoParams,
  type PachinkoRisk,
} from '@msgboard/games'
import type { GameDeployment } from '../config'
import { useSession, type RoundRecord } from '../hooks/useSession'
import { StakeInput, parseStake } from './StakeInput'
import { TurnTiming } from './TurnTiming'
import { InfoDot } from './Meta'

/** the row counts this screen offers; only 12 ships a table for now (PACHINKO_DEFAULT_ROWS). */
const ALLOWED_ROWS = [PACHINKO_DEFAULT_ROWS] as const
const RISKS: readonly PachinkoRisk[] = ['low', 'medium', 'high']

const fmtMult = (x100: bigint): string => `${(Number(x100) / 100).toFixed(2)}x`

/** the edged per-slot multiplier ladder for a (risk, rows) pair, straight from the package helpers. */
const ladderFor = (risk: PachinkoRisk, rows: number): bigint[] | undefined => {
  try {
    const fair = pachinkoFairTableX100(risk, rows)
    return fair.map((_, slot) => pachinkoMultiplierX100(risk, rows, slot))
  } catch {
    return undefined
  }
}

/**
 * OFF-CHAIN session-game screen (Pachinko). A ball deflects through pegs into a slot; the slot sets the
 * multiplier. Mechanically the plinko engine with a pachinko paytable. Settles off-chain, co-signed.
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

export const PachinkoScreen = ({
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
  const [risk, setRisk] = useState<PachinkoRisk>('medium')
  const [rows, setRows] = useState<number>(PACHINKO_DEFAULT_ROWS)

  const session = useSession<PachinkoParams>({
    game: pachinko,
    walletClient,
    chainId: deployment.chainId,
    boardRpc: deployment.boardRpc,
    gameLabel: 'pachinko',
  })

  const stake = parseStake(amount)
  const rowsOk = (ALLOWED_ROWS as readonly number[]).includes(rows)
  const ladder = rowsOk ? ladderFor(risk, rows) : undefined
  const paramsOk = rowsOk && ladder !== undefined
  const params: PachinkoParams | undefined = paramsOk ? { rows, risk } : undefined
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
          Pachinko
          <InfoDot>
            <strong>Drop a ball through the pins.</strong> Where it settles sets your multiplier — higher
            risk spreads the payouts wider, and the edge slots pay the most. (Payout values shown are
            illustrative.) Instant off-chain settle, no gas, sealed seed you can re-check.
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
            {ladder.map((x, slot) => (
              <span key={slot} className="tag">
                {slot}
                <span className="mono"> {fmtMult(x)}</span>
              </span>
            ))}
          </p>
        )}
        <p className="muted">
          {amount !== '' && stake === undefined && <span className="bad">enter a positive amount · </span>}
          {!rowsOk && <span className="bad">rows must be one of {ALLOWED_ROWS.join(' / ')} · </span>}
          {rowsOk && ladder === undefined && (
            <span className="bad">no paytable for {risk} risk at {rows} rows · </span>
          )}
          {maxMult !== undefined && maxMult > 0n && <span className="ok">up to {fmtMult(maxMult)}</span>}
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
