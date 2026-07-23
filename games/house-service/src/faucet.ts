/**
 * faucet.ts — owner-mints Chips tokens up to a cap.
 *
 * Thin writeContract wrapper. The cap prevents a misconfigured faucet from draining
 * the house's token supply in a single call.
 */
import type { Hex } from 'viem'

/** Minimal walletClient surface needed for minting. */
export interface FaucetWalletClient {
  writeContract(args: {
    address: Hex
    abi: readonly unknown[]
    functionName: string
    args: [Hex, bigint]
  }): Promise<Hex>
}

/** Chips ERC-20 mint ABI fragment (owner-only). */
const MINT_ABI = [
  {
    name: 'mint',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
] as const

/**
 * Mint `min(amount, cap)` Chips tokens to `to` via the owner wallet.
 * Returns the transaction hash.
 */
export async function faucetMint(opts: {
  walletClient: FaucetWalletClient
  chips: Hex
  to: Hex
  amount: bigint
  cap: bigint
}): Promise<Hex> {
  const { walletClient, chips, to, amount, cap } = opts
  if (amount < 0n) throw new Error('faucetMint: amount must not be negative')
  const mintAmount = amount < cap ? amount : cap
  return walletClient.writeContract({
    address: chips,
    abi: MINT_ABI,
    functionName: 'mint',
    args: [to, mintAmount],
  })
}
