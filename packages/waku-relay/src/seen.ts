import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * A dedup set: "have I already relayed this content id?". Backed by an in-memory Set for O(1) checks
 * and, when a `path` is given, persisted as a newline-delimited append log so dedup SURVIVES RESTARTS.
 * That persistence matters even for the one-way relay: without it, a restart re-posts every message Waku
 * redelivers (and re-posting costs a fresh PoW grind each time). The log is loaded once on construction.
 */
export interface SeenStore {
  has(id: string): boolean
  remember(id: string): void
  size(): number
}

export interface SeenStoreOptions {
  /** append-log path; omit for a process-local (non-persistent) store. */
  path?: string
}

export function createSeenStore(options: SeenStoreOptions = {}): SeenStore {
  const ids = new Set<string>()
  const path = options.path

  if (path && existsSync(path)) {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const id = line.trim()
      if (id) ids.add(id)
    }
  }
  if (path) mkdirSync(dirname(path), { recursive: true })

  return {
    has: (id) => ids.has(id),
    remember: (id) => {
      if (ids.has(id)) return
      ids.add(id)
      if (path) appendFileSync(path, `${id}\n`)
    },
    size: () => ids.size,
  }
}
