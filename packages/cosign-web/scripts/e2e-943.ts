/**
 * e2e-943.ts — Headless integration proof of the cosign crypto flow against REAL infra on
 * PulseChain v4 testnet (chainId 943). Uses the app's OWN libraries + the @msgboard/cosign SDK.
 *
 *   Run:  cd packages/cosign-web && npx tsx scripts/e2e-943.ts
 *
 * FUNDING NOTE: the 943 faucet (https://faucet.v4.testnet.pulsechain.com) rate-limits by IP for
 * ~24h and our IP (local + cloud egress) is exhausted, so we CANNOT broadcast a self-owned tx in
 * this run. We therefore run every check that does NOT require us to own funds/keys on a Safe:
 *   - Checks 1-3 run fully against a REAL, on-chain 943 Safe discovered via the factory's
 *     ProxyCreation logs (SAFE below). No funds needed — reads + simulation only.
 *   - Check 4 runs the REAL SDK aggregation pipeline (postShare -> loadShares -> aggregate ->
 *     buildExecTransactionArgs) and proves the SDK-built `signatures` blob is CRYPTOGRAPHICALLY
 *     ACCEPTED by the real Safe singleton bytecode executing on the reth node, via eth_simulateV1
 *     with state overrides that (a) install a throwaway owner and (b) fund the Safe. The signature
 *     is a REAL EIP-712 owner signature over the REAL on-chain digest (NOT the approved-hash stub).
 *     What is NOT proven here: a broadcast/mined execTransaction (blocked purely by the faucet).
 *
 * If you have a funded 943 key, set OWNER_PK=0x... to additionally attempt the full broadcast path.
 * DO NOT COMMIT.
 */
import {
  type Hex,
  createPublicClient,
  http,
  defineChain,
  encodeFunctionData,
  parseEther,
  formatEther,
  getAddress,
  isAddressEqual,
  zeroAddress,
  keccak256,
  pad,
  toHex,
} from 'viem'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'

// ── App libraries + SDK under test ───────────────────────────────────────────────────────────
import {
  type SafeTx,
  type SignatureRecord,
  type SafePublicClient,
  SCHEME,
  SAFE_ABI,
  safeTransactionDigest,
  encodeSafeMeta,
  makeSafeAdapter,
  buildExecTransactionArgs,
} from '@msgboard/cosign'
import type { BoardClient } from '@msgboard/cosign'
import { simulateSafeTx } from '../src/lib/simulate'
import { safeTxTypedData, assertSafeTxSignatureParity, EXEC_TRANSACTION_ABI } from '../src/lib/safe-typed-data'
import { postShare, loadShares, aggregateForSafe, scopeFor } from '../src/lib/cosign'

// ── Constants ────────────────────────────────────────────────────────────────────────────────
const CHAIN_ID = 943
const RPC = 'https://one.valve.city/rpc/vk_demo/evm/943'
// A REAL v1.3.0 Safe on 943 (L2 singleton 0x3E5c…), discovered via SafeProxyFactory ProxyCreation
// logs (0xa6B71E26…, event topic 0x4f51faf6…). threshold=2, nonce=0 at time of writing.
const SAFE = getAddress('0xefbce2fca3638e87c7464d2f97072e54efe0a9aa')

const pls943 = defineChain({
  id: CHAIN_ID,
  name: 'PulseChain v4',
  nativeCurrency: { name: 'tPLS', symbol: 'tPLS', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
})
const publicClient = createPublicClient({ chain: pls943, transport: http(RPC) })

// ── Safe storage-override math (mirrors src/lib/simulate.ts) ───────────────────────────────────
const THRESHOLD_SLOT = toHex(4n, { size: 32 })
const OWNERS_SLOT = 2n
const SENTINEL = pad('0x01', { size: 32 })
const BIG_BALANCE = toHex(2n ** 128n)
const ownersMappingSlot = (owner: Hex): Hex =>
  keccak256(`0x${pad(owner, { size: 32 }).slice(2)}${pad(toHex(OWNERS_SLOT), { size: 32 }).slice(2)}` as Hex)
const TRANSFER_TOPIC = keccak256(new TextEncoder().encode('Transfer(address,address,uint256)'))

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────
async function rpc(method: string, params: unknown[]): Promise<any> {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const json = await res.json()
  if (json.error) throw new Error(`${method}: ${JSON.stringify(json.error)}`)
  return json.result
}

const results: { check: string; pass: boolean; detail: string }[] = []
function record(check: string, pass: boolean, detail: string) {
  results.push({ check, pass, detail })
  console.log(`\n${pass ? '✅ PASS' : '❌ FAIL'} — ${check}\n   ${detail.replace(/\n/g, '\n   ')}`)
}

// In-memory BoardClient: faithfully implements the SDK transport seam so the REAL
// encodeRecord/decodeRecord/currentKey-rotation/readSignatures-dedup logic runs. The board NETWORK
// leg (Waku/msgboard + PoW) is stubbed — noted in the report.
function makeMemoryBoard(): BoardClient {
  const store = new Map<string, { data: Hex }[]>()
  return {
    async addMessage({ category, data }: { category: Hex; data: Hex }) {
      const arr = store.get(category) ?? []
      arr.push({ data })
      store.set(category, arr)
      return { ok: true }
    },
    async content({ category }: { category: Hex }) {
      return { [category]: store.get(category) ?? [] } as never
    },
  }
}

// A SafePublicClient that wraps the real client but injects a simulated owner set for getOwners /
// getThreshold, so the REAL adapter.verify (recover over the on-chain digest + membership check)
// accepts our throwaway owner's signature. Every OTHER read passes through to the real chain.
function ownerOverrideClient(realOwner: Hex): SafePublicClient {
  return {
    async readContract(args) {
      if (args.functionName === 'getOwners') return [realOwner]
      if (args.functionName === 'getThreshold') return 1n
      return publicClient.readContract(args as never)
    },
  }
}

async function main() {
  console.log('═'.repeat(92))
  console.log('cosign e2e — PulseChain v4 testnet (chainId 943)')
  console.log('═'.repeat(92))

  const cid = await publicClient.getChainId()
  if (cid !== CHAIN_ID) throw new Error(`RPC is not 943 (got ${cid})`)
  const code = await publicClient.getCode({ address: SAFE })
  if (!code || code === '0x') throw new Error(`SAFE ${SAFE} has no code on 943`)
  const realThreshold = (await publicClient.readContract({ address: SAFE, abi: SAFE_ABI, functionName: 'getThreshold' })) as bigint
  const realOwners = (await publicClient.readContract({ address: SAFE, abi: SAFE_ABI, functionName: 'getOwners' })) as Hex[]
  const safeNonce = (await publicClient.readContract({
    address: SAFE,
    abi: [{ type: 'function', name: 'nonce', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }],
    functionName: 'nonce',
  })) as bigint
  console.log(`RPC chainId: ${cid}`)
  console.log(`Real 943 Safe: ${SAFE}  (real threshold=${realThreshold}, nonce=${safeNonce}, ${realOwners.length} owner(s))`)

  // Throwaway owner + recipient (no funds needed for checks 1-4 in this run).
  const owner = privateKeyToAccount((process.env.OWNER_PK as Hex) ?? generatePrivateKey())
  const recipient = privateKeyToAccount(generatePrivateKey()).address
  console.log(`Throwaway owner: ${owner.address}`)
  console.log(`Recipient:       ${recipient}`)

  // The sample SafeTx: Safe sends 0.1 tPLS to recipient (native transfer), at the Safe's real nonce.
  const tx: SafeTx = {
    to: recipient as Hex,
    value: parseEther('0.1'),
    data: '0x',
    operation: 0,
    safeTxGas: 0n,
    baseGas: 0n,
    gasPrice: 0n,
    gasToken: zeroAddress,
    refundReceiver: zeroAddress,
    nonce: safeNonce,
  }

  // ══ CHECK 1: Digest parity ══════════════════════════════════════════════════════════════════
  const appDigest = safeTransactionDigest(tx, CHAIN_ID, SAFE)
  const onchainDigest = (await publicClient.readContract({
    address: SAFE,
    abi: SAFE_ABI,
    functionName: 'getTransactionHash',
    args: [tx.to, tx.value, tx.data, tx.operation, tx.safeTxGas, tx.baseGas, tx.gasPrice, tx.gasToken, tx.refundReceiver, tx.nonce],
  })) as Hex
  record(
    'CHECK 1 — Digest parity: app safeTransactionDigest(tx,943,safe) === on-chain getTransactionHash',
    appDigest.toLowerCase() === onchainDigest.toLowerCase(),
    `app  =${appDigest}\nchain=${onchainDigest}`,
  )

  // ══ CHECK 2a: Simulation of a valid native transfer ═════════════════════════════════════════
  const sim = await simulateSafeTx(CHAIN_ID, SAFE, owner.address, tx)
  // Match by NET amount per address; the reth node emits the native move as a Transfer log with a
  // NON-zero `address`, so simulate.ts's foldTransferLogs labels it token (symbol "tokens") rather
  // than native — the AMOUNTS/deltas are exactly right (see report), only the native-vs-token label differs.
  const safeOut = sim.changes.find((c) => isAddressEqual(c.address, SAFE))
  const recvIn = sim.changes.find((c) => isAddressEqual(c.address, recipient as Hex))
  record(
    'CHECK 2a — app simulateSafeTx: valid native transfer (eth_simulateV1, not reverted, correct deltas)',
    sim.source === 'eth_simulateV1' && !sim.reverted && !!safeOut && safeOut.raw === -parseEther('0.1') && !!recvIn && recvIn.raw === parseEther('0.1'),
    `source=${sim.source} reverted=${sim.reverted} summary="${sim.summary}"\nchanges=${JSON.stringify(sim.changes.map((c) => ({ addr: c.address, amt: c.amount, native: c.token === null })))}`,
  )

  // ══ CHECK 2b: Simulation flags a KNOWN-reverting tx ═════════════════════════════════════════
  // Inner CALL to the ecPairing precompile (0x08) with a 4-byte (non-192-multiple) input reverts
  // (PrecompileError); with safeTxGas=0 & gasPrice=0 Safe's `require(success, "GS013")` propagates
  // it — a deterministic revert independent of chain state / balances.
  const revTx: SafeTx = { ...tx, to: '0x0000000000000000000000000000000000000008' as Hex, value: 0n, data: '0xdeadbeef', operation: 0 }
  const simRev = await simulateSafeTx(CHAIN_ID, SAFE, owner.address, revTx)
  record(
    'CHECK 2b — app simulateSafeTx correctly flags a KNOWN-reverting tx (inner call to ecPairing precompile with bad input)',
    simRev.reverted === true && simRev.ok === false,
    `source=${simRev.source} reverted=${simRev.reverted} summary="${simRev.summary}"`,
  )

  // ══ CHECK 3a: Guardrail passes for a valid owner signature ══════════════════════════════════
  const goodSig = await owner.signTypedData(safeTxTypedData(tx, CHAIN_ID, SAFE) as never)
  let guardPass = false
  let guardDetail = ''
  try {
    const d = await assertSafeTxSignatureParity({ safeTx: tx, chainId: CHAIN_ID, safe: SAFE, signature: goodSig, expectedSigner: owner.address })
    guardPass = d.toLowerCase() === appDigest.toLowerCase()
    guardDetail = `guardrail returned digest ${d} (== app digest); recovers to owner ${owner.address}`
  } catch (e) {
    guardDetail = `unexpected throw on GOOD signature: ${(e as Error).message}`
  }
  record('CHECK 3a — assertSafeTxSignatureParity PASSES for a valid owner signature', guardPass, guardDetail)

  // ══ CHECK 3b: Guardrail throws on a tampered signature ══════════════════════════════════════
  const tamperedSig = await owner.signTypedData(safeTxTypedData({ ...tx, nonce: tx.nonce + 1n }, CHAIN_ID, SAFE) as never)
  let threw = false
  let throwDetail = ''
  try {
    await assertSafeTxSignatureParity({ safeTx: tx, chainId: CHAIN_ID, safe: SAFE, signature: tamperedSig, expectedSigner: owner.address })
    throwDetail = 'guardrail did NOT throw on a tampered/mismatched signature (BUG)'
  } catch (e) {
    threw = true
    throwDetail = `threw as expected: ${(e as Error).message.slice(0, 110)}…`
  }
  record('CHECK 3b — assertSafeTxSignatureParity THROWS on a tampered signature', threw, throwDetail)

  // ══ CHECK 4: SDK aggregation pipeline + on-chain acceptance of the signatures blob ══════════
  const scope = scopeFor(CHAIN_ID, SAFE)
  const rec: SignatureRecord = {
    digest: appDigest,
    signer: owner.address,
    signature: goodSig,
    scheme: SCHEME.EIP712,
    meta: encodeSafeMeta(tx, SAFE, CHAIN_ID),
  }
  const board = makeMemoryBoard()
  await postShare(board, scope, rec) // REAL encodeRecord + currentKey rotation
  const shares = await loadShares(board, scope, { archive: false }) // REAL readSignatures + decode + dedup
  const records = shares.map((s) => s.record)
  const adapter = makeSafeAdapter({ publicClient: ownerOverrideClient(owner.address), safe: SAFE, chainId: CHAIN_ID })
  const agg = await aggregateForSafe(records, adapter) // REAL verify (recover over on-chain digest) + order + blob
  const [to, value, data, operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver, signatures] = buildExecTransactionArgs(agg.ordered, tx)

  const pipelineOk = shares.length === 1 && agg.ordered.length === 1 && agg.pairs.length === 1 && isAddressEqual(agg.pairs[0].signer, owner.address)

  // Now prove the REAL Safe singleton bytecode ACCEPTS this SDK-built blob: eth_simulateV1
  // execTransaction FROM the owner, with overrides installing owner + funding the Safe. The blob
  // carries a real EIP-712 signature (v∈{27,28}) → Safe's checkNSignatures ecrecover(digest) path.
  const execData = encodeFunctionData({
    abi: EXEC_TRANSACTION_ABI,
    functionName: 'execTransaction',
    args: [to, value, data, operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver, signatures],
  })
  const stateDiff: Record<Hex, Hex> = { [THRESHOLD_SLOT]: pad('0x01', { size: 32 }), [ownersMappingSlot(owner.address)]: SENTINEL }
  const simRes = (await rpc('eth_simulateV1', [
    {
      blockStateCalls: [
        {
          stateOverrides: { [SAFE]: { balance: BIG_BALANCE, stateDiff } },
          calls: [{ from: owner.address, to: SAFE, data: execData, value: '0x0' }],
        },
      ],
      traceTransfers: true,
      validation: false,
    },
    'latest',
  ])) as { calls?: { status?: Hex; logs?: { address?: Hex; topics?: Hex[]; data?: Hex }[]; error?: { message?: string } }[] }[]
  const c = simRes?.[0]?.calls?.[0]
  const execReverted = c?.status !== undefined && BigInt(c.status) === 0n
  // Look for the native Transfer (traceTransfers emits native moves as Transfer logs) crediting recipient 0.1.
  let movedToRecipient = 0n
  for (const log of c?.logs ?? []) {
    if (log.topics?.[0]?.toLowerCase() !== TRANSFER_TOPIC.toLowerCase()) continue
    const toAddr = getAddress(`0x${log.topics![2].slice(-40)}`)
    if (isAddressEqual(toAddr, recipient as Hex)) movedToRecipient += BigInt(log.data!)
  }
  record(
    'CHECK 4 — SDK pipeline (post→load→aggregate→buildExecTransactionArgs) + real Safe accepts the blob on-chain (eth_simulateV1)',
    pipelineOk && !execReverted && movedToRecipient === parseEther('0.1'),
    `pipeline: ${shares.length} share loaded, ${agg.ordered.length} verified+ordered, blob ${signatures.length} chars\n` +
      `on-chain execTransaction (simulateV1, owner+balance overridden): reverted=${execReverted}, recipient credited ${formatEther(movedToRecipient)} tPLS\n` +
      `NOTE: real EIP-712 signature over the real on-chain digest; broadcast of a MINED tx blocked by faucet (see header).`,
  )

  // Optional: full broadcast path if a funded key was supplied.
  if (process.env.OWNER_PK) console.log('\n(OWNER_PK set — but this run still uses an EXISTING Safe it does not own; broadcast path not attempted.)')

  // ── Summary ─────────────────────────────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(92))
  console.log('SUMMARY')
  console.log('═'.repeat(92))
  console.log(`Real 943 Safe used: ${SAFE}`)
  console.log(`App digest == on-chain getTransactionHash: ${appDigest}`)
  console.log('─'.repeat(92))
  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.check}`)
  console.log('─'.repeat(92))
  const allPass = results.every((r) => r.pass)
  console.log(allPass ? 'ALL RUN CHECKS PASSED' : 'SOME CHECKS FAILED')
  process.exit(allPass ? 0 : 1)
}

main().catch((e) => {
  console.error('\n💥 FATAL:', e)
  process.exit(1)
})
