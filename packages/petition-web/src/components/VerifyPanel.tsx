import { useEffect, useState } from 'react'
import type { Hex } from 'viem'
import type { SignatureRecord } from '@msgboard/cosign'
import { type Petition, verifySignature } from '@msgboard/petition'
import { cx } from './ui'

export interface VerifyOutcome {
  /** Deduped, lowercased signer addresses whose signature verified — THE trustless count. */
  verifiedSigners: Hex[]
  /** Captured records annotated with whether they verified (drives `settle`'s signer↔signature map). */
  records: (SignatureRecord & { valid: boolean })[]
  /** Captured records that failed verification (forged signer, tampered statement, bad signature, …). */
  invalidCount: number
}

/**
 * `VerifyPanel` — recomputes EVERY captured signature client-side (recovering against the EIP-712
 * digest for `petition`'s statement + `verifyingContract`) and renders the ONLY trustless count in
 * the app. The read-side "captured" tally is posted-but-unverified (anyone can post a
 * `SignatureRecord` naming any `signer`); this panel is what actually proves a signature is real —
 * a tampered statement or a forged signer/signature makes `verifySignature` return `false`, and
 * that record is excluded from `verifiedSigners` and counted in `invalidCount` (shown as a mismatch
 * notice, never silently dropped).
 */
export function VerifyPanel(props: {
  petition: Petition
  verifyingContract: Hex
  records: SignatureRecord[]
  onResult?: (outcome: VerifyOutcome) => void
}) {
  const { petition, verifyingContract, records, onResult } = props
  const [state, setState] = useState<'idle' | 'verifying' | 'done'>('idle')
  const [outcome, setOutcome] = useState<VerifyOutcome | null>(null)

  useEffect(() => {
    let cancelled = false
    setState('verifying')
    setOutcome(null)
    ;(async () => {
      const seen = new Set<string>()
      const verifiedSigners: Hex[] = []
      const annotated: (SignatureRecord & { valid: boolean })[] = []
      let invalidCount = 0
      for (const r of records) {
        const valid = await verifySignature(petition, r, verifyingContract)
        annotated.push({ ...r, valid })
        if (!valid) {
          invalidCount++
          continue
        }
        const lower = r.signer.toLowerCase()
        if (seen.has(lower)) continue
        seen.add(lower)
        verifiedSigners.push(r.signer.toLowerCase() as Hex)
      }
      if (cancelled) return
      const result: VerifyOutcome = { verifiedSigners, records: annotated, invalidCount }
      setOutcome(result)
      setState('done')
      onResult?.(result)
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [petition.id, petition.statement, petition.chainId, verifyingContract, records])

  return (
    <div className={cx('notice', outcome && outcome.invalidCount > 0 ? 'err' : 'info')} role="status">
      <div className="eyebrow">verified · trustless</div>
      {state !== 'done' || !outcome ? (
        <div className="hint" style={{ margin: '4px 0 0' }}>
          verifying {records.length} captured signature{records.length === 1 ? '' : 's'}…
        </div>
      ) : (
        <>
          <div className="disp" style={{ fontSize: 20, margin: '4px 0' }}>
            {outcome.verifiedSigners.length} verified
          </div>
          {outcome.invalidCount > 0 && (
            <div className="hint" style={{ margin: 0, color: 'var(--oxblood)' }}>
              {outcome.invalidCount} captured signature{outcome.invalidCount === 1 ? '' : 's'} failed
              verification (statement/signer/signature mismatch) — excluded from the count above.
            </div>
          )}
        </>
      )}
    </div>
  )
}
