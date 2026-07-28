import { createPublicClient, http, type PublicClient } from 'viem'
import { pulsechain, pulsechainV4 } from 'viem/chains'
import * as msgboard from '@msgboard/sdk'

/**
 * A MsgBoard endpoint that hosts petition descriptors + co-signatures. Chain default is 369
 * (real users); 943 is selectable for bots/demo. Mirrors packages/cosign-web's BOARD_ENDPOINTS.
 */
export interface BoardEndpoint {
  label: string
  chainId: number
  rpc: string
}

export const BOARD_ENDPOINTS: BoardEndpoint[] = [
  { label: 'PulseChain mainnet', chainId: pulsechain.id, rpc: 'https://one.valve.city/rpc/vk_demo/evm/369' },
  { label: 'PulseChain v4 testnet', chainId: pulsechainV4.id, rpc: 'https://one.valve.city/rpc/vk_demo/evm/943' },
]

const chainFor = (chainId: number) => (chainId === pulsechain.id ? pulsechain : pulsechainV4)

/** The board's current PoW difficulty factors. Core's defaults are the safe fallback. */
export interface BoardFactors {
  workMultiplier: number
  workDivisor: number
  enabled: boolean
}

export const DEFAULT_FACTORS: BoardFactors = { workMultiplier: 10_000, workDivisor: 1_000_000, enabled: false }

/**
 * Reads `msgboard_status` to learn the board's live difficulty factors + availability. Returns
 * the core defaults (and `enabled: false`) on any failure so the UI can still render a warning.
 */
export async function fetchBoardFactors(rpc: string, chainId: number): Promise<BoardFactors> {
  try {
    const provider = createPublicClient({ chain: chainFor(chainId), transport: http(rpc) }) as PublicClient
    const client = new msgboard.MsgBoardClient(provider as unknown as msgboard.Provider)
    const status = await client.status()
    return {
      workMultiplier: Number(BigInt(status.workMultiplier)),
      workDivisor: Number(BigInt(status.workDivisor)),
      enabled: !!status.enabled,
    }
  } catch {
    return DEFAULT_FACTORS
  }
}
