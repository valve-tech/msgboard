import { describe, it, expect, vi } from 'vitest'

import {
  MIN_OVERLAP,
  checkConvergence,
  endpointsDiffer,
  snapshotBoard,
  type BoardSnapshot,
} from '../src/convergence.js'
import type { Fetcher } from '../src/check.js'
import { CONVERGENCE_GROUPS, groupFromEnv } from '../src/targets.js'

/** A board as `msgboard_content` returns it: category -> { hash: message }. */
const board = (hashes: string[]) =>
  new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: { '0x6c6f72656d': Object.fromEntries(hashes.map((h) => [h, { data: '0x00' }])) },
    }),
    { status: 200 },
  )

/** Serves a different board per endpoint. */
const fleet = (boards: Record<string, string[]>): Fetcher =>
  async (url) => {
    const hashes = boards[String(url)]
    if (!hashes) return new Response('nope', { status: 502 })
    return board(hashes)
  }

const now = () => Promise.resolve()

describe('snapshotBoard', () => {
  it('collects every message hash across every category', async () => {
    const fetcher: Fetcher = async () =>
      new Response(
        JSON.stringify({
          result: { catA: { '0xAA': {}, '0xBB': {} }, catB: { '0xCC': {} } },
        }),
        { status: 200 },
      )
    const s = await snapshotBoard(fetcher, 'http://a')
    expect([...s.hashes].sort()).toEqual(['0xaa', '0xbb', '0xcc'])
  })

  it('reads the array shape too, keying on each message hash', async () => {
    const fetcher: Fetcher = async () =>
      new Response(JSON.stringify({ result: { catA: [{ hash: '0xAA' }, { hash: '0xBB' }] } }), {
        status: 200,
      })
    const s = await snapshotBoard(fetcher, 'http://a')
    expect([...s.hashes].sort()).toEqual(['0xaa', '0xbb'])
  })

  it('reports a refused method as not-ok rather than as an empty board', async () => {
    // A node that does not serve msgboard and a node with nothing on its board are
    // completely different states. Collapsing them is how the original outage hid.
    const fetcher: Fetcher = async () =>
      new Response(JSON.stringify({ error: { code: -32601, message: 'Method not found' } }), {
        status: 200,
      })
    const s = await snapshotBoard(fetcher, 'http://a')
    expect(s.ok).toBe(false)
    expect(s.reason).toContain('Method not found')
  })

  it('reports an unreachable endpoint as not-ok, never as converged', async () => {
    const fetcher: Fetcher = async () => {
      throw new Error('ECONNREFUSED')
    }
    const s = await snapshotBoard(fetcher, 'http://a')
    expect(s.ok).toBe(false)
  })
})

describe('checkConvergence', () => {
  it('passes a pair that holds the same board', async () => {
    const r = await checkConvergence({
      fetcher: fleet({ 'http://a': ['0x1', '0x2', '0x3'], 'http://b': ['0x1', '0x2', '0x3'] }),
      endpoints: ['http://a', 'http://b'],
      sleep: now,
    })
    expect(r.verdict).toBe('converged')
    expect(r.overlap).toBe(1)
  })

  it('fails a pair that shares nothing — the real outage', async () => {
    // Measured on mainnet 2026-09-08: 33 messages against 0, not one hash in common,
    // for weeks, while both nodes reported healthy at the same head block.
    const r = await checkConvergence({
      fetcher: fleet({ 'http://a': ['0x1', '0x2', '0x3'], 'http://b': [] }),
      endpoints: ['http://a', 'http://b'],
      sleep: now,
    })
    expect(r.verdict).toBe('diverged')
    expect(r.shared).toBe(0)
    expect(r.report).toContain('not gossiping')
  })

  it('fails a pair carrying entirely different writers', async () => {
    // The 943 shape: each replica held only what was posted directly to it.
    const r = await checkConvergence({
      fetcher: fleet({ 'http://a': ['0x1', '0x2'], 'http://b': ['0x8', '0x9'] }),
      endpoints: ['http://a', 'http://b'],
      sleep: now,
    })
    expect(r.verdict).toBe('diverged')
    expect(r.overlap).toBe(0)
  })

  it('tolerates normal propagation lag rather than crying partition', async () => {
    // Messages expire after ~20 minutes and a fresh post has not propagated yet, so
    // healthy replicas never match exactly. Grading on equality would page nightly.
    const r = await checkConvergence({
      fetcher: fleet({
        'http://a': ['0x1', '0x2', '0x3', '0x4'],
        'http://b': ['0x1', '0x2', '0x3', '0x9'],
      }),
      endpoints: ['http://a', 'http://b'],
      sleep: now,
    })
    expect(r.verdict).toBe('converged')
    expect(r.overlap).toBeGreaterThan(MIN_OVERLAP)
  })

  it('clears a transient miss when a later sample overlaps', async () => {
    // One bad sample is not a partition. A pair that ever agrees is gossiping.
    let call = 0
    const fetcher: Fetcher = async (url) => {
      call += 1
      if (String(url) === 'http://b' && call <= 2) return board([])
      return board(['0x1', '0x2'])
    }
    const r = await checkConvergence({
      fetcher,
      endpoints: ['http://a', 'http://b'],
      sleep: now,
    })
    expect(r.verdict).toBe('converged')
  })

  it('keeps failing when every sample shows the same split', async () => {
    const sleep = vi.fn(async () => {})
    const r = await checkConvergence({
      fetcher: fleet({ 'http://a': ['0x1'], 'http://b': ['0x9'] }),
      endpoints: ['http://a', 'http://b'],
      samples: 3,
      sleep,
    })
    expect(r.verdict).toBe('diverged')
    expect(sleep).toHaveBeenCalledTimes(2)
  })

  it('calls two empty boards idle, not converged', async () => {
    // Nothing to disagree about is not evidence that gossip works. Saying
    // "converged" here would have graded the whole 18-day writer outage green.
    const r = await checkConvergence({
      fetcher: fleet({ 'http://a': [], 'http://b': [] }),
      endpoints: ['http://a', 'http://b'],
      sleep: now,
    })
    expect(r.verdict).toBe('idle')
  })

  it('cannot check when only one replica answers', async () => {
    // A one-sided read must never look like agreement.
    const r = await checkConvergence({
      fetcher: fleet({ 'http://a': ['0x1'] }),
      endpoints: ['http://a', 'http://b'],
      sleep: now,
    })
    expect(r.verdict).toBe('cannot-check')
    expect(r.report).toContain('CANNOT CHECK')
  })

  it('refuses a single endpoint instead of passing vacuously', async () => {
    const r = await checkConvergence({
      fetcher: fleet({ 'http://a': ['0x1'] }),
      endpoints: ['http://a'],
      sleep: now,
    })
    expect(r.verdict).toBe('cannot-check')
  })

  it('compares three replicas on what all three share', async () => {
    const r = await checkConvergence({
      fetcher: fleet({
        'http://a': ['0x1', '0x2'],
        'http://b': ['0x1', '0x2'],
        'http://c': ['0x9'],
      }),
      endpoints: ['http://a', 'http://b', 'http://c'],
      sleep: now,
    })
    expect(r.verdict).toBe('diverged')
    expect(r.shared).toBe(0)
  })
})

describe('endpointsDiffer', () => {
  it('rejects the same URL listed twice', () => {
    // A gateway pins each key to one upstream, so a duplicated URL compares a node
    // against itself and passes forever. That is the failure this check exists to
    // prevent, so it must not be possible to configure it into the check.
    expect(endpointsDiffer(['http://a', 'http://a'])).toBe(false)
    expect(endpointsDiffer(['http://a', 'HTTP://A '])).toBe(false)
  })

  it('accepts genuinely distinct endpoints', () => {
    expect(endpointsDiffer(['http://a', 'http://b'])).toBe(true)
  })
})

describe('groupFromEnv', () => {
  it('uses the shipped group when no override is set', () => {
    const g = groupFromEnv({ chain: '1', ours: 'http://ours', peers: ['http://p'] }, {})
    expect(g.ours).toBe('http://ours')
    expect(g.peers).toEqual(['http://p'])
  })

  it('replaces the group with per-replica URLs when the override is set', () => {
    // This is how the check gets pointed at OUR two replicas from inside the fleet.
    // From outside, the gateway pins every request to one of them and the stronger
    // check cannot be expressed at all.
    const g = groupFromEnv({ chain: '1', ours: 'http://ours', peers: ['http://p'] }, {
      CONVERGENCE_1: 'http://a, http://b ,http://c',
    })
    expect(g.ours).toBe('http://a')
    expect(g.peers).toEqual(['http://b', 'http://c'])
  })

  it('ignores an override that names fewer than two endpoints', () => {
    // One endpoint cannot be compared with anything. Silently checking a node against
    // itself is the failure mode this whole file exists to prevent.
    const g = groupFromEnv({ chain: '1', ours: 'http://ours', peers: ['http://p'] }, {
      CONVERGENCE_1: 'http://only',
    })
    expect(g.ours).toBe('http://ours')
  })

  it('drops duplicates in an override rather than comparing a node with itself', () => {
    const g = groupFromEnv({ chain: '1', ours: 'http://ours', peers: ['http://p'] }, {
      CONVERGENCE_1: 'http://a,http://a',
    })
    expect(g.ours).toBe('http://ours')
  })
})

describe('CONVERGENCE_GROUPS', () => {
  it('never lists our own endpoint among the peers it is compared against', () => {
    for (const g of CONVERGENCE_GROUPS) {
      expect(g.peers).not.toContain(g.ours)
      expect(endpointsDiffer([g.ours, ...g.peers])).toBe(true)
    }
  })

  it('gives every group at least one peer to compare with', () => {
    for (const g of CONVERGENCE_GROUPS) expect(g.peers.length).toBeGreaterThan(0)
  })
})

describe('checkConvergence — requireNonEmpty', () => {
  it('refuses to call two empty boards agreement', async () => {
    // Empty boards are identical, so a check that accepts them passes hardest exactly
    // when there is nothing to compare. Two replicas expiring to zero would read as
    // converged, and the 18-day window when every writer was dead would grade green.
    const r = await checkConvergence({
      fetcher: fleet({ 'http://a': [], 'http://b': [] }),
      endpoints: ['http://a', 'http://b'],
      requireNonEmpty: true,
      sleep: now,
    })
    expect(r.verdict).toBe('cannot-check')
    expect(r.report).toContain('agreement proves nothing')
  })

  it('still calls two empty boards idle when proof was not demanded', async () => {
    const r = await checkConvergence({
      fetcher: fleet({ 'http://a': [], 'http://b': [] }),
      endpoints: ['http://a', 'http://b'],
      sleep: now,
    })
    expect(r.verdict).toBe('idle')
  })

  it('passes a shared NON-empty board under requireNonEmpty', async () => {
    // The claim worth making after a fix: non-empty AND shared.
    const r = await checkConvergence({
      fetcher: fleet({ 'http://a': ['0x1', '0x2'], 'http://b': ['0x1', '0x2'] }),
      endpoints: ['http://a', 'http://b'],
      requireNonEmpty: true,
      sleep: now,
    })
    expect(r.verdict).toBe('converged')
    expect(r.shared).toBeGreaterThan(0)
  })

  it('keeps failing a real split under requireNonEmpty', async () => {
    const r = await checkConvergence({
      fetcher: fleet({ 'http://a': ['0x1'], 'http://b': ['0x9'] }),
      endpoints: ['http://a', 'http://b'],
      requireNonEmpty: true,
      sleep: now,
    })
    expect(r.verdict).toBe('diverged')
  })
})
