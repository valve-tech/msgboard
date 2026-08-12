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
  randomAbi,
  poolLocationFor,
  type GamesChainId,
  type Info,
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

// --- OperatorCoinFlip validator-forfeit plumbing (validator self-inking + staked pools + chop) ---
//
// The operator game is the ONLY game whose validators STAKE real capital when they ink. A round heats
// the table token at its stake-tier price, so each provider's preimage is bound to (token, tierPrice)
// and a withheld reveal forfeits that stake on chop. The helpers below are shared by the cast-watcher
// (the live service) and the e2e forfeit test, so both derive the SAME Random key from the SAME Info —
// the key is `hash(section(info)+index)` over the whole cohort, so the caster MUST rebuild the exact
// Info the opener heated with, or `cast`/`chop` revert NotInCohort/SecretMismatch.

/** OperatorCoinFlip.TableCreated — enumerate a chain's tables (id + token + stake range) from origin. */
const operatorTableCreatedAbi = [
  {
    type: 'event',
    name: 'TableCreated',
    inputs: [
      { name: 'tableId', type: 'bytes32', indexed: true },
      { name: 'operator', type: 'address', indexed: true },
      { name: 'token', type: 'address', indexed: true },
      { name: 'maxMultiplierX100', type: 'uint16', indexed: false },
      { name: 'minStake', type: 'uint256', indexed: false },
      { name: 'maxStake', type: 'uint256', indexed: false },
    ],
  },
] as const satisfies viem.Abi

/** Minimal ERC-20 surface the caster needs to fund a validator's Random stake custody. */
export const erc20Abi = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: '', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ name: '', type: 'address' }, { name: '', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
] as const satisfies viem.Abi

/**
 * The stake-tier ladder for a table: minStake, minStake<<1, … up to maxStake. Every accepted stake
 * rounds UP to one of these prices (see OperatorCoinFlip._tierPrice), and each price is its OWN
 * (token, price) validator pool ladder.
 */
export const tierLadder = (minStake: bigint, maxStake: bigint): bigint[] => {
  const tiers: bigint[] = []
  for (let price = minStake; price <= maxStake; price <<= 1n) tiers.push(price)
  return tiers
}

/**
 * A validator's staked secret for the operator game, namespaced by (validator, token, price, slot) and
 * derived from the seeds0 seed. Independent of the price-0 HD secret (seeds0Secret) so the two ladders
 * never collide. Nothing is stored: whoever holds seeds0 re-derives every secret. The on-chain preimage
 * is keccak256(secret); `cast`/`chop` are given the secret itself.
 */
export const operatorSecret = (
  seeds0: string,
  validatorIndex: number,
  token: viem.Hex,
  price: bigint,
  slot: number | bigint,
): viem.Hex =>
  viem.keccak256(
    viem.encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }],
      [viem.keccak256(viem.stringToHex(`${seeds0}::operator-forfeit`)), BigInt(validatorIndex), token, price, BigInt(slot)],
    ),
  )

/** The concatenated on-chain preimages (keccak of each secret) for a validator's (token, price) pool. */
export const operatorPoolPreimages = (
  seeds0: string,
  validatorIndex: number,
  token: viem.Hex,
  price: bigint,
  poolStart: bigint,
  poolSize: number,
): viem.Hex =>
  viem.concatHex(
    Array.from({ length: poolSize }, (_p, j) =>
      viem.keccak256(operatorSecret(seeds0, validatorIndex, token, price, poolStart + BigInt(j))),
    ),
  )

/**
 * The canonical heat/cast/chop location for a staked (token, price) pool at chronological slot `k` on
 * its ladder. base offset is 0 — each (token, price) tier is a fresh preimage namespace for the operator
 * game, so pool n sits at offset n*poolSize (core poolLocationFor). The opener and the caster call this
 * identically, so the derived key matches.
 */
export const operatorLocationAt = (
  provider: viem.Hex,
  k: bigint,
  poolSize: bigint,
  token: viem.Hex,
  price: bigint,
): Info => {
  const { offset, index } = poolLocationFor(k, 0n, poolSize)
  return { provider, callAtChange: false, durationIsTimestamp: false, duration: 12n, token, price, offset, index }
}

/** The full cohort of locations for a round at slot `k`, in subset order. */
export const operatorLocationsAt = (
  subset: viem.Hex[],
  k: bigint,
  poolSize: bigint,
  token: viem.Hex,
  price: bigint,
): Info[] => subset.map((provider) => operatorLocationAt(provider, k, poolSize, token, price))

/** Read every table the operator game has created, with its current open flag. */
export const operatorTables = async (
  publicClient: ReturnType<typeof makePublicClient>,
  config: Deployment,
): Promise<{ tableId: viem.Hex; token: viem.Hex; minStake: bigint; maxStake: bigint; open: boolean }[]> => {
  if (!config.operatorCoinFlip) return []
  const logs = (await chunkedEvents(publicClient, {
    address: config.operatorCoinFlip,
    abi: operatorTableCreatedAbi as viem.Abi,
    eventName: 'TableCreated',
    fromBlock: BigInt(config.deployBlock),
  })) as { args: { tableId: viem.Hex; token: viem.Hex; minStake: bigint; maxStake: bigint } }[]
  const seen = new Set<string>()
  const tables: { tableId: viem.Hex; token: viem.Hex; minStake: bigint; maxStake: bigint; open: boolean }[] = []
  for (const log of logs) {
    const { tableId, token, minStake, maxStake } = log.args
    if (seen.has(tableId)) continue
    seen.add(tableId)
    const t = (await publicClient.readContract({
      address: config.operatorCoinFlip,
      abi: operatorCoinFlipTablesAbi as viem.Abi,
      functionName: 'tables',
      args: [tableId],
    })) as readonly [viem.Hex, viem.Hex, number, bigint, bigint, boolean]
    tables.push({ tableId, token, minStake, maxStake, open: t[5] })
  }
  return tables
}

/**
 * Ensure `provider`'s Random custody holds at least `needed` of `token`, funded from the validator's OWN
 * ERC-20 balance (approve Random, then handoff(provider, token, -deficit) signed AS the validator). This
 * is what puts the validator's own capital at stake before it inks. Returns false if the validator can't
 * cover the deficit from its balance (the caster then skips inking that pool).
 */
export const ensureStakeCustody = async (
  publicClient: ReturnType<typeof makePublicClient>,
  validatorWallet: viem.WalletClient,
  random: viem.Hex,
  token: viem.Hex,
  needed: bigint,
): Promise<boolean> => {
  const provider = validatorWallet.account!.address
  const custody = (await publicClient.readContract({
    address: random,
    abi: randomAbi,
    functionName: 'balanceOf',
    args: [provider, token],
  })) as bigint
  if (custody >= needed) return true
  const deficit = needed - custody
  const balance = (await publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [provider] })) as bigint
  if (balance < deficit) return false
  const allowance = (await publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [provider, random] })) as bigint
  if (allowance < deficit) {
    await sendAs(publicClient, validatorWallet, { address: token, abi: erc20Abi, functionName: 'approve', args: [random, viem.maxUint256] })
  }
  await sendAs(publicClient, validatorWallet, { address: random, abi: randomAbi, functionName: 'handoff', args: [provider, token, -deficit] })
  return true
}

/**
 * Self-ink one validator's staked (token, price) pool at `poolStart` if it does not exist yet. Funds the
 * validator's stake custody first (poolSize*price), then inks FROM THE VALIDATOR'S OWN KEY so the debited
 * stake is the validator's own. Idempotent: a pool whose pointer is already set is left alone.
 */
export const inkValidatorStakedPool = async (
  publicClient: ReturnType<typeof makePublicClient>,
  validatorWallet: viem.WalletClient,
  random: viem.Hex,
  seeds0: string,
  validatorIndex: number,
  token: viem.Hex,
  price: bigint,
  poolStart: bigint,
  poolSize: number,
): Promise<'inked' | 'exists' | 'underfunded'> => {
  const provider = validatorWallet.account!.address as viem.Hex
  const probe: Info = { provider, callAtChange: false, durationIsTimestamp: false, duration: 12n, token, price, offset: poolStart, index: 0n }
  const pointer = (await publicClient.readContract({ address: random, abi: randomAbi, functionName: 'pointer', args: [probe] })) as viem.Hex
  if (pointer !== viem.zeroAddress) return 'exists'
  const needed = price * BigInt(poolSize)
  if (!(await ensureStakeCustody(publicClient, validatorWallet, random, token, needed))) return 'underfunded'
  const preimages = operatorPoolPreimages(seeds0, validatorIndex, token, price, poolStart, poolSize)
  await sendAs(publicClient, validatorWallet, {
    address: random,
    abi: randomAbi,
    functionName: 'ink',
    args: [{ ...probe, offset: 0n }, preimages],
  })
  return 'inked'
}
