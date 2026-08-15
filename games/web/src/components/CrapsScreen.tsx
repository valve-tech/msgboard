import { useState } from 'react'
import * as viem from 'viem'
import { craps, resolveCraps, type CrapsParams, type CrapsBet } from '@msgboard/games'
import type { GameDeployment } from '../config'
import { useSession, type RoundRecord } from '../hooks/useSession'
import { parseStake } from './StakeInput'
import { TurnTiming } from './TurnTiming'
import { GameStage } from './shell/GameStage'
import { BetTray } from './shell/BetTray'
import { MetaPanel } from './shell/MetaPanel'
import { FeltTable } from './stages/FeltTable'

const BETS: readonly CrapsBet[] = ['pass', 'dontpass']
const LINE_LABEL: Record<CrapsBet, string> = { pass: 'Pass', dontpass: "Don't Pass" }
const DIE_FACE = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅']

const Die = ({ n, dim }: { n: number; dim?: boolean }) => (
  <span style={{ fontSize: 'clamp(46px, 7vw, 78px)', lineHeight: 1, color: dim ? '#3f5545' : 'var(--cream, #f3ead7)', filter: 'drop-shadow(0 4px 6px #000a)' }}>
    {DIE_FACE[n - 1]}
  </span>
)

const RoundReceipt = ({ record }: { record: RoundRecord }) => {
  const push = !record.win && record.playerDelta === 0n
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span>
          <span className="tag">roll {record.round}</span>
          {viem.formatEther(record.stake)} staked
          {record.win ? <span className="tag ok">won</span> : push ? <span className="tag">push (bar 12)</span> : <span className="tag">lost</span>}
        </span>
        <span className={record.playerDelta >= 0n ? 'ok' : 'bad'}>
          {record.playerDelta >= 0n ? '+' : ''}
          {viem.formatEther(record.playerDelta)}
        </span>
      </div>
      <p className="card-meta muted">balance {viem.formatEther(record.balancePlayer)} · co-signed by both parties</p>
      {record.timing && <p className="card-meta muted"><TurnTiming timing={record.timing} /></p>}
    </div>
  )
}

export const CrapsScreen = ({ deployment, walletClient, trustAcknowledged, myAddress }: {
  deployment: GameDeployment; walletClient?: viem.WalletClient; trustAcknowledged: boolean; myAddress?: viem.Hex
}) => {
  const [amount, setAmount] = useState('0.1')
  const [bet, setBet] = useState<CrapsBet>('pass')

  const session = useSession<CrapsParams>({
    game: craps,
    walletClient,
    chainId: deployment.chainId,
    boardRpc: deployment.boardRpc,
    gameLabel: 'craps',
  })

  const stake = parseStake(amount)
  const busy = session.status === 'opening' || session.status === 'playing'
  const canOpen = walletClient !== undefined && trustAcknowledged && !busy
  const canRoll = session.ready && !busy && stake !== undefined

  const roll = () => {
    if (stake === undefined) return
    void session.play(stake, { bet })
  }

  const last = session.history.length > 0 ? session.history[session.history.length - 1] : undefined
  // rolls + point are bet-independent (same dice); only the win/lose flips by line, which we take
  // from the co-signed record. Pass here just to extract the shoot.
  const shoot = last ? resolveCraps(last.raw, 'pass') : undefined
  const finalRoll = shoot ? shoot.rolls[shoot.rolls.length - 1] : undefined
  const point = shoot ? shoot.point : null
  const outcome = last ? (last.win ? 'win' : last.playerDelta === 0n ? 'push' : 'lose') : undefined

  const wins = session.history.filter((r) => r.win).length
  const net = session.history.reduce((sum, r) => sum + r.playerDelta, 0n)

  const puckNode = (
    <div className="spot main" style={{ width: 'clamp(52px, 6vw, 68px)', fontSize: 11, letterSpacing: '0.06em', fontVariantNumeric: 'tabular-nums' }}>
      {point !== null ? <>ON<span style={{ display: 'block', fontSize: 18, fontWeight: 700 }}>{point}</span></> : 'OFF'}
    </div>
  )
  const diceNode = (
    <div className="row" style={{ flexDirection: 'column', alignItems: 'center', gap: 8 }}>
      <div className="row" style={{ gap: 'clamp(8px, 2vw, 18px)' }}>
        {finalRoll ? <><Die n={finalRoll[0]} /><Die n={finalRoll[1]} /></> : <><Die n={3} dim /><Die n={4} dim /></>}
      </div>
      <span className="muted" style={{ letterSpacing: '0.1em', fontSize: 12 }}>
        {finalRoll ? `rolled ${finalRoll[0] + finalRoll[1]}${shoot && shoot.rolls.length > 1 ? ` · ${shoot.rolls.length} rolls` : ''}` : 'set your line and roll'}
      </span>
    </div>
  )
  const spotsNode = BETS.map((b) => (
    <button
      key={b}
      type="button"
      className={`spot${bet === b ? ' main' : ''}`}
      onClick={() => setBet(b)}
      aria-label={`bet ${b}`}
      style={outcome && outcome !== 'push' && bet === b ? { outline: `2px solid ${outcome === 'win' ? '#5cc98f' : '#e0574a'}`, outlineOffset: 3 } : undefined}
    >
      {b === 'pass' ? 'Pass' : "Don't"}
      <span style={{ display: 'block', fontSize: 9, opacity: 0.75, fontWeight: 400 }}>2.00x</span>
    </button>
  ))

  const rollLabel = session.status === 'playing' ? 'Rolling…' : 'Roll'
  const openLabel = session.status === 'opening' ? 'Opening…' : 'Open table'

  return (
    <>
      <GameStage title="CRAPS" subtitle="the pass line · sealed dice">
        <FeltTable dealer={puckNode} spread={diceNode} spots={spotsNode} centerMark={null} />
      </GameStage>

      <div className="tray-col">
        <BetTray
          amount={amount}
          onAmount={setAmount}
          action={
            session.ready ? (
              <button className="primary" onClick={roll} disabled={!canRoll}>{rollLabel}</button>
            ) : (
              <button className="primary" onClick={() => void session.start()} disabled={!canOpen}>{openLabel}</button>
            )
          }
        >
          <p className="tray-hint">
            on the <b style={{ color: 'var(--gold)' }}>{LINE_LABEL[bet]}</b> line · pays 2.00x
            <span className="muted"> · even money</span>
          </p>
          {!walletClient && <p className="tray-hint">connect a wallet to play</p>}
          {walletClient && !trustAcknowledged && <p className="tray-hint">tap "Got it" on the fairness note above first</p>}
          {last && outcome && (
            <p className={outcome === 'win' ? 'ok' : outcome === 'push' ? '' : 'bad'}>
              {outcome === 'win' ? 'line wins' : outcome === 'push' ? 'push · bar 12' : 'line loses'} ·{' '}
              {last.playerDelta >= 0n ? '+' : ''}{viem.formatEther(last.playerDelta)}
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
            <span className="muted">{session.ready ? 'table open — pick your line and Roll' : 'no rolls yet'}</span>
          )}
        </MetaPanel>
      </div>

      {myAddress && session.history.length > 0 && (
        <>
          <h2>Your book</h2>
          <details className="history">
            <summary>
              {session.history.length} roll{session.history.length === 1 ? '' : 's'}
              <span className="muted"> · {wins}/{session.history.length} won · {viem.formatEther(net)} net</span>
            </summary>
            {[...session.history].reverse().map((record) => <RoundReceipt key={record.round} record={record} />)}
          </details>
        </>
      )}
    </>
  )
}
