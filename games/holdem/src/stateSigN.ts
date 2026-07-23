import { hashTypedData, recoverTypedDataAddress, type Hex } from 'viem'

/// A side-pot: an amount earmarked for the seats whose bit is set in `eligibleMask`
/// (bit i set => seat i eligible). Mirrors SidePot in ChannelStateN.sol.
export interface SidePot {
  amount: bigint        // uint256 wei
  eligibleMask: bigint  // uint256 bitmask, bit i => seat i eligible
}

/// The N-party channel state. Generalizes the 2-party ChannelState to N seats:
/// `balances` is a per-seat vector, `sidePots` carries layered all-in pots, and
/// `rakeAccrued` is taken at settle. The conservation invariant everywhere a state
/// is accepted: Σ balances + pot + Σ sidePots.amount + rakeAccrued == Σ escrow.
export interface ChannelStateN {
  tableId: Hex          // bytes32
  nonce: bigint         // uint64, strictly increasing
  balances: bigint[]    // uint256[] per-seat stack
  pot: bigint           // uint256 main pot
  sidePots: SidePot[]   // layered all-in pots
  rakeAccrued: bigint   // uint256, taken at settle
  deckCommitment: Hex   // bytes32 keccak of serialized masked deck
  phase: number         // uint8, game-defined
  gameStateHash: Hex    // bytes32, game package owns the preimage
}

export interface ChannelDomainN {
  name: 'HoldemTableN'; version: '1'; chainId: number; verifyingContract: Hex
}

/** anvil chainId + placeholder address; the contracts plan pins the real domain */
export const TEST_DOMAIN_N: ChannelDomainN = {
  name: 'HoldemTableN', version: '1', chainId: 31337,
  verifyingContract: '0x00000000000000000000000000000000005a6b54',
}

/// EIP-712 type set. The dynamic arrays (`uint256[]` balances, `SidePot[]` sidePots)
/// are the parity-bug-prone part: EIP-712 hashes a `uint256[]` as keccak of the packed
/// 32-byte words, and a struct array as keccak of the concatenated member struct hashes.
/// viem implements this; ChannelStateNLib in HoldemTableN.sol must mirror it byte-for-byte.
export const CHANNEL_STATE_N_TYPES = {
  ChannelStateN: [
    { name: 'tableId', type: 'bytes32' },
    { name: 'nonce', type: 'uint64' },
    { name: 'balances', type: 'uint256[]' },
    { name: 'pot', type: 'uint256' },
    { name: 'sidePots', type: 'SidePot[]' },
    { name: 'rakeAccrued', type: 'uint256' },
    { name: 'deckCommitment', type: 'bytes32' },
    { name: 'phase', type: 'uint8' },
    { name: 'gameStateHash', type: 'bytes32' },
  ],
  SidePot: [
    { name: 'amount', type: 'uint256' },
    { name: 'eligibleMask', type: 'uint256' },
  ],
} as const

export interface StateSigner {
  address: Hex
  signTypedData(args: any): Promise<Hex>
}

/** The production domain: bind to the deployed HoldemTableN. Matches EIP712("HoldemTableN","1"). */
export function makeDomainN(chainId: number, verifyingContract: Hex): ChannelDomainN {
  return { name: 'HoldemTableN', version: '1', chainId, verifyingContract }
}

export function hashStateN(domain: ChannelDomainN, state: ChannelStateN): Hex {
  return hashTypedData({
    domain, types: CHANNEL_STATE_N_TYPES, primaryType: 'ChannelStateN', message: state as any,
  })
}

export async function signStateN(signer: StateSigner, domain: ChannelDomainN, state: ChannelStateN): Promise<Hex> {
  return signer.signTypedData({
    domain, types: CHANNEL_STATE_N_TYPES, primaryType: 'ChannelStateN', message: state,
  })
}

export async function verifyStateSigN(expected: Hex, domain: ChannelDomainN, state: ChannelStateN, sig: Hex): Promise<boolean> {
  try {
    const rec = await recoverTypedDataAddress({
      domain, types: CHANNEL_STATE_N_TYPES, primaryType: 'ChannelStateN', message: state as any, signature: sig,
    })
    return rec.toLowerCase() === expected.toLowerCase()
  } catch { return false }
}

/// Σ balances + pot + Σ sidePots.amount + rakeAccrued. The quantity that must equal
/// the total escrow for any accepted state.
export function totalLocked(state: ChannelStateN): bigint {
  let sum = state.pot + state.rakeAccrued
  for (const b of state.balances) sum += b
  for (const sp of state.sidePots) sum += sp.amount
  return sum
}
