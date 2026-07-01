import { type Hex, isAddressEqual } from 'viem'
import {
  type BoardClient,
  type CosignAdapter,
  type SignatureRecord,
  type SafeTx,
  SCHEME,
  postSignature,
  readSignatures,
  groupByDigest,
  aggregate,
  recoverEffectiveSigner,
  buildSignatureBlob,
} from '@msgboard/cosign'
import { loadArchiveShares, shareKey } from './archive'

/** The cosign namespace — the first segment of every category key. */
export const NAMESPACE = 'cosign'

/** The rolling read window. 7 UTC days keeps the working set small and self-pruning. */
export const WINDOW_DAYS = 7

/**
 * The scope (second category-key segment) buckets shares per-Safe-per-chain so unrelated Safes
 * never collide on the board. PRODUCT DECISION (for review): `safe:<chainId>:<lowercased safe>`.
 */
export const scopeFor = (chainId: number, safe: Hex): string => `safe:${chainId}:${safe.toLowerCase()}`

/** Posts one signature share under today's rotating category for `scope`. */
export async function postShare(board: BoardClient, scope: string, record: SignatureRecord): Promise<void> {
  await postSignature(board, { namespace: NAMESPACE, scope, record })
}

/** Where a unioned share came from — surfaced in the owner checklist ("from archive"). */
export type ShareSource = 'board' | 'archive'

/**
 * Reads the rolling window of shares for `scope`, UNIONING the live board with the cosign archivist
 * (so shares that have aged out of the board still count toward the quorum). Board records win on a
 * signature collision; the archive only contributes shares the board no longer serves. The archive
 * leg degrades to nothing on any failure (`loadArchiveShares` never throws), so this stays board-only
 * when the archive is down. Junk-skipping + per-source dedupe is handled by the SDK / archive client.
 */
export async function loadShares(
  board: BoardClient,
  scope: string,
  opts?: { archiveBase?: string; archive?: boolean },
): Promise<{ record: SignatureRecord; source: ShareSource }[]> {
  const boardRecords = await readSignatures(board, { namespace: NAMESPACE, scope, days: WINDOW_DAYS })
  const seen = new Set<string>()
  const out: { record: SignatureRecord; source: ShareSource }[] = []
  for (const record of boardRecords) {
    const k = shareKey(record)
    if (seen.has(k)) continue
    seen.add(k)
    out.push({ record, source: 'board' })
  }
  if (opts?.archive === false) return out
  const archived = await loadArchiveShares({ base: opts?.archiveBase, namespace: NAMESPACE, scope, days: WINDOW_DAYS })
  for (const record of archived) {
    const k = shareKey(record)
    if (seen.has(k)) continue
    seen.add(k)
    out.push({ record, source: 'archive' })
  }
  return out
}

/** Records grouped by the digest they sign, so the UI can list one co-sign session per digest. */
export function sessionsByDigest(records: SignatureRecord[]): Map<Hex, SignatureRecord[]> {
  return groupByDigest(records)
}

/** A record annotated with its recovered effective signer, for display + owner-matching. */
export interface AnnotatedShare {
  record: SignatureRecord
  /** The recovered signer, or null if the signature is malformed (recovery threw). */
  signer: Hex | null
  /** Where the share was read from — board (live) or archive (aged-out). */
  source: ShareSource
}

/** Annotates each record with its recovered signer (SDK `recoverEffectiveSigner`; digest-agnostic). */
export async function annotate(
  records: { record: SignatureRecord; source: ShareSource }[],
): Promise<AnnotatedShare[]> {
  return Promise.all(
    records.map(async ({ record, source }) => {
      try {
        return { record, source, signer: await recoverEffectiveSigner(record) }
      } catch {
        return { record, source, signer: null }
      }
    }),
  )
}

/** The result of aggregating a digest's shares through the Safe adapter. */
export interface AggregateResult {
  /** SDK `aggregate` output: adapter-verified, adapter-ordered `{ signer, signature }` pairs. */
  pairs: { signer: Hex; signature: Hex }[]
  /** The verified records in submission order (input to `buildExecTransactionArgs`). */
  ordered: SignatureRecord[]
  /** The Safe `signatures` blob built from the same ordered records (ready for execTransaction). */
  blob: Hex
}

/**
 * Runs the SDK's generic `aggregate()` (verify-filter + adapter order) and additionally builds the
 * Safe-specific `signatures` blob. We re-map the SDK's ordered pairs back to their source records
 * (matching on the unique signature bytes) so the blob is built WITHOUT a second verify round-trip.
 */
export async function aggregateForSafe(
  records: SignatureRecord[],
  adapter: CosignAdapter,
): Promise<AggregateResult> {
  const pairs = await aggregate(records, adapter)
  const ordered: SignatureRecord[] = pairs.map((p) => {
    const match = records.find((r) => r.signature === p.signature && isAddressEqual(r.signer, p.signer))
    if (!match) throw new Error('internal: aggregated pair has no source record')
    return match
  })
  return { pairs, ordered, blob: buildSignatureBlob(ordered) }
}

/** Parses the SafeTx builder form (all-string inputs) into a typed `SafeTx`. Throws on bad numbers. */
export function parseSafeTx(form: {
  to: string
  value: string
  data: string
  operation: string
  safeTxGas: string
  baseGas: string
  gasPrice: string
  gasToken: string
  refundReceiver: string
  nonce: string
}): SafeTx {
  return {
    to: form.to as Hex,
    value: BigInt(form.value || '0'),
    data: (form.data || '0x') as Hex,
    operation: Number(form.operation || '0'),
    safeTxGas: BigInt(form.safeTxGas || '0'),
    baseGas: BigInt(form.baseGas || '0'),
    gasPrice: BigInt(form.gasPrice || '0'),
    gasToken: (form.gasToken || '0x0000000000000000000000000000000000000000') as Hex,
    refundReceiver: (form.refundReceiver || '0x0000000000000000000000000000000000000000') as Hex,
    nonce: BigInt(form.nonce || '0'),
  }
}

/** Human label for a SCHEME value. */
export const schemeLabel = (scheme: number): string =>
  scheme === SCHEME.ECDSA ? 'ECDSA (eth_sign)' : scheme === SCHEME.EIP712 ? 'EIP-712' : scheme === SCHEME.EIP1271 ? 'EIP-1271' : `scheme ${scheme}`
