import { useState } from 'react'
import * as viem from 'viem'
import { andarBahar, dealAndarBahar, shuffleDeck, type AndarBaharParams, type AndarBaharBet } from '@msgboard/games'
import type { GameDeployment } from '../config'
import { useSession, type RoundRecord } from '../hooks/useSession'
import { parseStake } from './StakeInput'
import { TurnTiming } from './TurnTiming'
import { Card, CardBack } from './decisionShared'
import { GameStage } from './shell/GameStage'
import { BetTray } from './shell/BetTray'
import { MetaPanel } from './shell/MetaPanel'
import { FeltTable } from './stages/FeltTable'

const BETS: readonly AndarBaharBet[] = ['andar', 'bahar']
const fmtMult = (x100: bigint): string => `${(Number(x100) / 100).toFixed(2)}x`
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

/** Rebuild the two rows dealt from the seed: joker = deck[0], then alternate Andar (odd), Bahar
 *  (even) up to and including the matching card (`cardsDealt`). */
const rebuild = (raw: bigint) => {
  const { joker, winner, cardsDealt } = dealAndarBahar(raw)
  const deck = shuffleDeck(raw)
  const andar: number[] = []
  const bahar: number[] = []
  for (let i = 1; i <= cardsDealt; i++) (i % 2 === 1 ? andar : bahar).push(deck[i]!)
  return { joker, winner, andar, bahar }
}

const RoundReceipt = ({ record }: { record: RoundRecord }) => (
  <div className="card">
    <div className="row" style={{ justifyContent: 'space-between' }}>
      <span>
        <span className="tag">round {record.round}</span>
        {viem.formatEther(record.stake)} staked
        {record.win ? <span className="tag ok">won {fmtMult(record.multiplierX100)}</span> : <span className="tag">lost</span>}
      </span>
      <span className={record.playerDelta >= 0n ? 'ok' : 'bad'}>
        {record.playerDelta >= 0n ? '+' : ''}
        {viem.formatEther(record.playerDelta)}
      </span>
    </div>
    <p className="card-meta muted">
      balance {viem.formatEther(record.balancePlayer)} · co-signed by both parties
    </p>
    {record.timing && <p className="card-meta muted"><TurnTiming timing={record.timing} /></p>}
  </div>
)

/** One side's row of dealt cards, label lit gold when this side caught the joker's rank. */
const SideRow = ({ label, cards, won }: { label: string; cards?: number[]; won?: boolean }) => (
  <div className="row" style={{ gap: 8, alignItems: 'center', minHeight: 62 }}>
    <span
      className={won ? 'ok' : 'muted'}
      style={{ width: 52, textAlign: 'right', letterSpacing: '0.1em', fontSize: 12, fontWeight: won ? 700 : 400 }}
    >
      {label}
    </span>
    <div className="row" style={{ gap: 4 }}>
      {cards && cards.length > 0 ? cards.map((c, i) => <Card key={i} index={c} />) : <span className="muted" style={{ opacity: 0.4 }}>—</span>}
    </div>
  </div>
)

/**
 * Andar Bahar — a joker is revealed, then cards fall alternately to Andar (first) and Bahar until one
 * matches the joker's rank; that side wins. The joker sits at the head of the table, the two rows build
 * down the center, and the Andar / Bahar circles line the rail. The whole deal is recomputed from the
 * round's revealed seed. Andar is dealt first (a small edge) so it pays 0.9:1; Bahar pays 1:1.
 */
export const AndarBaharScreen = ({
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
  const [bet, setBet] = useState<AndarBaharBet>('andar')

  const session = useSession<AndarBaharParams>({
    game: andarBahar,
    walletClient,
    chainId: deployment.chainId,
    boardRpc: deployment.boardRpc,
    gameLabel: 'andar-bahar',
  })

  const stake = parseStake(amount)
  const busy = session.status === 'opening' || session.status === 'playing'
  const canOpen = walletClient !== undefined && trustAcknowledged && !busy
  const canDeal = session.ready && !busy && stake !== undefined

  const deal = () => {
    if (stake === undefined) return
    void session.play(stake, { bet })
  }

  const last = session.history.length > 0 ? session.history[session.history.length - 1] : undefined
  const coup = last ? rebuild(last.raw) : undefined

  const wins = session.history.filter((r) => r.win).length
  const net = session.history.reduce((sum, r) => sum + r.playerDelta, 0n)

  const jokerNode = (
    <div className="row" style={{ flexDirection: 'column', alignItems: 'center', gap: 4 }}>
      {coup ? <Card index={coup.joker} /> : <CardBack />}
      <span className="muted" style={{ letterSpacing: '0.12em', fontSize: 10 }}>Joker</span>
    </div>
  )
  const rowsNode = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <SideRow label="Andar" cards={coup?.andar} won={coup?.winner === 'andar'} />
      <SideRow label="Bahar" cards={coup?.bahar} won={coup?.winner === 'bahar'} />
    </div>
  )
  const spotsNode = BETS.map((b) => (
    <button
      key={b}
      type="button"
      className={`spot${bet === b ? ' main' : ''}`}
      onClick={() => setBet(b)}
      aria-label={`bet ${b}`}
      style={coup && coup.winner === b ? { outline: '2px solid var(--gold-live)', outlineOffset: 3 } : undefined}
    >
      {cap(b)}
      <span style={{ display: 'block', fontSize: 9, opacity: 0.75, fontWeight: 400 }}>
        {fmtMult(andarBahar.maxMultiplierX100({ bet: b }))}
      </span>
    </button>
  ))

  const dealLabel = session.status === 'playing' ? 'Dealing…' : 'Deal'
  const openLabel = session.status === 'opening' ? 'Opening…' : 'Open table'

  return (
    <>
      <GameStage title="ANDAR BAHAR" subtitle="catch the joker's rank">
        <FeltTable dealer={jokerNode} spread={rowsNode} spots={spotsNode} centerMark={null} />
      </GameStage>

      <div className="tray-col">
        <BetTray
          amount={amount}
          onAmount={setAmount}
          action={
            session.ready ? (
              <button className="primary" onClick={deal} disabled={!canDeal}>{dealLabel}</button>
            ) : (
              <button className="primary" onClick={() => void session.start()} disabled={!canOpen}>{openLabel}</button>
            )
          }
        >
          <p className="tray-hint">
            betting <b style={{ color: 'var(--gold)' }}>{cap(bet)}</b> · pays {fmtMult(andarBahar.maxMultiplierX100({ bet }))}
            <span className="muted"> · Andar deals first</span>
          </p>
          {!walletClient && <p className="tray-hint">connect a wallet to play</p>}
          {walletClient && !trustAcknowledged && <p className="tray-hint">tap "Got it" on the fairness note above first</p>}
          {last && coup && (
            <p className={last.win ? 'ok' : 'bad'}>
              {cap(coup.winner)} catches it · {coup.andar.length + coup.bahar.length} cards ·{' '}
              {last.win ? `+${viem.formatEther(last.playerDelta)}` : viem.formatEther(last.playerDelta)}
            </p>
          )}
          {session.error && <p className="bad">{session.error}</p>}
        </BetTray>

        <MetaPanel tabs={['Recent', 'Stats']}>
          {myAddress && session.history.length > 0 ? (
            <span>
              <b>{net >= 0n ? '+' : ''}{viem.formatEther(net)}</b> net · {wins}/{session.history.length} won
              {session.commit && <span className="muted"> · commit {session.commit.slice(0, 10)}…</span>}
            </span>
          ) : (
            <span className="muted">{session.ready ? 'table open — set your bet and deal' : 'no hands yet'}</span>
          )}
        </MetaPanel>
      </div>

      {myAddress && session.history.length > 0 && (
        <>
          <h2>Your book</h2>
          <details className="history">
            <summary>
              {session.history.length} hand{session.history.length === 1 ? '' : 's'}
              <span className="muted"> · {wins}/{session.history.length} won · {viem.formatEther(net)} net</span>
            </summary>
            {[...session.history].reverse().map((record) => (
              <RoundReceipt key={record.round} record={record} />
            ))}
          </details>
        </>
      )}
    </>
  )
}
