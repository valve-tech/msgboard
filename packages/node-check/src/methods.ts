// Which RPC methods does a node answer to an anonymous caller?
//
// This check lives in the client repo on purpose. msgboard talks to both
// implementations and depends on neither, so it can point at a reth node or an
// erigon node and judge them by the same rule. A check that ships inside the
// thing it checks is not an external check.
//
// It exists because an audit found `msgboard_addMessage` — a write method —
// answering on 0.0.0.0:8545 behind a config line that read like a
// three-namespace restriction. Nothing was watching for it.

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

export type Severity = 'critical' | 'sensitive'

export interface SensitiveMethod {
  method: string
  severity: Severity
  /** The argument that makes PROBE_PARAM inert for this method. Every entry
   *  must name one, so the question is answered before a method joins. */
  requiresTypedArg: string
}

/**
 * Methods that take no arguments, and so cannot be probed safely.
 *
 * Measured on a live reth node: it accepted PROBE_PARAM as a surplus argument
 * to `txpool_content` and ran the method, returning a 3 MB mempool dump. A
 * strict server answers the same call "too many arguments, want at most 0". We
 * cannot choose which one we are talking to, so a zero-arity method is never
 * inert. Their namespaces are covered below by a sibling that takes a typed
 * argument.
 */
export const ZERO_ARITY_METHODS: readonly string[] = [
  'txpool_content',
  'admin_nodeInfo',
  'admin_peers',
  'personal_listAccounts',
]

/**
 * Methods an anonymous caller should never reach.
 *
 * `critical` writes, controls the node, or drives consensus. `sensitive` only
 * leaks information.
 *
 * Nothing appears here whose handler could act. `miner_start` and friends would
 * be real findings, but they take an argument a node might coerce, and no
 * monitoring check is worth a chance of starting a stranger's miner.
 */
export const SENSITIVE_METHODS: readonly SensitiveMethod[] = [
  { method: 'msgboard_addMessage', severity: 'critical', requiresTypedArg: 'the message, as a hex string' },
  { method: 'admin_addPeer', severity: 'critical', requiresTypedArg: 'an enode URL' },
  { method: 'debug_setHead', severity: 'critical', requiresTypedArg: 'a block number, as hex' },
  { method: 'engine_forkchoiceUpdatedV3', severity: 'critical', requiresTypedArg: 'a forkchoice state object' },
  {
    // Stands in for `personal_listAccounts`, which takes no arguments and would
    // have listed the node's accounts on a lenient server.
    method: 'personal_ecRecover',
    severity: 'critical',
    requiresTypedArg: 'a message and a signature, both hex',
  },
  {
    // Stands in for `txpool_content`. Same namespace, same evidence, and it
    // needs an address, so the sentinel cannot reach the handler.
    method: 'txpool_contentFrom',
    severity: 'sensitive',
    requiresTypedArg: 'an address',
  },
  { method: 'debug_traceTransaction', severity: 'sensitive', requiresTypedArg: 'a transaction hash' },
  { method: 'msgboard_content', severity: 'sensitive', requiresTypedArg: 'a content filter object' },
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
