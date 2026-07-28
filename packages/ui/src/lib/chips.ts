import type { Hex, PublicClient } from 'viem'

/**
 * Reads the play-money "fun-chips" ERC-20 balance (`Chips.balanceOf`) for a wallet address.
 *
 * Kept as a standalone helper (rather than inlined into Arcade.tsx) so the read is trivially
 * mockable in the arcade-faucet test — the balance-poll loop there shouldn't need a real
 * PublicClient/RPC round-trip.
 */
const BALANCE_OF_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const

export async function readChipsBalance(client: PublicClient, chips: Hex, addr: Hex): Promise<bigint> {
  const bal = await client.readContract({
    address: chips,
    abi: BALANCE_OF_ABI,
    functionName: 'balanceOf',
    args: [addr],
  })
  return bal as bigint
}
