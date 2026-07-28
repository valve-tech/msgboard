import type { Hex } from 'viem'

/** The MsgBoard namespace all petition traffic is bucketed under. */
export const PETITION_NS = 'petition'

/** The category scope for the petition index (listing/discovery). */
export const INDEX_SCOPE = 'index'

/**
 * The category scope for signatures on a specific petition: the petition id,
 * lowercased. Signers and readers must agree on this exact scope string.
 */
export function signScope(petitionId: Hex): string {
  return petitionId.toLowerCase()
}
