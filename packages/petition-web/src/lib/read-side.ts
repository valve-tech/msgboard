import type { Hex } from 'viem'
import type { Petition } from '@msgboard/petition'
import { PETITION_READ_BASE } from './config.js'

/**
 * The petition read-side client (`@msgboard/history`'s `/petition/*` group, Task C) — this is the
 * CAPTURED (posted-but-unverified) source. Anyone can post a `SignatureRecord` naming any `signer`,
 * so nothing read here should be presented as a trustless count on its own — see `VerifyPanel`,
 * which recomputes signatures client-side to produce the actually-trustworthy number.
 */
export interface SignatureRecordView {
  digest: Hex
  signer: Hex
  signature: Hex
  scheme: number
  meta: Hex
}

const DAYS = 7
const PAGE_LIMIT = 1000

/** `GET /petition/index?days=N` → the directory of posted petition descriptors. */
export async function fetchPetitionIndex(base: string = PETITION_READ_BASE, days = DAYS): Promise<Petition[]> {
  const url = `${base}/petition/index?days=${days}`
  const res = await fetch(url, { headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`petition index fetch failed: HTTP ${res.status}`)
  const json = (await res.json()) as { petitions?: Petition[] }
  return Array.isArray(json.petitions) ? json.petitions : []
}

/** One page of `GET /petition/:id/signatures?days=N&offset=&limit=`. */
export async function fetchPetitionSignaturesPage(
  id: Hex,
  offset: number,
  limit: number,
  base: string = PETITION_READ_BASE,
  days = DAYS,
): Promise<{ signatures: SignatureRecordView[]; total: number }> {
  const url = `${base}/petition/${encodeURIComponent(id)}/signatures?days=${days}&offset=${offset}&limit=${limit}`
  const res = await fetch(url, { headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`petition signatures fetch failed: HTTP ${res.status}`)
  const json = (await res.json()) as { signatures?: SignatureRecordView[]; total?: number }
  return { signatures: Array.isArray(json.signatures) ? json.signatures : [], total: json.total ?? 0 }
}

/**
 * Pages through every captured signature for `id` (the full set, not just one page) — needed so
 * `VerifyPanel`/`verifyAll` can recompute EVERY posted signature, not just the first batch.
 */
export async function fetchAllPetitionSignatures(
  id: Hex,
  base: string = PETITION_READ_BASE,
  days = DAYS,
): Promise<SignatureRecordView[]> {
  const out: SignatureRecordView[] = []
  let offset = 0
  for (;;) {
    const { signatures, total } = await fetchPetitionSignaturesPage(id, offset, PAGE_LIMIT, base, days)
    out.push(...signatures)
    offset += signatures.length
    if (signatures.length === 0 || offset >= total) break
  }
  return out
}

/** `GET /petition/:id/tally?days=N` → the headline CAPTURED count (posted, unverified). */
export async function fetchPetitionTally(
  id: Hex,
  base: string = PETITION_READ_BASE,
  days = DAYS,
): Promise<{ count: number; signers: Hex[] }> {
  const url = `${base}/petition/${encodeURIComponent(id)}/tally?days=${days}`
  const res = await fetch(url, { headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`petition tally fetch failed: HTTP ${res.status}`)
  const json = (await res.json()) as { count?: number; signers?: Hex[] }
  return { count: json.count ?? 0, signers: Array.isArray(json.signers) ? json.signers : [] }
}
