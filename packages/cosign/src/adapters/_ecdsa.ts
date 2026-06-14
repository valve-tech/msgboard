import { type Hex, size, slice, getAddress } from 'viem'
import type { SignatureRecord } from '../record.js'

/** Splits a 65-byte ECDSA signature into r (32) ‖ s (32) ‖ v (1). Throws if not 65 bytes. */
export function splitSig(sig: Hex): { r: Hex; s: Hex; v: number } {
  if (size(sig) !== 65) throw new Error(`expected 65-byte signature, got ${size(sig)} bytes`)
  return { r: slice(sig, 0, 32), s: slice(sig, 32, 64), v: Number(BigInt(slice(sig, 64, 65))) }
}

/**
 * The verbatim 65-byte {r}{s}{v} word for an EOA signature — no v adjustment, no tail.
 * (The Safe adapter applies its own v+4 / 1271-tail policy on top of splitSig; OwnableValidator
 * uses verbatim words, so this primitive returns the signature unchanged after a length check.)
 */
export function eoaWord(sig: Hex): Hex {
  if (size(sig) !== 65) throw new Error(`expected 65-byte signature, got ${size(sig)} bytes`)
  return sig
}

/**
 * Sorts records strictly ascending by record.signer and dedups (keeps first). Pure + synchronous.
 * Callers must have already established record.signer == the effective recovered signer (aggregate
 * runs verify before order). Shared by the Safe and Rhinestone adapters.
 */
export function sortDedupBySigner(records: SignatureRecord[]): SignatureRecord[] {
  const seen = new Set<string>()
  const deduped: SignatureRecord[] = []
  for (const r of records) {
    const key = getAddress(r.signer).toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(r)
  }
  return deduped.sort((a, b) => {
    const av = BigInt(getAddress(a.signer))
    const bv = BigInt(getAddress(b.signer))
    return av < bv ? -1 : av > bv ? 1 : 0
  })
}
