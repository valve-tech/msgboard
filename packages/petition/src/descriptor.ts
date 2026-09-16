import { type Hex, decodeAbiParameters, encodeAbiParameters, keccak256 } from 'viem'

/**
 * A petition descriptor — the single source of truth shared by creators, signers,
 * and readers. Field order matches PETITION_ABI.
 */
export interface Petition {
  /** The petition id (bytes32) — see derivePetitionId. */
  id: Hex
  /** The petition's human-readable statement. */
  statement: string
  /** The petition creator's address. */
  creator: Hex
  /** Unix timestamp (seconds) the petition was created. */
  createdAt: number
  /** The chain the petition is scoped to. */
  chainId: number
  /** Random salt used to derive `id`, disambiguating identical (statement, creator) pairs. */
  salt: Hex
}

/**
 * Canonical ABI tuple — ORDER IS LAW. Both readers and downstream consumers decode
 * against this exact sequence:
 * (bytes32 id, string statement, address creator, uint64 createdAt, uint32 chainId, bytes32 salt)
 */
export const PETITION_ABI = [
  { name: 'id', type: 'bytes32' },
  { name: 'statement', type: 'string' },
  { name: 'creator', type: 'address' },
  { name: 'createdAt', type: 'uint64' },
  { name: 'chainId', type: 'uint32' },
  { name: 'salt', type: 'bytes32' },
] as const

/**
 * Derives a petition's id: `keccak256(encodeAbiParameters([string,address,bytes32], [statement, creator, salt]))`.
 * Deterministic and binds all three inputs — changing any one changes the id.
 */
export function derivePetitionId(statement: string, creator: Hex, salt: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'string' }, { type: 'address' }, { type: 'bytes32' }],
      [statement, creator, salt],
    ),
  )
}

/** ABI-encodes a Petition into the canonical tuple. */
export function encodePetition(p: Petition): Hex {
  return encodeAbiParameters(PETITION_ABI, [
    p.id,
    p.statement,
    p.creator,
    BigInt(p.createdAt),
    p.chainId,
    p.salt,
  ])
}

/**
 * ABI-decodes the canonical tuple into a Petition.
 * @throws (via viem) on malformed / undecodable input.
 */
export function decodePetition(data: Hex): Petition {
  const [id, statement, creator, createdAt, chainId, salt] = decodeAbiParameters(
    PETITION_ABI,
    data,
  )
  return {
    id,
    statement,
    creator,
    createdAt: Number(createdAt),
    chainId: Number(chainId),
    salt,
  }
}
