import { describe, it, expect } from 'vitest'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { keccak256, encodeAbiParameters, parseAbiParameters, stringToHex } from 'viem'
import { Transcript, makeEnvelope, verifyEnvelope, entryDigest } from '../src/transcript'
import { LocalTransport } from '../src/transport'

const GENESIS: `0x${string}` = `0x${'00'.repeat(32)}`

const A = privateKeyToAccount(generatePrivateKey())
const B = privateKeyToAccount(generatePrivateKey())
const tableId = ('0x' + 'cd'.repeat(32)) as `0x${string}`

describe('transcript', () => {
  it('appends signed envelopes, hash-chained, and verifies end to end', async () => {
    const t = new Transcript(tableId)
    const e1 = await makeEnvelope(A, tableId, 0, t.head, 'KEYGEN', { pub: '0x01' })
    t.append(e1)
    const e2 = await makeEnvelope(B, tableId, 1, t.head, 'KEYGEN', { pub: '0x02' })
    t.append(e2)
    expect(t.entries).toHaveLength(2)
    expect(await t.verify({ A: A.address, B: B.address })).toBe(true)
  })
  it('rejects out-of-order seq and broken chain', async () => {
    const t = new Transcript(tableId)
    const e1 = await makeEnvelope(A, tableId, 0, t.head, 'X', {})
    t.append(e1)
    const wrongSeq = await makeEnvelope(B, tableId, 5, t.head, 'X', {})
    expect(() => t.append(wrongSeq)).toThrow(/seq/)
    const wrongPrev = await makeEnvelope(B, tableId, 1, ('0x' + 'ee'.repeat(32)) as `0x${string}`, 'X', {})
    expect(() => t.append(wrongPrev)).toThrow(/chain/)
  })
  it('verify fails if a body is tampered after the fact', async () => {
    const t = new Transcript(tableId)
    t.append(await makeEnvelope(A, tableId, 0, t.head, 'X', { v: 1 }))
    ;(t.entries[0]!.body as any).v = 2
    expect(await verifyEnvelope(t.entries[0]!)).toBe(false)
    expect(await t.verify({ A: A.address, B: B.address })).toBe(false)
  })
  it('round-trips through JSON and rejects a forged head', async () => {
    const t = new Transcript(tableId)
    t.append(await makeEnvelope(A, tableId, 0, t.head, 'X', { v: 1 }))
    const t2 = Transcript.fromJSON(t.toJSON())
    expect(await t2.verify({ A: A.address, B: B.address })).toBe(true)

    // Forged head must throw
    const raw = JSON.parse(t.toJSON())
    raw.head = '0x' + 'aa'.repeat(32)
    expect(() => Transcript.fromJSON(JSON.stringify(raw))).toThrow(/head/)
  })
})

describe('entryDigest abi structure', () => {
  it('entryDigest is abi-structured (recomputable from parts)', () => {
    const body = { hello: 1 }
    const entry = { tableId, seq: 0, prev: GENESIS, kind: 'KEYGEN', body }
    const expected = keccak256(
      encodeAbiParameters(
        parseAbiParameters('bytes32, uint64, bytes32, bytes32, bytes32'),
        [tableId, 0n, GENESIS, keccak256(stringToHex('KEYGEN')), keccak256(stringToHex(JSON.stringify(body)))],
      ),
    )
    expect(entryDigest(entry)).toBe(expected)
  })
})

describe('local transport', () => {
  it('delivers both directions; drop injection loses messages', async () => {
    const [ta, tb] = LocalTransport.pair()
    const got: string[] = []
    const back: string[] = []
    tb.onMessage((m) => got.push(m as string))
    ta.onMessage((m) => back.push(m as string))
    await ta.send('one')
    ta.dropNext()
    await ta.send('two')
    await ta.send('three')
    await tb.send('back')
    await new Promise((r) => setTimeout(r, 10))
    expect(got).toEqual(['one', 'three'])
    expect(back).toEqual(['back'])
  })
  it('delayMs defers delivery past the next microtask but arrives after the delay', async () => {
    const [ta, tb] = LocalTransport.pair()
    const got: string[] = []
    tb.onMessage((m) => got.push(m as string))
    ta.delayMs = 5
    await ta.send('delayed')
    // Not yet delivered after one microtask tick
    await Promise.resolve()
    expect(got).toHaveLength(0)
    // Delivered after the timer fires
    await new Promise((r) => setTimeout(r, 15))
    expect(got).toEqual(['delayed'])
  })
})
