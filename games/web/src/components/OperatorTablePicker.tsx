import * as viem from 'viem'
import type { GameDeployment } from '../config'
import type { OperatorTableCard } from '../lib/operatorIndex'
import { fmtAmount } from './Meta'

const fmtMultiplier = (x100: number) => `${(x100 / 100).toFixed(2)}×`
const shortAddr = (address: viem.Address) => `${address.slice(0, 6)}…${address.slice(-4)}`

const TableRow = ({
  deployment,
  table,
  selected,
  onSelect,
}: {
  deployment: GameDeployment
  table: OperatorTableCard
  selected: boolean
  onSelect: (tableId: viem.Hex) => void
}) => {
  const reason = table.open ? undefined : 'paused by operator'
  return (
    <li>
      <button
        type="button"
        className={`tp-row${selected ? ' selected' : ''}`}
        disabled={reason !== undefined}
        title={reason}
        onClick={() => onSelect(table.tableId)}
      >
        <span className="mono tp-op">{shortAddr(table.operator)}</span>
        <span className="tag">{fmtMultiplier(table.maxMultiplierX100)}</span>
        <span className="tp-hot">
          {fmtAmount(deployment, table.minStake)}–{fmtAmount(deployment, table.maxStake)} stake
        </span>
        {reason && <span className="bad tp-reason">{reason}</span>}
      </button>
    </li>
  )
}

/**
 * Browse and pick a live operator coin-flip table. Pure presentation over the already-folded
 * `OperatorTableCard[]` (the screen owns the poll via `useOperatorRounds` + `foldOperatorTables`). Reuses
 * the tables picker's CSS classes so the look matches; open tables sort before paused ones.
 */
export const OperatorTablePicker = ({
  deployment,
  tables,
  selected,
  onSelect,
}: {
  deployment: GameDeployment
  tables: OperatorTableCard[]
  selected: viem.Hex | null
  onSelect: (tableId: viem.Hex) => void
}) => {
  const sorted = [...tables].sort((a, b) => Number(b.open) - Number(a.open))
  return (
    <div className="tp-picker card">
      <div className="row tp-head" style={{ justifyContent: 'space-between' }}>
        <span className="tp-title">Operator tables</span>
      </div>
      {sorted.length === 0 ? (
        <p className="muted tp-empty">no operator tables yet on this chain</p>
      ) : (
        <ul className="tp-list">
          {sorted.map((t) => (
            <TableRow
              key={t.tableId}
              deployment={deployment}
              table={t}
              selected={selected === t.tableId}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
    </div>
  )
}
