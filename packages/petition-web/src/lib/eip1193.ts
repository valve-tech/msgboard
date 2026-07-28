import type { Hex } from 'viem'

/** Minimal EIP-1193 provider surface we use (MetaMask / Rabbit / any injected wallet). */
export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>
  on?(event: string, handler: (...args: unknown[]) => void): void
  removeListener?(event: string, handler: (...args: unknown[]) => void): void
}

declare global {
  interface Window {
    ethereum?: Eip1193Provider
  }
}

/** The injected provider, or undefined when no wallet is present. */
export const injectedProvider = (): Eip1193Provider | undefined =>
  typeof window !== 'undefined' ? window.ethereum : undefined

/** Normalizes a wallet `eth_chainId` response (hex string) to a number. */
export const parseChainId = (raw: unknown): number => Number(BigInt(raw as string))

/** Best-effort lowercase address normalize for the first account of an accounts array. */
export const firstAccount = (accounts: unknown): Hex | null => {
  if (Array.isArray(accounts) && typeof accounts[0] === 'string') return accounts[0] as Hex
  return null
}
