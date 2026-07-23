import * as viem from 'viem'
import { chains, defaultRpc, makePublicClient, type GamesChainId } from '@msgboard/games-core'

declare global {
  interface Window {
    ethereum?: {
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>
    }
  }
}

/** Build the read client for a chain through the core registry (optionally overriding the RPC). */
export const publicClientFor = (chainId: GamesChainId, rpc?: string) => makePublicClient(chainId, rpc)

/** Connect the injected wallet and return a viem wallet client on the requested chain. */
export const connectInjected = async (chainId: GamesChainId): Promise<viem.WalletClient> => {
  if (!window.ethereum) throw new Error('no injected wallet found — install a browser wallet')
  const accounts = (await window.ethereum.request({ method: 'eth_requestAccounts' })) as viem.Hex[]
  if (!accounts[0]) throw new Error('wallet returned no accounts')
  await switchToChain(chainId)
  return viem.createWalletClient({
    account: accounts[0],
    chain: chains[chainId],
    transport: viem.custom(window.ethereum),
  })
}

/** Switch the wallet to the chain, adding it (from the core registry) when unknown (EIP-3085). */
export const switchToChain = async (chainId: GamesChainId) => {
  if (!window.ethereum) return
  const hexId = viem.toHex(chainId)
  try {
    await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hexId }] })
  } catch (error) {
    const code = (error as { code?: number }).code
    if (code !== 4902) throw error
    const chain = chains[chainId]
    await window.ethereum.request({
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId: hexId,
          chainName: chain.name,
          nativeCurrency: chain.nativeCurrency,
          rpcUrls: [defaultRpc[chainId]],
        },
      ],
    })
    await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hexId }] })
  }
}
