import { useCallback, useState } from 'react'
import * as viem from 'viem'
import type { GamesChainId } from '@msgboard/games-core'
import { connectInjected } from '../wallet'

export type WalletState = {
  walletClient?: viem.WalletClient
  address?: viem.Hex
  error?: string
  connecting: boolean
}

export const useWallet = (chainId: GamesChainId) => {
  const [state, setState] = useState<WalletState>({ connecting: false })

  const connect = useCallback(async () => {
    setState((s) => ({ ...s, connecting: true, error: undefined }))
    try {
      const walletClient = await connectInjected(chainId)
      setState({ walletClient, address: walletClient.account!.address, connecting: false })
    } catch (error) {
      setState({ connecting: false, error: error instanceof Error ? error.message : String(error) })
    }
  }, [chainId])

  const disconnect = useCallback(() => setState({ connecting: false }), [])

  return { ...state, connect, disconnect }
}
