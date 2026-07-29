import type { ReactNode } from 'react'

/** Trim a scaled amount to a clean short decimal (no float dust, no trailing zeros). */
const fmt = (n: number): string => (!isFinite(n) || n <= 0 ? '0' : parseFloat(n.toFixed(6)).toString())

/**
 * The docked bet controls: a full-width amount box + a tidy quick-set row, then any game-specific
 * fields (`children`), the primary action, and the provably-fair link. The amount is continuous —
 * ½/2× scale the current value, the presets set it — replacing the old cramped inline-chip input.
 */
export const BetTray = ({
  amount,
  onAmount,
  min,
  unit = '◈ PLS',
  quick,
  action,
  children,
}: {
  amount: string
  onAmount: (v: string) => void
  min?: string
  unit?: string
  quick?: ReactNode
  action: ReactNode
  children?: ReactNode
}) => {
  const n = parseFloat(amount)
  const scale = (f: number) => onAmount(fmt((isFinite(n) ? n : 0) * f))
  return (
    <div className="bet">
      <div className="top">
        <span>Amount</span>
        {min && <span>{min}</span>}
      </div>
      <label className="amount">
        <input
          className="amount-input"
          inputMode="decimal"
          value={amount}
          onChange={(e) => onAmount(e.target.value)}
          placeholder="0"
          aria-label="stake amount"
        />
        <span className="m">{unit}</span>
      </label>
      {quick ?? (
        <div className="quick">
          <button type="button" onClick={() => scale(0.5)}>
            ½
          </button>
          <button type="button" onClick={() => scale(2)}>
            2×
          </button>
          <button type="button" onClick={() => onAmount('1')}>
            1
          </button>
          <button type="button" onClick={() => onAmount('10')}>
            10
          </button>
        </div>
      )}
      {children}
      {action}
      <div className="pf-link">🤝 Provably fair — replay the transcript ↗</div>
    </div>
  )
}
