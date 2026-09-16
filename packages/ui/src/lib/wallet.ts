import type { EIP1193Provider } from 'viem'

export function getInjectedProvider(): EIP1193Provider | undefined {
  const w = globalThis as unknown as { window?: { ethereum?: EIP1193Provider } }
  return w.window?.ethereum
}

/** Minimal injected-wallet connect: request accounts + read chainId. Throws if no wallet. */
export async function connectInjectedWallet(): Promise<{ address: `0x${string}`; chainId: number }> {
  const provider = getInjectedProvider()
  if (!provider) throw new Error('No injected wallet found — install a wallet to receive chips.')
  const accounts = (await provider.request({ method: 'eth_requestAccounts' })) as string[]
  const address = accounts?.[0] as `0x${string}` | undefined
  if (!address) throw new Error('No account authorized.')
  const chainIdHex = (await provider.request({ method: 'eth_chainId' })) as string
  return { address, chainId: Number(BigInt(chainIdHex)) }
}
