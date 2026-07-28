import type { Hex } from 'viem'

/**
 * `outstanding = captured − settled` — a pure, address-normalized set difference. `captured` is
 * assumed to already be the VERIFIED signer set (recomputed client-side via
 * `@msgboard/petition`'s `verifySignature`, not the raw posted-but-unverified read-side count —
 * see `VerifyPanel`), so this is what actually drives the "settle outstanding on-chain" button.
 * Case-insensitive (addresses may arrive in mixed checksum casing from different sources); dedupes
 * `captured` and preserves its original relative order.
 */
export function outstanding(captured: Hex[], settled: Hex[]): Hex[] {
  const settledLower = new Set(settled.map((s) => s.toLowerCase()))
  const seen = new Set<string>()
  const out: Hex[] = []
  for (const c of captured) {
    const lower = c.toLowerCase()
    if (settledLower.has(lower) || seen.has(lower)) continue
    seen.add(lower)
    out.push(c)
  }
  return out
}
