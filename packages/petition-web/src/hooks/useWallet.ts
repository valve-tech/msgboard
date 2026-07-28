import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  createWalletClient,
  createPublicClient,
  custom,
  type Hex,
  type PublicClient,
  type TypedDataDefinition,
} from 'viem'
import { PETITION_SIGNATURES_ABI } from '@msgboard/petition'
import { type Eip1193Provider, injectedProvider, parseChainId, firstAccount } from '../lib/eip1193'

export interface SettleFees {
  maxFeePerGas: bigint
  maxPriorityFeePerGas: bigint
}

export interface UseWallet {
  available: boolean
  address: Hex | null
  chainId: number | null
  connecting: boolean
  error: string | null
  connect: () => Promise<void>
  /** EIP-712 typed-data sign — used to sign a petition's digest (EIP712 scheme, no scheme choice here). */
  signTyped: (typedData: TypedDataDefinition) => Promise<Hex>
  /** A read-only viem client over the wallet provider (used to read the current base fee for settle). */
  publicClient: () => PublicClient
  /**
   * Submits `submitBatch(petitionId, statement, signers, signatures)` to the PetitionSignatures
   * verifier at `address`, with EXPLICIT EIP-1559 fees (never the node's auto-estimate — on
   * PulseChain that under/over-prices and the tx never mines). Returns the tx hash.
   */
  submitBatch: (
    address: Hex,
    args: readonly [Hex, string, Hex[], Hex[]],
    fees: SettleFees,
  ) => Promise<Hex>
}

export function useWallet(): UseWallet {
  const provider = useMemo<Eip1193Provider | undefined>(() => injectedProvider(), [])
  const [address, setAddress] = useState<Hex | null>(null)
  const [chainId, setChainId] = useState<number | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refreshChain = useCallback(async (p: Eip1193Provider) => {
    try {
      setChainId(parseChainId(await p.request({ method: 'eth_chainId' })))
    } catch {
      /* ignore — chain id is informational until a sign is attempted */
    }
  }, [])

  const connect = useCallback(async () => {
    if (!provider) {
      setError('No injected wallet found. Install a browser wallet (e.g. MetaMask).')
      return
    }
    setConnecting(true)
    setError(null)
    try {
      const accounts = await provider.request({ method: 'eth_requestAccounts' })
      setAddress(firstAccount(accounts))
      await refreshChain(provider)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Wallet connection rejected')
    } finally {
      setConnecting(false)
    }
  }, [provider, refreshChain])

  useEffect(() => {
    if (!provider?.on || !provider.removeListener) return
    const onAccounts = (...a: unknown[]) => setAddress(firstAccount(a[0]))
    const onChain = (...a: unknown[]) => setChainId(parseChainId(a[0]))
    provider.on('accountsChanged', onAccounts)
    provider.on('chainChanged', onChain)
    return () => {
      provider.removeListener?.('accountsChanged', onAccounts)
      provider.removeListener?.('chainChanged', onChain)
    }
  }, [provider])

  const require = useCallback((): { p: Eip1193Provider; account: Hex } => {
    if (!provider) throw new Error('No wallet available')
    if (!address) throw new Error('Wallet not connected')
    return { p: provider, account: address }
  }, [provider, address])

  const signTyped = useCallback(
    async (typedData: TypedDataDefinition): Promise<Hex> => {
      const { p, account } = require()
      const wallet = createWalletClient({ account, transport: custom(p) })
      return wallet.signTypedData({ account, ...typedData })
    },
    [require],
  )

  const publicClient = useCallback((): PublicClient => {
    if (!provider) throw new Error('No wallet available')
    return createPublicClient({ transport: custom(provider) }) as PublicClient
  }, [provider])

  const submitBatch = useCallback(
    async (address: Hex, args: readonly [Hex, string, Hex[], Hex[]], fees: SettleFees): Promise<Hex> => {
      const { p, account } = require()
      const wallet = createWalletClient({ account, transport: custom(p) })
      return wallet.writeContract({
        account,
        chain: null,
        address,
        abi: PETITION_SIGNATURES_ABI,
        functionName: 'submitBatch',
        args,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      })
    },
    [require],
  )

  return {
    available: !!provider,
    address,
    chainId,
    connecting,
    error,
    connect,
    signTyped,
    publicClient,
    submitBatch,
  }
}
