import { describe, it, expect, vi } from 'vitest'
import { MsgBoardTransport } from '../src/msgboardTransport'

// Minimal fake of the MsgBoardClient surface the adapter uses.
function fakeClient() {
  const posted: any[] = []
  return {
    posted,
    addMessage: vi.fn(async (seed: any) => { posted.push(seed); return '0xhash' }),
    content: vi.fn(async (_filter: any) => ({})),
  }
}

const tableId = `0x${'ab'.repeat(32)}` as const

describe('MsgBoardTransport', () => {
  it('posts a broadcast under the table category', async () => {
    const client = fakeClient()
    const t = new MsgBoardTransport(client as any, tableId)
    await t.send({ kind: 'ROUND', round: 1 })
    expect(client.addMessage).toHaveBeenCalledOnce()
    expect(client.posted[0].category).toBe(t.category)
  })

  it('decodes polled content into messages for the handler', async () => {
    const client = fakeClient()
    const t = new MsgBoardTransport(client as any, tableId)
    const got: unknown[] = []
    t.onMessage((m) => got.push(m))
    client.content = vi.fn(async () => ({
      [t.category]: [{ data: t.encode({ kind: 'ROUND', round: 2 }) }],
    })) as any
    await t.poll()
    expect(got).toEqual([{ kind: 'ROUND', round: 2 }])
  })

  it('does not re-deliver a message already seen', async () => {
    const client = fakeClient()
    const t = new MsgBoardTransport(client as any, tableId)
    const got: unknown[] = []
    t.onMessage((m) => got.push(m))
    const msg = { data: t.encode({ kind: 'X' }) }
    client.content = vi.fn(async () => ({ [t.category]: [msg] })) as any
    await t.poll()
    await t.poll()
    expect(got).toEqual([{ kind: 'X' }])
  })
})
