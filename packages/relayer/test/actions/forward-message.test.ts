import { describe, expect, it, vi } from 'vitest'
import type { Hex } from 'viem'
import { forwardMessageAction } from '../../src/actions/forward-message.js'
import type { RelayerContext } from '../../src/types.js'

const RLP = '0xdeadbeefcafef00dba5e' as Hex

/** Builds a minimal context whose client records the RLP passed to addMessage. */
const contextWith = (addMessage: (rlp: Hex) => Promise<Hex>): RelayerContext =>
  ({ client: { addMessage } } as unknown as RelayerContext)

describe('forwardMessageAction', () => {
  it('describe identifies the message by its leading bytes', () => {
    const action = forwardMessageAction()
    const description = action.describe(RLP, {} as RelayerContext)
    // truncated to the first 10 chars ("0x" + 8 hex) so logs stay readable
    expect(description).toContain(RLP.slice(0, 10))
    expect(description).not.toContain(RLP.slice(10))
  })

  it('execute forwards the RLP verbatim to addMessage (no proof-of-work)', async () => {
    const addMessage = vi.fn(async () => '0xhash' as Hex)
    const action = forwardMessageAction()

    await action.execute(RLP, contextWith(addMessage))

    // The whole point of "forward": the item is submitted unchanged, untouched.
    expect(addMessage).toHaveBeenCalledTimes(1)
    expect(addMessage).toHaveBeenCalledWith(RLP)
  })

  it('execute surfaces the returned message hash as the result ref', async () => {
    const messageHash = '0xabc123' as Hex
    const action = forwardMessageAction()

    const result = await action.execute(RLP, contextWith(async () => messageHash))

    expect(result).toEqual({ ok: true, ref: messageHash })
  })

  it('execute propagates a rejecting addMessage (the relayer records the failure)', async () => {
    const action = forwardMessageAction()
    const rejecting = contextWith(async () => {
      throw new Error('node rejected: invalid proof of work')
    })

    await expect(action.execute(RLP, rejecting)).rejects.toThrow('invalid proof of work')
  })
})
