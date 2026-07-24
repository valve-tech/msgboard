import { describe, it, expect } from 'vitest'
import { hexToBytes, toHex, type Hex } from 'viem'
import {
  decryptMessage,
  deriveCategory,
  encodeInvite,
  encryptMessage,
  isUndecryptable,
  mintRoomKey,
  parseInvite,
} from '../src/lib/room-crypto'

/**
 * The security bar: outsiders can't read, tampering never yields garbage, and a ciphertext can't be
 * lifted into another room. These tests pin the exact AEAD/nonce/AAD/envelope behaviour the audit
 * will check — a subtle regression here is the whole failure mode.
 */
describe('room-crypto', () => {
  it('encrypt → decrypt is an exact round-trip (handle + text)', () => {
    const key = mintRoomKey()
    const category = deriveCategory(key)
    for (const [text, handle] of [
      ['hello world', 'alice'],
      ['no handle here', undefined],
      ['unicode: café ☕ 日本語 🔒', 'bob'],
      ['', 'emptytext'],
      ['x'.repeat(2000), 'long'],
    ] as [string, string | undefined][]) {
      const env = encryptMessage(key, category, text, handle)
      const out = decryptMessage(key, category, env)
      expect(isUndecryptable(out)).toBe(false)
      if (!isUndecryptable(out)) {
        expect(out.text).toBe(text)
        expect(out.handle).toBe(handle && handle.trim() ? handle : undefined)
      }
    }
  })

  it('the envelope is version(0x01) || nonce(24) || ciphertext, and the board never sees plaintext', () => {
    const key = mintRoomKey()
    const category = deriveCategory(key)
    const text = 'secret message body'
    const env = encryptMessage(key, category, text, 'carol')
    const bytes = hexToBytes(env)
    expect(bytes[0]).toBe(0x01)
    expect(bytes.length).toBeGreaterThan(1 + 24 + 16)
    // The plaintext must not appear anywhere on the wire.
    const wire = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
    expect(wire.includes(text)).toBe(false)
    expect(wire.includes('carol')).toBe(false)
    // Fresh nonce per message → same input encrypts to different envelopes.
    expect(encryptMessage(key, category, text, 'carol')).not.toBe(env)
  })

  it('wrong key → undecryptable (not a throw, not garbage)', () => {
    const key = mintRoomKey()
    const category = deriveCategory(key)
    const env = encryptMessage(key, category, 'top secret', 'dave')
    const wrong = mintRoomKey()
    // Decrypt with the wrong key under its own (matching) category so the AAD isn't what fails.
    expect(isUndecryptable(decryptMessage(wrong, category, env))).toBe(true)
    expect(isUndecryptable(decryptMessage(wrong, deriveCategory(wrong), env))).toBe(true)
  })

  it('tampered ciphertext (one flipped byte) → undecryptable', () => {
    const key = mintRoomKey()
    const category = deriveCategory(key)
    const env = encryptMessage(key, category, 'integrity matters', 'eve')
    const bytes = hexToBytes(env)
    // Flip a byte inside the ciphertext region (past version + nonce).
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff
    expect(isUndecryptable(decryptMessage(key, category, toHex(bytes)))).toBe(true)
    // Flipping the nonce also breaks it.
    const b2 = hexToBytes(env)
    b2[5] = b2[5]! ^ 0x01
    expect(isUndecryptable(decryptMessage(key, category, toHex(b2)))).toBe(true)
  })

  it('wrong version byte → undecryptable', () => {
    const key = mintRoomKey()
    const category = deriveCategory(key)
    const bytes = hexToBytes(encryptMessage(key, category, 'v-check', 'frank'))
    bytes[0] = 0x02
    expect(isUndecryptable(decryptMessage(key, category, toHex(bytes)))).toBe(true)
  })

  it('wrong-category AAD → undecryptable (a ciphertext cannot be lifted into another room)', () => {
    const key = mintRoomKey()
    const catA = deriveCategory(key)
    const env = encryptMessage(key, catA, 'room-bound', 'grace')
    const otherKey = mintRoomKey()
    const catB = deriveCategory(otherKey)
    // Same key, but verifying against a different category → AAD mismatch → fails closed.
    expect(isUndecryptable(decryptMessage(key, catB, env))).toBe(true)
    // Sanity: the correct category still works.
    expect(isUndecryptable(decryptMessage(key, catA, env))).toBe(false)
  })

  it('short / non-hex envelopes → undecryptable, never throw', () => {
    const key = mintRoomKey()
    const category = deriveCategory(key)
    expect(isUndecryptable(decryptMessage(key, category, '0x' as Hex))).toBe(true)
    expect(isUndecryptable(decryptMessage(key, category, '0x01' as Hex))).toBe(true)
    expect(isUndecryptable(decryptMessage(key, category, ('0x' + 'ab'.repeat(20)) as Hex))).toBe(true)
  })

  it('category derivation is deterministic; different keys → different categories', () => {
    const key = mintRoomKey()
    expect(deriveCategory(key)).toBe(deriveCategory(key))
    const seen = new Set<string>()
    for (let i = 0; i < 200; i++) seen.add(deriveCategory(mintRoomKey()))
    expect(seen.size).toBe(200)
    // A category is a 32-byte hex.
    expect(deriveCategory(key)).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it('invite encode → parse round-trip (with and without a name)', () => {
    const key = mintRoomKey()
    const withName = encodeInvite(key, 'Team Room ☕')
    const p1 = parseInvite(withName)
    expect(p1).not.toBeNull()
    expect(toHex(p1!.key)).toBe(toHex(key))
    expect(p1!.name).toBe('Team Room ☕')

    const noName = encodeInvite(key)
    const p2 = parseInvite(noName)
    expect(p2).not.toBeNull()
    expect(toHex(p2!.key)).toBe(toHex(key))
    expect(p2!.name).toBeUndefined()

    // A parsed key must re-derive the same category (join reaches the same room).
    expect(deriveCategory(p1!.key)).toBe(deriveCategory(key))
  })

  it('malformed invites → null (never throw)', () => {
    for (const bad of [
      '',
      'nonsense',
      'msgboard-room',
      'msgboard-room:v1',
      'wrong-prefix:v1:AAAA',
      'msgboard-room:v2:' + encodeInvite(mintRoomKey()).split(':')[2],
      'msgboard-room:v1:not*base64url!',
      'msgboard-room:v1:AAAA', // decodes to 3 bytes, not 32
      'msgboard-room:v1:' + 'A'.repeat(43) + ':x:extra', // too many parts
    ]) {
      expect(parseInvite(bad)).toBeNull()
    }
    // A 32-byte key with a valid prefix must still parse (guards against over-rejection).
    expect(parseInvite(encodeInvite(mintRoomKey()))).not.toBeNull()
  })
})
