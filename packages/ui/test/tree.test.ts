import { describe, expect, it } from 'vitest'
import type { Message } from '@msgboard/sdk'
import { formatBlocksRemaining, kvSeparator, toTree } from '../src/lib/tree'

const msg = (over: Partial<Message> = {}): Message => ({
  version: 0,
  blockHash: '0xabc',
  category: '0xcat',
  data: '0xdeadbeef',
  nonce: 7n,
  workMultiplier: 1n,
  workDivisor: 1n,
  blockNumber: 100n,
  hash: '0xhash',
  ...over,
})

describe('formatBlocksRemaining', () => {
  it('reports expired at or below zero', () => {
    expect(formatBlocksRemaining(0n)).toBe('expired')
    expect(formatBlocksRemaining(-5n)).toBe('expired')
  })
  it('formats minutes + seconds', () => {
    // 10 blocks * 10s = 100s => 1m 40s
    expect(formatBlocksRemaining(10n)).toBe('~1m 40s')
  })
  it('formats seconds only', () => {
    expect(formatBlocksRemaining(3n)).toBe('~30s')
  })
})

describe('toTree', () => {
  it('builds category groups with leaf rows (stats + fields)', () => {
    const tree = toTree({ list: [msg()], globalFactors: { workMultiplier: 1n, workDivisor: 1n } })
    expect(tree.isRoot).toBe(true)
    expect(tree.children).toHaveLength(1)
    const group = tree.children[0]
    expect(group.label).toBe('0xcat')
    expect(group.isRoot).toBe(true)
    expect(group.children).toHaveLength(1)
    const leaf = group.children[0]
    expect(leaf.label).toBe('0xhash')
    const labels = leaf.children.map((c) => c.label)
    // first row is the stats row
    expect(labels[0].startsWith(`stats${kvSeparator}`)).toBe(true)
    // then blockHash / blockNumber / nonce / data rows
    expect(labels).toContain(`blockHash${kvSeparator}0xabc`)
    expect(labels).toContain(`blockNumber${kvSeparator}100`)
    expect(labels).toContain(`nonce${kvSeparator}7`)
    expect(labels).toContain(`data${kvSeparator}0xdeadbeef`)
  })

  it('groups multiple messages under the same category', () => {
    const tree = toTree({
      list: [msg({ hash: '0xa' }), msg({ hash: '0xb' })],
    })
    expect(tree.children).toHaveLength(1)
    expect(tree.children[0].children.map((c) => c.label)).toEqual(['0xa', '0xb'])
  })

  it('adds an expiry meta when latestBlockNumber is supplied', () => {
    const tree = toTree({ list: [msg({ blockNumber: 100n })], latestBlockNumber: 110n })
    const leaf = tree.children[0].children[0]
    // BLOCK_RANGE_LIMIT(120) - (110 - 100) = 110 blocks remaining => non-empty estimate
    expect(leaf.meta).toBeTruthy()
    expect(leaf.meta).not.toBe('expired')
  })

  it('omits meta when latestBlockNumber is absent', () => {
    const tree = toTree({ list: [msg()] })
    expect(tree.children[0].children[0].meta).toBeUndefined()
  })
})
