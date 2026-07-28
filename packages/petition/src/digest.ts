import { type Hex, hashTypedData } from 'viem'
import type { Petition } from './descriptor.js'

/** EIP-712 domain name for petition signatures. */
export const PETITION_DOMAIN_NAME = 'MsgBoard Petition'

/** EIP-712 domain version for petition signatures. */
export const PETITION_DOMAIN_VERSION = '1'

/** EIP-712 type for a petition signature. Order is law. */
export const PETITION_TYPES = {
  Petition: [
    { name: 'petitionId', type: 'bytes32' },
    { name: 'statement', type: 'string' },
  ],
} as const

/**
 * The EIP-712 digest a signer signs to co-sign a petition. Domain-separated by
 * `chainId` and `verifyingContract`, so the same petition digests differently per
 * deployment.
 */
export function petitionDigest(
  p: Pick<Petition, 'id' | 'statement' | 'chainId'>,
  verifyingContract: Hex,
): Hex {
  return hashTypedData({
    domain: {
      name: PETITION_DOMAIN_NAME,
      version: PETITION_DOMAIN_VERSION,
      chainId: p.chainId,
      verifyingContract,
    },
    types: PETITION_TYPES,
    primaryType: 'Petition',
    message: { petitionId: p.id, statement: p.statement },
  })
}
