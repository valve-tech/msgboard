import { useState } from 'react'
import * as viem from 'viem'
import { cardName } from '@msgboard/zk-cards-core'
import type { Bet } from '@msgboard/hilo-war'
import type { GameDeployment } from '../config'
import { useWarSession, type FlipRecord } from '../hooks/useWarSession'
import { TurnTiming } from './TurnTiming'
import { InfoDot } from './Meta'

/** hidden-card glyph for a folded / unrevealed opponent card. */
const CARD_BACK = '🂠'

/** Render a card index as a glyph (e.g. `K♠`), or the hidden back when null. */
const renderCard = (i: number | null): string => (i === null ? CARD_BACK : cardName(i))

const winnerLabel = (r: FlipRecord): { text: string; cls: string } => {
  if (r.folded) return r.winner === 'A' ? { text: 'house folded', cls: 'ok' } : { text: 'you folded', cls: 'bad' }
  if (r.winner === null) return { text: 'tie — war carry', cls: 'tag' }
  return r.winner === 'A' ? { text: 'you won', cls: 'ok' } : { text: 'house won', cls: 'bad' }
}

const FlipReceipt = ({ record }: { record: FlipRecord }) => {
  const w = winnerLabel(record)
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span>
          <span className="tag">flip {record.flip}</span>
          <span className="mono">{renderCard(record.myCard)}</span> you · house{' '}
          <span className="mono">{renderCard(record.opponentCard)}</span>
          <span className={`tag ${w.cls === 'tag' ? '' : w.cls}`}> {w.text}</span>
          <span className="tag">bet {record.bet}</span>
        </span>
        <span className={record.deltaA >= 0n ? 'ok' : 'bad'}>
          {record.deltaA >= 0n ? '+' : ''}
          {viem.formatEther(record.deltaA)}
        </span>
      </div>
      <p className="card-meta muted">
        your balance {viem.formatEther(record.balanceA)} · house {viem.formatEther(record.balanceB)}
        {record.pot > 0n && <> · war carry {viem.formatEther(record.pot)}</>} · co-signed by both peers
      </p>
      {record.timing && (
        <p className="card-meta muted">
          <TurnTiming timing={record.timing} />
        </p>
      )}
    </div>
  )
}

/**
 * Hi-Lo War — the two-peer ZK-masked-deck session game. There is NO entropy beacon: the randomness
 * is the masked-deck double shuffle co-signed at genesis. The human is Player A; an in-browser
 * random-strategy bot is Player B (mirroring how the other session screens run an in-browser house).
 *
 * Signature matches DiceScreen exactly. `walletClient`/`myAddress` gate opening a table and identify
 * the player; the in-browser session itself uses ephemeral keys for both peers (see useWarSession's
 * ASSUMPTIONS — co-signing every per-flip envelope through the injected wallet would be unplayable).
 */
export const HiLoWarScreen = ({
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
  const [bet, setBet] = useState<Bet>('HOLD')
  const [onRaise, setOnRaise] = useState<'CALL' | 'FOLD'>('CALL')

  const session = useWarSession({ chainId: deployment.chainId, boardRpc: deployment.boardRpc })

  const busy = session.status === 'opening' || session.status === 'playing' || session.status === 'settling'
  const canOpen = walletClient !== undefined && trustAcknowledged && !busy
  const canFlip = session.ready && !busy
  const settled = session.status === 'settled'

  const flip = () => void session.playFlip({ bet, onRaise })

  const wins = session.history.filter((r) => r.winner === 'A').length
  const taken = session.history.reduce((sum, r) => sum + r.deltaA, 0n)

  const Chip = <T extends string>({
    value,
    current,
    set,
    children,
  }: {
    value: T
    current: T
    set: (v: T) => void
    children: React.ReactNode
  }) => (
    <button
      onClick={() => set(value)}
      disabled={busy}
      className={value === current ? 'tag ok' : 'tag'}
      style={{ cursor: busy ? 'default' : 'pointer' }}
      aria-pressed={value === current}
    >
      {children}
    </button>
  )

  return (
    <div>
      <div className="card">
        <h3>
          Hi-Lo War
          <InfoDot>
            <strong>Higher card wins the pot.</strong> Each flip you and the house get one card
            face-down. Hold to ante, or Raise to push — the other side Calls (showdown) or Folds (its
            card stays hidden). Ties carry a war pot to the next flip. One shuffle, sealed at the
            start; no per-flip gas.
          </InfoDot>
        </h3>
        <div className="row" style={{ gap: '0.75rem', flexWrap: 'wrap', alignItems: 'center' }}>
          <span className="muted">bet</span>
          <Chip value="HOLD" current={bet} set={setBet}>
            Hold
          </Chip>
          <Chip value="RAISE" current={bet} set={setBet}>
            Raise
          </Chip>
          <span className="muted">if the house raises</span>
          <Chip value="CALL" current={onRaise} set={setOnRaise}>
            Call
          </Chip>
          <Chip value="FOLD" current={onRaise} set={setOnRaise}>
            Fold
          </Chip>
          {session.ready ? (
            <>
              <button onClick={flip} disabled={!canFlip}>
                {session.status === 'playing' ? 'Flipping…' : 'Flip'}
              </button>
              <button onClick={() => void session.settle()} disabled={!canFlip} className="tag">
                {session.status === 'settling' ? 'Settling…' : 'Cash out / settle'}
              </button>
            </>
          ) : (
            <button onClick={() => void session.start()} disabled={!canOpen}>
              {session.status === 'opening' ? 'Shuffling…' : settled ? 'Open new table' : 'Open table'}
            </button>
          )}
          {!walletClient && <span className="muted">connect a wallet to play</span>}
          {walletClient && !trustAcknowledged && (
            <span className="muted">tap "Got it" on the fairness note above first</span>
          )}
        </div>
        {session.deckCommitment && (
          <p className="card-meta muted">
            deck commitment <span className="mono">{session.deckCommitment.slice(0, 10)}…</span>
            {session.state && (
              <>
                {' · '}your balance {viem.formatEther(session.state.balanceA)} · house{' '}
                {viem.formatEther(session.state.balanceB)}
                {session.state.pot > 0n && <> · war carry {viem.formatEther(session.state.pot)}</>}
                {settled && <span className="ok"> · settled</span>}
              </>
            )}
          </p>
        )}
        {session.error && <p className="bad">{session.error}</p>}
      </div>

      <h2>This table</h2>
      {!session.ready && session.history.length === 0 && (
        <p className="muted">No table open — pick your bet, then open one to shuffle a fresh deck.</p>
      )}
      {[...session.history].reverse().map((record) => (
        <FlipReceipt key={record.nonce.toString()} record={record} />
      ))}

      {myAddress && session.history.length > 0 && (
        <>
          <h2>Your book</h2>
          <details className="history" open>
            <summary>
              {session.history.length} flip{session.history.length === 1 ? '' : 's'}
              <span className="muted">
                {' '}
                · {wins}/{session.history.length} won · {viem.formatEther(taken)} net
              </span>
            </summary>
            {[...session.history].reverse().map((record) => (
              <FlipReceipt key={record.nonce.toString()} record={record} />
            ))}
          </details>
        </>
      )}
    </div>
  )
}
