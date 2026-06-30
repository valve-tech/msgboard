import { describe, it, expect } from 'vitest'
import { bytesToHex, stringToBytes, type Hex } from 'viem'
import { createRelay } from '../src/relay.js'
import { createSeenStore } from '../src/seen.js'
import { MockWakuSource } from '../src/waku.js'
import { categoryFor } from '../src/category.js'
import { unwrapEnvelope } from '../src/envelope.js'

interface PostCall { category: Hex; data: Hex }
const recordingPost = () => {
  const calls: PostCall[] = []
  const post = async (category: Hex, data: Hex): Promise<Hex> => {
    calls.push({ category, data })
    return `0x${calls.length.toString(16).padStart(64, '0')}` as Hex
  }
  return { calls, post }
}
const payload = (s: string): Uint8Array => stringToBytes(s)

describe('relay (one-way Waku -> MsgBoard)', () => {
  it('relays each message once, mapping channel -> category (keccak256 default)', async () => {
    const source = new MockWakuSource()
    const { calls, post } = recordingPost()
    const relay = createRelay({ source, post, seen: createSeenStore(), channels: ['lobby'] })
    await relay.start()

    source.emit('lobby', payload('hello'))
    source.emit('lobby', payload('world'))
    await relay.stop()

    expect(calls).toHaveLength(2)
    expect(calls[0]!.category).toBe(categoryFor('lobby', 'keccak256'))
    expect(relay.stats()).toMatchObject({ received: 2, relayed: 2, skippedDuplicate: 0, failed: 0 })
  })

  it('flips channel->category to ascii32 when configured', async () => {
    const source = new MockWakuSource()
    const { calls, post } = recordingPost()
    const relay = createRelay({ source, post, seen: createSeenStore(), channels: ['lobby'], categoryEncoding: 'ascii32' })
    await relay.start()
    source.emit('lobby', payload('x'))
    await relay.stop()
    expect(calls[0]!.category).toBe(categoryFor('lobby', 'ascii32'))
    expect(calls[0]!.category).not.toBe(categoryFor('lobby', 'keccak256'))
  })

  it('dedups duplicate payloads (in-flight + seen guard)', async () => {
    const source = new MockWakuSource()
    const { calls, post } = recordingPost()
    const relay = createRelay({ source, post, seen: createSeenStore(), channels: ['lobby'] })
    await relay.start()

    source.emit('lobby', payload('same')) // queued (in-flight)
    source.emit('lobby', payload('same')) // dropped by the in-flight guard
    await relay.stop()
    source.emit('lobby', payload('same')) // dropped by the seen guard (already relayed)

    expect(calls).toHaveLength(1) // posted exactly once
    expect(relay.stats()).toMatchObject({ received: 3, relayed: 1, skippedDuplicate: 2 })
  })

  it('envelope mode wraps the payload; raw mode posts the bare bytes', async () => {
    const body = bytesToHex(payload('data'))

    const envSource = new MockWakuSource()
    const env = recordingPost()
    const envRelay = createRelay({ source: envSource, post: env.post, seen: createSeenStore(), channels: ['c'], bodyMode: 'envelope' })
    await envRelay.start()
    envSource.emit('c', payload('data'))
    await envRelay.stop()
    const unwrapped = unwrapEnvelope(env.calls[0]!.data)
    expect(unwrapped).not.toBeNull()
    expect(unwrapped!.body).toBe(body)
    expect(unwrapped!.origin).toBe('waku')

    const rawSource = new MockWakuSource()
    const raw = recordingPost()
    const rawRelay = createRelay({ source: rawSource, post: raw.post, seen: createSeenStore(), channels: ['c'], bodyMode: 'raw' })
    await rawRelay.start()
    rawSource.emit('c', payload('data'))
    await rawRelay.stop()
    expect(raw.calls[0]!.data).toBe(body) // bare payload, no envelope
  })

  it('preserves order and counts failures (un-remembered for retry)', async () => {
    const source = new MockWakuSource()
    const order: string[] = []
    let calls = 0
    const post = async (_category: Hex, data: Hex): Promise<Hex> => {
      calls++
      const env = unwrapEnvelope(data)
      order.push(env ? Buffer.from(env.body.slice(2), 'hex').toString() : 'raw')
      if (calls === 2) throw new Error('boom') // second post fails
      return '0x00' as Hex
    }
    const seen = createSeenStore()
    const relay = createRelay({ source, post, seen, channels: ['lobby'] })
    await relay.start()
    source.emit('lobby', payload('one'))
    source.emit('lobby', payload('two'))
    source.emit('lobby', payload('three'))
    await relay.stop()

    expect(order).toEqual(['one', 'two', 'three']) // serialized, in order
    expect(relay.stats()).toMatchObject({ relayed: 2, failed: 1 })
    // the failed one was NOT remembered, so it can retry on redelivery
    expect(seen.size()).toBe(2)
  })
})
