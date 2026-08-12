/** Shared plumbing for the off-chain actors (cast-watcher, player-bots). */
import * as viem from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import {
  chains,
  defaultRpc,
  makePublicClient,
  coinFlipAbi,
  coinFlipTablesAbi,
  raffleAbi,
  type GamesChainId,
} from '@msgboard/games-core'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))

/** OperatorCoinFlip.RoundOpened — its own signature (no subsetHash, unlike CoinFlipTables), so
 *  heatsSincePriced decodes its heats with this rather than reusing coinFlipTablesAbi. Since
 *  validator-forfeit (tiers + fee metering), the event also carries `tierPrice` — the round's
 *  (token, price) pool is `tierPrice` plus the table's token (read separately, see
 *  operatorCoinFlipTablesAbi below). This MUST list every non-indexed field in on-chain order:
 *  a missing/misordered field silently shifts the decode of every field after it, corrupting
 *  `key` — that bug is exactly why this file previously miscounted operator heats. */
const operatorCoinFlipRoundOpenedAbi = [
  {
    type: 'event',
    name: 'RoundOpened',
    inputs: [
      { name: 'roundId', type: 'bytes32', indexed: true },
      { name: 'tableId', type: 'bytes32', indexed: true },
      { name: 'player', type: 'address', indexed: true },
      { name: 'side', type: 'uint8', indexed: false },
      { name: 'stake', type: 'uint256', indexed: false },
      { name: 'payout', type: 'uint256', indexed: false },
      { name: 'tierPrice', type: 'uint256', indexed: false },
      { name: 'key', type: 'bytes32', indexed: false },
      { name: 'openedAtBlock', type: 'uint256', indexed: false },
    ],
  },
] as const satisfies viem.Abi

/** OperatorCoinFlip.tables(tableId) — the auto-generated getter for the Table struct. Only `token`
 *  (index 1) is read here, to pair with a round's `tierPrice` and resolve the (token, price) pool a
 *  heat consumed. Field order MUST match the Table struct exactly (operator, token, maxMultiplierX100,
 *  minStake, maxStake, open) — readContract decodes this as a positional tuple, not by name. */
const operatorCoinFlipTablesAbi = [
  {
    type: 'function',
    name: 'tables',
    stateMutability: 'view',
    inputs: [{ name: 'tableId', type: 'bytes32' }],
    outputs: [
      { name: 'operator', type: 'address' },
      { name: 'token', type: 'address' },
      { name: 'maxMultiplierX100', type: 'uint16' },
      { name: 'minStake', type: 'uint256' },
      { name: 'maxStake', type: 'uint256' },
      { name: 'open', type: 'bool' },
    ],
  },
] as const satisfies viem.Abi

export type Deployment = {
  chainId: number
  coinFlip: viem.Hex
  raffle: viem.Hex
  /** Permissionless player-run coin-flip tables (validator-settled). Optional: absent on chains where
   *  CoinFlipTables isn't deployed. When set, its heats share the same validator preimage pools as
   *  coinFlip/raffle, so heatsSince MUST include them to keep the caster's slot counter correct. */
  coinFlipTables?: viem.Hex
  /** RETIRED CoinFlipTables addresses (superseded by a redeploy). Their past RoundOpened events still
   *  consumed pool slots forever, so heatsSince MUST keep counting them or the chronological slot
   *  counter drops by that many on the swap → SecretMismatch. Append the old address here whenever
   *  coinFlipTables is repointed to a fresh deployment. */
  coinFlipTablesRetired?: viem.Hex[]
  /** OperatorCoinFlip (table-maintainer substrate reference game, validator-forfeit build). Validator-
   *  settled, but it heats its OWN pool ladder keyed by (table.token, round.tierPrice) — NOT the shared
   *  native/price-0 pools that CoinFlip/Raffle/CoinFlipTables use. REGRESSION RISK: heatsSince MUST NOT
   *  include these heats — doing so once desynced the shared price-0 slot counter (every operator open
   *  stole a slot from CoinFlip/Raffle/CoinFlipTables) → SecretMismatch for ALL shared-pool games. Use
   *  heatsSincePriced(token, price) to count these on their own ladder instead. Optional: absent on
   *  chains where the substrate isn't deployed. */
  operatorCoinFlip?: viem.Hex
  /** RETIRED OperatorCoinFlip addresses — same slot-permanence rule as coinFlipTablesRetired, but on the
   *  operator game's own priced ladders (see heatsSincePriced), never the shared price-0 counter. */
  operatorCoinFlipRetired?: viem.Hex[]
  random: viem.Hex
  canonicalSubset: viem.Hex[]
  /** BASE offsets; pools chain at base + n*poolSize (core poolLocationFor). */
  poolOffsets: Record<string, string>
  poolSize: number
  deployBlock: string
}

export const loadDeployment = (chainId: number, configPath?: string): Deployment => {
  const p = configPath ?? path.join(scriptDir, `${chainId}-deployment.json`)
  const config = JSON.parse(fs.readFileSync(p, 'utf8')) as Deployment
  if (!config.coinFlip || !config.raffle || !config.poolSize) {
    throw new Error(`${p} is missing game addresses or poolSize`)
  }
  return config
}

export const makeActor = (chainId: GamesChainId, mnemonic: string, addressIndex: number, rpc?: string) => {
  const account = mnemonicToAccount(mnemonic, { addressIndex })
  const endpoint = rpc || defaultRpc[chainId]
  const publicClient = makePublicClient(chainId, endpoint)
  const wallet = viem.createWalletClient({ account, chain: chains[chainId], transport: viem.http(endpoint) })
  return { account, publicClient, wallet }
}

/**
 * Fee shaping with a FLOOR. The valve nodes quote wei-level gas prices when the chain is idle
 * (943 especially), and an unfloored `gasPrice * 2` produces transactions that never mine — this
 * is what silently killed the cast watcher (casts + pool re-inks timing out for weeks, which
 * drained the validator pools and stalled the entropy games). Anything under 0.1 gwei is bumped
 * to 1 gwei; at PulseChain prices that rounds to nothing.
 */
export const flooredFees = async (publicClient: ReturnType<typeof makePublicClient>) => {
  const quoted = await publicClient.getGasPrice()
  const gasPrice = quoted < viem.parseGwei('0.1') ? viem.parseGwei('1') : quoted
  return { maxFeePerGas: gasPrice * 2n + gasPrice / 10n, maxPriorityFeePerGas: gasPrice / 10n || 1n }
}

/** Simulate-then-send with live-chain fee shaping; throws with a one-line reason. */
export const sendAs = async (
  publicClient: ReturnType<typeof makePublicClient>,
  wallet: viem.WalletClient,
  call: { address: viem.Hex; abi: viem.Abi; functionName: string; args: readonly unknown[]; value?: bigint; gas?: bigint },
): Promise<viem.TransactionReceipt> => {
  const fees = await flooredFees(publicClient)
  const { request } = await publicClient.simulateContract({
    ...call,
    value: call.value ?? 0n,
    account: wallet.account!,
    ...fees,
    ...(call.gas ? { gas: call.gas } : {}),
  })
  const receipt = await publicClient.waitForTransactionReceipt({ hash: await wallet.writeContract(request) })
  if (receipt.status !== 'success') throw new Error(`${call.functionName} reverted`)
  return receipt
}

/**
 * Chunked + cached event scan. The valve nodes reject single getLogs calls over wide ranges
 * (~38k+ blocks → "Request exceeds defined limit"), and the actors scan from a months-old origin —
 * so every scan walks 10k-block chunks, and an in-process cursor makes each subsequent tick pay
 * only the new blocks. Restart = one full (chunked) rescan; a reorged-out log could linger in the
 * cache, which is harmless here because every actor re-derives live state from contract reads
 * before acting.
 */
const EVENT_CHUNK = 10_000n
const eventCache = new Map<string, { lastBlock: bigint; logs: unknown[] }>()
export const chunkedEvents = async (
  publicClient: ReturnType<typeof makePublicClient>,
  params: { address: viem.Hex; abi: viem.Abi; eventName: string; fromBlock: bigint },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any[]> => {
  const head = await publicClient.getBlockNumber()
  const key = `${params.address.toLowerCase()}:${params.eventName}:${params.fromBlock}`
  const cached = eventCache.get(key) ?? { lastBlock: params.fromBlock - 1n, logs: [] }
  for (let lo = cached.lastBlock + 1n; lo <= head; lo += EVENT_CHUNK) {
    const hi = lo + EVENT_CHUNK - 1n < head ? lo + EVENT_CHUNK - 1n : head
    const logs = await publicClient.getContractEvents({
      address: params.address,
      abi: params.abi,
      eventName: params.eventName,
      fromBlock: lo,
      toBlock: hi,
    })
    cached.logs.push(...logs)
  }
  cached.lastBlock = head
  eventCache.set(key, cached)
  return cached.logs
}

/**
 * All heats on the SHARED native/price-0 pool ladder since the deployment origin, chronological — the
 * k-th entry consumed pool slot k.
 *
 * REGRESSION NOTE (desync risk): only consumers of the price-0 ladder belong here — CoinFlip, Raffle,
 * CoinFlipTables. OperatorCoinFlip (validator-forfeit build) heats a SEPARATE ladder keyed by
 * (table.token, round.tierPrice); it is deliberately excluded. Adding it back here — or adding any
 * future consumer of a non-price-0 pool — would desync this counter for every game that shares it,
 * producing SecretMismatch. Count a priced consumer with heatsSincePriced instead.
 */
export const heatsSince = async (
  publicClient: ReturnType<typeof makePublicClient>,
  config: Deployment,
): Promise<{ key: viem.Hex; blockNumber: bigint }[]> => {
  const from = BigInt(config.deployBlock)
  // CoinFlipTables consumes the SAME validator pools; every open() heats one slot and emits
  // RoundOpened{key,...}. Omitting these would desync the chronological slot counter and corrupt casts
  // for ALL games once any table round exists. A redeploy moves the address but the OLD address's past
  // rounds still consumed slots, so count every current + retired table address. logIndex is unique
  // within a block across all contracts, so the (block, logIndex) sort below is a true chronological
  // merge across sources. No-op until coinFlipTables is set + played.
  const tableAddresses = [
    ...(config.coinFlipTables ? [config.coinFlipTables] : []),
    ...(config.coinFlipTablesRetired ?? []),
  ]
  const [heated, armed, ...rest] = await Promise.all([
    chunkedEvents(publicClient, { address: config.coinFlip, abi: coinFlipAbi as viem.Abi, eventName: 'Heated', fromBlock: from }),
    chunkedEvents(publicClient, { address: config.raffle, abi: raffleAbi as viem.Abi, eventName: 'Armed', fromBlock: from }),
    ...tableAddresses.map((address) =>
      chunkedEvents(publicClient, { address, abi: coinFlipTablesAbi as viem.Abi, eventName: 'RoundOpened', fromBlock: from }),
    ),
  ])
  return [...heated, ...armed, ...rest.flat()]
    .map((log) => ({ key: (log.args as { key: viem.Hex }).key, blockNumber: log.blockNumber, logIndex: log.logIndex }))
    .sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1))
    .map(({ key, blockNumber }) => ({ key, blockNumber }))
}

/**
 * All OperatorCoinFlip heats on its OWN `(token, price)` pool ladder since the deployment origin,
 * chronological — the k-th entry consumed that ladder's pool slot k. This is a SEPARATE counter from
 * heatsSince: OperatorCoinFlip (validator-forfeit build) heats `(table.token, round.tierPrice)`, not the
 * shared native/price-0 pools, so its heats must never be merged into heatsSince (see the regression
 * note there).
 *
 * `RoundOpened` carries `tierPrice` directly; `token` lives on the table, so each round's tableId is
 * resolved to a token with one `tables()` read per distinct (contract address, tableId) pair.
 */
export const heatsSincePriced = async (
  publicClient: ReturnType<typeof makePublicClient>,
  config: Deployment,
  token: viem.Hex,
  price: bigint,
): Promise<{ key: viem.Hex; blockNumber: bigint }[]> => {
  const from = BigInt(config.deployBlock)
  const operatorAddresses = [
    ...(config.operatorCoinFlip ? [config.operatorCoinFlip] : []),
    ...(config.operatorCoinFlipRetired ?? []),
  ]
  const perAddress = await Promise.all(
    operatorAddresses.map((address) =>
      chunkedEvents(publicClient, { address, abi: operatorCoinFlipRoundOpenedAbi as viem.Abi, eventName: 'RoundOpened', fromBlock: from }),
    ),
  )
  const logs = perAddress.flat() as {
    address: viem.Hex
    args: { tableId: viem.Hex; tierPrice: bigint; key: viem.Hex }
    blockNumber: bigint
    logIndex: number
  }[]

  // Cheap filter first (no RPC): only resolve `token` for rounds whose tierPrice already matches.
  const priced = logs.filter((log) => log.args.tierPrice === price)

  const tableTokenCache = new Map<string, viem.Hex>()
  const tokenOf = async (address: viem.Hex, tableId: viem.Hex): Promise<viem.Hex> => {
    const cacheKey = `${address.toLowerCase()}:${tableId}`
    const cached = tableTokenCache.get(cacheKey)
    if (cached) return cached
    const table = (await publicClient.readContract({
      address,
      abi: operatorCoinFlipTablesAbi as viem.Abi,
      functionName: 'tables',
      args: [tableId],
    })) as readonly [viem.Hex, viem.Hex, number, bigint, bigint, boolean]
    const resolved = table[1] // Table.token
    tableTokenCache.set(cacheKey, resolved)
    return resolved
  }

  const matched: { key: viem.Hex; blockNumber: bigint; logIndex: number }[] = []
  for (const log of priced) {
    const logToken = await tokenOf(log.address, log.args.tableId)
    if (logToken.toLowerCase() !== token.toLowerCase()) continue
    matched.push({ key: log.args.key, blockNumber: log.blockNumber, logIndex: log.logIndex })
  }
  return matched
    .sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1))
    .map(({ key, blockNumber }) => ({ key, blockNumber }))
}
