/**
 * clawback-dangling.ts — unwind any dangling (never-settled) tables on the live 943 HouseChannel.
 *
 * A table that was open()'d but never settle()'d sits in Status.Live with both escrows locked. The
 * contract's chess-clock recovery path unwinds it WITHOUT either co-signature:
 *
 *   disputeFromOpen(tableId)  — any seat (here the owner/index-0) posts a synthetic nonce-0 state
 *                               that simply refunds escrowPlayer→player and escrowHouse→pool, and
 *                               starts the dispute clock (block.number + clockBlocks).
 *   resolveTimeout(tableId)   — once block.number > disputeDeadline and no newer co-signed state was
 *                               filed, the synthetic refund stands and is paid out.
 *
 * This is exactly the "player walks away / round expires → house claws it back" flow from the
 * architecture vision, run for real. It also recovers the testnet limbo table left locked when a
 * rate-limited settle starved out.
 *
 * Discovery: enumerate Opened events from the contract's deploy block, read tables(tableId), keep the
 * ones still in Status.Live. The public `tables` getter omits the nested disputeState struct, so it
 * returns 11 flat fields with `status` at index 5.
 *
 *   Dry:  pnpm --filter @msgboard/games-house-service exec tsx scripts/clawback-dangling.ts
 *   Live: LIVE_EXECUTE=1 pnpm --filter @msgboard/games-house-service exec tsx scripts/clawback-dangling.ts
 *
 * The owner (mnemonic index 0) signs — it is a valid seat on every table via _seatOf's owner() branch
 * and holds the PLS for gas. Override the scan window with FROM_BLOCK.
 */
import {
  createPublicClient, createWalletClient, http, formatUnits,
  type Hex, type Abi,
} from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import { DEPLOYMENT_943, pulsechainV4, readMnemonic, redactRpc } from '../src/liveConfig'

const EXECUTE = process.env.LIVE_EXECUTE === '1'
const D = DEPLOYMENT_943
// The redeployed HouseChannel went live ~24708662; scan a little before to be safe.
const FROM_BLOCK = BigInt(process.env.FROM_BLOCK ?? '24700000')

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const STATUS = ['None', 'Live', 'Disputed', 'Settled'] as const

const openedEventAbi = [
  { type: 'event', name: 'Opened', inputs: [
    { name: 'tableId', type: 'bytes32', indexed: true },
    { name: 'player', type: 'address', indexed: true },
    { name: 'playerKey', type: 'address', indexed: false },
    { name: 'gameId', type: 'uint8', indexed: false },
    { name: 'escrowPlayer', type: 'uint256', indexed: false },
    { name: 'escrowHouse', type: 'uint256', indexed: false },
  ] },
] as const satisfies Abi

// The auto-generated getter for `mapping(bytes32 => Table) public tables` returns every value member
// of Table EXCEPT the nested `disputeState` struct (Solidity omits nested structs): 11 flat fields.
const tablesGetterAbi = [
  { type: 'function', name: 'tables', stateMutability: 'view',
    inputs: [{ name: '', type: 'bytes32' }],
    outputs: [
      { name: 'player', type: 'address' },
      { name: 'playerKey', type: 'address' },
      { name: 'escrowPlayer', type: 'uint256' },
      { name: 'escrowHouse', type: 'uint256' },
      { name: 'gameId', type: 'uint8' },
      { name: 'status', type: 'uint8' },
      { name: 'clockBlocks', type: 'uint64' },
      { name: 'checkpointNonce', type: 'uint64' },
      { name: 'hasCheckpoint', type: 'bool' },
      { name: 'disputeDeadline', type: 'uint64' },
      { name: 'disputant', type: 'uint8' },
    ] },
] as const satisfies Abi

const disputeAbi = [
  { type: 'function', name: 'disputeFromOpen', stateMutability: 'nonpayable',
    inputs: [{ name: 'tableId', type: 'bytes32' }], outputs: [] },
  { type: 'function', name: 'resolveTimeout', stateMutability: 'nonpayable',
    inputs: [{ name: 'tableId', type: 'bytes32' }], outputs: [] },
] as const satisfies Abi

/** Send a legacy type-0 tx with a live 2x-buffered gasPrice (943 1559 estimation is unreliable). Signs
 *  locally via the wallet client's bound account (eth_sendRawTransaction). Mirrors live-round.ts. */
async function send(
  publicClient: ReturnType<typeof createPublicClient>,
  walletClient: ReturnType<typeof createWalletClient>,
  label: string,
  tx: { address: Hex; abi: Abi; functionName: string; args: readonly unknown[] },
): Promise<Hex> {
  const live = await publicClient.getGasPrice()
  const gasPrice = live * 2n > 1_000_000_000n ? live * 2n : 1_000_000_000n
  const hash = await walletClient.writeContract({
    address: tx.address, abi: tx.abi, functionName: tx.functionName, args: tx.args,
    chain: pulsechainV4, type: 'legacy', gasPrice,
  } as Parameters<typeof walletClient.writeContract>[0])
  console.log(`  ${label}: ${hash} (gasPrice=${gasPrice})`)
  const rcpt = await publicClient.waitForTransactionReceipt({ hash })
  if (rcpt.status !== 'success') throw new Error(`${label} reverted in block ${rcpt.blockNumber}`)
  console.log(`  ${label}: confirmed block ${rcpt.blockNumber}`)
  return hash
}

interface Dangling {
  tableId: Hex
  player: Hex
  gameId: number
  escrowPlayer: bigint
  escrowHouse: bigint
  clockBlocks: bigint
}

async function main(): Promise<void> {
  const mnemonic = readMnemonic()
  const owner = mnemonicToAccount(mnemonic, { addressIndex: 0 })
  const publicClient = createPublicClient({ chain: pulsechainV4, transport: http(D.txRpcUrl) })
  const walletClient = createWalletClient({ account: owner, chain: pulsechainV4, transport: http(D.txRpcUrl) })

  const head = await publicClient.getBlockNumber()
  console.log(`== clawback-dangling on ${D.chainId} (${EXECUTE ? 'LIVE — will send txs' : 'DRY — scan only'}) ==`)
  console.log(`signer=${owner.address} (owner/seat)  channel=${D.houseChannel}  rpc=${redactRpc(D.txRpcUrl)}`)
  console.log(`scanning Opened from block ${FROM_BLOCK} to head ${head}`)

  // 1. Enumerate every table ever opened on this channel. The vk_demo RPC caps eth_getLogs at 30000
  //    blocks/request, so scan in windows.
  const WINDOW = 25_000n
  const logs: Array<{ args: unknown }> = []
  for (let from = FROM_BLOCK; from <= head; from += WINDOW + 1n) {
    const to = from + WINDOW > head ? head : from + WINDOW
    const chunk = await publicClient.getLogs({
      address: D.houseChannel, event: openedEventAbi[0], fromBlock: from, toBlock: to,
    })
    logs.push(...chunk)
  }
  const tableIds = [...new Set(logs.map((l) => (l.args as { tableId: Hex }).tableId))]
  console.log(`found ${tableIds.length} distinct opened table(s)`)

  // 2. Read live status of each; keep the ones still Live (dangling).
  const dangling: Dangling[] = []
  for (const tableId of tableIds) {
    const t = await publicClient.readContract({
      address: D.houseChannel, abi: tablesGetterAbi, functionName: 'tables', args: [tableId],
    }) as readonly [Hex, Hex, bigint, bigint, number, number, bigint, bigint, boolean, bigint, number]
    const status = Number(t[5])
    const tag = STATUS[status] ?? `?${status}`
    console.log(`  ${tableId} gameId=${t[4]} status=${tag} escrowP=${formatUnits(t[2], 18)} escrowH=${formatUnits(t[3], 18)}`)
    if (status === 1 /* Live */) {
      dangling.push({ tableId, player: t[0], gameId: Number(t[4]), escrowPlayer: t[2], escrowHouse: t[3], clockBlocks: t[6] })
    }
  }

  if (dangling.length === 0) {
    console.log('\nno dangling Live tables — nothing to claw back.')
    return
  }
  const lockedP = dangling.reduce((a, d) => a + d.escrowPlayer, 0n)
  const lockedH = dangling.reduce((a, d) => a + d.escrowHouse, 0n)
  console.log(`\n${dangling.length} dangling table(s) — locked: ${formatUnits(lockedP, 18)} player + ${formatUnits(lockedH, 18)} house chips`)

  if (!EXECUTE) {
    console.log('DRY run — set LIVE_EXECUTE=1 to disputeFromOpen + (after the clock) resolveTimeout.')
    return
  }

  // 3. disputeFromOpen each — posts the synthetic refund state and starts the clock.
  let maxClock = 0n
  for (const d of dangling) {
    console.log(`\ndispute ${d.tableId} (gameId=${d.gameId}):`)
    await send(publicClient, walletClient, 'disputeFromOpen', {
      address: D.houseChannel, abi: disputeAbi, functionName: 'disputeFromOpen', args: [d.tableId],
    })
    if (d.clockBlocks > maxClock) maxClock = d.clockBlocks
  }

  // 4. Wait out the dispute clock (block.number > disputeDeadline), then resolveTimeout each.
  const startBlock = await publicClient.getBlockNumber()
  const target = startBlock + maxClock + 1n
  console.log(`\nwaiting for dispute clock: need block > ${target} (clockBlocks=${maxClock}); current ${startBlock}`)
  for (;;) {
    const now = await publicClient.getBlockNumber()
    if (now > target) break
    console.log(`  block ${now}/${target} …`)
    await sleep(15_000)
  }

  for (const d of dangling) {
    console.log(`\nresolve ${d.tableId}:`)
    await send(publicClient, walletClient, 'resolveTimeout', {
      address: D.houseChannel, abi: disputeAbi, functionName: 'resolveTimeout', args: [d.tableId],
    })
  }

  console.log(`\n== clawed back ${dangling.length} table(s) — escrow refunded (player) / returned to pool (house) ==`)
}

main().catch((e) => { console.error(e); process.exit(1) })
