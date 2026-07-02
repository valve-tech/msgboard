import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  createWalletClient,
  createPublicClient,
  custom,
  type Hex,
  type PublicClient,
  type TypedDataDefinition,
} from 'viem'
import { type Eip1193Provider, injectedProvider, parseChainId, firstAccount } from '../lib/eip1193'
import { EXEC_TRANSACTION_ABI } from '../lib/safe-typed-data'
import { SAFE_V141, PROXY_FACTORY_ABI } from '../lib/deploy-safe'

export interface UseWallet {
  available: boolean
  address: Hex | null
  chainId: number | null
  connecting: boolean
  error: string | null
  connect: () => Promise<void>
  /** Personal-message sign of the raw 32-byte digest → an eth_sign-style (ECDSA scheme) signature. */
  signRawDigest: (digest: Hex) => Promise<Hex>
  /** EIP-712 typed-data sign (EIP712 scheme). */
  signTyped: (typedData: TypedDataDefinition) => Promise<Hex>
  /** A read-only viem client over the wallet provider (satisfies the adapter's SafePublicClient). */
  publicClient: () => PublicClient
  /** Submits a Safe `execTransaction` via the wallet (experimental). Returns the tx hash. */
  submitExecTransaction: (
    safe: Hex,
    args: readonly [Hex, bigint, Hex, number, bigint, bigint, bigint, Hex, Hex, Hex],
  ) => Promise<Hex>
  /** Deploys a new Safe v1.4.1 via createProxyWithNonce on the canonical factory. Returns the tx hash. */
  deploySafe: (initializer: Hex, saltNonce: bigint) => Promise<Hex>
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

  const signRawDigest = useCallback(
    async (digest: Hex): Promise<Hex> => {
      const { p, account } = require()
      const wallet = createWalletClient({ account, transport: custom(p) })
      return wallet.signMessage({ account, message: { raw: digest } })
    },
    [require],
  )

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

  const submitExecTransaction = useCallback(
    async (
      safe: Hex,
      args: readonly [Hex, bigint, Hex, number, bigint, bigint, bigint, Hex, Hex, Hex],
    ): Promise<Hex> => {
      const { p, account } = require()
      const wallet = createWalletClient({ account, transport: custom(p) })
      return wallet.writeContract({
        account,
        chain: null,
        address: safe,
        abi: EXEC_TRANSACTION_ABI,
        functionName: 'execTransaction',
        args,
      })
    },
    [require],
  )

  const deploySafe = useCallback(
    async (initializer: Hex, saltNonce: bigint): Promise<Hex> => {
      const { p, account } = require()
      const wallet = createWalletClient({ account, transport: custom(p) })
      return wallet.writeContract({
        account,
        chain: null,
        address: SAFE_V141.factory,
        abi: PROXY_FACTORY_ABI,
        functionName: 'createProxyWithNonce',
        args: [SAFE_V141.singletonL2, initializer, saltNonce],
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
    signRawDigest,
    signTyped,
    publicClient,
    submitExecTransaction,
    deploySafe,
  }
}
