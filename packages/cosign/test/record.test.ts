import { describe, expect, it } from 'vitest'
import type { Hex } from 'viem'
import { SCHEME, type SignatureRecord, decodeRecord, encodeRecord } from '../src/record.js'

const digest = `0x${'11'.repeat(32)}` as Hex
const signer = `0x${'22'.repeat(20)}` as Hex
const signature = `0x${'33'.repeat(65)}` as Hex // r||s||v

const make = (scheme: number, meta: Hex): SignatureRecord => ({
  digest,
  signer,
  signature,
  scheme,
  meta,
})

describe('SCHEME', () => {
  it('pins the enum values (order is law)', () => {
    expect(SCHEME).toEqual({ ECDSA: 0, EIP1271: 1, EIP712: 2 })
  })
})

describe('encodeRecord / decodeRecord', () => {
  it('round-trips ECDSA with empty meta', () => {
    const r = make(SCHEME.ECDSA, '0x')
    expect(decodeRecord(encodeRecord(r))).toEqual(r)
  })

  it('round-trips EIP1271 with non-empty meta', () => {
    const r = make(SCHEME.EIP1271, '0xdeadbeef')
    expect(decodeRecord(encodeRecord(r))).toEqual(r)
  })

  it('round-trips EIP712 with empty meta', () => {
    const r = make(SCHEME.EIP712, '0x')
    expect(decodeRecord(encodeRecord(r))).toEqual(r)
  })

  it('produces a 0x hex string from encodeRecord', () => {
    expect(encodeRecord(make(SCHEME.ECDSA, '0x'))).toMatch(/^0x[0-9a-f]+$/)
  })

  it('throws on garbage input', () => {
    expect(() => decodeRecord('0xdead' as Hex)).toThrow()
  })

  it('throws on empty input', () => {
    expect(() => decodeRecord('0x' as Hex)).toThrow()
  })
})
