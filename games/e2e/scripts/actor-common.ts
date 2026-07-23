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
  raffleAbi,
  type GamesChainId,
} from '@msgboard/games-core'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))

export type Deployment = {
  chainId: number
  coinFlip: viem.Hex
  raffle: viem.Hex
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

/** All heats since the deployment origin, chronological — the k-th consumed pool slot k. */
export const heatsSince = async (
  publicClient: ReturnType<typeof makePublicClient>,
  config: Deployment,
): Promise<{ key: viem.Hex; blockNumber: bigint }[]> => {
  const from = BigInt(config.deployBlock)
  const [heated, armed] = await Promise.all([
    chunkedEvents(publicClient, { address: config.coinFlip, abi: coinFlipAbi as viem.Abi, eventName: 'Heated', fromBlock: from }),
    chunkedEvents(publicClient, { address: config.raffle, abi: raffleAbi as viem.Abi, eventName: 'Armed', fromBlock: from }),
  ])
  return [...heated, ...armed]
    .map((log) => ({ key: (log.args as { key: viem.Hex }).key, blockNumber: log.blockNumber, logIndex: log.logIndex }))
    .sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1))
    .map(({ key, blockNumber }) => ({ key, blockNumber }))
}
