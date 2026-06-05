import { http, type Address } from 'viem'
import { pulsechain, pulsechainV4 } from 'viem/chains'
import {
  Relayer,
  bridgeAffirmationSource,
  memoryTtlStore,
  submitMessageAction,
} from '@msgboard/relayer'

const rpcByChain: Record<number, string> = {
  [pulsechainV4.id]:
    process.env.RPC_943 || process.env.VITE_RPC_943 || 'https://rpc.v4.testnet.pulsechain.com',
  [pulsechain.id]:
    process.env.RPC_369 || process.env.VITE_RPC_369 || 'https://rpc.pulsechain.com',
}

const bridgeByChain: Record<number, Address> = {
  [pulsechainV4.id]: '0xf902DE27606cd3A7F66695c77487769Ff96211fE',
  [pulsechain.id]: '0x6ef79FD6f9f840264332884240539Ed7A2dA8b2b',
}

const disabledChains = new Set(
  (process.env.DISABLED_CHAINS ?? '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter(Boolean),
)

const mode = process.env.BRIDGE_LIVE ? 'live' : 'observe'

const startForChain = (chainId: number): void => {
  if (disabledChains.has(chainId)) {
    console.log('chain %d is disabled, skipping', chainId)
    return
  }
  const relayer = new Relayer<Address>({
    node: { transport: http(rpcByChain[chainId]) },
    mode,
    intervalMs: 120_000,
    source: bridgeAffirmationSource({ bridgeAddress: bridgeByChain[chainId] }),
    key: (address) => address.toLowerCase(),
    store: memoryTtlStore<Address>({ ttlMs: 10 * 60 * 1000 }),
    action: submitMessageAction<Address>({
      category: () => 'gasmoneyplease',
      data: (address) => address,
    }),
  })
  console.log('[%d] starting bridge relayer (mode=%s)', chainId, mode)
  relayer.start()
}

const main = () => {
  startForChain(pulsechainV4.id)
  startForChain(pulsechain.id)
}

main()
