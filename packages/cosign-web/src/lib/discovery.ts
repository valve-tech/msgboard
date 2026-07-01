import { type Hex, getAddress, isAddress } from 'viem'
import { SAFE_INDEXER_BASE, SAFE_TX_SERVICE } from './config'

/**
 * Hybrid Safe discovery: one `discoverSafes(owner, chainId)` client that reads the official Safe
 * Transaction Service where one exists (Ethereum mainnet) and the self-hosted `safe-indexer` on
 * chains that have none (PulseChain 369 / v4 943). Both return `{ safes: [...] }`, so the caller
 * never branches. Degrades to an empty list (→ manual entry) when discovery is unavailable.
 */
export interface DiscoveredSafe {
  address: Hex
  chainId: number
}

interface OwnerSafesResponse {
  safes?: string[]
}

/** Where each chain's discovery request goes, and whether the indexer needs an explicit `?chainId`. */
function endpointFor(owner: Hex, chainId: number): string | null {
  const official = SAFE_TX_SERVICE[chainId]
  if (official) return `${official}/api/v1/owners/${owner}/safes/`
  if (SAFE_INDEXER_BASE) return `${SAFE_INDEXER_BASE}/owners/${owner}/safes?chainId=${chainId}`
  return null
}

/**
 * Returns the Safes `owner` controls on `chainId`. Never throws — any network/parse failure yields
 * `[]` so the UI silently falls back to manual Safe-address entry.
 */
export async function discoverSafes(owner: Hex, chainId: number): Promise<DiscoveredSafe[]> {
  if (!isAddress(owner)) return []
  const url = endpointFor(getAddress(owner), chainId)
  if (!url) return []
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' } })
    if (!res.ok) return []
    const json = (await res.json()) as OwnerSafesResponse
    const list = Array.isArray(json.safes) ? json.safes : []
    return list
      .filter((a) => isAddress(a))
      .map((a) => ({ address: getAddress(a), chainId }))
  } catch {
    return []
  }
}
