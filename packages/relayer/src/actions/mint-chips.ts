import { type Account, type Address, type WalletClient, createWalletClient } from 'viem'
import type { RelayerAction, RelayerContext } from '../types.js'

const MINT_ABI = [{
  name: 'mint', type: 'function', stateMutability: 'nonpayable',
  inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [],
}] as const

export type MintChipsActionOptions<T> = {
  account: Account
  chips: Address
  recipient: (item: T, context: RelayerContext) => Address
  amount: bigint
  cap: bigint
  gas?: bigint
  walletFactory?: (context: RelayerContext) => WalletClient
}

/** Owner-mints `min(amount, cap)` of an ERC-20 to an address derived from each item; waits the receipt. */
export const mintChipsAction = <T>(options: MintChipsActionOptions<T>): RelayerAction<T> => {
  const makeWallet = (context: RelayerContext): WalletClient =>
    options.walletFactory?.(context) ??
    createWalletClient({ account: options.account, chain: context.chain, transport: context.node.transport })
  const minted = options.amount < options.cap ? options.amount : options.cap
  return {
    describe: (item, context) => `mint ${minted} chips to ${options.recipient(item, context)}`,
    execute: async (item, context) => {
      const wallet = makeWallet(context)
      const to = options.recipient(item, context)
      const hash = await wallet.writeContract({
        account: options.account, chain: context.chain,
        address: options.chips, abi: MINT_ABI, functionName: 'mint', args: [to, minted],
        ...(options.gas ? { gas: options.gas } : {}),
      })
      await context.publicClient.waitForTransactionReceipt({ hash })
      return { ok: true, ref: hash }
    },
  }
}
