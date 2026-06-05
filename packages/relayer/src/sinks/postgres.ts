import type { RelayerContext, RelayerSink } from '../types.js'
import type { Queryable } from '../stores/postgres.js'

export type PostgresSinkOptions<T> = {
  pool: Queryable
  table: string
  /** Maps an item to a durable row: a stable key and a JSON payload. */
  toRow: (item: T, context: RelayerContext) => { key: string; payload: unknown }
}

/** A generic durable record sink: one upserted row per item, keyed and JSON-bodied. */
export const postgresSink = <T>(
  options: PostgresSinkOptions<T>,
): RelayerSink<T> & { migrate(): Promise<void> } => {
  const { pool, table, toRow } = options
  return {
    migrate: async () => {
      await pool.query(
        `CREATE TABLE IF NOT EXISTS ${table} (
          key TEXT PRIMARY KEY,
          payload JSONB,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`,
      )
    },
    record: async (item, context) => {
      const row = toRow(item, context)
      await pool.query(
        `INSERT INTO ${table} (key, payload) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET payload = $2`,
        [row.key, JSON.stringify(row.payload)],
      )
    },
  }
}
