import { hashTypedData, recoverTypedDataAddress, type Hex } from 'viem'

/** Co-signed running state of one house-game session. Order of fields is consensus —
 *  the settlement-plan Solidity mirror MUST match this tuple exactly. */
export interface SessionState {
  tableId: Hex          // bytes32 session id
  nonce: bigint         // uint64, strictly increasing
  balancePlayer: bigint // uint256 chip base units
  balanceHouse: bigint
  settlementMode: number // uint8: 0 optimistic, 1 escrowed, 2 zk
  gameId: number         // uint8: 1 dice, 2 limbo
  gameStateHash: Hex     // bytes32, game module owns the preimage
  rngCommit: Hex         // bytes32, server-seed hash-chain head for this session
}

export interface GameDomain {
  name: 'MsgBoardGames'; version: '1'; chainId: number; verifyingContract: Hex
}

/** anvil chainId + placeholder address; the settlement plan pins the real HouseChannel domain. */
export const TEST_DOMAIN: GameDomain = {
  name: 'MsgBoardGames', version: '1', chainId: 31337,
  verifyingContract: '0x00000000000000000000000000000000000a3eb1',
}

export function makeDomain(chainId: number, verifyingContract: Hex): GameDomain {
  return { name: 'MsgBoardGames', version: '1', chainId, verifyingContract }
}

export const SESSION_STATE_TYPES = {
  SessionState: [
    { name: 'tableId', type: 'bytes32' },
    { name: 'nonce', type: 'uint64' },
    { name: 'balancePlayer', type: 'uint256' },
    { name: 'balanceHouse', type: 'uint256' },
    { name: 'settlementMode', type: 'uint8' },
    { name: 'gameId', type: 'uint8' },
    { name: 'gameStateHash', type: 'bytes32' },
    { name: 'rngCommit', type: 'bytes32' },
  ],
} as const

export interface StateSigner {
  address: Hex
  signTypedData(args: any): Promise<Hex>
}

export function hashSessionState(domain: GameDomain, s: SessionState): Hex {
  return hashTypedData({ domain, types: SESSION_STATE_TYPES, primaryType: 'SessionState', message: s as any })
}

export async function signSessionState(signer: StateSigner, domain: GameDomain, s: SessionState): Promise<Hex> {
  return signer.signTypedData({ domain, types: SESSION_STATE_TYPES, primaryType: 'SessionState', message: s })
}

export async function verifySessionStateSig(expected: Hex, domain: GameDomain, s: SessionState, sig: Hex): Promise<boolean> {
  try {
    const rec = await recoverTypedDataAddress({
      domain, types: SESSION_STATE_TYPES, primaryType: 'SessionState', message: s as any, signature: sig,
    })
    return rec.toLowerCase() === expected.toLowerCase()
  } catch { return false }
}
