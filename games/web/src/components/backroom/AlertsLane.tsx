import type { Address, Hex } from 'viem'
import type { GameDeployment } from '../../config'
import type { OperatorTableView, PitRound, Treasury } from '../../lib/backroomIndex'
import type { Reconciliation } from '../../hooks/useBackroomData'
import { blocksSince, fmtToken, maxTableExposure, STALE_BLOCKS, tokenLabel, topTierPrice } from './shared'

type Alert = { id: string; severity: 'warn' | 'bad'; text: string }

const CAP_WARN_RATIO = 0.9
const FEE_RUNWAY_WARN_ROUNDS = 20n
const HEAD_LAG_WARN_BLOCKS = 5n

/**
 * 4.9 Alerts lane (SAFE-PRE, pinned) — every alert here fires on a liveness/capacity fact: round age,
 * cap usage, fee runway, idle bankroll, reconciliation drift, indexer staleness. None of it is a
 * function of any round's outcome (there is no outcome material anywhere in this file's inputs).
 */
export const computeAlerts = ({
  deployment,
  pit,
  tables,
  treasury,
  decidedUnsettled,
  reconciliation,
  status,
}: {
  deployment: GameDeployment
  pit: PitRound[]
  tables: OperatorTableView[]
  treasury: Treasury[]
  decidedUnsettled: number
  reconciliation: Reconciliation
  status: 'live' | 'degraded' | 'loading'
}): Alert[] => {
  const alerts: Alert[] = []
  const lastBlock = reconciliation.rpcHead

  const staleCount = pit.filter((r) => blocksSince(lastBlock, r.openedAtBlock) >= STALE_BLOCKS).length
  if (staleCount > 0) {
    alerts.push({
      id: 'stale-no-seed',
      severity: 'bad',
      text: `${staleCount} round${staleCount === 1 ? '' : 's'} past ${STALE_BLOCKS} blocks with no seed — eligible for a plain-timeout refund.`,
    })
  }

  if (decidedUnsettled > 0) {
    alerts.push({
      id: 'decided-unsettled',
      severity: 'warn',
      text: `${decidedUnsettled} round${decidedUnsettled === 1 ? '' : 's'} decided but not yet settled.`,
    })
  }

  for (const t of tables) {
    if (t.cap === 0n) continue
    const usedRatio = Number(t.locked) / Number(t.cap)
    if (usedRatio >= CAP_WARN_RATIO) {
      alerts.push({
        id: `cap-${t.tableId}`,
        severity: usedRatio >= 1 ? 'bad' : 'warn',
        text: `Table ${t.tableId.slice(0, 10)}… is at ${(usedRatio * 100).toFixed(0)}% of its cap (${fmtToken(deployment, t.token, t.locked)} / ${fmtToken(deployment, t.token, t.cap)}).`,
      })
    }
  }

  const bankrollOf = new Map(treasury.map((tr) => [tr.token, tr.bankroll]))
  const tablesByToken = new Map<Address, OperatorTableView[]>()
  for (const t of tables) tablesByToken.set(t.token, [...(tablesByToken.get(t.token) ?? []), t])

  for (const [token, tokenTables] of tablesByToken) {
    const tableIds = new Set<Hex>(tokenTables.map((t) => t.tableId))
    const bankroll = bankrollOf.get(token) ?? 0n
    const maxExposure = tokenTables.reduce(
      (m, t) => (maxTableExposure(t.maxStake, t.maxMultiplierX100) > m ? maxTableExposure(t.maxStake, t.maxMultiplierX100) : m),
      0n,
    )
    if (maxExposure > 0n && bankroll < maxExposure) {
      alerts.push({
        id: `idle-bankroll-${token}`,
        severity: 'warn',
        text: `Idle ${tokenLabel(deployment, token)} bankroll (${fmtToken(deployment, token, bankroll)}) is below one max-tier exposure (${fmtToken(deployment, token, maxExposure)}).`,
      })
    }

    const top = topTierPrice(pit, tableIds)
    const fees = treasury.find((tr) => tr.token === token)?.fees ?? 0n
    if (top && top > 0n) {
      const runway = fees / (3n * top)
      if (runway < FEE_RUNWAY_WARN_ROUNDS) {
        alerts.push({
          id: `fee-runway-${token}`,
          severity: fees === 0n ? 'bad' : 'warn',
          text: `${tokenLabel(deployment, token)} fee runway is low (~${runway.toString()} rounds left).`,
        })
      }
    } else if (fees === 0n && tokenTables.some((t) => t.open)) {
      alerts.push({
        id: `fee-pool-empty-${token}`,
        severity: 'bad',
        text: `${tokenLabel(deployment, token)} fee pool is empty — every open() on this token will revert InsufficientFees.`,
      })
    }
  }

  for (const t of reconciliation.tables) {
    if (t.delta !== 0n) {
      alerts.push({
        id: `drift-table-${t.tableId}`,
        severity: 'bad',
        text: `Reconciliation drift on table ${t.tableId.slice(0, 10)}…'s locked exposure (Δ ${t.delta.toString()} wei) — see the reconciliation strip.`,
      })
    }
  }
  for (const tr of reconciliation.tokens) {
    if (tr.ledgerDelta !== 0n) {
      alerts.push({
        id: `drift-ledger-${tr.token}`,
        severity: 'bad',
        text: `Reconciliation drift on the ${tokenLabel(deployment, tr.token)} escrow ledger (Δ ${tr.ledgerDelta.toString()} wei) — see the reconciliation strip.`,
      })
    }
  }

  if (status === 'degraded') {
    alerts.push({ id: 'degraded', severity: 'warn', text: 'Reading the chain directly — the indexer is unavailable or behind.' })
  }
  if (reconciliation.headDelta !== null && reconciliation.headDelta > HEAD_LAG_WARN_BLOCKS) {
    alerts.push({ id: 'indexer-stale', severity: 'warn', text: `Indexer is ${reconciliation.headDelta.toString()} blocks behind the RPC head.` })
  }

  return alerts
}

/** Pinned alert strip — never scrolled away with the rest of the panels. */
export const AlertsLane = (props: {
  deployment: GameDeployment
  pit: PitRound[]
  tables: OperatorTableView[]
  treasury: Treasury[]
  decidedUnsettled: number
  reconciliation: Reconciliation
  status: 'live' | 'degraded' | 'loading'
}) => {
  const alerts = computeAlerts(props)
  if (alerts.length === 0) return null
  return (
    <div className="brm-alerts">
      {alerts.map((a) => (
        <div key={a.id} className={`banner${a.severity === 'bad' ? ' bad' : ''}`}>
          {a.text}
        </div>
      ))}
    </div>
  )
}
