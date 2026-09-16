import { describe, it, expect } from 'vitest'
import { type Hex, keccak256, toBytes } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { SCHEME, categoryKey, encodeRecord, isoDay, type SignatureRecord } from '@msgboard/cosign'
import type { Content } from '@msgboard/sdk'
import {
  COSIGN_NAMESPACE,
  cosignCategories,
  fleetSafeFor,
  foldQuorum,
  groupByDigest,
  mergeShares,
  readArchiveShares,
  readBoardShares,
  safeScope,
  verifyShares,
  type CosignShare,
} from '../src/lib/cosign-feed'

/**
 * The Cosign tab's read path.
 *
 * Every record here is wire-encoded with the real `@msgboard/cosign` codec and signed with a real
 * key, so the tests exercise the actual decode, recover and quorum logic — never a re-implementation.
 * The archive is a fake `fetch`, and the live board is a hand-built `content` snapshot, so no test
 * touches the network.
 */

const CHAIN_ID = 943
const SAFE = '0x67D4FBA30DFeFb1AA2d199c33e239dc6BCAfF705' as Hex
const NOW = new Date('2026-09-07T12:00:00.000Z')

const KEY_A = ('0x' + '11'.repeat(32)) as Hex
const KEY_B = ('0x' + '22'.repeat(32)) as Hex
const KEY_C = ('0x' + '33'.repeat(32)) as Hex
const ownerA = privateKeyToAccount(KEY_A)
const ownerB = privateKeyToAccount(KEY_B)
const outsider = privateKeyToAccount(KEY_C)

const DIGEST = keccak256(toBytes('a benign self-call')) as Hex

/** A real EIP-712-scheme record: the account signs the digest itself. */
async function signedRecord(account: typeof ownerA, digest: Hex = DIGEST): Promise<SignatureRecord> {
  const signature = await account.sign({ hash: digest })
  return { digest, signer: account.address, signature, scheme: SCHEME.EIP712, meta: '0x' }
}

/** A fake `fetch` that answers one GraphQL body and records the request it was given. */
function fakeArchive(body: unknown, init?: { ok?: boolean; status?: number }) {
  const calls: { url: string; body: unknown }[] = []
  const impl = (async (url: unknown, options?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(options?.body ?? '{}')) })
    return {
      ok: init?.ok ?? true,
      status: init?.status ?? 200,
      json: async () => body,
    } as unknown as Response
  }) as unknown as typeof fetch
  return { impl, calls }
}

describe('cosign-feed — category keys and the fleet Safe', () => {
  it('derives the same day-bucket categories the bot fleet posts under', () => {
    const categories = cosignCategories({ chainId: CHAIN_ID, safe: SAFE, days: 3, now: NOW })
    const scope = safeScope({ chainId: CHAIN_ID, safe: SAFE })
    expect(scope).toBe('safe:943:0x67d4fba30dfefb1aa2d199c33e239dc6bcaff705')
    expect(categories).toHaveLength(3)
    expect(categories[0]).toBe(categoryKey(COSIGN_NAMESPACE, scope, isoDay(NOW)))
    // The fleet's own key for 2026-09-07, computed independently from the documented scheme.
    expect(categories[0]).toBe(keccak256(toBytes(`cosign:${scope}:2026-09-07`)))
    expect(categories[2]).toBe(categoryKey(COSIGN_NAMESPACE, scope, '2026-09-05'))
  })

  it('rejects a window shorter than a day', () => {
    expect(() => cosignCategories({ chainId: CHAIN_ID, safe: SAFE, days: 0, now: NOW })).toThrow(/days >= 1/)
  })

  it('knows the fleet Safe on 943 and admits it has none elsewhere', () => {
    expect(fleetSafeFor({ chainId: 943 })).toMatchObject({ address: SAFE, threshold: 2, ownerCount: 3 })
    expect(fleetSafeFor({ chainId: 369 })).toBeNull()
    expect(fleetSafeFor({ chainId: 1 })).toBeNull()
  })
})

describe('cosign-feed — reading the archive', () => {
  it('queries the archive for the window and decodes every share', async () => {
    const record = await signedRecord(ownerA)
    const categories = cosignCategories({ chainId: CHAIN_ID, safe: SAFE, days: 2, now: NOW })
    const { impl, calls } = fakeArchive({
      data: {
        message_archive: [
          {
            category: categories[0],
            data: encodeRecord(record),
            block_number: 25_331_298,
            first_seen_at: '2026-09-07T11:59:00+00:00',
          },
        ],
      },
    })

    const shares = await readArchiveShares({ chainId: CHAIN_ID, categories, fetchImpl: impl })

    expect(calls).toHaveLength(1)
    const sent = calls[0]!.body as { variables: { chainId: number; categories: Hex[]; limit: number } }
    expect(sent.variables.chainId).toBe(CHAIN_ID)
    expect(sent.variables.categories).toEqual(categories)
    expect(shares).toHaveLength(1)
    expect(shares[0]!.record.signer).toBe(ownerA.address)
    expect(shares[0]!.blockNumber).toBe(25_331_298)
    expect(shares[0]!.source).toBe('archive')
  })

  it('skips undecodable rows instead of failing the whole feed', async () => {
    const record = await signedRecord(ownerA)
    const categories = cosignCategories({ chainId: CHAIN_ID, safe: SAFE, days: 1, now: NOW })
    const { impl } = fakeArchive({
      data: {
        message_archive: [
          { category: categories[0], data: '0xdeadbeef', block_number: 1, first_seen_at: null },
          { category: categories[0], data: null, block_number: 2, first_seen_at: null },
          { category: categories[0], data: encodeRecord(record), block_number: 3, first_seen_at: null },
        ],
      },
    })

    const shares = await readArchiveShares({ chainId: CHAIN_ID, categories, fetchImpl: impl })
    expect(shares).toHaveLength(1)
    expect(shares[0]!.record.digest).toBe(DIGEST)
  })

  it('throws on a GraphQL error so the tab can say the archive is unreachable', async () => {
    const categories = cosignCategories({ chainId: CHAIN_ID, safe: SAFE, days: 1, now: NOW })
    const { impl } = fakeArchive({ errors: [{ message: 'field not found' }] })
    await expect(readArchiveShares({ chainId: CHAIN_ID, categories, fetchImpl: impl })).rejects.toThrow(
      /field not found/,
    )
  })

  it('throws on a transport failure', async () => {
    const categories = cosignCategories({ chainId: CHAIN_ID, safe: SAFE, days: 1, now: NOW })
    const { impl } = fakeArchive({}, { ok: false, status: 502 })
    await expect(readArchiveShares({ chainId: CHAIN_ID, categories, fetchImpl: impl })).rejects.toThrow(/502/)
  })

  it('makes no request when there is no window to read', async () => {
    const { impl, calls } = fakeArchive({ data: { message_archive: [] } })
    expect(await readArchiveShares({ chainId: CHAIN_ID, categories: [], fetchImpl: impl })).toEqual([])
    expect(calls).toHaveLength(0)
  })
})

describe('cosign-feed — the live board half', () => {
  it('reads fresh shares out of the polled content snapshot', async () => {
    const record = await signedRecord(ownerB)
    const categories = cosignCategories({ chainId: CHAIN_ID, safe: SAFE, days: 1, now: NOW })
    const content = {
      [categories[0]!]: [{ data: encodeRecord(record) }, { data: '0x00' }],
    } as unknown as Content

    const shares = readBoardShares({ content, categories })
    expect(shares).toHaveLength(1)
    expect(shares[0]!.source).toBe('board')
    expect(shares[0]!.seenAt).toBeNull()
  })

  it('returns nothing when the poll has not filled the cache yet', () => {
    expect(readBoardShares({ content: null, categories: ['0x01' as Hex] })).toEqual([])
  })

  it('keeps the archive copy when both sources carry the same share, and sorts board shares first', async () => {
    const record = await signedRecord(ownerA)
    const categories = cosignCategories({ chainId: CHAIN_ID, safe: SAFE, days: 1, now: NOW })
    const fresh = await signedRecord(ownerB)

    const archive: CosignShare[] = [
      {
        record,
        category: categories[0]!,
        seenAt: '2026-09-07T11:00:00+00:00',
        blockNumber: 100,
        source: 'archive',
      },
    ]
    const board: CosignShare[] = [
      { record, category: categories[0]!, seenAt: null, blockNumber: null, source: 'board' },
      { record: fresh, category: categories[0]!, seenAt: null, blockNumber: null, source: 'board' },
    ]

    const merged = mergeShares({ archive, board })
    expect(merged).toHaveLength(2)
    // The duplicate resolved to the archive copy, which is the one carrying a timestamp.
    expect(merged.find((s) => s.record.signer === ownerA.address)!.source).toBe('archive')
    // The board-only share has no timestamp, so it is the freshest thing we have and sorts first.
    expect(merged[0]!.record.signer).toBe(ownerB.address)
  })
})

describe('cosign-feed — verification and the quorum', () => {
  it('marks a real signature self-consistent and a forged signer inconsistent', async () => {
    const honest = await signedRecord(ownerA)
    const forged: SignatureRecord = { ...honest, signer: outsider.address }
    const malformed: SignatureRecord = { ...honest, signature: '0x1234' }
    const shares: CosignShare[] = [honest, forged, malformed].map((record) => ({
      record,
      category: '0x01' as Hex,
      seenAt: null,
      blockNumber: null,
      source: 'board' as const,
    }))

    const verified = await verifyShares({ shares })
    expect(verified[0]!.selfConsistent).toBe(true)
    expect(verified[0]!.recovered).toBe(ownerA.address)
    expect(verified[1]!.selfConsistent).toBe(false)
    expect(verified[2]!.recovered).toBeNull()
    expect(verified[2]!.selfConsistent).toBe(false)
  })

  it('reaches the threshold on two distinct owners and never counts an outsider', async () => {
    const shares: CosignShare[] = []
    for (const account of [ownerA, ownerB, outsider]) {
      shares.push({
        record: await signedRecord(account),
        category: '0x01' as Hex,
        seenAt: null,
        blockNumber: null,
        source: 'board',
      })
    }
    const verified = await verifyShares({ shares })
    const fold = foldQuorum({
      shares: verified,
      owners: [ownerA.address, ownerB.address, '0x119e9D29608c8d38003dd2Ae1fb0FAeCB07185d2' as Hex],
      threshold: 2,
    })

    expect(fold.signedOwners).toHaveLength(2)
    expect(fold.thresholdMet).toBe(true)
    expect(fold.outsiders).toEqual([outsider.address])
  })

  it('counts one owner once, however many shares it posts', async () => {
    const first = await signedRecord(ownerA)
    const shares: CosignShare[] = [first, first].map((record) => ({
      record,
      category: '0x01' as Hex,
      seenAt: null,
      blockNumber: null,
      source: 'board' as const,
    }))
    const fold = foldQuorum({
      shares: await verifyShares({ shares }),
      owners: [ownerA.address, ownerB.address],
      threshold: 2,
    })
    expect(fold.signedOwners).toEqual([ownerA.address])
    expect(fold.thresholdMet).toBe(false)
  })

  it('recovers each share once when the caller keeps a cache', async () => {
    const record = await signedRecord(ownerA)
    const shares: CosignShare[] = [
      { record, category: '0x01' as Hex, seenAt: null, blockNumber: null, source: 'board' },
    ]
    const cache = new Map<string, Hex | null>()

    const first = await verifyShares({ shares, cache })
    expect(first[0]!.recovered).toBe(ownerA.address)
    expect(cache.size).toBe(1)

    // Poison the cached entry: a second pass must read it back rather than recover again.
    for (const key of cache.keys()) cache.set(key, outsider.address)
    const second = await verifyShares({ shares, cache })
    expect(second[0]!.recovered).toBe(outsider.address)
    expect(second[0]!.selfConsistent).toBe(false)
  })

  it('groups shares by the digest they sign', async () => {
    const other = keccak256(toBytes('another session')) as Hex
    const shares: CosignShare[] = [
      { record: await signedRecord(ownerA), category: '0x01' as Hex, seenAt: null, blockNumber: null, source: 'board' },
      { record: await signedRecord(ownerB, other), category: '0x01' as Hex, seenAt: null, blockNumber: null, source: 'board' },
      { record: await signedRecord(ownerB), category: '0x01' as Hex, seenAt: null, blockNumber: null, source: 'board' },
    ]
    const groups = groupByDigest({ shares: await verifyShares({ shares }) })
    expect(groups.size).toBe(2)
    expect(groups.get(DIGEST)).toHaveLength(2)
    expect(groups.get(other)).toHaveLength(1)
  })
})
