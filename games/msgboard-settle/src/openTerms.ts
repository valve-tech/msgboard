import { encodeAbiParameters, keccak256, recoverTypedDataAddress, type Hex } from 'viem'
import { makeDomain, type GameDomain, type StateSigner } from '@msgboard/games'

/** Mirrors HouseChannel.sol OpenTermsLib TYPEHASH field order exactly. */
export interface OpenTerms {
  tableId: Hex
  player: Hex
  playerKey: Hex
  escrowPlayer: bigint
  escrowHouse: bigint
  gameId: number
  rngCommit: Hex
  clockBlocks: bigint
  expiry: bigint
  clientSeedCommit: Hex
  paramsHash: Hex
}

export const OPEN_TERMS_TYPES = {
  OpenTerms: [
    { name: 'tableId', type: 'bytes32' },
    { name: 'player', type: 'address' },
    { name: 'playerKey', type: 'address' },
    { name: 'escrowPlayer', type: 'uint256' },
    { name: 'escrowHouse', type: 'uint256' },
    { name: 'gameId', type: 'uint8' },
    { name: 'rngCommit', type: 'bytes32' },
    { name: 'clockBlocks', type: 'uint64' },
    { name: 'expiry', type: 'uint64' },
    { name: 'clientSeedCommit', type: 'bytes32' },
    { name: 'paramsHash', type: 'bytes32' },
  ],
} as const

/** paramsHash for a single-uint256-target game (dice/limbo). MUST match Solidity
 *  keccak256(abi.encode(uint256 targetX100)) — abi.encode (32-byte padded), NOT encodePacked. */
export function paramsHashOf(targetX100: bigint): Hex {
  const encoded = encodeAbiParameters([{ type: 'uint256' }], [targetX100])
  return keccak256(encoded)
}

/** The EIP-712 domain for the settlement contracts (same name/version as SessionState).
 *  `verifyingContract` is the HouseBankroll or HouseChannel address. */
export function makeSettleDomain(chainId: number, verifyingContract: Hex): GameDomain {
  return makeDomain(chainId, verifyingContract)
}

/** House signs OpenTerms with its session key; the player presents this sig to HouseChannel.open. */
export async function signOpenTerms(signer: StateSigner, domain: GameDomain, terms: OpenTerms): Promise<Hex> {
  return signer.signTypedData({ domain, types: OPEN_TERMS_TYPES, primaryType: 'OpenTerms', message: terms })
}

export async function verifyOpenTermsSig(expected: Hex, domain: GameDomain, terms: OpenTerms, sig: Hex): Promise<boolean> {
  try {
    const rec = await recoverTypedDataAddress({ domain, types: OPEN_TERMS_TYPES, primaryType: 'OpenTerms', message: terms as any, signature: sig })
    return rec.toLowerCase() === expected.toLowerCase()
  } catch { return false }
}
