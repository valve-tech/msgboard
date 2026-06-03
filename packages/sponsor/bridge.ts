import { MsgBoardClient, type Provider } from "@msgboard/sdk"
import { type Chain, createPublicClient, getContract, http, parseAbi, parseEventLogs, type PublicClient, stringToHex } from "viem"
import { pulsechain, pulsechainV4 } from "viem/chains"

const rpcs = new Map<number, string>([
  [pulsechainV4.id, process.env.RPC_943 || process.env.VITE_RPC_943 || 'https://rpc.v4.testnet.pulsechain.com'],
  [pulsechain.id, process.env.RPC_369 || process.env.VITE_RPC_369 || 'https://rpc.pulsechain.com'],
])

/** comma-separated list of chain ids to skip, e.g. DISABLED_CHAINS="369" or DISABLED_CHAINS="369,943" */
const disabledChains = new Set(
  (process.env.DISABLED_CHAINS ?? '').split(',').map((s) => Number(s.trim())).filter(Boolean),
)

/** tracks recently submitted addresses per chain to avoid redundant PoW */
const recentlySubmitted = new Map<number, Map<string, number>>()

/** how long to remember a submitted address before allowing resubmission */
const DEDUP_TTL_MS = 10 * 60 * 1_000 // 10 minutes

const wasRecentlySubmitted = (chainId: number, address: string): boolean => {
  const chainCache = recentlySubmitted.get(chainId)
  if (!chainCache) return false
  const submittedAt = chainCache.get(address.toLowerCase())
  if (!submittedAt) return false
  if (Date.now() - submittedAt > DEDUP_TTL_MS) {
    chainCache.delete(address.toLowerCase())
    return false
  }
  return true
}

const markSubmitted = (chainId: number, address: string) => {
  if (!recentlySubmitted.has(chainId)) {
    recentlySubmitted.set(chainId, new Map())
  }
  recentlySubmitted.get(chainId)!.set(address.toLowerCase(), Date.now())
}

const doWorkForChain = async (chain: Chain) => {
  if (disabledChains.has(chain.id)) {
    console.log('[%s] chain %d is disabled, skipping', chain.name, chain.id)
    return
  }
  const bridgeAddress = chainToAddress.get(chain.id)
  if (!bridgeAddress) {
    console.log('[%s] no bridge contract configured, skipping', chain.name)
    return
  }
  const rpc = rpcs.get(chain.id)
  const provider = createPublicClient({
    transport: http(rpc ?? chain.rpcUrls.default.http[0], { timeout: 30_000 }),
    chain,
  })
  const client = new MsgBoardClient(provider as Provider)
  const category = stringToHex('gasmoneyplease', { size: 32 })

  console.log('[%s] starting bridge monitor...', chain.name)
  while (true) {
    try {
      const bridgerAddress = await getRecentBridges(provider as PublicClient)
      if (!bridgerAddress) {
        console.log('[%s] no recent bridgers found', chain.name)
      } else if (wasRecentlySubmitted(chain.id, bridgerAddress)) {
        console.log('[%s] bridger %o already submitted recently, skipping', chain.name, bridgerAddress)
      } else {
        console.log('[%s] working for bridger %o...', chain.name, bridgerAddress)
        const work = await client.doPoW(category, bridgerAddress)
        const added = await client.addMessage(work.message).catch((e) => {
          console.log('[%s] error adding message %o', chain.name, e)
          return null
        })
        if (added !== null) {
          markSubmitted(chain.id, bridgerAddress)
        }
        console.log('[%s] message added failed=%o hash=%o stats=%o', chain.name, added === null, work.message.hash, work.stats)
      }
    } catch (e) {
      console.error('[%s] loop iteration failed, retrying: %o', chain.name, e instanceof Error ? e.message : e)
    }
    await new Promise((resolve) => setTimeout(resolve, 120_000))
  }
}

const chainToAddress = new Map<number, `0x${string}`>([
  [pulsechainV4.id, '0xf902DE27606cd3A7F66695c77487769Ff96211fE'],
  [pulsechain.id, '0x6ef79FD6f9f840264332884240539Ed7A2dA8b2b'],
])

const getRecentBridges = async (provider: PublicClient) => {
  const bridgeAddress = chainToAddress.get(provider.chain!.id)
  if (!bridgeAddress) return null
  const bridgeAbi = parseAbi([
    'event AffirmationCompleted(address sender, address executor, bytes32 messageId, bool status)',
  ])
  const contract = getContract({
    address: bridgeAddress,
    abi: bridgeAbi,
    client: provider,
  })
  const finalized = await provider.getBlock({
    blockTag: 'finalized',
  })
  const events = await contract.getEvents.AffirmationCompleted({
    fromBlock: finalized.number - 1_000n,
  })
  if (events.length === 0) {
    return null
  }
  const latestTx = events[events.length - 1].transactionHash
  const receipt = await provider.getTransactionReceipt({
    hash: latestTx,
  })
  const transferAbi = parseAbi([
    'event Transfer(address indexed from, address indexed to, uint256 amount)',
    'event Mint(address indexed to, uint256 amount)',
  ])
  const transfer = parseEventLogs({
    abi: transferAbi,
    logs: receipt.logs,
  })
  return transfer.map((t) => t.args.to).at(0) ?? null
}

const main = async () => {
  await Promise.all([
    doWorkForChain(pulsechainV4),
    doWorkForChain(pulsechain),
  ])
}

main()
