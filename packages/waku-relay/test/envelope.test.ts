import { describe, it, expect } from 'vitest'
import { toHex } from 'viem'
import { wrapEnvelope, unwrapEnvelope, contentId, ENVELOPE_VERSION } from '../src/envelope.js'

describe('envelope', () => {
  it('wrap → unwrap round-trips the payload + metadata', () => {
    const body = toHex(new Uint8Array([1, 2, 3, 255]))
    const data = wrapEnvelope({ origin: 'waku', channel: 'lobby', body, at: 1_700_000_000_000 })
    const env = unwrapEnvelope(data)
    expect(env).not.toBeNull()
    expect(env!.v).toBe(ENVELOPE_VERSION)
    expect(env!.origin).toBe('waku')
    expect(env!.channel).toBe('lobby')
    expect(env!.body).toBe(body)
    expect(env!.at).toBe(1_700_000_000_000)
  })

  it('unwrap returns null for non-envelope data', () => {
    expect(unwrapEnvelope(toHex('just some text'))).toBeNull()
    expect(unwrapEnvelope(toHex(JSON.stringify({ v: 999, origin: 'waku', channel: 'x', at: 0, body: '0x' })))).toBeNull()
    expect(unwrapEnvelope(toHex(JSON.stringify({ hello: 'world' })))).toBeNull()
  })

  it('content id is stable and origin-independent (so echo detection works both ways)', () => {
    const body = toHex(new Uint8Array([9, 9, 9]))
    expect(contentId('lobby', body)).toBe(contentId('lobby', body))
    // case-insensitive on the hex body
    expect(contentId('lobby', body.toUpperCase() as `0x${string}`)).toBe(contentId('lobby', body))
    // different channel or body → different id
    expect(contentId('other', body)).not.toBe(contentId('lobby', body))
    expect(contentId('lobby', toHex(new Uint8Array([9, 9, 8])))).not.toBe(contentId('lobby', body))
  })
})
