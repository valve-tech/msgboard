/**
 * liveConfig.ts — the 943 deployment constants, the chain def, default limits, and key derivation
 * shared by the house runner (`main.ts`) and the live-round proof script.
 *
 * SECURITY: this reads the operator MNEMONIC and derives the house key (index 1). In production the
 * house process should hold ONLY the index-1 private key, never the full mnemonic (which also derives
 * the owner at index 0). Deriving from the mnemonic here is a convenience for the local proof run.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { type Chain, type Hex } from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import type { HouseSigner } from './runHouse'
import type { Limits } from './openReview'

/** 943 deployment (mirrors examples/games/web/src/config.ts). */
export const DEPLOYMENT_943 = {
  chainId: 943,
  // Reads + the msgboard_ board module + tx submission all run through the valve.city vk_demo
  // endpoint. Its method allowlist permits eth_sendRawTransaction (web3_clientVersion stays blocked
  // by design). txRpcUrl is kept as a seam in case chain writes ever need a separate endpoint.
  rpcUrl: 'https://one.valve.city/rpc/vk_demo/evm/943',
  txRpcUrl: 'https://one.valve.city/rpc/vk_demo/evm/943',
  boardRpc: 'https://one.valve.city/rpc/vk_demo/evm/943',
  houseChannel: '0x74bbc31e77c02593c0a7aad0cadadb5b6bff3948' as Hex,
  chips: '0xA5276259e544C86438566cB28cc87daCce060910' as Hex,
  gamesIndexer: 'https://games.msgboard.xyz/games-indexer/graphql',
  explorer: 'https://scan.v4.testnet.pulsechain.com/#',
} as const

/** Minimal viem chain for PulseChain Testnet v4. */
export const pulsechainV4: Chain = {
  id: 943,
  name: 'PulseChain Testnet v4',
  nativeCurrency: { name: 'Test Pulse', symbol: 'tPLS', decimals: 18 },
  rpcUrls: { default: { http: [DEPLOYMENT_943.txRpcUrl] } },
}

/**
 * Default open-review limits. `clockBlocks` must sit within the contract's MIN/MAX_CLOCK_BLOCKS — the
 * live-round script reads those on-chain and overrides if needed.
 *
 * NOTE: the contract's open() checks `block.timestamp > terms.expiry`, so terms.expiry is a Unix
 * TIMESTAMP. The house feeds reviewOpen the head block's TIMESTAMP (see runHouse), so `expiryBlocks`
 * is really a SECONDS window here (3600 = 1h is ample for a slow PoW round). The field name is a
 * carryover misnomer to rename later.
 */
export const DEFAULT_LIMITS: Limits = {
  maxEscrowHouse: 10n ** 24n, // 1,000,000 chips cap per table (housePool is 500,000)
  clockBlocks: 100n,
  expiryBlocks: 3_600n, // seconds (1 hour) — NOT blocks; see note above
}

/** Read the operator mnemonic from $MNEMONIC, falling back to games/contracts/.env. */
export function readMnemonic(): string {
  const fromEnv = process.env.MNEMONIC?.trim()
  if (fromEnv) return fromEnv
  // Fallback: parse the contracts package .env (relative to this module → repo .../games/contracts/.env).
  const envPath = fileURLToPath(new URL('../../../games/contracts/.env', import.meta.url))
  const m = readFileSync(envPath, 'utf8').match(/^MNEMONIC=(.+)$/m)
  const mnemonic = m?.[1]?.trim().replace(/^["']|["']$/g, '')
  if (!mnemonic) throw new Error('no MNEMONIC in env or games/contracts/.env')
  return mnemonic
}

/** Redact the key segment of a valve.city RPC URL for logs (`.../rpc/<key>/evm/943` → `<key>` masked). */
export function redactRpc(url: string): string {
  return url.replace(/(\/rpc\/)[^/]+(\/)/, '$1***$2')
}

/** Adapt a viem mnemonic account at `index` to the house signer surface the loop needs. */
export function houseSignerFromMnemonic(mnemonic: string, index = 1): HouseSigner {
  const acct = mnemonicToAccount(mnemonic, { addressIndex: index })
  return {
    address: acct.address,
    signTypedData: (a: Parameters<typeof acct.signTypedData>[0]) => acct.signTypedData(a),
    signMessage: (a: { message: { raw: Hex } }) => acct.signMessage(a),
  }
}
