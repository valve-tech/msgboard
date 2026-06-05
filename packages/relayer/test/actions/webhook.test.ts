import { describe, expect, it, vi } from 'vitest'
import { webhookAction } from '../../src/actions/webhook.js'
import { noopAction } from '../../src/actions/noop.js'
import type { RelayerContext } from '../../src/types.js'

const ctx = {} as RelayerContext

describe('webhookAction', () => {
  it('describe reports the target url', () => {
    const action = webhookAction<{ id: string }>({ url: 'https://hook.test/x' })
    expect(action.describe({ id: '1' }, ctx)).toMatch('https://hook.test/x')
  })

  it('execute posts the item as JSON and reports ok on a 2xx', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200 }) as Response)
    const action = webhookAction<{ id: string }>({ url: 'https://hook.test/x', fetchImpl })
    const result = await action.execute({ id: '1' }, ctx)
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://hook.test/x',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(result.ok).toBe(true)
  })

  it('execute reports not-ok on a non-2xx', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 500 }) as Response)
    const action = webhookAction<{ id: string }>({ url: 'https://hook.test/x', fetchImpl })
    const result = await action.execute({ id: '1' }, ctx)
    expect(result.ok).toBe(false)
  })
})

describe('noopAction', () => {
  it('describe is stable and execute reports ok without effect', async () => {
    const action = noopAction<{ id: string }>()
    expect(typeof action.describe({ id: '1' }, ctx)).toBe('string')
    expect(await action.execute({ id: '1' }, ctx)).toEqual({ ok: true })
  })
})
