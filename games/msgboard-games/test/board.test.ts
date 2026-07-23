import { describe, it, expect, afterEach } from 'vitest'
import { msgBoardClientAdapter } from '../src/board'

// A minimal MsgBoardClient stand-in: the guard must fire BEFORE doPoW is reached, so these are only
// hit on the allowed (no-DOM) path.
const fakeBoard = () =>
  ({
    doPoW: async (category: unknown, data: unknown) => ({ message: { category, data } }),
    addMessage: async () => '0xhash',
  }) as never

describe('board PoW main-thread guard', () => {
  afterEach(() => {
    delete (globalThis as { document?: unknown }).document
  })

  it('REFUSES to grind PoW when a DOM is present (a browser main thread freezes on doPoW)', async () => {
    ;(globalThis as { document?: unknown }).document = {}
    const client = msgBoardClientAdapter(fakeBoard())
    await expect(client.addMessage({ category: '0x00', data: '0x01' })).rejects.toThrow(/main thread/i)
  })

  it('grinds normally when there is no DOM (Node bot / Web Worker)', async () => {
    const client = msgBoardClientAdapter(fakeBoard())
    await expect(client.addMessage({ category: '0x00', data: '0x01' })).resolves.toBe('0xhash')
  })
})
