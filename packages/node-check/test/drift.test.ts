import { describe, it, expect } from 'vitest'

import {
  DriftExit,
  UPSTREAM_PIN,
  checkDrift,
  parseLsTree,
  planQueries,
  validatePin,
  type UpstreamPin,
} from '../src/index.js'

const pin: UpstreamPin = {
  remote: 'https://gitlab.com/pulsechaincom/erigon.git',
  branch: 'pulse-v3.4.4',
  commit: '78fbcffb8b23fee20deff3e6c5641f23865f98ff',
  reviewed: '2026-09-04',
  watched: {
    msgboard: { type: 'tree', oid: 'aaa' },
    'msgboard/message_index.go': { type: 'blob', oid: 'bbb' },
    'rpc/jsonrpc/msgboard_api.go': { type: 'blob', oid: 'ccc' },
  },
}

/** What upstream currently holds, as the fetch would report it. */
const upstream = (over: Record<string, string> = {}) => ({
  commit: pin.commit,
  objects: { msgboard: 'aaa', 'msgboard/message_index.go': 'bbb', 'rpc/jsonrpc/msgboard_api.go': 'ccc', ...over },
})

describe('planQueries', () => {
  it('asks about each directory on its own', () => {
    // `git ls-tree` given a directory pathspec AND a file inside it expands the
    // directory into its children and never emits the tree row. The first real
    // run of the original check hit exactly this and reported the watched
    // `msgboard` tree as deleted upstream. Unit tests alone would not have
    // caught it, so the shape is pinned here.
    const groups = planQueries(pin.watched)
    expect(groups).toEqual([
      ['msgboard'],
      ['msgboard/message_index.go', 'rpc/jsonrpc/msgboard_api.go'],
    ])
  })

  it('emits no group for a pin that watches nothing', () => {
    expect(planQueries({})).toEqual([])
  })
})

describe('parseLsTree', () => {
  it('reads mode, type, oid and path into a map', () => {
    const listing = [
      '040000 tree 4f47bf0ecfeddc3117e5026ec1af2fda04c1ee69\tmsgboard',
      '100644 blob 3b7b812834d9a0d770a8825be03faf5d39c8a8cb\tmsgboard/message_index.go',
      '',
    ].join('\n')
    expect(parseLsTree(listing)).toEqual({
      msgboard: '4f47bf0ecfeddc3117e5026ec1af2fda04c1ee69',
      'msgboard/message_index.go': '3b7b812834d9a0d770a8825be03faf5d39c8a8cb',
    })
  })
})

describe('validatePin', () => {
  it('rejects a pin that watches nothing, rather than passing vacuously', () => {
    // A check with nothing to compare reports success forever. That is the
    // exact failure this whole file exists to prevent.
    expect(validatePin({ ...pin, watched: {} })).toMatch(/watch/i)
  })

  it('rejects a pin with no commit', () => {
    expect(validatePin({ ...pin, commit: '' })).toBeTruthy()
  })

  it('accepts the pin we ship', () => {
    expect(validatePin(UPSTREAM_PIN)).toBeNull()
  })
})

describe('checkDrift', () => {
  it('reports ok when the branch and every watched path match', async () => {
    const r = await checkDrift(pin, async () => upstream())
    expect(r.exit).toBe(DriftExit.Ok)
  })

  it('names which watched path changed, not merely that something moved', async () => {
    const r = await checkDrift(pin, async () => ({
      commit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      objects: { ...upstream().objects, 'msgboard/message_index.go': 'CHANGED' },
    }))
    expect(r.exit).toBe(DriftExit.Drift)
    expect(r.changed).toEqual(['msgboard/message_index.go'])
    expect(r.report).toContain('msgboard/message_index.go')
  })

  it('treats a watched path that vanished upstream as its own failure', async () => {
    const objects = { ...upstream().objects }
    delete (objects as Record<string, string>)['msgboard/message_index.go']
    const r = await checkDrift(pin, async () => ({ commit: pin.commit, objects }))
    expect(r.exit).toBe(DriftExit.PathVanished)
    expect(r.report).toContain('msgboard/message_index.go')
  })

  it('fails loudly when upstream cannot be reached', async () => {
    // The whole point. A check that cannot check must never look like a clean
    // bill of health, or the blindness it was built to remove comes back
    // silently.
    const r = await checkDrift(pin, async () => { throw new Error('could not read from remote') })
    expect(r.exit).toBe(DriftExit.CannotCheck)
    expect(r.report).toContain('CANNOT CHECK')
  })

  it('fails loudly when the branch itself is gone', async () => {
    const r = await checkDrift(pin, async () => { throw new Error("couldn't find remote ref pulse-v3.4.4") })
    expect(r.exit).toBe(DriftExit.CannotCheck)
  })

  it('refuses to run against a pin that watches nothing', async () => {
    let called = false
    const r = await checkDrift({ ...pin, watched: {} }, async () => { called = true; return upstream() })
    expect(r.exit).toBe(DriftExit.PinInvalid)
    expect(called, 'must not even ask upstream with an invalid pin').toBe(false)
  })

  it('reports drift even when the commit is unchanged but an object is not', async () => {
    // A force push can leave the branch tip alone and still change content.
    const r = await checkDrift(pin, async () => upstream({ msgboard: 'MOVED' }))
    expect(r.exit).toBe(DriftExit.Drift)
    expect(r.changed).toEqual(['msgboard'])
  })

  it('never returns ok on any non-zero exit', async () => {
    for (const fetcher of [
      async () => { throw new Error('boom') },
      async () => upstream({ msgboard: 'MOVED' }),
    ]) {
      const r = await checkDrift(pin, fetcher)
      expect(r.exit).not.toBe(DriftExit.Ok)
    }
  })
})
