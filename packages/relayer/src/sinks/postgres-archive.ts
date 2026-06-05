import { type Hex, hexToString } from 'viem'
import type { RPCMessage } from '@msgboard/sdk'
import type { RelayerContext, RelayerSink } from '../types.js'
import type { Queryable } from '../stores/postgres.js'

export type ArchiveRetention = {
  /** Rows older than this many days are pruned. */
  days: number
}

export type PostgresArchiveOptions = {
  pool: Queryable
  retention: ArchiveRetention
}

/** Filters for querying the historical archive. */
export type ArchiveQuery = {
  chainId?: number
  /** A bytes32 hex category or its decoded text. */
  category?: string
  since?: Date
  until?: Date
  /** Substring match on decoded content. */
  contains?: string
  limit?: number
  offset?: number
}

/** A row of the historical archive. */
export type ArchivedMessage = {
  hash: string
  chain_id: number
  category: string | null
  category_text: string | null
  data: string | null
  content: string | null
  block_number: string | null
  block_hash: string | null
  first_seen_at: string
}

/** Decodes a hex blob to text, stripping null padding and returning null if not printable. */
const tryDecodeText = (hex: Hex): string | null => {
  try {
    const text = hexToString(hex).replace(/\0+$/g, '').trim()
    if (text.length === 0) return null
    // Reject blobs with non-printable control characters
    if (/[\x00-\x1f\x7f]/u.test(text)) return null
    return text
  } catch {
    return null
  }
}

/**
 * The historical index of every message seen flowing through the board. An
 * ever-growing table, pruned to a retention window (default one year). `record`
 * is idempotent on `(hash, chain_id)`. Call `migrate()` once at startup.
 */
export const postgresArchiveSink = (
  options: PostgresArchiveOptions,
): RelayerSink<RPCMessage> & {
  migrate(): Promise<void>
  query(filter: ArchiveQuery): Promise<ArchivedMessage[]>
} => {
  const { pool } = options
  const retentionDays = options.retention.days

  const migrate = async (): Promise<void> => {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS message_archive (
        hash          TEXT NOT NULL,
        chain_id      INTEGER NOT NULL,
        category      TEXT,
        category_text TEXT,
        data          TEXT,
        content       TEXT,
        block_number  BIGINT,
        block_hash    TEXT,
        first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (hash, chain_id)
      )`,
    )
    await pool.query(
      `CREATE INDEX IF NOT EXISTS message_archive_seen_idx ON message_archive (first_seen_at)`,
    )
    await pool.query(
      `CREATE INDEX IF NOT EXISTS message_archive_chain_seen ON message_archive (chain_id, first_seen_at)`,
    )
    await pool.query(
      `CREATE INDEX IF NOT EXISTS message_archive_category_idx ON message_archive (category)`,
    )
  }

  const record = async (message: RPCMessage, context: RelayerContext): Promise<void> => {
    await pool.query(
      `INSERT INTO message_archive
        (hash, chain_id, category, category_text, data, content, block_number, block_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (hash, chain_id) DO NOTHING`,
      [
        message.hash,
        context.chain.id,
        message.category,
        tryDecodeText(message.category),
        message.data,
        tryDecodeText(message.data),
        BigInt(message.blockNumber).toString(),
        message.blockHash,
      ],
    )
  }

  const prune = async (): Promise<void> => {
    await pool.query(
      `DELETE FROM message_archive WHERE first_seen_at < now() - INTERVAL '${retentionDays} days'`,
    )
  }

  const query = async (filter: ArchiveQuery): Promise<ArchivedMessage[]> => {
    const clauses: string[] = []
    const params: unknown[] = []
    const add = (clause: string, value: unknown): void => {
      params.push(value)
      clauses.push(clause.replace(/\$\?/g, `$${params.length}`))
    }
    if (filter.chainId !== undefined) add('chain_id = $?', filter.chainId)
    if (filter.category !== undefined) add('(category = $? OR category_text = $?)', filter.category)
    if (filter.since) add('first_seen_at >= $?', filter.since.toISOString())
    if (filter.until) add('first_seen_at <= $?', filter.until.toISOString())
    if (filter.contains) add('content ILIKE $?', `%${filter.contains}%`)
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const limit = Math.min(Math.max(Number.parseInt(String(filter.limit ?? 100), 10) || 100, 1), 1000)
    const offset = Math.max(Number.parseInt(String(filter.offset ?? 0), 10) || 0, 0)
    const { rows } = await pool.query(
      `SELECT hash, chain_id, category, category_text, data, content, block_number, block_hash, first_seen_at FROM message_archive ${where} ORDER BY first_seen_at DESC LIMIT ${limit} OFFSET ${offset}`,
      params,
    )
    return rows as ArchivedMessage[]
  }

  return { record, prune, migrate, query }
}
