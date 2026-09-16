import { describe, it, expect } from 'vitest'
import { hexToBytes, toHex, type Hex } from 'viem'
import { x25519 } from '@noble/curves/ed25519'
import {
  deriveEncKeypair,
  dmCategory,
  encodeContact,
  isUndecryptable,
  openMessage,
  parseContact,
  sealMessage,
  type EncKeypair,
} from '../src/lib/dm-crypto'
import type { ZkIdentity } from '../src/lib/zk-identity'

/**
 * The security bar for per-recipient DMs: the named recipients (and the sender) can read; NO ONE
 * else can; tampering / wrong-conversation / non-recipient all fail CLOSED to `undecryptable`
 * (never a throw, never garbage); and each message carries a fresh ephemeral key (forward secrecy).
 * These pin the exact envelope/AEAD/AAD behaviour the security audit will check.
 */

/** Fresh X25519 keypair for a test participant. */
const kp = (): EncKeypair => {
  const privateKey = x25519.utils.randomPrivateKey()
  return { privateKey, publicKey: x25519.getPublicKey(privateKey) }
}

describe('dm-crypto: seal → open', () => {
  it('round-trips for BOTH a recipient and the sender', () => {
    const alice = kp()
    const bob = kp()
    const category = dmCategory([alice.publicKey, bob.publicKey])
    const env = sealMessage(alice.privateKey, alice.publicKey, [bob.publicKey], category, 'hi bob', 'alice')

    // recipient reads it
    const asBob = openMessage(bob.privateKey, bob.publicKey, category, env)
    expect(isUndecryptable(asBob)).toBe(false)
    if (!isUndecryptable(asBob)) {
      expect(asBob.text).toBe('hi bob')
      expect(asBob.handle).toBe('alice')
    }
    // sender reads their own sent message (sender pubkey is auto-added to the recipient set)
    const asAlice = openMessage(alice.privateKey, alice.publicKey, category, env)
    expect(isUndecryptable(asAlice)).toBe(false)
    if (!isUndecryptable(asAlice)) {
      expect(asAlice.text).toBe('hi bob')
      expect(asAlice.handle).toBe('alice')
    }
  })

  it('round-trips edge-case bodies (empty text, no handle, unicode, long)', () => {
    const a = kp()
    const b = kp()
    const category = dmCategory([a.publicKey, b.publicKey])
    for (const [text, handle] of [
      ['plain', undefined],
      ['', 'onlyhandle'],
      ['unicode: café ☕ 日本語 🔒', 'zoë'],
      ['y'.repeat(4000), 'long'],
    ] as [string, string | undefined][]) {
      const env = sealMessage(a.privateKey, a.publicKey, [b.publicKey], category, text, handle)
      const out = openMessage(b.privateKey, b.publicKey, category, env)
      expect(isUndecryptable(out)).toBe(false)
      if (!isUndecryptable(out)) {
        expect(out.text).toBe(text)
        expect(out.handle).toBe(handle && handle.trim() ? handle : undefined)
      }
    }
  })

  it('a group message reaches every named recipient', () => {
    const a = kp()
    const b = kp()
    const c = kp()
    const category = dmCategory([a.publicKey, b.publicKey, c.publicKey])
    const env = sealMessage(a.privateKey, a.publicKey, [b.publicKey, c.publicKey], category, 'group hello')
    for (const who of [a, b, c]) {
      const out = openMessage(who.privateKey, who.publicKey, category, env)
      expect(isUndecryptable(out)).toBe(false)
      if (!isUndecryptable(out)) expect(out.text).toBe('group hello')
    }
  })

  it('a non-recipient (random keypair) → undecryptable', () => {
    const a = kp()
    const b = kp()
    const eve = kp()
    const category = dmCategory([a.publicKey, b.publicKey])
    const env = sealMessage(a.privateKey, a.publicKey, [b.publicKey], category, 'for bob only')
    // Eve has a valid keypair but is not in the recipient set — no matching keyId.
    expect(isUndecryptable(openMessage(eve.privateKey, eve.publicKey, category, env))).toBe(true)
  })

  it('the body plaintext never appears on the wire', () => {
    const a = kp()
    const b = kp()
    const category = dmCategory([a.publicKey, b.publicKey])
    const env = sealMessage(a.privateKey, a.publicKey, [b.publicKey], category, 'topsecretbody', 'spy')
    const bytes = hexToBytes(env)
    expect(bytes[0]).toBe(0x01)
    const wire = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
    expect(wire.includes('topsecretbody')).toBe(false)
    expect(wire.includes('spy')).toBe(false)
  })
})

describe('dm-crypto: fail-closed on tampering / wrong context', () => {
  const setup = () => {
    const a = kp()
    const b = kp()
    const category = dmCategory([a.publicKey, b.publicKey])
    const env = sealMessage(a.privateKey, a.publicKey, [b.publicKey], category, 'integrity', 'alice')
    return { a, b, category, env }
  }

  it('tampered body ciphertext (flip last byte) → undecryptable', () => {
    const { b, category, env } = setup()
    const bytes = hexToBytes(env)
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff
    expect(isUndecryptable(openMessage(b.privateKey, b.publicKey, category, toHex(bytes)))).toBe(true)
  })

  it('tampered wrap (flip a byte inside the wrap table) → undecryptable', () => {
    const { b, category, env } = setup()
    const bytes = hexToBytes(env)
    // The first wrap block begins right after version(1)+ephemeralPub(32)+bodyNonce(24)+count(2)=59.
    // Byte 59 is the start of keyId; flipping a byte deeper (in wrapNonce/wrapped) breaks the unseal.
    const wrapByte = 59 + 8 + 24 + 2 // into the wrapped DEK ciphertext
    bytes[wrapByte] = bytes[wrapByte]! ^ 0xff
    expect(isUndecryptable(openMessage(b.privateKey, b.publicKey, category, toHex(bytes)))).toBe(true)
  })

  it('wrong category (AAD mismatch) → undecryptable', () => {
    const { b, env } = setup()
    const other = dmCategory([kp().publicKey, kp().publicKey])
    expect(isUndecryptable(openMessage(b.privateKey, b.publicKey, other, env))).toBe(true)
  })

  it('wrong version byte → undecryptable', () => {
    const { b, category, env } = setup()
    const bytes = hexToBytes(env)
    bytes[0] = 0x02
    expect(isUndecryptable(openMessage(b.privateKey, b.publicKey, category, toHex(bytes)))).toBe(true)
  })

  it('short / non-hex / truncated envelopes → undecryptable, never throw', () => {
    const { b, category, env } = setup()
    expect(isUndecryptable(openMessage(b.privateKey, b.publicKey, category, '0x' as Hex))).toBe(true)
    expect(isUndecryptable(openMessage(b.privateKey, b.publicKey, category, '0x01' as Hex))).toBe(true)
    // truncate the real envelope mid-body
    const bytes = hexToBytes(env).slice(0, 40)
    expect(isUndecryptable(openMessage(b.privateKey, b.publicKey, category, toHex(bytes)))).toBe(true)
  })
})

describe('dm-crypto: forward secrecy sanity', () => {
  it('two seals of the same message use different ephemeral keys', () => {
    const a = kp()
    const b = kp()
    const category = dmCategory([a.publicKey, b.publicKey])
    const env1 = hexToBytes(sealMessage(a.privateKey, a.publicKey, [b.publicKey], category, 'same', 'a'))
    const env2 = hexToBytes(sealMessage(a.privateKey, a.publicKey, [b.publicKey], category, 'same', 'a'))
    // ephemeralPub occupies bytes [1, 33).
    const eph1 = toHex(env1.slice(1, 33))
    const eph2 = toHex(env2.slice(1, 33))
    expect(eph1).not.toBe(eph2)
    // whole envelopes differ too (fresh DEK + nonces)
    expect(toHex(env1)).not.toBe(toHex(env2))
  })
})

describe('dm-crypto: dmCategory', () => {
  it('is order-independent and deterministic', () => {
    const a = kp().publicKey
    const b = kp().publicKey
    const c = kp().publicKey
    expect(dmCategory([a, b, c])).toBe(dmCategory([c, a, b]))
    expect(dmCategory([a, b])).toBe(dmCategory([a, b]))
    expect(dmCategory([a, b])).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it('different member sets → different categories', () => {
    const a = kp().publicKey
    const b = kp().publicKey
    const c = kp().publicKey
    const cats = new Set([dmCategory([a, b]), dmCategory([a, c]), dmCategory([b, c]), dmCategory([a, b, c])])
    expect(cats.size).toBe(4)
  })
})

describe('dm-crypto: contact cards', () => {
  it('encode → parse round-trip (with and without a label)', () => {
    const { publicKey } = kp()
    const withLabel = encodeContact(publicKey, 'Alice ☕')
    const p1 = parseContact(withLabel)
    expect(p1).not.toBeNull()
    expect(toHex(p1!.pubkey)).toBe(toHex(publicKey))
    expect(p1!.label).toBe('Alice ☕')

    const noLabel = encodeContact(publicKey)
    const p2 = parseContact(noLabel)
    expect(p2).not.toBeNull()
    expect(toHex(p2!.pubkey)).toBe(toHex(publicKey))
    expect(p2!.label).toBeUndefined()
  })

  it('malformed contact cards → null (never throw)', () => {
    const good = encodeContact(kp().publicKey)
    for (const bad of [
      '',
      'nonsense',
      'msgboard-contact',
      'msgboard-contact:v1',
      'wrong-prefix:v1:AAAA',
      'msgboard-contact:v2:' + good.split(':')[2],
      'msgboard-contact:v1:not*base64url!',
      'msgboard-contact:v1:AAAA', // decodes to 3 bytes, not 32
      good + ':x:extra', // too many parts
    ]) {
      expect(parseContact(bad)).toBeNull()
    }
    expect(parseContact(good)).not.toBeNull()
  })
})

describe('dm-crypto: deriveEncKeypair', () => {
  const id = (n: bigint, t: bigint): ZkIdentity => ({ nullifier: n, trapdoor: t })

  it('is deterministic for a given identity', () => {
    const identity = id(123456789n, 987654321n)
    const k1 = deriveEncKeypair(identity)
    const k2 = deriveEncKeypair(identity)
    expect(toHex(k1.publicKey)).toBe(toHex(k2.publicKey))
    expect(toHex(k1.privateKey)).toBe(toHex(k2.privateKey))
    expect(k1.publicKey.length).toBe(32)
    expect(k1.privateKey.length).toBe(32)
  })

  it('different identities → different enc keys', () => {
    const k1 = deriveEncKeypair(id(1n, 2n))
    const k2 = deriveEncKeypair(id(2n, 1n))
    expect(toHex(k1.publicKey)).not.toBe(toHex(k2.publicKey))
  })

  it('the derived keypair actually works end-to-end over seal/open', () => {
    const alice = deriveEncKeypair(id(0xaaaan, 0xbbbbn))
    const bob = deriveEncKeypair(id(0xccccn, 0xddddn))
    const category = dmCategory([alice.publicKey, bob.publicKey])
    const env = sealMessage(alice.privateKey, alice.publicKey, [bob.publicKey], category, 'derived keys work')
    const out = openMessage(bob.privateKey, bob.publicKey, category, env)
    expect(isUndecryptable(out)).toBe(false)
    if (!isUndecryptable(out)) expect(out.text).toBe('derived keys work')
  })
})

describe('dm-crypto: keyId is per-message (audit MEDIUM 1 — no global correlator)', () => {
  it('the same recipient gets a DIFFERENT keyId locator in two messages (unlinkable)', () => {
    const alice = kp()
    const bob = kp()
    const category = dmCategory([alice.publicKey, bob.publicKey])
    // keyId lives at bytes [1 + 32 + 24 + 2 .. +8) of the envelope (after version+ephPub+bodyNonce+count).
    const keyIdOfEnv = (envHex: Hex) => toHex(hexToBytes(envHex).slice(59, 67))
    const e1 = sealMessage(alice.privateKey, alice.publicKey, [bob.publicKey], category, 'one', 'a')
    const e2 = sealMessage(alice.privateKey, alice.publicKey, [bob.publicKey], category, 'two', 'a')
    // Different ephemeral key each message ⇒ different shared secret ⇒ different keyId. An observer
    // holding bob's pubkey cannot precompute a stable locator to scan the board for his traffic.
    expect(keyIdOfEnv(e1)).not.toBe(keyIdOfEnv(e2))
    // ...yet bob still opens both (he recomputes the keyId from his own shared secret).
    expect(isUndecryptable(openMessage(bob.privateKey, bob.publicKey, category, e1))).toBe(false)
    expect(isUndecryptable(openMessage(bob.privateKey, bob.publicKey, category, e2))).toBe(false)
  })
})
