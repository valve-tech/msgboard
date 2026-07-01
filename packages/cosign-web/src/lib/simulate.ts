import {
  type Hex,
  encodeFunctionData,
  decodeFunctionData,
  formatUnits,
  getAddress,
  isAddressEqual,
  keccak256,
  pad,
  toHex,
  slice,
  size,
} from 'viem'
import type { SafeTx } from '@msgboard/cosign'
import { EXEC_TRANSACTION_ABI } from './safe-typed-data'
import { chainMeta, simRpcUrl } from './config'

/**
 * ── Transaction simulation ("What this does") ─────────────────────────────────────────────────
 *
 * We simulate the Safe's `execTransaction(...)` on the SAFE'S chain via `eth_simulateV1` with a
 * `stateOverride` that lets it execute WITHOUT collecting real signatures, then decode asset changes,
 * the top-level call, and revert status. Fallbacks: `debug_traceCall` → `trace_call` → calldata-only.
 *
 * THE OVERRIDE (why it always executes):
 *   Safe storage layout (v1.3.0 / v1.4.1): slot 4 = `threshold`, slot 2 = `owners` (a linked-list
 *   mapping address→address). We:
 *     1. set `threshold` (slot 4) → 1, so a single signature satisfies the quorum;
 *     2. mark the connected wallet an owner by writing `owners[wallet] = SENTINEL(0x1)` at
 *        keccak256(pad(wallet) ‖ pad(2)), so `checkNSignatures` accepts it as a member;
 *     3. fund the Safe (balance override) so native value transfers don't fail for lack of gas/value;
 *   then call `execTransaction` FROM the wallet with an approved-hash stub signature
 *     `{ r = pad(wallet) }{ s = 0 }{ v = 1 }`.
 *   For `v == 1`, Safe's `checkNSignatures` passes when `msg.sender == currentOwner` (the approved-hash
 *   branch) — which holds because `from` IS the wallet/owner — so no real signature or stored approval
 *   is needed and the Safe's own nonce is used (our SafeTx.nonce is irrelevant to execution).
 */

const SAFE_THRESHOLD_SLOT = toHex(4n, { size: 32 })
const SAFE_OWNERS_MAPPING_SLOT = 2n
const SENTINEL_NONZERO = pad('0x01', { size: 32 })
const BIG_BALANCE = toHex(2n ** 128n) // plenty to cover any native `value`
const TRANSFER_TOPIC = keccak256(new TextEncoder().encode('Transfer(address,address,uint256)'))

/** The mapping slot for `owners[owner]` in a Safe (mapping at storage slot 2). */
function ownersMappingSlot(owner: Hex): Hex {
  return keccak256(`0x${pad(owner, { size: 32 }).slice(2)}${pad(toHex(SAFE_OWNERS_MAPPING_SLOT), { size: 32 }).slice(2)}` as Hex)
}

/** The approved-hash stub signature blob (one word): r = padded owner, s = 0, v = 1. */
function approvedHashStub(owner: Hex): Hex {
  return `0x${pad(owner, { size: 32 }).slice(2)}${'00'.repeat(32)}01` as Hex
}

export interface AssetChange {
  /** Token contract, or `null` for the chain's native asset. */
  token: Hex | null
  symbol: string
  /** Net signed amount for `address` (positive = received, negative = sent), as a decimal string. */
  amount: string
  raw: bigint
  address: Hex
}

export type SimSource = 'eth_simulateV1' | 'debug_traceCall' | 'trace_call' | 'calldata'

export interface SimResult {
  ok: boolean
  reverted: boolean
  revertReason?: string
  /** One plain-language sentence describing the dominant effect. */
  summary: string
  /** Net asset deltas per (address, token). */
  changes: AssetChange[]
  /** Best-effort decode of the top-level call. */
  call: { to: Hex; selector: Hex; label: string }
  /** Which engine produced this result (for the "raw trace" affordance). */
  source: SimSource
  /** Pretty-printed raw response for the expandable panel. */
  raw: unknown
}

async function rpc(chainId: number, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(simRpcUrl(chainId), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const json = (await res.json()) as { result?: unknown; error?: { message?: string; code?: number } }
  if (json.error) throw Object.assign(new Error(json.error.message ?? method), { code: json.error.code })
  return json.result
}

/** Decodes the top-level call (`to` + selector, best-effort human label for common ERC-20 methods). */
function decodeTopCall(safe: SafeTx, symbol: string): SimResult['call'] {
  const to = getAddress(safe.to)
  const data = (safe.data ?? '0x') as Hex
  const hasData = size(data) >= 4
  const selector = (hasData ? slice(data, 0, 4) : '0x') as Hex
  const nativeStr = formatUnits(safe.value, 18)

  if (!hasData) {
    return { to, selector, label: safe.value > 0n ? `Send ${nativeStr} ${symbol} to ${to}` : `Empty call to ${to}` }
  }
  // Best-effort ERC-20 transfer / approve decode for the plain-language line.
  const ERC20 = [
    { type: 'function', name: 'transfer', inputs: [{ name: 'to', type: 'address' }, { name: 'v', type: 'uint256' }] },
    { type: 'function', name: 'approve', inputs: [{ name: 's', type: 'address' }, { name: 'v', type: 'uint256' }] },
  ] as const
  try {
    const d = decodeFunctionData({ abi: ERC20, data })
    if (d.functionName === 'transfer') return { to, selector, label: `ERC-20 transfer on ${to}` }
    if (d.functionName === 'approve') return { to, selector, label: `ERC-20 approve on ${to}` }
  } catch {
    /* not an ERC-20 method — fall through to selector */
  }
  return { to, selector, label: `Call ${selector} on ${to}` }
}

/** Folds Transfer logs (native + ERC-20) into net per-address deltas. */
function foldTransferLogs(
  logs: { address?: Hex; topics?: Hex[]; data?: Hex }[],
  symbol: string,
): AssetChange[] {
  // key = `${address}|${token ?? 'native'}` → net bigint
  const net = new Map<string, { address: Hex; token: Hex | null; raw: bigint }>()
  const bump = (address: Hex, token: Hex | null, delta: bigint) => {
    const key = `${address.toLowerCase()}|${token?.toLowerCase() ?? 'native'}`
    const cur = net.get(key) ?? { address: getAddress(address), token, raw: 0n }
    cur.raw += delta
    net.set(key, cur)
  }
  for (const log of logs) {
    if (!log.topics || log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC.toLowerCase()) continue
    if (log.topics.length < 3 || !log.data) continue
    const from = getAddress(`0x${log.topics[1].slice(-40)}`)
    const to = getAddress(`0x${log.topics[2].slice(-40)}`)
    const amount = BigInt(log.data)
    // eth_simulateV1 traceTransfers emits native moves as a Transfer log whose emitting address is the
    // ERC-7528 native placeholder (0xEeee…EEeE — what this reth node uses) or, on some nodes, the zero
    // address. Anything else is a real ERC-20 contract.
    const addr = (log.address ?? '0x0000000000000000000000000000000000000000').toLowerCase()
    const isNative = /^0x0+$/.test(addr) || addr === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
    const token = isNative ? null : getAddress(addr as Hex)
    bump(from, token, -amount)
    bump(to, token, amount)
  }
  return [...net.values()]
    .filter((c) => c.raw !== 0n)
    .map((c) => ({
      token: c.token,
      symbol: c.token ? 'tokens' : symbol,
      raw: c.raw,
      amount: `${c.raw < 0n ? '-' : '+'}${formatUnits(c.raw < 0n ? -c.raw : c.raw, 18)}`,
      address: c.address,
    }))
}

function plainSummary(changes: AssetChange[], call: SimResult['call'], reverted: boolean): string {
  if (reverted) return 'This transaction REVERTS — do not sign it.'
  const outs = changes.filter((c) => c.raw < 0n)
  if (outs.length > 0) {
    const primary = outs.reduce((a, b) => (b.raw < a.raw ? b : a))
    const recipient = changes.find((c) => c.raw > 0n && (c.token?.toLowerCase() ?? 'native') === (primary.token?.toLowerCase() ?? 'native'))
    const amt = formatUnits(-primary.raw, 18)
    const dest = recipient ? ` to ${recipient.address}` : ''
    const more = changes.length > 2 ? ` (+${changes.length - 2} more asset changes)` : ''
    return `Sends ${amt} ${primary.symbol}${dest}${more}`
  }
  return `${call.label} — no asset changes detected`
}

/** Builds the `execTransaction` calldata + state overrides for the simulation. */
function buildSimCall(wallet: Hex, tx: SafeTx) {
  const data = encodeFunctionData({
    abi: EXEC_TRANSACTION_ABI,
    functionName: 'execTransaction',
    args: [
      tx.to,
      tx.value,
      tx.data,
      tx.operation,
      tx.safeTxGas,
      tx.baseGas,
      tx.gasPrice,
      tx.gasToken,
      tx.refundReceiver,
      approvedHashStub(wallet),
    ],
  })
  const stateDiff: Record<Hex, Hex> = {
    [SAFE_THRESHOLD_SLOT]: pad('0x01', { size: 32 }),
    [ownersMappingSlot(wallet)]: SENTINEL_NONZERO,
  }
  return { data, stateDiff }
}

/**
 * Simulate a SafeTx on its own chain and return a decoded "what this does" result. Never throws:
 * on total failure it returns a calldata-only `SimResult` with `ok: false`.
 */
export async function simulateSafeTx(
  chainId: number,
  safe: Hex,
  wallet: Hex,
  tx: SafeTx,
): Promise<SimResult> {
  const symbol = chainMeta(chainId).symbol
  const call = decodeTopCall(tx, symbol)
  const { data, stateDiff } = buildSimCall(wallet, tx)
  const from = getAddress(wallet)

  // ── Attempt 1: eth_simulateV1 (asset changes via traceTransfers) ──────────────────────────────
  try {
    const result = (await rpc(chainId, 'eth_simulateV1', [
      {
        blockStateCalls: [
          {
            stateOverrides: { [getAddress(safe)]: { balance: BIG_BALANCE, stateDiff } },
            calls: [{ from, to: getAddress(safe), data, value: '0x0' }],
          },
        ],
        traceTransfers: true,
        validation: false,
        returnFullTransactions: false,
      },
      'latest',
    ])) as { calls?: { status?: Hex; returnData?: Hex; logs?: unknown[]; error?: { message?: string } }[] }[]
    const c = result?.[0]?.calls?.[0]
    if (c) {
      const reverted = c.status !== undefined && BigInt(c.status) === 0n
      const changes = foldTransferLogs((c.logs as never) ?? [], symbol)
      return {
        ok: !reverted,
        reverted,
        revertReason: c.error?.message,
        summary: plainSummary(changes, call, reverted),
        changes,
        call,
        source: 'eth_simulateV1',
        raw: result,
      }
    }
  } catch {
    /* fall through */
  }

  // ── Attempt 2: debug_traceCall (callTracer) ───────────────────────────────────────────────────
  try {
    const trace = (await rpc(chainId, 'debug_traceCall', [
      { from, to: getAddress(safe), data, value: '0x0' },
      'latest',
      { tracer: 'callTracer', stateOverrides: { [getAddress(safe)]: { balance: BIG_BALANCE, stateDiff } } },
    ])) as { error?: string; revertReason?: string; calls?: unknown[] }
    const reverted = !!trace.error
    return {
      ok: !reverted,
      reverted,
      revertReason: trace.revertReason ?? trace.error,
      summary: reverted ? 'This transaction REVERTS — do not sign it.' : `${call.label} — simulated via call trace`,
      changes: [],
      call,
      source: 'debug_traceCall',
      raw: trace,
    }
  } catch {
    /* fall through */
  }

  // ── Attempt 3: trace_call (parity) ────────────────────────────────────────────────────────────
  try {
    const trace = await rpc(chainId, 'trace_call', [
      { from, to: getAddress(safe), data, value: '0x0' },
      ['trace'],
      'latest',
    ])
    const t = trace as { output?: Hex; trace?: { error?: string }[] }
    const reverted = !!t.trace?.some((x) => x.error)
    return {
      ok: !reverted,
      reverted,
      revertReason: reverted ? 'reverted (parity trace)' : undefined,
      summary: reverted ? 'This transaction REVERTS — do not sign it.' : `${call.label} — simulated via parity trace`,
      changes: [],
      call,
      source: 'trace_call',
      raw: trace,
    }
  } catch {
    /* fall through */
  }

  // ── Attempt 4: calldata-only (no simulation available on this chain) ──────────────────────────
  const changes: AssetChange[] =
    tx.value > 0n
      ? [
          { token: null, symbol, raw: -tx.value, amount: `-${formatUnits(tx.value, 18)}`, address: getAddress(safe) },
          { token: null, symbol, raw: tx.value, amount: `+${formatUnits(tx.value, 18)}`, address: getAddress(tx.to) },
        ]
      : []
  return {
    ok: true,
    reverted: false,
    summary: `${call.label} (calldata decode only — no simulation on chain ${chainId})`,
    changes,
    call,
    source: 'calldata',
    raw: { note: 'no simulation RPC available; showing intended effect from calldata', tx: { ...tx, value: tx.value.toString() } },
  }
}

/** True when two addresses are the same (nullsafe helper for the UI). */
export const sameAddr = (a?: Hex | null, b?: Hex | null): boolean => !!a && !!b && isAddressEqual(a, b)
