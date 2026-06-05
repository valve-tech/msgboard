import type { ActionResult, RelayerStore } from '../types.js'

/** The minimal database surface the Postgres store needs (a `pg.Pool` satisfies it). */
export type Queryable = {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>
}

export type PostgresStoreOptions = {
  pool: Queryable
  /** Table name for the dedup rows. */
  table: string
  /** Rows older than this are removed by `prune`, in milliseconds. */
  maxAgeMs: number
}

/** A durable dedup store backed by a Postgres table. Call `migrate()` once at startup. */
export const postgresStore = <T>(
  options: PostgresStoreOptions,
): RelayerStore<T> & { migrate(): Promise<void> } => {
  const { pool, table } = options
  const maxAgeSeconds = Math.floor(options.maxAgeMs / 1000)
  return {
    migrate: async () => {
      await pool.query(
        `CREATE TABLE IF NOT EXISTS ${table} (
          key TEXT PRIMARY KEY,
          ref TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`,
      )
    },
    has: async (key) => {
      const { rows } = await pool.query(`SELECT key FROM ${table} WHERE key = $1 LIMIT 1`, [key])
      return rows.length > 0
    },
    remember: async (key, result: ActionResult) => {
      await pool.query(
        `INSERT INTO ${table} (key, ref) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET ref = $2`,
        [key, result.ref ?? null],
      )
    },
    prune: async () => {
      await pool.query(
        `DELETE FROM ${table} WHERE created_at < now() - INTERVAL '${maxAgeSeconds} seconds'`,
      )
    },
  }
}
