import {
  type Chain,
  type Hex,
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  http,
  isAddressEqual,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { pulsechain, pulsechainV4 } from 'viem/chains'
import { PROXY_FACTORY_ABI, SAFE_V141 } from './constants.js'

export type RelayChainId = 943 | 369

type ChainConfig = {
  chain: Chain
  keyEnv: string
  rpcEnv: string
  defaultRpc: string
}

const CHAIN_CONFIG: Record<RelayChainId, ChainConfig> = {
  943: {
    chain: pulsechainV4,
    keyEnv: 'RELAY_KEY_943',
    rpcEnv: 'RPC_943',
    defaultRpc: 'https://one.valve.city/rpc/vk_demo/evm/943',
  },
  369: {
    chain: pulsechain,
    keyEnv: 'RELAY_KEY_369',
    rpcEnv: 'RPC_369',
    defaultRpc: 'https://one.valve.city/rpc/vk_demo/evm/369',
  },
}

function rpcUrl(chainId: RelayChainId): string {
  const cfg = CHAIN_CONFIG[chainId]
  return process.env[cfg.rpcEnv] ?? cfg.defaultRpc
}

/** Reads the relay's funded key for a chain from env. NEVER log the return value. */
function relayKey(chainId: RelayChainId): Hex | undefined {
  const cfg = CHAIN_CONFIG[chainId]
  const key = process.env[cfg.keyEnv]
  return key ? (key as Hex) : undefined
}

/** The chain ids this relay instance will submit to — i.e. which have a funded key configured. */
export function enabledChains(): RelayChainId[] {
  return ([943, 369] as const).filter((id) => relayKey(id) !== undefined)
}

/** The relay's sponsor address for a chain, or undefined if no key is configured for it. */
export function sponsorAddress(chainId: RelayChainId): Hex | undefined {
  const key = relayKey(chainId)
  return key ? privateKeyToAccount(key).address : undefined
}

export type SponsorInfo = { chainId: RelayChainId; address: Hex; balance: string }

/**
 * The relay's sponsor address + native balance for every enabled chain — surfaced by `GET /config`
 * so users can see how much gas is left and top it up themselves. NEVER exposes the key. NEVER
 * throws: an RPC hiccup on one chain just reports that chain's balance as `'0'` rather than failing
 * the whole response.
 */
export async function sponsorInfo(): Promise<SponsorInfo[]> {
  const out: SponsorInfo[] = []
  for (const chainId of enabledChains()) {
    const address = sponsorAddress(chainId)
    if (!address) continue
    let balance = '0'
    try {
      const cfg = CHAIN_CONFIG[chainId]
      const publicClient = createPublicClient({ chain: cfg.chain, transport: http(rpcUrl(chainId)) })
      balance = (await publicClient.getBalance({ address })).toString()
    } catch {
      // RPC hiccup — report the sponsor address with a '0' balance rather than failing /config.
    }
    out.push({ chainId, address, balance })
  }
  return out
}

/**
 * Submits `createProxyWithNonce` on `chainId`, paying gas from that chain's relay key, and waits
 * for the receipt. Returns the tx hash and the proxy address parsed from the `ProxyCreation` log.
 * NEVER logs the relay key.
 */
export async function submitDeploy(args: { chainId: RelayChainId; initializer: Hex; saltNonce: bigint }): Promise<{ txHash: Hex; proxy: Hex }> {
  const { chainId, initializer, saltNonce } = args
  const key = relayKey(chainId)
  if (!key) throw new Error(`no relay key configured for chain ${chainId}`)
  const cfg = CHAIN_CONFIG[chainId]
  const account = privateKeyToAccount(key)
  const transport = http(rpcUrl(chainId))
  const walletClient = createWalletClient({ account, chain: cfg.chain, transport })
  const publicClient = createPublicClient({ chain: cfg.chain, transport })

  const txHash = await walletClient.writeContract({
    address: SAFE_V141.factory,
    abi: PROXY_FACTORY_ABI,
    functionName: 'createProxyWithNonce',
    args: [SAFE_V141.singletonL2, initializer, saltNonce],
  })

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash })
  if (receipt.status !== 'success') throw new Error('deploy transaction reverted')

  for (const log of receipt.logs) {
    if (!isAddressEqual(log.address, SAFE_V141.factory)) continue
    try {
      const event = decodeEventLog({ abi: PROXY_FACTORY_ABI, topics: log.topics, data: log.data })
      if (event.eventName === 'ProxyCreation') {
        return { txHash, proxy: event.args.proxy }
      }
    } catch {
      // not a ProxyCreation log — skip
    }
  }
  throw new Error('deploy transaction produced no ProxyCreation event')
}
