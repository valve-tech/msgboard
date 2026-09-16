import { useMemo, useState } from 'react'
import * as viem from 'viem'
import type { Address, Hex } from 'viem'
import type { GameDeployment } from '../config'
import { useBackroomData } from '../hooks/useBackroomData'
import { AlertsLane } from './backroom/AlertsLane'
import { ExposureMeters } from './backroom/ExposureMeters'
import { FloorOverview } from './backroom/FloorOverview'
import { Incidents } from './backroom/Incidents'
import { Pit } from './backroom/Pit'
import { PnL } from './backroom/PnL'
import { Reconciliation } from './backroom/Reconciliation'
import { Tape } from './backroom/Tape'
import { Treasury } from './backroom/Treasury'
import { Menu } from './Menu'

const OPERATOR_MODES = ['Connected wallet', 'Custom address']

/** Never a blank page (spec §6) — a handful of dim placeholder tiles instead of nothing while the
 *  first indexer/getLogs poll is in flight. */
const FloorSkeleton = () => (
  <div className="card">
    <h3>Floor</h3>
    <div className="brm-grid">
      {[0, 1, 2].map((i) => (
        <div className="brm-tile brm-skel" key={i} aria-hidden />
      ))}
    </div>
  </div>
)

/**
 * The operator's security room: one live read-only view of every table, in-flight round (positions
 * only), bankroll, exposure vs cap, and the settle/forfeit tape. Never sends a transaction (Global
 * Constraints: read-only only) — every control here is a `Menu`, never a write button.
 *
 * Full-page, non-immersive layout (page scroll, like Standings/Live) — dense multi-panel data wants
 * scroll, not the immersive HUD (spec §3 "Placement").
 */
export const BackroomScreen = ({ deployment, operator }: { deployment: GameDeployment; operator?: Address }) => {
  const [mode, setMode] = useState(0) // 0 = connected wallet, 1 = custom address
  const [customAddress, setCustomAddress] = useState('')

  const customValid = viem.isAddress(customAddress)
  const effectiveOperator: Address | undefined =
    mode === 1 ? (customValid ? (customAddress as Address) : undefined) : operator

  const data = useBackroomData(effectiveOperator ?? viem.zeroAddress)

  // tableId -> token, shared by every panel below that needs to label an amount without its own
  // token field (Pit/Tape/Incidents/PnL — none of those types carry a token, by design: it's the
  // table's property, not the round's).
  const tableTokens = useMemo<Map<Hex, Address>>(() => new Map(data.tables.map((t) => [t.tableId, t.token])), [data.tables])

  return (
    <div>
      <div className="card">
        <h3>🎥 Backroom — {deployment.label}</h3>
        <p className="muted">
          A read-only security room: every table, every position in flight, bankroll vs exposure, and the
          settle/forfeit tape. Never writes a transaction — deposits, withdrawals, and policy changes stay in{' '}
          <span className="mono">operator-ops.ts</span>.
        </p>
        <div className="row">
          <Menu label="operator source" options={OPERATOR_MODES} value={mode} onChange={setMode} />
          {mode === 1 && (
            <input
              value={customAddress}
              onChange={(e) => setCustomAddress(e.target.value)}
              placeholder="0x… operator address"
              className="mono"
              style={{ minWidth: '22rem' }}
            />
          )}
          {effectiveOperator ? (
            <span className="tag mono">{effectiveOperator.slice(0, 6)}…{effectiveOperator.slice(-4)}</span>
          ) : (
            <span className="tag bad">no operator selected</span>
          )}
          <span className={`tag${data.status === 'live' ? ' ok' : data.status === 'degraded' ? ' bad' : ''}`}>{data.status}</span>
          <span className="mono muted">block {data.lastBlock.toString()}</span>
        </div>
        {mode === 0 && !operator && <p className="tray-hint">Connect a wallet, or switch to "Custom address" above, to read an operator's bankroll.</p>}
        {mode === 1 && customAddress.length > 0 && !customValid && <p className="tray-hint bad">Not a valid address.</p>}
      </div>

      {!effectiveOperator ? null : data.status === 'loading' ? (
        <FloorSkeleton />
      ) : (
        <>
          <AlertsLane
            deployment={deployment}
            pit={data.pit}
            tables={data.tables}
            treasury={data.treasury}
            decidedUnsettled={data.decidedUnsettled}
            reconciliation={data.reconciliation}
            status={data.status}
          />
          <FloorOverview deployment={deployment} tables={data.tables} treasury={data.treasury} lastBlock={data.lastBlock} />
          <Treasury deployment={deployment} treasury={data.treasury} treasuryHistory={data.treasuryHistory} pit={data.pit} tableTokens={tableTokens} />
          <ExposureMeters deployment={deployment} tables={data.tables} treasury={data.treasury} />
          <Pit deployment={deployment} pit={data.pit} lastBlock={data.lastBlock} decidedUnsettled={data.decidedUnsettled} tableTokens={tableTokens} />
          <Tape deployment={deployment} tape={data.tape} tableTokens={tableTokens} />
          <Incidents deployment={deployment} tables={data.tables} tape={data.tape} pit={data.pit} lastBlock={data.lastBlock} />
          <PnL deployment={deployment} tape={data.tape} treasury={data.treasury} tableTokens={tableTokens} lastBlock={data.lastBlock} />
          <Reconciliation
            deployment={deployment}
            reconciliation={data.reconciliation}
            tables={data.tables}
            pit={data.pit}
            tape={data.tape}
            treasury={data.treasury}
            status={data.status}
          />
        </>
      )}
    </div>
  )
}
