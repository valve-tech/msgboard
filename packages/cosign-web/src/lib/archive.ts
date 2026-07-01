import type { Hex } from 'viem'
import { type SignatureRecord } from '@msgboard/cosign'
import { ARCHIVE_BASE } from './config'

/**
 * Archive fallback: reads shares from the cosign archivist's decoded read API so shares that have
 * aged out of the live board still count toward the quorum. The route mirrors the SDK's read side:
 *   GET {base}/cosign/:namespace/:scope/signatures?days=N  →  { signatures: SignatureRecordView[] }
 * Each view is a decoded `SignatureRecord` plus provenance fields (which we ignore). Never throws —
 * a 404 / down archive yields `[]` so the caller degrades to board-only.
 */
interface SignatureRecordView {
  digest: Hex
  signer: Hex
  signature: Hex
  scheme: number
  meta: Hex
}

export interface ArchiveOptions {
  base?: string
  namespace: string
  scope: string
  days: number
}

export async function loadArchiveShares(opts: ArchiveOptions): Promise<SignatureRecord[]> {
  const base = opts.base ?? ARCHIVE_BASE
  if (!base) return []
  const url = `${base}/cosign/${encodeURIComponent(opts.namespace)}/${encodeURIComponent(opts.scope)}/signatures?days=${opts.days}`
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' } })
    if (!res.ok) return []
    const json = (await res.json()) as { signatures?: SignatureRecordView[] }
    const list = Array.isArray(json.signatures) ? json.signatures : []
    return list
      .filter((v) => v && v.digest && v.signer && v.signature)
      .map((v) => ({
        digest: v.digest,
        signer: v.signer,
        signature: v.signature,
        scheme: Number(v.scheme ?? 0),
        meta: (v.meta ?? '0x') as Hex,
      }))
  } catch {
    return []
  }
}

/** Dedupe key for unioning board ∪ archive shares — signature bytes are unique per share. */
export const shareKey = (r: SignatureRecord): string => `${r.digest.toLowerCase()}:${r.signature.toLowerCase()}`
