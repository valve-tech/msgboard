import { useChainStore, selectChain, selectRpcUrl } from '../stores/chain'
import { getScope } from '../lib/persist'

/**
 * The chain-scoped localStorage prefix (`chainId:rpcUrl`), recomputed whenever the chain or
 * its rpc url changes. Replaces the Svelte `getScope()` that read `chain.chain?.id` /
 * `chain.rpcUrl` reactively — here `persist.getScope` takes explicit args and this hook
 * supplies them from the chain store so callers stay reactive on a chain switch.
 */
export const useChainScope = (): string =>
  useChainStore((s) => getScope(selectChain(s)?.id, selectRpcUrl(s)))
