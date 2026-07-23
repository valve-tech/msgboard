import { hashTypedData, recoverTypedDataAddress, type Hex } from 'viem'

export interface ChannelState {
  tableId: Hex          // bytes32
  nonce: bigint         // uint64, strictly increasing
  balanceA: bigint      // uint256 wei
  balanceB: bigint
  pot: bigint           // in-flight pot (incl. war carry); invariant: A+B+pot == escrow
  deckCommitment: Hex   // bytes32 keccak of serialized masked deck
  phase: number         // uint8, game-defined
  gameStateHash: Hex    // bytes32, game package owns the preimage
}

export interface ChannelDomain {
  name: 'ZkTable'; version: '1'; chainId: number; verifyingContract: Hex
}
/** anvil chainId + placeholder address; the contracts plan pins the real domain */
export const TEST_DOMAIN: ChannelDomain = {
  name: 'ZkTable', version: '1', chainId: 31337,
  verifyingContract: '0x00000000000000000000000000000000005a6b54',
}

export const CHANNEL_STATE_TYPES = {
  ChannelState: [
    { name: 'tableId', type: 'bytes32' },
    { name: 'nonce', type: 'uint64' },
    { name: 'balanceA', type: 'uint256' },
    { name: 'balanceB', type: 'uint256' },
    { name: 'pot', type: 'uint256' },
    { name: 'deckCommitment', type: 'bytes32' },
    { name: 'phase', type: 'uint8' },
    { name: 'gameStateHash', type: 'bytes32' },
  ],
} as const

export interface StateSigner {
  address: Hex
  signTypedData(args: any): Promise<Hex>
}

/** The production domain: bind to the deployed ZkTable. Matches EIP712("ZkTable","1") on-chain. */
export function makeDomain(chainId: number, verifyingContract: Hex): ChannelDomain {
  return { name: 'ZkTable', version: '1', chainId, verifyingContract }
}

export function hashState(domain: ChannelDomain, state: ChannelState): Hex {
  return hashTypedData({ domain, types: CHANNEL_STATE_TYPES, primaryType: 'ChannelState', message: state as any })
}
export async function signState(signer: StateSigner, domain: ChannelDomain, state: ChannelState): Promise<Hex> {
  return signer.signTypedData({ domain, types: CHANNEL_STATE_TYPES, primaryType: 'ChannelState', message: state })
}
export async function verifyStateSig(expected: Hex, domain: ChannelDomain, state: ChannelState, sig: Hex): Promise<boolean> {
  try {
    const rec = await recoverTypedDataAddress({
      domain, types: CHANNEL_STATE_TYPES, primaryType: 'ChannelState', message: state as any, signature: sig,
    })
    return rec.toLowerCase() === expected.toLowerCase()
  } catch { return false }
}
