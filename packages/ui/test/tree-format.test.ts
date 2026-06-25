import { describe, expect, it } from 'vitest'
import { isPrintable, resolveCategoryValue, stripPadding } from '../src/lib/tree-format'

const NUL = String.fromCharCode(0)
const ctrl = (...codes: number[]): string => String.fromCharCode(...codes)

const HASH = '0x200ac67a0d9f43b1505d0f03fa5038c1d180e126d4aab3afe5ed2987f9778d81'
// "gasmoneyplease" utf8-encoded and zero-padded to 32 bytes decodes back with trailing NULs
const GAS_DECODED = `gasmoneyplease${NUL.repeat(18)}`
// a keccak hash decodes to bytes that include control characters — i.e. not real text
const HASH_DECODED = `${ctrl(1, 2)}garbage`

describe('isPrintable', () => {
  it('accepts plain text', () => {
    expect(isPrintable('gasmoneyplease')).toBe(true)
    expect(isPrintable('0x200ac6')).toBe(true)
  })
  it('rejects empty and control-character strings', () => {
    expect(isPrintable('')).toBe(false)
    expect(isPrintable(`abc${ctrl(1)}`)).toBe(false)
    expect(isPrintable(`a${ctrl(0x7f)}b`)).toBe(false)
    expect(isPrintable(NUL)).toBe(false)
  })
})

describe('stripPadding', () => {
  it('drops trailing NUL padding then whitespace', () => {
    expect(stripPadding(GAS_DECODED)).toBe('gasmoneyplease')
    expect(stripPadding('hello')).toBe('hello')
    expect(stripPadding(`${NUL}${NUL}`)).toBe('')
  })
})

describe('resolveCategoryValue', () => {
  it('shows the raw hex for a hashed (non-text) category', () => {
    expect(resolveCategoryValue(HASH, HASH_DECODED, true)).toBe(HASH)
  })
  it('shows the decoded name when the category is real text', () => {
    expect(resolveCategoryValue('0xdead', GAS_DECODED, true)).toBe('gasmoneyplease')
  })
  it('shows the raw hex when the decode toggle is off, even for text', () => {
    expect(resolveCategoryValue('0xdead', GAS_DECODED, false)).toBe('0xdead')
  })
})
