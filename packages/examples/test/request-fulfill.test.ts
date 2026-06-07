import { describe, it, expect } from 'vitest'
import type { Hex } from 'viem'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { canonical, sign, encode, decode, isAuthentic, type Request, type Envelope } from '../src/request-fulfill.js'

const newAccount = () => privateKeyToAccount(generatePrivateKey())
const REQUEST: Request = { action: 'swap', params: '100 PLS -> USDC', issuedAt: 1717000000, nonce: 'demo-1' }

describe('canonical', () => {
  it('produces identical bytes regardless of key order (signer and verifier must agree)', () => {
    // The signature covers canonical(request); if serialization were order-sensitive a
    // verifier reconstructing the request from JSON could compute a different digest and
    // wrongly reject an authentic request.
    const reordered = { nonce: 'demo-1', issuedAt: 1717000000, params: '100 PLS -> USDC', action: 'swap' } as Request
    expect(canonical(reordered)).toBe(canonical(REQUEST))
  })

  it('changes when any field changes', () => {
    expect(canonical({ ...REQUEST, params: 'other' })).not.toBe(canonical(REQUEST))
  })
})

describe('isAuthentic', () => {
  it('accepts an envelope whose signature matches the signer and request', async () => {
    const account = newAccount()
    const envelope = await sign(REQUEST, account)
    expect(await isAuthentic(envelope)).toBe(true)
  })

  it('rejects a tampered request (the core security property)', async () => {
    // An attacker who flips the swap amount after signing must not be able to get it
    // fulfilled — the recovered signer no longer authorizes the modified request.
    const account = newAccount()
    const envelope = await sign(REQUEST, account)
    const tampered: Envelope = { ...envelope, request: { ...envelope.request, params: '100000 PLS -> USDC' } }
    expect(await isAuthentic(tampered)).toBe(false)
  })

  it('rejects an envelope that claims a different signer than actually signed', async () => {
    const signerAccount = newAccount()
    const impostor = newAccount()
    const envelope = await sign(REQUEST, signerAccount)
    const spoofed: Envelope = { ...envelope, signer: impostor.address }
    expect(await isAuthentic(spoofed)).toBe(false)
  })

  it('returns false (does not throw) on a malformed signature from untrusted board data', async () => {
    const account = newAccount()
    const envelope = await sign(REQUEST, account)
    const malformed: Envelope = { ...envelope, signature: `0x${'00'.repeat(65)}` as Hex }
    expect(await isAuthentic(malformed)).toBe(false)
  })
})

describe('encode/decode', () => {
  it('round-trips an envelope through the board data field', async () => {
    const envelope = await sign(REQUEST, newAccount())
    expect(decode(encode(envelope))).toEqual(envelope)
  })

  it('returns null for non-JSON data', () => {
    expect(decode('0xabcdef' as Hex)).toBeNull()
  })

  it('returns null when the envelope shape is incomplete', async () => {
    const data = `0x${Buffer.from(JSON.stringify({ request: REQUEST }), 'utf8').toString('hex')}` as Hex
    expect(decode(data)).toBeNull()
  })
})
