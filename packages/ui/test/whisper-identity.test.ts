import { describe, it, expect } from 'vitest'
import {
  exportIdentity,
  importIdentity,
  randomIdentity,
  type ZkIdentity,
} from '../src/lib/zk-identity'
import { SNARK_FIELD } from '../src/lib/zk-post'

/**
 * The recovery key is the ONE secret that IS a Whisper pseudonym. Its export/import MUST be an
 * exact round-trip of the real field-element secrets, and import MUST reject anything invalid.
 */
describe('Whisper recovery key (export/import)', () => {
  it('round-trips a random identity exactly', () => {
    for (let i = 0; i < 50; i++) {
      const id = randomIdentity()
      const back = importIdentity(exportIdentity(id))
      expect(back).not.toBeNull()
      expect(back!.nullifier).toBe(id.nullifier)
      expect(back!.trapdoor).toBe(id.trapdoor)
    }
  })

  it('round-trips edge secrets (1 and field-1)', () => {
    const edge: ZkIdentity = { nullifier: 1n, trapdoor: SNARK_FIELD - 1n }
    const back = importIdentity(exportIdentity(edge))
    expect(back).toEqual(edge)
  })

  it('produces a self-identifying, copy-pasteable string', () => {
    const key = exportIdentity(randomIdentity())
    expect(key.startsWith('whisper1')).toBe(true)
    expect(key).toMatch(/^whisper1[1-9A-HJ-NP-Za-km-z]+$/) // base58 alphabet only
    expect(key.length).toBeLessThan(120)
  })

  it('tolerates surrounding whitespace and the optional prefix', () => {
    const id = randomIdentity()
    const key = exportIdentity(id)
    expect(importIdentity(`  ${key}  `)).toEqual(id)
    // body without the human prefix still imports
    expect(importIdentity(key.slice('whisper1'.length))).toEqual(id)
  })

  it('rejects garbage / tampered / out-of-range input (returns null, never throws)', () => {
    expect(importIdentity('')).toBeNull()
    expect(importIdentity('not-a-key')).toBeNull()
    expect(importIdentity('whisper1!!!!')).toBeNull()
    // a valid key with one character flipped fails the checksum
    const key = exportIdentity(randomIdentity())
    const flipped = key.slice(0, -1) + (key.slice(-1) === 'A' ? 'B' : 'A')
    expect(importIdentity(flipped)).toBeNull()
    // truncated
    expect(importIdentity(key.slice(0, key.length - 5))).toBeNull()
  })
})
