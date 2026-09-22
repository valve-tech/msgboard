import { describe, expect, it } from 'vitest'
import { stringToHex } from 'viem'
import { categoryHash } from '@msgboard/sdk'
import { msgboardContentSource, toCategoryHex } from '../../src/sources/msgboard-content.js'
import type { RelayerContext } from '../../src/types.js'
import type { Content, RPCMessage } from '@msgboard/sdk'

const msg = (hash: string): RPCMessage => ({ hash } as RPCMessage)

const ctxWithContent = (content: Content): RelayerContext =>
  ({ client: { content: async () => content } } as unknown as RelayerContext)

describe('toCategoryHex', () => {
  it('zero-pads plain UTF-8 category names to 32 bytes', () => {
    expect(toCategoryHex('gasmoneyplease')).toBe(stringToHex('gasmoneyplease', { size: 32 }))
    expect(toCategoryHex('valaxy-relayer-ad-v1')).toBe(stringToHex('valaxy-relayer-ad-v1', { size: 32 }))
    // Plaintext is NOT keccak — callers who want keccak pass categoryHash(...) as 0x
    expect(toCategoryHex('gasmoneyplease')).not.toBe(categoryHash('gasmoneyplease'))
  })

  it('passes through pre-hashed 0x bytes32 unchanged', () => {
    const hashed = categoryHash('valaxy-privacy-relay-v1')
    expect(toCategoryHex(hashed)).toBe(hashed)
  })
})

describe('msgboardContentSource', () => {
  it('flattens all messages across categories when no category is set', async () => {
    const a = stringToHex('a', { size: 32 })
    const b = stringToHex('b', { size: 32 })
    const source = msgboardContentSource()
    const items = await source.poll(ctxWithContent({ [a]: [msg('0x1')], [b]: [msg('0x2')] }))
    expect(items.map((m) => m.hash).sort()).toEqual(['0x1', '0x2'])
  })

  it('requests a single category via zero-pad and returns its messages', async () => {
    const cat = stringToHex('gasmoneyplease', { size: 32 })
    let requested: unknown
    const ctx = {
      client: {
        content: async (filter: { category?: string }) => {
          requested = filter
          return { [cat]: [msg('0x3')] }
        },
      },
    } as unknown as RelayerContext
    const source = msgboardContentSource({ category: 'gasmoneyplease' })
    const items = await source.poll(ctx)
    expect(items.map((m) => m.hash)).toEqual(['0x3'])
    expect(requested).toEqual({ category: cat })
  })

  it('accepts an explicit pre-hashed category (SDK categoryHash / Valaxy pattern)', async () => {
    const cat = categoryHash('valaxy-tornado-job-v1')
    let requested: unknown
    const ctx = {
      client: {
        content: async (filter: { category?: string }) => {
          requested = filter
          return { [cat]: [msg('0x4')] }
        },
      },
    } as unknown as RelayerContext
    const source = msgboardContentSource({ category: cat })
    const items = await source.poll(ctx)
    expect(items.map((m) => m.hash)).toEqual(['0x4'])
    expect(requested).toEqual({ category: cat })
  })
})
