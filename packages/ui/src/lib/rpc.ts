import { parseEther } from 'viem'
import { mainnet, pulsechain, pulsechainV4, type Chain } from 'viem/chains'

/**
 * The board RPC url for a built-in chain: ALWAYS the key-safe, same-origin proxy path
 * (`/api/rpc-proxy?chain=<id>`). The preview server substitutes the keyed valve endpoint from its
 * RUNTIME env there, so the unlimited RPC key NEVER reaches the browser bundle. We deliberately do NOT
 * read `import.meta.env.VITE_RPC_*` here: vite inlines any referenced build-time env value into the
 * public bundle, so reading a keyed `VITE_RPC_*` would ship the key to every visitor. Custom absolute
 * endpoints go through the `custom` chain option instead. See the `?chain=` handler in vite.config.ts.
 */
const boardRpcUrl = (chainId: number): string => `/api/rpc-proxy?chain=${chainId}`

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
  /** info regarding chip faucet sponsorship - when users ask for chips
   * the following token address, category, and amount will be used to sponsor them
   */
  chipFaucet?: {
    chips: `0x${string}`
    category: string
    amount: bigint
  }
}

/** default block range limit for message expiry on the msgboard */
export const BLOCK_RANGE_LIMIT = 120n
/** targeted block time in seconds for pulsechain */
export const BLOCK_TIME_SECONDS = 10

/** returns true when the page is served over https and the url is plain http (excluding localhost which is exempt) */
export const needsProxy = (url: string): boolean =>
  typeof window !== 'undefined' &&
  window.location.protocol === 'https:' &&
  url.startsWith('http://') &&
  !url.startsWith('http://localhost') &&
  !url.startsWith('http://127.0.0.1')

export const rpcs = new Map<ChainOption, ChainConfig>([
  [
    'pulsechainV4',
    {
      chain: pulsechainV4,
      rpcUrl: boardRpcUrl(943),
      gasSponsor: {
        address: '0x5891148fFBea957c1C183313Dc8F63AbEf0f3958',
        amount: parseEther('10'),
      },
      chipFaucet: {
        chips: '0x81f130c7d9ff020f46f3b01918424173f8d5ca64',
        category: 'chipsplease:943',
        amount: 1000n * 10n ** 18n,
      },
    },
  ],
  [
    'pulsechain',
    {
      chain: pulsechain,
      rpcUrl: boardRpcUrl(369),
    },
  ],
  [
    'ethereum',
    {
      chain: mainnet,
      rpcUrl: boardRpcUrl(1),
    },
  ],
])
