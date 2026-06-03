import { chain } from './msgboard.svelte'
import type { Tree } from './log.svelte'

const PREFIX = 'msgboard:ui'

/**
 * Returns the current chain-scoped storage key prefix.
 * Uses `chainId:rpcUrl` as the unique identifier so that each
 * chain's UI state is stored independently.
 * When called inside a Svelte `$effect`, reactive dependencies on
 * `chain.chain?.id` and `chain.rpcUrl` are automatically tracked.
 */
export function getScope(): string {
  return `${chain.chain?.id ?? 0}:${chain.rpcUrl ?? ''}`
}

/**
 * Read a JSON-serialised value from chain-scoped localStorage.
 * Returns `fallback` when the key is missing or parsing fails.
 */
export function load<T>(scope: string, key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`${PREFIX}:${scope}:${key}`)
    if (raw === null) return fallback
    const parsed: unknown = JSON.parse(raw)
    return parsed as T
  } catch {
    return fallback
  }
}

/**
 * Write a JSON-serialisable value to chain-scoped localStorage.
 * Silently swallows errors (e.g. localStorage full or unavailable).
 */
export function save(scope: string, key: string, value: unknown): void {
  try {
    localStorage.setItem(`${PREFIX}:${scope}:${key}`, JSON.stringify(value))
  } catch { /* localStorage may be full or unavailable */ }
}

/**
 * Recursively collect all node labels from a tree structure.
 * Used to determine which persisted TreeView entries are still valid
 * so stale ones can be pruned after content reloads.
 */
export function collectLabels(children: ReadonlyArray<Tree>): Set<string> {
  const labels = new Set<string>()
  const visit = (nodes: ReadonlyArray<Tree>) => {
    for (const node of nodes) {
      if (node.label) labels.add(node.label)
      if (node.children?.length) visit(node.children)
    }
  }
  visit(children)
  return labels
}
