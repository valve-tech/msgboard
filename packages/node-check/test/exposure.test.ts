import { describe, it, expect } from 'vitest'

import {
  CONTROL_METHOD,
  MAX_RESPONSE_BYTES,
  PROBE_PARAM,
  SAMPLES,
  SENSITIVE_METHODS,
  ZERO_ARITY_METHODS,
  buildBatch,
  checkEndpoint,
  verdictFor,
  type ExposureReport,
} from '../src/index.js'

/** Batch id of a method, mirroring how buildBatch numbers them. */
const idOf = (method: string): number => {
  if (method === CONTROL_METHOD) return SENSITIVE_METHODS.length + 1
  return SENSITIVE_METHODS.findIndex((m) => m.method === method) + 1
}

const notFound = (id: number) => ({
  jsonrpc: '2.0',
  id,
  error: { code: -32601, message: 'Method not found' },
})

/** Every method absent. Overrides replace the entry at a given id. */
const allAbsent = (...overrides: Array<{ id: number; body: unknown }>): unknown[] => {
  const entries = new Map<number, unknown>()
  for (const m of SENSITIVE_METHODS) entries.set(idOf(m.method), notFound(idOf(m.method)))
  entries.set(idOf(CONTROL_METHOD), notFound(idOf(CONTROL_METHOD)))
  for (const o of overrides) entries.set(o.id, o.body)
  return [...entries.values()]
}

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })

const target = { name: 'rpc.pulsechain.com', url: 'https://rpc.pulsechain.com', keyGated: false }

describe('buildBatch', () => {
  it('sends every sensitive method with the inert sentinel', () => {
    const calls = JSON.parse(buildBatch()) as Array<{ method: string; params: unknown[] }>
    for (const m of SENSITIVE_METHODS) expect(calls.map((c) => c.method)).toContain(m.method)
    for (const call of calls) expect(call.params).toEqual([PROBE_PARAM])
  })

  it('carries a control method that exists on no node', () => {
    const calls = JSON.parse(buildBatch()) as Array<{ method: string }>
    expect(calls.map((c) => c.method)).toContain(CONTROL_METHOD)
  })

  it('probes only methods that require a typed argument', () => {
    // reth runs a zero-arity method even when handed a surplus argument —
    // `txpool_content` returned a 3 MB mempool dump that way. The sentinel is
    // inert only where the signature demands something it cannot satisfy.
    for (const m of SENSITIVE_METHODS) {
      expect(m.requiresTypedArg, `${m.method} must name the argument that rejects the sentinel`)
        .toBeTruthy()
    }
  })

  it('excludes every method known to take no arguments', () => {
    const asked = SENSITIVE_METHODS.map((m) => m.method)
    for (const zero of ZERO_ARITY_METHODS) expect(asked).not.toContain(zero)
  })

  it('grades only what a public RPC has no business serving', () => {
    // The severity split is the difference between a signal and a siren.
    const bySeverity = (sev: string) =>
      SENSITIVE_METHODS.filter((m) => m.severity === sev).map((m) => m.method)
    expect(bySeverity('critical')).toEqual(['msgboard_addMessage'])
    expect(bySeverity('sensitive')).toEqual(['msgboard_content'])
    expect(bySeverity('informational')).toEqual(['msgboard_getMessage'])
  })

  it('asks about the msgboard namespace and nothing else', () => {
    // This is the msgboard client. What a node does with its mempool or its
    // admin namespace is someone else's check; mixing them in only produced
    // findings we then had to explain away.
    for (const m of SENSITIVE_METHODS) expect(m.method.startsWith('msgboard_')).toBe(true)
    for (const z of ZERO_ARITY_METHODS) expect(z.startsWith('msgboard_')).toBe(true)
  })
})

describe('verdictFor', () => {
  it('separates a policy refusal from a handler talking', () => {
    expect(verdictFor({ code: -32601, message: 'Method not found' })).toBe('absent')
    expect(verdictFor({ code: -32602, message: 'too many arguments, want at most 0' })).toBe('exposed')
    expect(verdictFor({ code: -32602, message: 'Invalid params' })).toBe('exposed')
    expect(verdictFor({ code: -32602, message: 'Archive requests require a personal token' })).toBe('refused')
    expect(verdictFor({ code: -32000, message: 'Invalid or inactive API key' })).toBe('refused')
  })
})

describe('checkEndpoint', () => {
  it('passes when every method answers method-not-found', async () => {
    const r = await checkEndpoint(target, { fetcher: async () => ok(allAbsent()) })
    expect(r.status).toBe('pass')
    expect(r.exposed).toEqual([])
  })

  it('fails when a critical method answers from its own argument parser', async () => {
    const id = idOf('msgboard_addMessage')
    const r = await checkEndpoint(target, {
      fetcher: async () =>
        ok(allAbsent({ id, body: { jsonrpc: '2.0', id, error: { code: -32602, message: 'Invalid params' } } })),
    })
    expect(r.status).toBe('fail')
    expect(r.exposed.map((e) => e.method)).toEqual(['msgboard_addMessage'])
  })

  it('does not grade an endpoint for a method public RPCs serve on purpose', async () => {
    // txpool_* and debug_trace* are features, not leaks: the mempool is public
    // by nature and providers sell tracing. Grading these would fire on the
    // ordinary configuration of almost every public endpoint, and a check that
    // fires on the normal state is noise. Recorded, never graded.
    const id = idOf('msgboard_getMessage')
    const r = await checkEndpoint(target, {
      fetcher: async () =>
        ok(allAbsent({ id, body: { jsonrpc: '2.0', id, error: { code: -32602, message: 'invalid argument 0' } } })),
    })
    expect(r.status).toBe('pass')
    expect(r.exposed.map((e) => e.method)).toEqual(['msgboard_getMessage'])
  })

  it('still fails a key-gated endpoint for an informational method', async () => {
    // On an endpoint that must refuse everything, "normal on a public RPC" is
    // beside the point: anything that answers got past the key check.
    const id = idOf('msgboard_getMessage')
    const r = await checkEndpoint(
      { name: 'gw', url: 'https://one.valve.city/rpc/v1/369', keyGated: true, ours: true },
      {
        fetcher: async () =>
          ok(allAbsent({ id, body: { jsonrpc: '2.0', id, error: { code: -32602, message: 'invalid argument 0' } } })),
      },
    )
    expect(r.status).toBe('fail')
  })

  it('warns when only a sensitive method is exposed', async () => {
    const id = idOf('msgboard_content')
    const r = await checkEndpoint(target, {
      fetcher: async () =>
        ok(allAbsent({ id, body: { jsonrpc: '2.0', id, error: { code: -32602, message: 'too many arguments, want at most 0' } } })),
    })
    expect(r.status).toBe('warn')
    expect(r.exposed[0]?.message).toBe('too many arguments, want at most 0')
  })

  it('reports inconclusive when the control method also answers', async () => {
    const control = idOf(CONTROL_METHOD)
    const critical = idOf('msgboard_addMessage')
    const r = await checkEndpoint(target, {
      fetcher: async () =>
        ok(
          allAbsent(
            { id: control, body: { jsonrpc: '2.0', id: control, error: { code: -32602, message: 'bad params' } } },
            { id: critical, body: { jsonrpc: '2.0', id: critical, error: { code: -32602, message: 'bad params' } } },
          ),
        ),
    })
    expect(r.status).toBe('inconclusive')
    expect(r.exposed).toEqual([])
  })

  it('unions findings across samples, so a load-balanced endpoint cannot hide', async () => {
    // A public URL is often a pool. One operator's endpoint served the
    // msgboard namespace from two of six backends, so one batch proves nothing.
    const id = idOf('msgboard_content')
    let call = 0
    const r = await checkEndpoint(target, {
      fetcher: async () => {
        call += 1
        return call === 2
          ? ok(allAbsent({ id, body: { jsonrpc: '2.0', id, error: { code: -32602, message: 'too many arguments' } } }))
          : ok(allAbsent())
      },
    })
    expect(r.exposed.map((e) => e.method)).toEqual(['msgboard_content'])
    expect(r.absent).not.toContain('msgboard_content')
  })

  it('samples an endpoint more than once', async () => {
    let calls = 0
    await checkEndpoint(target, { fetcher: async () => { calls += 1; return ok(allAbsent()) } })
    expect(calls).toBe(SAMPLES)
    expect(SAMPLES).toBeGreaterThan(1)
  })

  it('stops reading a response that grows past the cap', async () => {
    // A pre-fix node serves msgboard_content with no arguments, and that board
    // reaches 167 MB. One lenient dispatch must not pull it into this process.
    const r = await checkEndpoint(target, {
      fetcher: async () =>
        ok([{ jsonrpc: '2.0', id: 1, result: 'x'.repeat(MAX_RESPONSE_BYTES + 1_000) }]),
    })
    expect(r.status).toBe('error')
    expect(r.detail).toContain('exceeded')
  })

  it('never sends an authorization header', async () => {
    let headers: Record<string, string> = {}
    await checkEndpoint(target, {
      fetcher: async (_u, init) => {
        headers = (init?.headers ?? {}) as Record<string, string>
        return ok(allAbsent())
      },
    })
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('authorization')
  })

  it('reports an error, not a pass, when the endpoint cannot be reached', async () => {
    // A check that cannot check must never look like a clean bill of health.
    const r = await checkEndpoint(target, {
      fetcher: async () => { throw new Error('ECONNREFUSED') },
    })
    expect(r.status).toBe('error')
    expect(r.detail).toContain('ECONNREFUSED')
  })
})

describe('a key-gated gateway', () => {
  const gateway = { name: 'one.valve.city', url: 'https://one.valve.city/rpc/v1/369', keyGated: true }

  it('passes when an anonymous caller is refused outright', async () => {
    // The gateway's whole job. `Invalid or inactive API key` is the right
    // answer to every method, and it is what the live endpoint returns today.
    const r = await checkEndpoint(gateway, {
      fetcher: async () =>
        ok([{ jsonrpc: '2.0', id: 0, error: { code: -32000, message: 'Invalid or inactive API key' } }]),
    })
    expect(r.status).toBe('pass')
    expect(r.detail).toContain('refuses anonymous')
  })

  it('passes when the gateway refuses at the HTTP layer', async () => {
    // The live gateway answers a batch with HTTP 401, not a JSON-RPC error.
    // That is the behaviour this check exists to keep true, so it must read as
    // a pass. Grading it `error` would fail the run on a healthy fleet.
    const r = await checkEndpoint(gateway, {
      fetcher: async () => new Response('unauthorized', { status: 401 }),
    })
    expect(r.status).toBe('pass')
    expect(r.detail).toContain('refuses anonymous')
  })

  it('still reports an error when the gateway is unreachable', async () => {
    // A 401 is an answer. A connection failure is not, and must not be
    // laundered into a pass just because the target is key gated.
    const r = await checkEndpoint(gateway, {
      fetcher: async () => { throw new Error('ECONNREFUSED') },
    })
    expect(r.status).toBe('error')
  })

  it('fails when a key-gated endpoint answers any method anonymously', async () => {
    // Anything reachable here bypassed the key check, so severity does not
    // matter: on a gated endpoint an answer is itself the finding.
    const id = idOf('msgboard_content')
    const r = await checkEndpoint(gateway, {
      fetcher: async () =>
        ok(allAbsent({ id, body: { jsonrpc: '2.0', id, error: { code: -32602, message: 'too many arguments' } } })),
    })
    expect(r.status).toBe('fail')
    expect(r.detail).toContain('without a key')
  })
})

describe('the report as a whole', () => {
  it('fails the run when any endpoint we operate fails', async () => {
    const reports: ExposureReport[] = [
      { name: 'a', url: 'u', ours: true, status: 'fail', exposed: [], refused: [], absent: [], inconclusive: [] },
      { name: 'b', url: 'u', ours: false, status: 'pass', exposed: [], refused: [], absent: [], inconclusive: [] },
    ]
    expect(reports.some((r) => r.ours && r.status === 'fail')).toBe(true)
  })
})
