import * as viem from 'viem'

/** Parse a user-typed coin amount; undefined when it isn't a positive number. */
export const parseStake = (raw: string): bigint | undefined => {
  if (!/^\d*\.?\d+$/.test(raw.trim())) return undefined
  try {
    const wei = viem.parseEther(raw.trim())
    return wei > 0n ? wei : undefined
  } catch {
    return undefined
  }
}

const QUICK = ['0.1', '1', '10']

/**
 * Manual stake entry with quick-fill chips. The chips are the old preset ladder — still the
 * liquidity nudge (identical stakes pair/pool together), but the amount is yours to set.
 */
export const StakeInput = ({
  value,
  onChange,
  placeholder = 'stake',
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
}) => (
  <span className="stake-input">
    <input
      inputMode="decimal"
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{ width: '7rem' }}
      aria-label={placeholder}
    />
    {QUICK.map((q) => (
      <button
        key={q}
        type="button"
        className={`chip${value === q ? ' active' : ''}`}
        onClick={() => onChange(q)}
      >
        {q}
      </button>
    ))}
  </span>
)
