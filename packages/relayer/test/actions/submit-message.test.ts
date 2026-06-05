import { describe, expect, it, vi } from 'vitest'
import { submitMessageAction } from '../../src/actions/submit-message.js'
import type { RelayerContext } from '../../src/types.js'

describe('submitMessageAction', () => {
  it('describe reports the category and data', () => {
    const action = submitMessageAction<string>({
      category: () => 'lorem',
      data: (item) => item,
    })
    const ctx = {} as RelayerContext
    expect(action.describe('hello', ctx)).toMatch(/lorem/)
    expect(action.describe('hello', ctx)).toMatch(/hello/)
  })

  it('execute does proof-of-work then adds the message', async () => {
    const doPoW = vi.fn(async () => ({ message: { hash: '0xmsg' }, stats: {} }))
    const addMessage = vi.fn(async () => '0xmsg')
    const ctx = { client: { doPoW, addMessage } } as unknown as RelayerContext
    const action = submitMessageAction<string>({ category: () => 'lorem', data: (item) => item })
    const result = await action.execute('hello', ctx)
    expect(doPoW).toHaveBeenCalled()
    expect(addMessage).toHaveBeenCalled()
    expect(result).toEqual({ ok: true, ref: '0xmsg', meta: { stats: {} } })
  })
})
