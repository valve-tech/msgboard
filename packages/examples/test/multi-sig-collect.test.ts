import { describe, it, expect } from 'vitest'
import type { Hex } from 'viem'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { makeCollector, payloadId, decode, sign, THRESHOLD } from '../src/multi-sig-collect.js'

const newOwner = () => privateKeyToAccount(generatePrivateKey())
const PAYLOAD = 'transfer 1000 PLS to 0xBEEF…'

describe('makeCollector', () => {
  it('rejects a signature from an address outside the owner set — even a valid one', async () => {
    // Authenticity is necessary but not sufficient: a stranger must never count toward the
    // threshold, or the multi-sig is meaningless.
    const [a, b] = [newOwner(), newOwner()]
    const stranger = newOwner()
    const collector = makeCollector([a.address, b.address], THRESHOLD)
    const result = await collector.offer(await sign(PAYLOAD, stranger))
    expect(result).toEqual({ accepted: false, reason: 'not an owner' })
  })

  it('rejects a well-formed signature that recovers to a different address', async () => {
    // An owner signs a DIFFERENT message; offered against PAYLOAD it recovers to the wrong
    // signer, so it must not count.
    const owner = newOwner()
    const collector = makeCollector([owner.address], THRESHOLD)
    const wrongSignature = await owner.signMessage({ message: 'a different payload' })
    const result = await collector.offer({ payload: PAYLOAD, signer: owner.address, signature: wrongSignature })
    expect(result).toEqual({ accepted: false, reason: 'bad signature' })
  })

  it('rejects a malformed signature without throwing (untrusted board data)', async () => {
    // Adversarial board data: a bogus signature makes the verifier throw. The collector must
    // absorb it as a bad signature rather than crash the watcher's polling loop.
    const owner = newOwner()
    const collector = makeCollector([owner.address], THRESHOLD)
    const forged = { payload: PAYLOAD, signer: owner.address, signature: `0x${'00'.repeat(65)}` as Hex }
    const result = await collector.offer(forged)
    expect(result).toEqual({ accepted: false, reason: 'bad signature' })
  })

  it('counts the first signature but withholds assembly below the threshold', async () => {
    const [a, b] = [newOwner(), newOwner()]
    const collector = makeCollector([a.address, b.address], THRESHOLD)
    const result = await collector.offer(await sign(PAYLOAD, a))
    expect(result.accepted).toBe(true)
    expect(result.complete).toBeUndefined()
  })

  it('ignores a repeat signature from the same owner (no double-counting toward threshold)', async () => {
    const [a, b] = [newOwner(), newOwner()]
    const collector = makeCollector([a.address, b.address], THRESHOLD)
    await collector.offer(await sign(PAYLOAD, a))
    const dup = await collector.offer(await sign(PAYLOAD, a))
    expect(dup).toEqual({ accepted: false, reason: 'duplicate signer' })
  })

  it('assembles the set, sorted by signer ascending, once the threshold is met', async () => {
    // On-chain verifiers expect signatures ordered by signer; the collector must emit
    // them that way regardless of arrival order.
    const [a, b] = [newOwner(), newOwner()]
    const collector = makeCollector([a.address, b.address], THRESHOLD)
    await collector.offer(await sign(PAYLOAD, a))
    const result = await collector.offer(await sign(PAYLOAD, b))

    expect(result.complete).toBeDefined()
    expect(result.complete).toHaveLength(THRESHOLD)
    const signers = result.complete!.map((part) => part.signer.toLowerCase())
    expect(signers).toEqual([...signers].sort())
  })

  it('does not re-announce a completed payload on further signatures', async () => {
    const [a, b, c] = [newOwner(), newOwner(), newOwner()]
    const collector = makeCollector([a.address, b.address, c.address], THRESHOLD)
    await collector.offer(await sign(PAYLOAD, a))
    await collector.offer(await sign(PAYLOAD, b)) // threshold met here
    const third = await collector.offer(await sign(PAYLOAD, c))
    expect(third.accepted).toBe(true)
    expect(third.complete).toBeUndefined()
  })
})

describe('payloadId', () => {
  it('is stable for the same payload and distinct for different payloads', () => {
    expect(payloadId(PAYLOAD)).toBe(payloadId(PAYLOAD))
    expect(payloadId(PAYLOAD)).not.toBe(payloadId('something else'))
  })
})

describe('decode', () => {
  const toHexJson = (value: unknown): Hex =>
    `0x${Buffer.from(JSON.stringify(value), 'utf8').toString('hex')}` as Hex

  it('decodes a well-formed partial', async () => {
    const owner = newOwner()
    const partial = await sign(PAYLOAD, owner)
    expect(decode(toHexJson(partial))).toEqual(partial)
  })

  it('returns null for non-JSON data', () => {
    expect(decode('0xnothex' as Hex)).toBeNull()
  })

  it('returns null when required fields are missing', () => {
    expect(decode(toHexJson({ payload: PAYLOAD }))).toBeNull()
  })
})
