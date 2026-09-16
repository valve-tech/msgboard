import { describe, it, expect } from 'vitest'
import { secp256k1 } from '@noble/curves/secp256k1'
import {
  generateStealthMetaAddress,
  deriveStealthMetaAddressFromSeed,
  parseMetaAddress,
  deriveStealthAddress,
  checkAnnouncement,
  computeStealthPrivateKey,
  stealthAddressOf,
  encryptMessage,
  decryptMessage,
} from '../src/lib/stealth'

describe('stealth (ERC-5564 secp256k1, schemeId 1)', () => {
  it('meta-address is 66 bytes and round-trips through parse', () => {
    const r = generateStealthMetaAddress()
    expect(r.metaAddress.length).toBe(66)
    expect(r.spendingPubKey.length).toBe(33)
    expect(r.viewingPubKey.length).toBe(33)
    const parsed = parseMetaAddress(r.metaAddress)
    expect(parsed.spendingPubKey).toEqual(r.spendingPubKey)
    expect(parsed.viewingPubKey).toEqual(r.viewingPubKey)
  })

  // The correctness proof: publish → derive → encrypt → scan → derive-same → decrypt → spend.
  it('full round-trip: recipient detects, agrees on the shared secret, decrypts, and can spend', () => {
    const recipient = generateStealthMetaAddress()

    // SENDER: derive a one-time stealth address + ephemeral key + view tag, and encrypt the body.
    const { stealthAddress, ephemeralPubKey, viewTag, sharedSecret } = deriveStealthAddress(recipient.metaAddress)
    expect(stealthAddress.length).toBe(20)
    expect(ephemeralPubKey.length).toBe(33)
    expect(viewTag).toBe(sharedSecret[0]) // view tag is the first byte of the shared secret
    const ciphertext = encryptMessage(sharedSecret, 'the recipient is nobody but you')

    // RECIPIENT: scan the announcement with the viewing key. View tag matches, address matches.
    const found = checkAnnouncement(
      { stealthAddress, ephemeralPubKey, viewTag },
      { spendingPubKey: recipient.spendingPubKey, viewingPrivKey: recipient.viewingPrivKey },
    )
    expect(found).not.toBeNull()
    // Recipient derived the SAME stealth address the sender announced…
    expect(found!.stealthAddress).toEqual(stealthAddress)
    // …and the SAME shared secret (ECDH symmetry: r·P_view == p_view·R).
    expect(found!.sharedSecret).toEqual(sharedSecret)

    // …so the recipient decrypts the body.
    expect(new TextDecoder().decode(decryptMessage(found!.sharedSecret, ciphertext))).toBe(
      'the recipient is nobody but you',
    )

    // …and can SPEND: the derived stealth private key's pubkey is exactly the stealth address.
    const stealthPriv = computeStealthPrivateKey(recipient.spendingPrivKey, found!.sharedSecret)
    expect(stealthPriv.length).toBe(32)
    const stealthPub = secp256k1.getPublicKey(stealthPriv, true)
    expect(stealthAddressOf(stealthPub)).toEqual(stealthAddress)
  })

  it('a DIFFERENT recipient scanning the same announcement returns null', () => {
    const recipient = generateStealthMetaAddress()
    const stranger = generateStealthMetaAddress()
    const { stealthAddress, ephemeralPubKey, viewTag } = deriveStealthAddress(recipient.metaAddress)

    const result = checkAnnouncement(
      { stealthAddress, ephemeralPubKey, viewTag },
      { spendingPubKey: stranger.spendingPubKey, viewingPrivKey: stranger.viewingPrivKey },
    )
    expect(result).toBeNull()
  })

  it('a wrong view tag makes the scan fast-reject (returns null)', () => {
    const recipient = generateStealthMetaAddress()
    const { stealthAddress, ephemeralPubKey, viewTag } = deriveStealthAddress(recipient.metaAddress)
    const wrongTag = (viewTag + 1) & 0xff

    const result = checkAnnouncement(
      { stealthAddress, ephemeralPubKey, viewTag: wrongTag },
      { spendingPubKey: recipient.spendingPubKey, viewingPrivKey: recipient.viewingPrivKey },
    )
    expect(result).toBeNull()
  })

  it('decryptMessage fails closed on tampered ciphertext', () => {
    const recipient = generateStealthMetaAddress()
    const { sharedSecret } = deriveStealthAddress(recipient.metaAddress)
    const blob = encryptMessage(sharedSecret, 'secret')
    blob[blob.length - 1] ^= 0x01 // flip a bit in the AEAD tag
    expect(() => decryptMessage(sharedSecret, blob)).toThrow()
  })

  it('deriveStealthMetaAddressFromSeed is deterministic and produces a usable meta-address', () => {
    const seed = new Uint8Array(64).fill(7)
    const a = deriveStealthMetaAddressFromSeed(seed)
    const b = deriveStealthMetaAddressFromSeed(seed)
    // Same seed → identical keys (portable/recoverable by re-signing).
    expect(a.metaAddress).toEqual(b.metaAddress)
    expect(a.spendingPrivKey).toEqual(b.spendingPrivKey)
    expect(a.viewingPrivKey).toEqual(b.viewingPrivKey)
    expect(a.metaAddress.length).toBe(66)
    // Spending & viewing keys are distinct (domain-separated HKDF labels).
    expect(a.spendingPrivKey).not.toEqual(a.viewingPrivKey)
    // A different seed yields a different identity.
    const c = deriveStealthMetaAddressFromSeed(new Uint8Array(64).fill(9))
    expect(c.metaAddress).not.toEqual(a.metaAddress)
    // And it works end-to-end as a real recipient meta-address.
    const { stealthAddress, ephemeralPubKey, viewTag } = deriveStealthAddress(a.metaAddress)
    const found = checkAnnouncement(
      { stealthAddress, ephemeralPubKey, viewTag },
      { spendingPubKey: a.spendingPubKey, viewingPrivKey: a.viewingPrivKey },
    )
    expect(found).not.toBeNull()
    expect(found!.stealthAddress).toEqual(stealthAddress)
  })

  it('deriveStealthMetaAddressFromSeed rejects a too-short seed', () => {
    expect(() => deriveStealthMetaAddressFromSeed(new Uint8Array(16))).toThrow()
  })

  it('is randomized: two derivations to the same recipient differ but both resolve', () => {
    const recipient = generateStealthMetaAddress()
    const a = deriveStealthAddress(recipient.metaAddress)
    const b = deriveStealthAddress(recipient.metaAddress)
    expect(a.stealthAddress).not.toEqual(b.stealthAddress)
    expect(a.ephemeralPubKey).not.toEqual(b.ephemeralPubKey)
    for (const d of [a, b]) {
      const found = checkAnnouncement(
        { stealthAddress: d.stealthAddress, ephemeralPubKey: d.ephemeralPubKey, viewTag: d.viewTag },
        { spendingPubKey: recipient.spendingPubKey, viewingPrivKey: recipient.viewingPrivKey },
      )
      expect(found).not.toBeNull()
      expect(found!.stealthAddress).toEqual(d.stealthAddress)
    }
  })
})
