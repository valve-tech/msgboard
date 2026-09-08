import { http } from 'viem'
import { pulsechainV4 } from 'viem/chains'
import { describe, expect, it, vi } from 'vitest'
import { Relayer } from '../src/relayer.js'
import type { RelayerConfig } from '../src/types.js'

type Item = { id: string }

const baseConfig = (over: Partial<RelayerConfig<Item>>): RelayerConfig<Item> => ({
  node: { transport: http('http://localhost:8545'), chain: pulsechainV4 },
  source: { poll: async () => [{ id: 'a' }] },
  action: {
    describe: (item) => `would act on ${item.id}`,
    execute: async (item) => ({ ok: true, ref: item.id }),
  },
  key: (item) => item.id,
  logger: () => {},
  ...over,
})

describe('Relayer.runOnce', () => {
  it('observe mode describes but never executes', async () => {
    const execute = vi.fn(async (item: Item) => ({ ok: true, ref: item.id }))
    const relayer = new Relayer(
      baseConfig({ mode: 'observe', action: { describe: () => 'x', execute } }),
    )
    const report = await relayer.runOnce()
    expect(execute).not.toHaveBeenCalled()
    expect(report.described).toBe(1)
    expect(report.executed).toBe(0)
  })

  it('live mode executes each eligible item exactly once', async () => {
    const execute = vi.fn(async (item: Item) => ({ ok: true, ref: item.id }))
    const relayer = new Relayer(
      baseConfig({ mode: 'live', action: { describe: () => 'x', execute } }),
    )
    const report = await relayer.runOnce()
    expect(execute).toHaveBeenCalledTimes(1)
    expect(report.executed).toBe(1)
  })

  it('records every polled item to the sink in observe mode', async () => {
    const record = vi.fn(async () => {})
    const relayer = new Relayer(baseConfig({ mode: 'observe', sink: { record } }))
    const report = await relayer.runOnce()
    expect(record).toHaveBeenCalledTimes(1)
    expect(report.recorded).toBe(1)
  })

  it('skips items the store has already seen', async () => {
    const execute = vi.fn(async (item: Item) => ({ ok: true, ref: item.id }))
    const store = { has: async () => true, remember: async () => {} }
    const relayer = new Relayer(
      baseConfig({ mode: 'live', store, action: { describe: () => 'x', execute } }),
    )
    const report = await relayer.runOnce()
    expect(execute).not.toHaveBeenCalled()
    expect(report.deduped).toBe(1)
  })

  it('remembers a key only after a successful live execute', async () => {
    const remember = vi.fn(async () => {})
    const store = { has: async () => false, remember }
    const relayer = new Relayer(baseConfig({ mode: 'live', store }))
    await relayer.runOnce()
    expect(remember).toHaveBeenCalledWith('a', expect.objectContaining({ ok: true }))
  })

  it('isolates an action error and does not remember the key', async () => {
    const remember = vi.fn(async () => {})
    const store = { has: async () => false, remember }
    const action = {
      describe: () => 'x',
      execute: async () => {
        throw new Error('boom')
      },
    }
    const relayer = new Relayer(baseConfig({ mode: 'live', store, action }))
    const report = await relayer.runOnce()
    expect(remember).not.toHaveBeenCalled()
    expect(report.executed).toBe(0)
  })

  it('drops items that fail the condition', async () => {
    const execute = vi.fn(async (item: Item) => ({ ok: true, ref: item.id }))
    const relayer = new Relayer(
      baseConfig({
        mode: 'live',
        condition: (item) => item.id === 'keep',
        source: { poll: async () => [{ id: 'drop' }, { id: 'keep' }] },
        action: { describe: () => 'x', execute },
      }),
    )
    const report = await relayer.runOnce()
    expect(execute).toHaveBeenCalledTimes(1)
    expect(report.eligible).toBe(1)
  })
})

describe('Relayer lifecycle', () => {
  it('start() runs ticks until stop() and stop awaits the in-flight tick', async () => {
    let polls = 0
    const relayer = new Relayer(
      baseConfig({
        mode: 'observe',
        intervalMs: 5,
        source: {
          poll: async () => {
            polls += 1
            return [{ id: 'a' }]
          },
        },
      }),
    )
    relayer.start()
    await new Promise((r) => setTimeout(r, 30))
    await relayer.stop()
    const seen = polls
    await new Promise((r) => setTimeout(r, 30))
    expect(polls).toBe(seen) // no ticks after stop
    expect(seen).toBeGreaterThan(1)
  })

  it('start() is idempotent (a second call does not start a second loop)', async () => {
    let polls = 0
    const relayer = new Relayer(
      baseConfig({
        mode: 'observe',
        intervalMs: 5,
        source: {
          poll: async () => {
            polls += 1
            return []
          },
        },
      }),
    )
    relayer.start()
    relayer.start()
    await new Promise((r) => setTimeout(r, 30))
    await relayer.stop()
    // a single loop at 5ms over ~30ms yields far fewer than a doubled loop would
    expect(polls).toBeLessThan(12)
  })
})

describe('Relayer onTick', () => {
  it('reports every tick, including one that polled nothing', async () => {
    // An empty tick is the case that matters. Per-item logging says nothing when
    // a source returns nothing, so a dead loop and an empty board look the same.
    const onTick = vi.fn()
    const relayer = new Relayer(baseConfig({ source: { poll: async () => [] }, onTick }))
    await relayer.runOnce()
    expect(onTick).toHaveBeenCalledTimes(1)
    expect(onTick.mock.calls[0]![0]).toMatchObject({ polled: 0, recorded: 0 })
  })

  it('hands over the same report runOnce returns', async () => {
    const onTick = vi.fn()
    const relayer = new Relayer(baseConfig({ sink: { record: async () => {} }, onTick }))
    const report = await relayer.runOnce()
    expect(onTick.mock.calls[0]![0]).toEqual(report)
  })

  it('passes the tick context, so a hook can read the chain id', async () => {
    const onTick = vi.fn()
    const relayer = new Relayer(baseConfig({ onTick }))
    await relayer.runOnce()
    expect(onTick.mock.calls[0]![1].chain.id).toBe(pulsechainV4.id)
  })

  it('runs after the sink, so its counts describe work already done', async () => {
    const order: string[] = []
    const relayer = new Relayer(
      baseConfig({
        sink: { record: async () => { order.push('record') } },
        onTick: () => { order.push('tick') },
      }),
    )
    await relayer.runOnce()
    expect(order).toEqual(['record', 'tick'])
  })

  it('swallows an error from the hook rather than failing the tick', async () => {
    // Observability must never take down the loop it observes. A wedged Postgres
    // would otherwise stop the archiving that still works.
    const relayer = new Relayer(
      baseConfig({ onTick: () => { throw new Error('heartbeat table is gone') } }),
    )
    await expect(relayer.runOnce()).resolves.toMatchObject({ polled: 1 })
  })

  it('awaits an async hook before the tick returns', async () => {
    let settled = false
    const relayer = new Relayer(
      baseConfig({
        onTick: async () => {
          await new Promise((resolve) => setTimeout(resolve, 5))
          settled = true
        },
      }),
    )
    await relayer.runOnce()
    expect(settled).toBe(true)
  })

  it('does not report a tick whose source threw, so a stale heartbeat means broken', async () => {
    const onTick = vi.fn()
    const relayer = new Relayer(
      baseConfig({ source: { poll: async () => { throw new Error('node unreachable') } }, onTick }),
    )
    await expect(relayer.runOnce()).rejects.toThrow('node unreachable')
    expect(onTick).not.toHaveBeenCalled()
  })

  it('still records to the sink when the condition rejects every item', async () => {
    // The indexer sets `condition: () => false` to silence the observe-mode log
    // line. Archiving must be untouched by that, because recordItem runs first.
    const record = vi.fn(async () => {})
    const describe_ = vi.fn(() => 'x')
    const relayer = new Relayer(
      baseConfig({
        mode: 'observe',
        condition: () => false,
        sink: { record },
        action: { describe: describe_, execute: async () => ({ ok: true }) },
      }),
    )
    const report = await relayer.runOnce()
    expect(record).toHaveBeenCalledTimes(1)
    expect(report.recorded).toBe(1)
    expect(describe_).not.toHaveBeenCalled()
    expect(report.described).toBe(0)
  })
})
