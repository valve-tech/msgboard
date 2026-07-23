/**
 * Acceptance gate for the solveAttestation archive — the 3-layer ground-truth template
 * (invariants → source-log parity → on-chain-oracle reconciliation at a pinned height), instanced
 * for EAS solve attestations. Unit tests can't see the DATA; correctness here means matching two
 * oracles the archive never reads: eth_getLogs (the canonical event log) and EAS contract storage
 * (getAttestation). The solve set is small, so parity is FULL, not sampled.
 *
 *   Layer 1 — invariants: unique ids, id == `${chainId}-${uid}`, game matches SOLVE_SCHEMAS, hex sanity.
 *   Layer 2 — full log parity per chain over [startBlock, H], H pinned = max archived block.
 *   Layer 3 — per-uid getAttestation(uid) at H: schema/recipient/attester match, time>0, never revoked.
 *
 * Run (node ≥ 23.6 — native type stripping): `npm run verify:solves`
 * Before the indexer ships the table, the archive layers downgrade to a chain-only run (logs↔oracle
 * cross-check + per-game counts) so the schema UIDs in ../schemas.ts are verified against reality.
 *
 * Env: INDEXER_URL, RPC_943, RPC_369 (defaults = the production games proxy, key server-side).
 */

import { createPublicClient, http, parseAbiItem } from 'viem'
import { SOLVE_SCHEMAS } from '../schemas.ts' // explicit .ts — node's native type stripping requires it

const INDEXER_URL = process.env.INDEXER_URL ?? 'https://games.msgboard.xyz/games-indexer/graphql'
// Address + start blocks mirror ponder.config.ts (EAS / FLIP_BOOK_START_*) — keep in sync.
const EAS = '0x9e84Aa4BD0C1931A34B14C1EC918A53C33e2B0F8'
const CHAINS = [
  { chainId: 943, rpc: process.env.RPC_943 ?? 'https://games.msgboard.xyz/rpc/evm/943', startBlock: 24_921_235n },
  { chainId: 369, rpc: process.env.RPC_369 ?? 'https://games.msgboard.xyz/rpc/evm/369', startBlock: 27_080_922n },
]
const CHUNK = 10_000n // keyed-RPC getLogs range cap

const attestedEvent = parseAbiItem(
  'event Attested(address indexed recipient, address indexed attester, bytes32 uid, bytes32 indexed schemaUID)',
)
const getAttestationAbi = [{
  name: 'getAttestation', type: 'function', stateMutability: 'view',
  inputs: [{ name: 'uid', type: 'bytes32' }],
  outputs: [{
    type: 'tuple',
    components: [
      { name: 'uid', type: 'bytes32' }, { name: 'schema', type: 'bytes32' },
      { name: 'time', type: 'uint64' }, { name: 'expirationTime', type: 'uint64' },
      { name: 'revocationTime', type: 'uint64' }, { name: 'refUID', type: 'bytes32' },
      { name: 'recipient', type: 'address' }, { name: 'attester', type: 'address' },
      { name: 'revocable', type: 'bool' }, { name: 'data', type: 'bytes' },
    ],
  }],
}] as const

interface ArchiveRow {
  id: string; chainId: number; uid: string; game: string; schemaUid: string
  solver: string; attester: string; blockNumber: bigint; txHash: string
}
interface ChainLog {
  uid: string; schemaUid: string; solver: string; attester: string; blockNumber: bigint; txHash: string
}

const failures: string[] = []
const fail = (msg: string) => { failures.push(msg); console.error(`  ✗ ${msg}`) }
const ok = (msg: string) => console.log(`  ✓ ${msg}`)
const low = (s: string) => s.toLowerCase()

/** Pull every solveAttestation row (cursor-paginated). null → the deployed indexer predates the table. */
async function fetchArchive(): Promise<ArchiveRow[] | null> {
  const rows: ArchiveRow[] = []
  let after: string | null = null
  for (;;) {
    const query = `query($after: String) { solveAttestations(limit: 1000, after: $after) {
      items { id chainId uid game schemaUid solver attester blockNumber txHash }
      pageInfo { hasNextPage endCursor } } }`
    const res = await fetch(INDEXER_URL, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables: { after } }),
    })
    const body = await res.json() as { data?: any; errors?: { message: string }[] }
    if (body.errors?.length) {
      if (body.errors.some((e) => /solveAttestations/.test(e.message))) return null // not deployed yet
      throw new Error(`indexer GraphQL: ${body.errors[0]!.message}`)
    }
    const page = body.data.solveAttestations
    for (const r of page.items) rows.push({ ...r, blockNumber: BigInt(r.blockNumber) })
    if (!page.pageInfo.hasNextPage) return rows
    after = page.pageInfo.endCursor
  }
}

/** Canonical event log: every Attested for OUR schema UIDs (same filter as the indexer), chunked. */
async function fetchChainLogs(client: any, fromBlock: bigint, toBlock: bigint): Promise<ChainLog[]> {
  const out: ChainLog[] = []
  for (let from = fromBlock; from <= toBlock; from += CHUNK) {
    const to = from + CHUNK - 1n < toBlock ? from + CHUNK - 1n : toBlock
    const logs = await client.getLogs({
      address: EAS, event: attestedEvent,
      args: { schemaUID: Object.keys(SOLVE_SCHEMAS) as `0x${string}`[] },
      fromBlock: from, toBlock: to,
    })
    for (const l of logs) out.push({
      uid: low(l.args.uid), schemaUid: low(l.args.schemaUID),
      solver: low(l.args.recipient), attester: low(l.args.attester),
      blockNumber: l.blockNumber, txHash: low(l.transactionHash),
    })
  }
  return out
}

// ---- Layer 1: invariants (archive-internal sanity) --------------------------------------------
function layer1(rows: ArchiveRow[]) {
  console.log(`\nLayer 1 — invariants over ${rows.length} archive rows`)
  const ids = new Set(rows.map((r) => r.id))
  if (ids.size !== rows.length) fail(`duplicate ids: ${rows.length - ids.size}`)
  for (const r of rows) {
    if (r.id !== `${r.chainId}-${low(r.uid)}`) fail(`${r.id}: id != chainId-uid`)
    if (SOLVE_SCHEMAS[low(r.schemaUid)] !== r.game) fail(`${r.id}: game '${r.game}' != schema map`)
    if (!/^0x[0-9a-f]{64}$/.test(low(r.uid))) fail(`${r.id}: malformed uid`)
    if (!/^0x[0-9a-f]{40}$/.test(low(r.solver))) fail(`${r.id}: malformed solver`)
    if (r.blockNumber <= 0n) fail(`${r.id}: blockNumber ${r.blockNumber}`)
  }
  if (!failures.length) ok('unique ids, id shape, schema→game map, hex sanity')
}

// ---- Layer 2: full source-log parity over [start, H] ------------------------------------------
function layer2(chainId: number, logs: ChainLog[], rows: ArchiveRow[]) {
  const key = (x: { uid: string }) => `${chainId}-${x.uid}`
  const byKey = new Map(rows.map((r) => [r.id, r]))
  for (const l of logs) {
    const r = byKey.get(key(l))
    if (!r) { fail(`${chainId}: log uid ${l.uid} missing from archive`); continue }
    for (const f of ['schemaUid', 'solver', 'attester', 'txHash'] as const)
      if (low(r[f]) !== l[f]) fail(`${key(l)}: ${f} archive=${low(r[f])} chain=${l[f]}`)
    if (r.blockNumber !== l.blockNumber) fail(`${key(l)}: blockNumber ${r.blockNumber} != ${l.blockNumber}`)
  }
  const logKeys = new Set(logs.map(key))
  for (const r of rows) if (!logKeys.has(r.id)) fail(`${r.id}: archive row has NO matching chain log (fabricated?)`)
  if (logs.length === rows.length) ok(`chain ${chainId}: ${logs.length} logs ⇔ ${rows.length} rows, all fields match`)
}

// ---- Layer 3: contract-storage oracle at pinned H ---------------------------------------------
async function layer3(client: any, chainId: number, H: bigint, logs: ChainLog[]) {
  for (const l of logs) {
    const a: any = await client.readContract({
      address: EAS, abi: getAttestationAbi, functionName: 'getAttestation',
      args: [l.uid as `0x${string}`], blockNumber: H,
    })
    if (a.time === 0n) { fail(`${chainId}-${l.uid}: getAttestation says NOT FOUND`); continue }
    if (low(a.schema) !== l.schemaUid) fail(`${chainId}-${l.uid}: oracle schema mismatch`)
    if (low(a.recipient) !== l.solver) fail(`${chainId}-${l.uid}: oracle recipient mismatch`)
    if (low(a.attester) !== l.attester) fail(`${chainId}-${l.uid}: oracle attester mismatch`)
    if (a.revocationTime !== 0n) fail(`${chainId}-${l.uid}: REVOKED at ${a.revocationTime}`)
  }
  ok(`chain ${chainId}: ${logs.length}/${logs.length} uids reconciled against getAttestation @ ${H}`)
}

// ---- main -------------------------------------------------------------------------------------
const archive = await fetchArchive()
if (archive === null) console.log('!! indexer does not serve solveAttestations yet — CHAIN-ONLY run (layers 2↔3 cross-check)')
else layer1(archive)

for (const { chainId, rpc, startBlock } of CHAINS) {
  const client = createPublicClient({ transport: http(rpc) })
  const head = await client.getBlockNumber()
  const chainRows = (archive ?? []).filter((r) => r.chainId === chainId)
  // Pin H once per chain: newest archived block (archive mode) or head (chain-only). Logs after H
  // are races with sync, reported as pending, never failures.
  const H = archive && chainRows.length ? chainRows.reduce((m, r) => (r.blockNumber > m ? r.blockNumber : m), 0n) : head
  const logsAll = await fetchChainLogs(client, startBlock, head)
  const logs = logsAll.filter((l) => l.blockNumber <= H)
  const pending = logsAll.length - logs.length
  const perGame: Record<string, number> = {}
  for (const l of logsAll) perGame[SOLVE_SCHEMAS[l.schemaUid]!] = (perGame[SOLVE_SCHEMAS[l.schemaUid]!] ?? 0) + 1

  console.log(`\nLayer 2 — chain ${chainId}: ${logsAll.length} Attested logs on-chain (${JSON.stringify(perGame)}), H=${H}${pending ? `, ${pending} pending past H` : ''}`)
  if (archive) {
    if (!chainRows.length && logsAll.length) fail(`${chainId}: chain has ${logsAll.length} solves, archive has 0 (backfill unfinished? re-run after sync)`)
    else layer2(chainId, logs, chainRows)
  } else ok(`chain-only: parity vs archive skipped`)

  console.log(`Layer 3 — chain ${chainId}: oracle reconciliation`)
  await layer3(client, chainId, H, logs)
}

const verdict = failures.length === 0
console.log(`\n${verdict ? 'PASS' : `FAIL — ${failures.length} finding(s)`} | mode=${archive ? 'archive' : 'chain-only'} | schemas=${Object.keys(SOLVE_SCHEMAS).length}`)
process.exit(verdict ? 0 : 1)
