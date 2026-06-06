import { createArchive } from '@msgboard/history'
import type { ArchiveQuery, ArchiveRetention, ArchivedMessage } from '@msgboard/history'
import type { RPCMessage } from '@msgboard/sdk'
import type { RelayerContext, RelayerSink } from '../types.js'
import type { Queryable } from '../stores/postgres.js'

// The archive storage + query now lives in @msgboard/history; this sink is the
// adapter that lets an archivist relayer populate it from live board traffic.
export type { ArchiveQuery, ArchiveRetention, ArchivedMessage }

export type PostgresArchiveOptions = {
  pool: Queryable
  retention: ArchiveRetention
}

/**
 * The historical index of every message seen flowing through the board, backed by
 * `@msgboard/history`. Adapts that archive to the relayer's sink interface: `record`
 * is driven by the relayer heartbeat (chain id taken from the tick context), while
 * `migrate`/`prune`/`query` pass straight through. An ever-growing table pruned to a
 * retention window (default one year); `record` is idempotent on `(hash, chain_id)`.
 * Call `migrate()` once at startup.
 */
export const postgresArchiveSink = (
  options: PostgresArchiveOptions,
): RelayerSink<RPCMessage> & {
  migrate(): Promise<void>
  query(filter: ArchiveQuery): Promise<ArchivedMessage[]>
} => {
  const archive = createArchive({ pool: options.pool, retention: options.retention })
  return {
    migrate: archive.migrate,
    prune: archive.prune,
    query: archive.query,
    record: (message: RPCMessage, context: RelayerContext) => archive.record(message, context.chain.id),
  }
}
