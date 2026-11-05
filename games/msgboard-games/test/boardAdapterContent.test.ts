import { describe, it, expect } from 'vitest'
import { msgBoardClientAdapter } from '../src/board'

describe('msgBoardClientAdapter.content', () => {
  it('reads with contentAll and passes the category through', async () => {
    const seen: unknown[] = []
    const board = {
      content: async () => { throw new Error('content() must not be called') },
      contentAll: async (filter: unknown) => { seen.push(filter); return { '0xaa': [{ data: '0x01' }] } },
    }
    const adapter = msgBoardClientAdapter(board as never)
    expect(await adapter.content({ category: '0xaa' as `0x${string}` })).toEqual({ '0xaa': [{ data: '0x01' }] })
    expect(await adapter.content({})).toBeDefined()
    expect(seen).toEqual([{ category: '0xaa' }, {}])
  })
})
