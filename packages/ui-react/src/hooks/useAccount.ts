import { useEffect, useRef, useState } from 'react'
import { createPublicClient, http, formatEther, type Hex, type PublicClient } from 'viem'
import { useChainStore, selectChain, selectTransportUrl } from '../stores/chain'
import { useTerminalStore, Log } from '../stores/terminal'

/**
 * Read-only "account" (replaces `web3.svelte.ts`; NO wagmi — gasless / no wallet).
 *
 * `address` is typed in by the user. Balance is fetched with a read-only viem client on the
 * proxy-aware `transportUrl` and polled every 10s — but only while an address is set
 * (matching the Svelte no-op-unless-set behavior). `gasSymbol` comes from the active chain.
 */
export type UseAccount = {
  address: Hex | null
  setAddress: (address: Hex | null) => void
  balance: bigint | null
  gasSymbol: string | null
}

export const useAccount = (): UseAccount => {
  const [address, setAddress] = useState<Hex | null>(null)
  const [balance, setBalance] = useState<bigint | null>(null)
  const transportUrl = useChainStore((s) => selectTransportUrl(s))
  const gasSymbol = useChainStore((s) => selectChain(s)?.nativeCurrency.symbol ?? null)
  const lastBalance = useRef<bigint | null>(null)

  useEffect(() => {
    if (!address || !transportUrl) {
      setBalance(null)
      lastBalance.current = null
      return
    }
    const chain = selectChain(useChainStore.getState())
    const client = createPublicClient({ chain, transport: http(transportUrl) }) as PublicClient
    let cancelled = false

    const update = async () => {
      try {
        const bal = await client.getBalance({ address })
        if (cancelled || bal === lastBalance.current) return
        lastBalance.current = bal
        setBalance(bal)
        useTerminalStore.getState().printToTerminal(new Log(`balance updated: ${formatEther(bal)}`))
      } catch {
        /* transient rpc failure — keep the last known balance */
      }
    }

    void update()
    const id = setInterval(() => void update(), 10_000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [address, transportUrl])

  return { address, setAddress, balance, gasSymbol }
}
