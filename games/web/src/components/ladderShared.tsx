import type { ReactNode } from 'react'
import * as viem from 'viem'
import type { LadderGameRecord, LadderSessionApi } from '../hooks/useLadderSession'
import { GameStage } from './shell/GameStage'
import { HowItWorksLink } from './HowItWorks'
import { BetTray } from './shell/BetTray'
import { MetaPanel } from './shell/MetaPanel'
import { LadderPath } from './stages/LadderPath'

const HUNDREDTHS = 100n
export const fmtMult = (x100: bigint): string => `${(Number(x100) / 100).toFixed(2)}x`

/** compact multiplier for tight slots (drop buckets): no "x", fewer digits as it grows. */
export const fmtMultShort = (x100: bigint): string => {
  const v = Number(x100) / 100
  return v >= 100 ? String(Math.round(v)) : v >= 10 ? v.toFixed(1) : v.toFixed(2)
}

/** A labelled row of difficulty toggle chips for a ladder game's tray config. */
export const DiffChips = <T extends string>({ label = 'difficulty', options, value, onChange, disabled }: {
  label?: string; options: readonly T[]; value: T; onChange: (v: T) => void; disabled?: boolean
}) => (
  <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
    <span className="muted" style={{ fontSize: 12, minWidth: 66 }}>{label}</span>
    {options.map((o) => (
      <button key={o} type="button" disabled={disabled} onClick={() => onChange(o)}
        className={o === value ? 'tag ok' : 'tag'} style={{ cursor: disabled ? 'default' : 'pointer', textTransform: 'capitalize' }}>{o}</button>
    ))}
  </div>
)

/** A finished ladder-game receipt with the provably-fair verify line (seed re-checked). */
export const LadderReceipt = ({ record, noun }: { record: LadderGameRecord; noun: string }) => {
  const won = record.status === 'cashed'
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span>
          <span className="tag">{noun} {record.id}</span>
          {viem.formatEther(record.stake)} staked
          {won ? <span className="tag ok">cashed {fmtMult(record.multiplierX100)}</span> : <span className="tag">busted</span>}
        </span>
        <span className={record.playerDelta >= 0n ? 'ok' : 'bad'}>
          {record.playerDelta >= 0n ? '+' : ''}
          {viem.formatEther(record.playerDelta)}
        </span>
      </div>
      <p className="card-meta muted">
        {record.steps} step{record.steps === 1 ? '' : 's'} · co-signed move log ({record.moves.length})
      </p>
      <p className="card-meta muted">
        provably fair · commit <span className="mono">{record.commit.slice(0, 10)}…</span> ·{' '}
        {record.verdict.ok ? <span className="ok">verify ✓ (seed re-checked)</span> : <span className="bad">verify ✗ {record.verdict.reason}</span>}
      </p>
    </div>
  )
}

/**
 * Shared shell for the stateful ladder screens on the LadderPath surface. Each game supplies its
 * climb visuals (per-rung multiplier + marker, the live rung's label + choice controls, the summit
 * crown) and its tray config; this renders the stage + docked tray (stake · config · running
 * multiplier · New/Cash-out) + the collapsed receipt history. Game mechanics live in the injected
 * `session` (useLadderSession) — this is presentation only.
 */
export const LadderShell = ({
  title, subtitle, noun, startLabel,
  amount, setAmount, session, canStart, onStart, stake,
  walletClient, trustAcknowledged, myAddress,
  steps, summit, multAt, markAt, currentLabel, choices, configTray, nextHint,
}: {
  title: string
  subtitle?: string
  noun: string
  startLabel: string
  amount: string
  setAmount: (v: string) => void
  session: LadderSessionApi
  canStart: boolean
  onStart: () => void
  stake?: bigint
  walletClient?: viem.WalletClient
  trustAcknowledged: boolean
  myAddress?: viem.Hex
  // climb visuals
  steps: number
  summit?: ReactNode
  multAt?: (i: number) => string
  markAt?: (i: number) => ReactNode
  currentLabel?: ReactNode
  choices: ReactNode
  /** config controls for the tray (difficulty chips, etc.). */
  configTray?: ReactNode
  /** game-specific "next Xx" hint appended to the running-multiplier line. */
  nextHint?: ReactNode
}) => {
  const playing = session.status === 'playing'
  const cashOut = stake !== undefined && session.step > 0 ? (stake * session.multiplierX100) / HUNDREDTHS : undefined
  const cashed = session.history.filter((g) => g.status === 'cashed').length
  const net = session.history.reduce((s, g) => s + g.playerDelta, 0n)

  return (
    <>
      <GameStage title={title} subtitle={subtitle} action={<HowItWorksLink />}>
        <LadderPath
          steps={steps}
          current={session.step}
          status={session.status}
          bustedStep={session.state?.bustStep ?? undefined}
          multAt={multAt}
          markAt={markAt}
          currentLabel={currentLabel}
          choices={choices}
          summit={summit}
        />
      </GameStage>

      <div className="tray-col">
        <BetTray
          amount={amount}
          onAmount={setAmount}
          action={
            playing ? (
              <button className="primary" onClick={() => session.cashOut()} disabled={!session.canCashOut}>
                Cash out{cashOut !== undefined ? ` · ${viem.formatEther(cashOut)}` : ''}
              </button>
            ) : (
              <button className="primary" onClick={onStart} disabled={!canStart}>{startLabel}</button>
            )
          }
        >
          {configTray}
          {playing && (
            <p className="tray-hint">
              now <b style={{ color: 'var(--gold-live)' }}>{fmtMult(session.multiplierX100)}</b>
              {nextHint}
              {cashOut !== undefined && <span className="muted"> · cash out {viem.formatEther(cashOut)}</span>}
            </p>
          )}
          {!walletClient && <p className="tray-hint">connect a wallet to play</p>}
          {walletClient && !trustAcknowledged && <p className="tray-hint">tap "Got it" on the fairness note above first</p>}
          {session.lastGame && (
            <p className={session.lastGame.status === 'cashed' ? 'ok' : 'bad'}>
              {session.lastGame.status === 'cashed'
                ? `cashed ${fmtMult(session.lastGame.multiplierX100)} · +${viem.formatEther(session.lastGame.playerDelta)}`
                : `busted · ${viem.formatEther(session.lastGame.playerDelta)}`}
            </p>
          )}
          {session.error && <p className="bad">{session.error}</p>}
        </BetTray>

        <MetaPanel tabs={['Recent', 'Stats']}>
          {myAddress && session.history.length > 0 ? (
            <span><b>{net >= 0n ? '+' : ''}{viem.formatEther(net)}</b> net · {cashed}/{session.history.length} cashed</span>
          ) : (
            <span className="muted">{playing ? `climbing — ${noun} in progress` : `no ${noun}s yet`}</span>
          )}
        </MetaPanel>
      </div>

      {myAddress && session.history.length > 0 && (
        <>
          <h2>Your book</h2>
          <details className="history">
            <summary>
              {session.history.length} {noun}{session.history.length === 1 ? '' : 's'}
              <span className="muted"> · {cashed}/{session.history.length} cashed · {viem.formatEther(net)} net</span>
            </summary>
            {[...session.history].reverse().map((record) => <LadderReceipt key={record.id} record={record} noun={noun} />)}
          </details>
        </>
      )}
    </>
  )
}
