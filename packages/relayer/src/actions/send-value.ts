import {
  type Account,
  type Address,
  type WalletClient,
  createWalletClient,
  formatEther,
} from 'viem'
import type { RelayerAction, RelayerContext } from '../types.js'

export type SendValueActionOptions<T> = {
  /** The funding account (e.g. from `mnemonicToAccount`). */
  account: Account
  /** Derives the recipient address for an item. */
  recipient: (item: T, context: RelayerContext) => Address
  /** Amount to send, in wei. */
  amount: bigint
  /** Gas limit for the transfer. */
  gas: bigint
  /** Overridable wallet-client factory (injected in tests). */
  walletFactory?: (context: RelayerContext) => WalletClient
}

/** Sends native coin to an address derived from each item; waits for the receipt. */
export const sendValueAction = <T>(options: SendValueActionOptions<T>): RelayerAction<T> => {
  const makeWallet = (context: RelayerContext): WalletClient =>
    options.walletFactory?.(context) ??
    createWalletClient({
      account: options.account,
      chain: context.chain,
      transport: context.node.transport,
    })
  return {
    describe: (item, context) =>
      `send ${formatEther(options.amount)} to ${options.recipient(item, context)}`,
    execute: async (item, context) => {
      const wallet = makeWallet(context)
      const to = options.recipient(item, context)
      const hash = await wallet.sendTransaction({
        account: options.account,
        chain: context.chain,
        to,
        value: options.amount,
        gas: options.gas,
      })
      await context.publicClient.waitForTransactionReceipt({ hash })
      return { ok: true, ref: hash }
    },
  }
}
