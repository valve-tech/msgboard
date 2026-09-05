import {
  CONTROL_METHOD,
  METHOD_NOT_FOUND_CODE,
  SENSITIVE_METHODS,
  buildBatch,
  methodForId,
  verdictFor,
  type Severity,
} from './methods.js'

export interface Target {
  /** Label for the report. */
  name: string
  /** Full JSON-RPC URL, including any path. The valve gateway serves
   *  `/rpc/v1/<chainId>`, not the site root. */
  url: string
  /** True when the endpoint demands an API key. Its correct answer to an
   *  anonymous caller is to refuse everything, so ANY method that answers is a
   *  finding regardless of severity — something bypassed the key check. */
  keyGated: boolean
  /** True for endpoints we operate. Only these fail the run. */
  ours?: boolean
}

export interface Finding {
  method: string
  severity: Severity
  code: number | null
  message: string | null
}

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'inconclusive' | 'error'

export interface ExposureReport {
  name: string
  url: string
  ours: boolean
  status: CheckStatus
  exposed: Finding[]
  refused: Finding[]
  absent: string[]
  inconclusive: string[]
  detail?: string
}

/**
 * How many times to ask one endpoint.
 *
 * A public URL is often a pool, not a node. One operator's endpoint answered
 * for the msgboard namespace from only two of six backends we sampled by hand.
 * A single batch against a pool can therefore hit a clean backend and report
 * the whole endpoint clean. Sampling narrows that blind spot; it does not close
 * it, so a finding here is worth more than a clean result from it.
 */
export const SAMPLES = 3

/**
 * The most this check will read from one endpoint.
 *
 * Every probed method names a typed argument the sentinel cannot satisfy, and
 * that is the defence. This is the backstop, because the defence assumes every
 * server rejects an argument it cannot use, and reth does not. A node on the
 * pre-fix build serves `msgboard_content` with no arguments and that board
 * reaches 167 MB. A normal answer here is about a kilobyte.
 */
export const MAX_RESPONSE_BYTES = 256 * 1024

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>

export interface CheckDeps {
  fetcher: Fetcher
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 8_000

/** Read the body, giving up past `max` bytes. Returns null at the cap, having
 *  cancelled the rest — the point is to stop transferring, not to download it
 *  and then complain about the size. */
const readBounded = async (response: Response, max: number): Promise<string | null> => {
  const body = response.body
  if (!body) {
    const text = await response.text()
    return Buffer.byteLength(text) > max ? null : text
  }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > max) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8')
}

interface Sample {
  /** Null when the endpoint could not be read at all. */
  byMethod: Map<string, { code?: number; message?: string; isResult: boolean }> | null
  error?: string
  /** The endpoint refused the whole request at the HTTP layer. That is an
   *  ANSWER, not a failure to check: it says an anonymous caller reaches
   *  nothing. Kept separate from `error` so a healthy gateway does not read as
   *  a broken probe. */
  httpRefusal?: boolean
}

const takeSample = async (target: Target, deps: CheckDeps): Promise<Sample> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  try {
    // No Authorization header, on purpose and on every target. The question is
    // what an ANONYMOUS caller reaches; authenticating answers a different one.
    const response = await deps.fetcher(target.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: buildBatch(),
      signal: controller.signal,
    })

    if (response.status === 401 || response.status === 403) {
      return { byMethod: null, httpRefusal: true }
    }
    if (!response.ok) return { byMethod: null, error: `http ${response.status}` }

    const raw = await readBounded(response, MAX_RESPONSE_BYTES)
    if (raw === null) {
      return {
        byMethod: null,
        error: `response exceeded ${MAX_RESPONSE_BYTES} bytes — a probed method ran and returned an unbounded result`,
      }
    }

    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return { byMethod: null, error: 'expected a JSON-RPC batch array' }

    const byMethod = new Map<string, { code?: number; message?: string; isResult: boolean }>()
    for (const entry of parsed as Array<{ id?: unknown; error?: { code?: number; message?: string } }>) {
      if (typeof entry.id !== 'number') continue
      const method = methodForId(entry.id)
      if (!method) continue
      byMethod.set(method, {
        code: entry.error?.code,
        message: entry.error?.message,
        isResult: entry.error === undefined,
      })
    }
    return { byMethod }
  } catch (err) {
    return { byMethod: null, error: err instanceof Error ? err.message : String(err) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Ask one endpoint, several times, which sensitive methods it answers.
 *
 * A check that cannot check never reports `pass`. Every unreachable, oversized
 * or unparseable answer becomes `error`, because the failure this guards
 * against is a probe that stays green while it has stopped looking.
 */
export const checkEndpoint = async (target: Target, deps: CheckDeps): Promise<ExposureReport> => {
  const base = {
    name: target.name,
    url: target.url,
    ours: target.ours ?? false,
    exposed: [] as Finding[],
    refused: [] as Finding[],
    absent: [] as string[],
    inconclusive: [] as string[],
  }

  const samples: Sample[] = []
  for (let i = 0; i < SAMPLES; i += 1) samples.push(await takeSample(target, deps))

  // An endpoint that turns an anonymous caller away at the HTTP layer has
  // answered the question this check asks. The live valve gateway does exactly
  // this: it returns 401 to an unkeyed batch. Grading that `error` would fail
  // the run on a healthy fleet, which is how a useful check gets switched off.
  if (samples.length > 0 && samples.every((s) => s.httpRefusal)) {
    return { ...base, status: 'pass', detail: 'refuses anonymous callers' }
  }

  const usable = samples.filter((s) => s.byMethod !== null)
  if (usable.length === 0) {
    return { ...base, status: 'error', detail: samples[0]?.error ?? 'no answer' }
  }

  const exposed = new Map<string, Finding>()
  const refused = new Map<string, Finding>()
  const absentCount = new Map<string, number>()
  let discriminated = 0

  for (const sample of usable) {
    const byMethod = sample.byMethod!
    const control = byMethod.get(CONTROL_METHOD)
    if (control?.code !== METHOD_NOT_FOUND_CODE) continue
    discriminated += 1

    for (const { method, severity } of SENSITIVE_METHODS) {
      const entry = byMethod.get(method)
      if (!entry) continue
      if (entry.isResult) {
        // A result means the handler ran. Nothing to interpret.
        if (!exposed.has(method)) exposed.set(method, { method, severity, code: null, message: null })
        continue
      }
      const finding: Finding = {
        method,
        severity,
        code: entry.code ?? null,
        message: entry.message ?? null,
      }
      switch (verdictFor(entry)) {
        case 'absent':
          absentCount.set(method, (absentCount.get(method) ?? 0) + 1)
          break
        case 'exposed':
          if (!exposed.has(method)) exposed.set(method, finding)
          break
        case 'refused':
          if (!refused.has(method)) refused.set(method, finding)
          break
      }
    }
  }
  for (const method of exposed.keys()) refused.delete(method)

  const exposedList = [...exposed.values()]

  // A gated endpoint's correct answer to an anonymous caller is to refuse
  // everything, so severity is beside the point: anything reachable here got
  // past the key check.
  if (target.keyGated) {
    if (exposedList.length > 0) {
      return {
        ...base,
        exposed: exposedList,
        status: 'fail',
        detail: `${exposedList.map((e) => e.method).join(', ')} answered without a key`,
      }
    }
    return { ...base, status: 'pass', detail: 'refuses anonymous callers' }
  }

  if (discriminated === 0) {
    return {
      ...base,
      status: 'inconclusive',
      inconclusive: SENSITIVE_METHODS.map((m) => m.method),
      detail: 'the endpoint does not distinguish unknown methods',
    }
  }

  const absent: string[] = []
  const inconclusive: string[] = []
  for (const { method } of SENSITIVE_METHODS) {
    if (exposed.has(method) || refused.has(method)) continue
    if (absentCount.get(method) === discriminated) absent.push(method)
    else inconclusive.push(method)
  }

  const refusedList = [...refused.values()]
  const status: CheckStatus = exposedList.some((e) => e.severity === 'critical')
    ? 'fail'
    : exposedList.length > 0
      ? 'warn'
      : 'pass'
  const detail =
    exposedList.length > 0
      ? `${exposedList.map((e) => e.method).join(', ')} reachable unauthenticated`
      : refusedList.length > 0
        ? `refused rather than absent: ${refusedList.map((e) => e.method).join(', ')}`
        : undefined

  return {
    ...base,
    status,
    exposed: exposedList,
    refused: refusedList,
    absent,
    inconclusive,
    ...(detail ? { detail } : {}),
  }
}
