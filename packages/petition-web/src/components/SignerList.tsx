import { useEffect, useState } from 'react'
import type { Hex } from 'viem'
import { short } from './ui'

const BATCH_SIZE = 50
/** Past this many signers, the header switches from an exact count to a rounded tier label
 *  (e.g. "1.2K signed") — the row list itself is ALWAYS batch-revealed regardless of this. */
const TIER_THRESHOLD = 1000

/** `"842 signed"` under the threshold, `"1.2K signed"` / `"12K signed"` past it. */
export function tierLabel(n: number): string {
  if (n < TIER_THRESHOLD) return `${n} signed`
  const k = n / 1000
  const rounded = k >= 10 ? Math.round(k) : Math.round(k * 10) / 10
  return `${rounded}K signed`
}

/**
 * `SignerList` — incrementally reveals `signers` in fixed-size batches (never renders the whole
 * set at mount, however large) with a "load more" control, plus an aggregate tier label in the
 * header once the set crosses `TIER_THRESHOLD`. This is what keeps a petition with thousands of
 * signers mountable/scrollable — a 2,000-row petition still only ever renders `BATCH_SIZE` DOM
 * rows at a time.
 */
export function SignerList(props: {
  signers: Hex[]
  verifiedSet?: Set<string>
  settledSet?: Set<string>
  batchSize?: number
}) {
  const { signers, verifiedSet, settledSet } = props
  const batchSize = props.batchSize ?? BATCH_SIZE
  const [visibleCount, setVisibleCount] = useState(Math.min(batchSize, signers.length))

  // reset the reveal window whenever the underlying signer list changes identity (new petition,
  // refreshed tally, …) rather than accumulating a stale visibleCount across data changes.
  useEffect(() => {
    setVisibleCount(Math.min(batchSize, signers.length))
  }, [signers, batchSize])

  const visible = signers.slice(0, visibleCount)
  const remaining = signers.length - visibleCount

  return (
    <div className="signer-list">
      <div className="hint" style={{ margin: '0 0 8px' }}>
        {tierLabel(signers.length)}
      </div>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {visible.map((s) => {
          const lower = s.toLowerCase()
          const verified = verifiedSet?.has(lower)
          const settled = settledSet?.has(lower)
          return (
            <li key={s} className="owner" data-testid="signer-row">
              <span className="dot" style={{ background: settled ? 'var(--patina)' : verified ? 'var(--brass)' : 'transparent' }} />
              <span className="mono">{short(s)}</span>
              <span className="st">
                {settled ? 'settled on-chain' : verified ? 'verified' : 'captured'}
              </span>
            </li>
          )
        })}
      </ul>
      {remaining > 0 && (
        <button type="button" className="btn" onClick={() => setVisibleCount((v) => Math.min(v + batchSize, signers.length))}>
          load more ({remaining} more)
        </button>
      )}
    </div>
  )
}
