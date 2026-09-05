// Which msgboard methods does a node answer to an anonymous caller?
//
// This check lives in the client repo on purpose. msgboard talks to both
// implementations and depends on neither, so it can point at a reth node or an
// erigon node and judge them by the same rule. A check that ships inside the
// thing it checks is not an external check.
//
// It exists because an audit found `msgboard_addMessage` — a write method —
// answering on 0.0.0.0:8545 behind a config line that read like a
// three-namespace restriction. Nothing was watching for it.
//
// The scope is the msgboard namespace and nothing else. An earlier version
// also asked about admin, debug, txpool, personal and engine, and warned on
// six of seven public endpoints for methods those operators serve on purpose.
// What a node does with its mempool is a different check in a different repo.

/**
 * The one argument every probed method receives.
 *
 * A bare, non-hex, non-numeric, non-object string satisfies no probed method's
 * signature, so a registered method rejects it while parsing arguments and
 * never reaches its handler. We learn the method exists without letting it do
 * anything.
 */
export const PROBE_PARAM = '0xprobe'

/** JSON-RPC's "method does not exist" code. The only answer that proves a
 *  method is not registered. */
export const METHOD_NOT_FOUND_CODE = -32601

/** JSON-RPC's "invalid params" code. A registered method answers with this
 *  when its own argument parser rejects PROBE_PARAM. */
export const INVALID_PARAMS_CODE = -32602

/**
 * What an argument parser's complaint looks like.
 *
 * This is the line between "the handler exists and refused my argument" and "a
 * gateway refused the method by name". Both come back as -32602 on real
 * endpoints. publicnode answers `debug_setHead` with "Archive requests require
 * a personal token", which never reached a handler, and `txpool_content` with
 * "too many arguments, want at most 0", which is a handler talking. Only a
 * message about parameters or arguments counts as the second.
 */
const ARGUMENT_REJECTION = /param|argument/i

export type MethodVerdict = 'absent' | 'exposed' | 'refused'

/**
 * Classify one JSON-RPC error into a verdict about the method behind it.
 *
 * A method that returns a result is exposed and never comes through here.
 */
export const verdictFor = (error: { code?: number; message?: string }): MethodVerdict => {
  if (error.code === METHOD_NOT_FOUND_CODE) return 'absent'
  if (error.code === INVALID_PARAMS_CODE && ARGUMENT_REJECTION.test(error.message ?? '')) {
    return 'exposed'
  }
  return 'refused'
}

/**
 * A method that exists on no node, sent alongside the real ones.
 *
 * Some endpoints answer every unknown method with a generic error rather than
 * -32601. Against one of those, "not method-not-found" stops meaning
 * "registered" and every real method reads as exposed. When the control
 * answers as anything but method-not-found, the endpoint cannot discriminate
 * and the check reports no verdict rather than a wrong one.
 */
export const CONTROL_METHOD = 'msgboard_nodeCheckControl'

/**
 * How much an exposed method costs us.
 *
 * `critical` writes, controls the node, or drives consensus. `sensitive` is
 * reachable-but-costly: it answers, and answering is a problem. `informational`
 * is a method public RPCs serve ON PURPOSE — the mempool is public by nature
 * and providers sell tracing — so it is recorded and never graded. Grading it
 * would fire on the ordinary configuration of almost every public endpoint,
 * and a check that fires on the normal state is noise.
 *
 * The distinction is dropped on a key-gated endpoint, where anything that
 * answers an anonymous caller got past the key check.
 */
export type Severity = 'critical' | 'sensitive' | 'informational'

export interface SensitiveMethod {
  method: string
  severity: Severity
  /** The argument that makes PROBE_PARAM inert for this method. Every entry
   *  must name one, so the question is answered before a method joins. */
  requiresTypedArg: string
}

/**
 * msgboard methods that take no arguments, and so cannot be probed safely.
 *
 * Measured on a live reth node: it accepted PROBE_PARAM as a surplus argument
 * to a zero-arity method and ran it anyway, returning a 3 MB response. A strict
 * server answers the same call "too many arguments, want at most 0". We cannot
 * choose which one we are talking to, so a zero-arity method is never inert.
 *
 * Both of these are harmless to call deliberately — `msgboard_status` returns a
 * small configuration object — but this file's job is to ask whether a method
 * is REGISTERED without running it, and for these two that is not possible.
 */
export const ZERO_ARITY_METHODS: readonly string[] = [
  'msgboard_status',
  'msgboard_categories',
]

/**
 * The methods this check asks about. See Severity for which ones grade.
 *
 * Nothing appears here whose handler could act. `miner_start` and friends would
 * be real findings, but they take an argument a node might coerce, and no
 * monitoring check is worth a chance of starting a stranger's miner.
 */
export const SENSITIVE_METHODS: readonly SensitiveMethod[] = [
  {
    // A write. The finding that started all of this: it answered on a port
    // whose config line read like a three-namespace restriction.
    method: 'msgboard_addMessage',
    severity: 'critical',
    requiresTypedArg: 'the message, as hex bytes',
  },
  {
    // Graded, because it returns the WHOLE board with no limit or offset on
    // every deployed build we have measured. Answering it at all hands the
    // caller an unbounded response the node pays for: 167 MB and 10.9 s on a
    // full board.
    method: 'msgboard_content',
    severity: 'sensitive',
    requiresTypedArg: 'a content filter object',
  },
  {
    // Not graded. A single message by hash is a bounded read and the reason
    // the namespace exists — a node serving it is working as intended.
    method: 'msgboard_getMessage',
    severity: 'informational',
    requiresTypedArg: 'a message hash',
  },
]

/** Batch ids run 1..N over SENSITIVE_METHODS, with the control last. */
export const CONTROL_ID = SENSITIVE_METHODS.length + 1

export const methodForId = (id: number): string | null => {
  if (id === CONTROL_ID) return CONTROL_METHOD
  return SENSITIVE_METHODS[id - 1]?.method ?? null
}

export const buildBatch = (): string =>
  JSON.stringify([
    ...SENSITIVE_METHODS.map((m, i) => ({
      jsonrpc: '2.0' as const,
      id: i + 1,
      method: m.method,
      params: [PROBE_PARAM],
    })),
    { jsonrpc: '2.0' as const, id: CONTROL_ID, method: CONTROL_METHOD, params: [PROBE_PARAM] },
  ])
