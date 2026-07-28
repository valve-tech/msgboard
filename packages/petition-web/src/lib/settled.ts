import type { Hex } from 'viem'
import { PETITION_INDEXER_URL } from './config.js'

/**
 * The settlement indexer client (Ponder, Task D) — the ON-CHAIN (hard-finality) source. Queries
 * the auto-generated GraphQL API's `petitionSignatures` table (mirrors the query pattern used by
 * games/web's `useSudoku`/`useChainData` hooks against the same indexer package). Degrades to `[]`
 * on ANY failure (down indexer, no base configured, network error) — never throws, so a missing/
 * unreachable indexer just means "no settled signers known yet" (outstanding = all verified).
 */
export async function fetchSettledSigners(
  chainId: number,
  petitionId: Hex,
  base: string = PETITION_INDEXER_URL,
): Promise<Hex[]> {
  if (!base) return []
  const query = `query($chainId: Int!, $petitionId: String!, $after: String) {
    petitionSignatures(where: { chainId: $chainId, petitionId: $petitionId }, orderBy: "blockNumber", orderDirection: "asc", limit: 1000, after: $after) {
      items { signer }
      pageInfo { hasNextPage endCursor }
    }
  }`
  const out: Hex[] = []
  let after: string | null = null
  try {
    for (;;) {
      const res = await fetch(base, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query, variables: { chainId, petitionId, after } }),
      })
      if (!res.ok) return out
      const json = (await res.json()) as {
        errors?: { message: string }[]
        data?: {
          petitionSignatures?: {
            items: { signer: Hex }[]
            pageInfo: { hasNextPage: boolean; endCursor: string | null }
          }
        }
      }
      if (json.errors?.length) return out
      const page = json.data?.petitionSignatures
      if (!page) return out
      out.push(...page.items.map((i) => i.signer))
      if (!page.pageInfo.hasNextPage) break
      after = page.pageInfo.endCursor
    }
  } catch {
    return out
  }
  return out
}
