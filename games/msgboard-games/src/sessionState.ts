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

/** A mutual-CLOSE authorization. Both parties sign this — and ONLY this — when they agree to finalize
 *  a table NOW at these balances. It is a DISTINCT EIP-712 type from the running SessionState, so a
 *  co-signature collected mid-play (a running checkpoint) can never be replayed on the cooperative
 *  HouseChannel.settle() fast path. Mirrors the on-chain SessionClose struct + SessionCloseLib.TYPEHASH
 *  in contracts/games/SessionState.sol EXACTLY; field order is consensus. */
export interface SessionClose {
  tableId: Hex          // bytes32 session id
  nonce: bigint         // uint64
  balancePlayer: bigint // uint256 chip base units
  balanceHouse: bigint
  gameId: number        // uint8
}

/** EIP-712 type of SessionClose — mirrors the SessionCloseLib.TYPEHASH string:
 *  SessionClose(bytes32 tableId,uint64 nonce,uint256 balancePlayer,uint256 balanceHouse,uint8 gameId) */
export const SESSION_CLOSE_TYPES = {
  SessionClose: [
    { name: 'tableId', type: 'bytes32' },
    { name: 'nonce', type: 'uint64' },
    { name: 'balancePlayer', type: 'uint256' },
    { name: 'balanceHouse', type: 'uint256' },
    { name: 'gameId', type: 'uint8' },
  ],
} as const

/** Project a running SessionState onto the mutual-close authorization for that state. The house only
 *  ever signs a SessionClose for the state it agrees is the true latest (see settle() security note). */
export function closeFromState(s: SessionState): SessionClose {
  return {
    tableId: s.tableId,
    nonce: s.nonce,
    balancePlayer: s.balancePlayer,
    balanceHouse: s.balanceHouse,
    gameId: s.gameId,
  }
}

export function hashSessionClose(domain: GameDomain, c: SessionClose): Hex {
  return hashTypedData({ domain, types: SESSION_CLOSE_TYPES, primaryType: 'SessionClose', message: c as any })
}

export async function signClose(signer: StateSigner, domain: GameDomain, c: SessionClose): Promise<Hex> {
  return signer.signTypedData({ domain, types: SESSION_CLOSE_TYPES, primaryType: 'SessionClose', message: c })
}

export async function verifyCloseSig(expected: Hex, domain: GameDomain, c: SessionClose, sig: Hex): Promise<boolean> {
  try {
    const rec = await recoverTypedDataAddress({
      domain, types: SESSION_CLOSE_TYPES, primaryType: 'SessionClose', message: c as any, signature: sig,
    })
    return rec.toLowerCase() === expected.toLowerCase()
  } catch { return false }
}

/** Canonical-JSON body shape for a SessionClose carried inside a CLOSE transcript envelope. bigints
 *  are stringified because the transcript is JSON (JSON.stringify throws on bigint). Restoration via
 *  closeFromBody is exact, so the reconstructed SessionClose hashes/recovers identically. */
export interface CloseBody {
  tableId: Hex
  nonce: string
  balancePlayer: string
  balanceHouse: string
  gameId: number
}

export function closeToBody(c: SessionClose): CloseBody {
  return {
    tableId: c.tableId,
    nonce: c.nonce.toString(),
    balancePlayer: c.balancePlayer.toString(),
    balanceHouse: c.balanceHouse.toString(),
    gameId: c.gameId,
  }
}

export function closeFromBody(b: CloseBody): SessionClose {
  return {
    tableId: b.tableId,
    nonce: BigInt(b.nonce),
    balancePlayer: BigInt(b.balancePlayer),
    balanceHouse: BigInt(b.balanceHouse),
    gameId: b.gameId,
  }
}
