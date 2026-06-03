import { SvelteMap } from "svelte/reactivity";
import { parseEther } from "viem";
import { mainnet, pulsechain, pulsechainV4, type Chain } from "viem/chains";

const VITE_RPC_943 = import.meta.env.VITE_RPC_943 as string | undefined
const VITE_RPC_369 = import.meta.env.VITE_RPC_369 as string | undefined
const VITE_RPC_1 = import.meta.env.VITE_RPC_1 as string | undefined

export const chainOptions = ['pulsechainV4', 'pulsechain', 'ethereum', 'custom'] as const

/** default chain definition used when connecting to a custom RPC url */
export const defaultCustomChain = pulsechainV4

export type ChainOption = (typeof chainOptions)[number]

export type ChainConfig = {
  /** the chain object */
  chain: Chain
  /** the rpc url for the chain that is running `msgboard` */
  rpcUrl: string
  /** whether the chain is disabled - if true, the chain will
   * still be shown in the ui buit in a disabled state
   */
  disabled?: boolean
  /** info regarding gas sponsorship - when users ask for gas
   * the following address and amount will be used to sponsor them
   */
  gasSponsor?: {
    address: string
    amount: bigint
  }
}

/** default block range limit for message expiry on the msgboard */
export const BLOCK_RANGE_LIMIT = 120n
/** targeted block time in seconds for pulsechain */
export const BLOCK_TIME_SECONDS = 10

/** returns true when the page is served over https and the url is plain http (excluding localhost which is exempt) */
export const needsProxy = (url: string): boolean => (
  typeof window !== 'undefined'
  && window.location.protocol === 'https:'
  && url.startsWith('http://')
  && !url.startsWith('http://localhost')
  && !url.startsWith('http://127.0.0.1')
)

export const rpcs = new SvelteMap<ChainOption, ChainConfig>([
  ['pulsechainV4', {
    chain: pulsechainV4,
    rpcUrl: VITE_RPC_943 ?? 'https://rpc.v4.testnet.pulsechain.com',
    gasSponsor: { address: '0x5891148fFBea957c1C183313Dc8F63AbEf0f3958', amount: parseEther('10') }
  }],
  ['pulsechain', {
    chain: pulsechain,
    rpcUrl: VITE_RPC_369 ?? 'https://one.valve.city/rpc/vk_demo/evm/369',
  }],
  ['ethereum', {
    chain: mainnet,
    rpcUrl: VITE_RPC_1 ?? 'https://ethereum-rpc.publicnode.com',
  }],
])
