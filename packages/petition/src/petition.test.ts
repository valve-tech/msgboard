import { describe, it, expect } from 'vitest'
import { type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { Content, RPCMessage } from '@msgboard/sdk'
import type { BoardClient } from '@msgboard/cosign'
import { derivePetitionId, type Petition } from './descriptor.js'
import {
  createPetition,
  signPetition,
  readPetitions,
  readPetitionSignatures,
  tally,
  verifySignature,
} from './petition.js'

/** In-memory fake BoardClient, mirroring packages/cosign/test/client.test.ts's fake. */
function fakeBoard(): BoardClient & { store: Map<Hex, { data: Hex }[]> } {
  const store = new Map<Hex, { data: Hex }[]>()
  return {
    store,
    addMessage: async ({ category, data }) => {
      const bucket = store.get(category) ?? []
      bucket.push({ data })
      store.set(category, bucket)
      return '0xhash'
    },
    content: async ({ category }) => {
      const bucket = store.get(category) ?? []
      return { [category]: bucket.map((m) => m as RPCMessage) } as Content
    },
  }
}

const creatorPk = ('0x' + '11'.repeat(32)) as Hex
const creatorAccount = privateKeyToAccount(creatorPk)
const salt = ('0x' + '22'.repeat(32)) as Hex
const verifyingContract = '0x3333333333333333333333333333333333333333' as Hex
const now = new Date('2026-07-28T10:00:00.000Z')

function makePetition(statement = 'Save the park'): Petition {
  return {
    id: derivePetitionId(statement, creatorAccount.address, salt),
    statement,
    creator: creatorAccount.address,
    createdAt: Math.floor(now.getTime() / 1000),
    chainId: 369,
    salt,
  }
}

describe('signPetition / verifySignature', () => {
  it('posts a decodable SignatureRecord whose verifySignature is true', async () => {
    const board = fakeBoard()
    const p = makePetition()
    const sign = (d: Hex) => creatorAccount.sign({ hash: d })
    const record = await signPetition(board, p, verifyingContract, sign, now)

    expect(record.signer.toLowerCase()).toBe(creatorAccount.address.toLowerCase())
    expect(await verifySignature(p, record, verifyingContract)).toBe(true)

    const signatures = await readPetitionSignatures(board, p.id, 1, now)
    expect(signatures).toHaveLength(1)
    expect(signatures[0]).toEqual(record)
  })

  it('tampering the statement makes verifySignature false', async () => {
    const board = fakeBoard()
    const p = makePetition()
    const sign = (d: Hex) => creatorAccount.sign({ hash: d })
    const record = await signPetition(board, p, verifyingContract, sign, now)

    const tampered: Petition = { ...p, statement: 'Bulldoze the park' }
    expect(await verifySignature(tampered, record, verifyingContract)).toBe(false)
  })

  it('rejects a forged record claiming a signer it did not sign for (tampered signer)', async () => {
    const board = fakeBoard()
    const p = makePetition()
    const sign = (d: Hex) => creatorAccount.sign({ hash: d })
    const record = await signPetition(board, p, verifyingContract, sign, now)

    const otherAccount = privateKeyToAccount(('0x' + '55'.repeat(32)) as Hex)
    const forged = { ...record, signer: otherAccount.address }
    expect(await verifySignature(p, forged, verifyingContract)).toBe(false)
  })

  it('rejects a record whose signature was swapped for someone else\'s (tampered signature)', async () => {
    const board = fakeBoard()
    const p = makePetition()
    const sign = (d: Hex) => creatorAccount.sign({ hash: d })
    const record = await signPetition(board, p, verifyingContract, sign, now)

    const otherAccount = privateKeyToAccount(('0x' + '55'.repeat(32)) as Hex)
    const otherSignature = await otherAccount.sign({ hash: record.digest })
    const tampered = { ...record, signature: otherSignature }
    expect(await verifySignature(p, tampered, verifyingContract)).toBe(false)
  })
})

describe('tally', () => {
  it('dedups a signer who signed twice -> count 1', async () => {
    const board = fakeBoard()
    const p = makePetition()
    const sign = (d: Hex) => creatorAccount.sign({ hash: d })
    await signPetition(board, p, verifyingContract, sign, now)
    await signPetition(board, p, verifyingContract, sign, now)

    const signatures = await readPetitionSignatures(board, p.id, 1, now)
    const result = tally(signatures)
    expect(result.count).toBe(1)
    expect(result.signers).toEqual([creatorAccount.address.toLowerCase()])
  })

  it('counts distinct signers', async () => {
    const board = fakeBoard()
    const p = makePetition()
    const otherPk = ('0x' + '44'.repeat(32)) as Hex
    const otherAccount = privateKeyToAccount(otherPk)
    await signPetition(board, p, verifyingContract, (d) => creatorAccount.sign({ hash: d }), now)
    await signPetition(board, p, verifyingContract, (d) => otherAccount.sign({ hash: d }), now)

    const signatures = await readPetitionSignatures(board, p.id, 1, now)
    const result = tally(signatures)
    expect(result.count).toBe(2)
  })
})

describe('createPetition / readPetitions', () => {
  it('returns descriptors posted via createPetition', async () => {
    const board = fakeBoard()
    const p1 = makePetition('Save the park')
    const p2 = makePetition('Fix the road')
    await createPetition(board, p1, now)
    await createPetition(board, p2, now)

    const petitions = await readPetitions(board, 1, now)
    expect(petitions).toHaveLength(2)
    expect(petitions.map((p) => p.id).sort()).toEqual([p1.id, p2.id].sort())
  })

  it('skips undecodable junk under the index category', async () => {
    const board = fakeBoard()
    const p1 = makePetition('Save the park')
    await createPetition(board, p1, now)
    // inject junk directly into the store under the same day's index category
    const anyBoard = board as unknown as { store: Map<Hex, { data: Hex }[]> }
    const [key] = [...anyBoard.store.keys()]
    anyBoard.store.get(key)!.push({ data: '0xdeadbeef' as Hex })

    const petitions = await readPetitions(board, 1, now)
    expect(petitions).toHaveLength(1)
    expect(petitions[0].id).toBe(p1.id)
  })
})
