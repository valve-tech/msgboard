import type { Hex } from 'viem'
import type { SignatureRecord } from '../record.js'

/**
 * The pluggable multisig seam. An adapter encodes a specific backend's verification
 * and ordering rules, and may make read-only chain calls (owners / threshold).
 * Verification failures (e.g. RPC errors) PROPAGATE — they are not silently treated
 * as "invalid signature"; the caller decides.
 */
export interface CosignAdapter {
  /** True if the record is a valid signature for this backend. Errors propagate. */
  verify(record: SignatureRecord): Promise<boolean>
  /** Returns the records in backend-required submission order. */
  order(records: SignatureRecord[]): SignatureRecord[]
  /** Optional: the current owner set (read-only chain call). */
  owners?(): Promise<Hex[]>
  /** Optional: the current signing threshold (read-only chain call). */
  threshold?(): Promise<number>
}
