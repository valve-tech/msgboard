import type { Queryable } from './stores/postgres.js'

/**
 * A liveness row per chain, so an operator can tell a dead indexer from an idle board.
 *
 * The two states used to look identical. The indexer logged one line per message
 * per poll, so a busy chain buried its own signal and a chain with nothing to say
 * printed nothing at all. Chain 1 stopped receiving messages on 2026-08-21 and
 * nobody saw it for 17 days, because "healthy and quiet" and "broken" are the same
 * silence.
 *
 * A heartbeat separates them:
 *
 *   last_tick_at stale            -> the indexer is not running. Alarm.
 *   last_tick_at fresh, polled 0  -> the indexer is fine and the board is empty.
 *   last_message_at stale         -> nobody is writing to that board. Look at the writers.
 *
 * The row is written only after a tick that finished. A tick that throws leaves
 * `last_tick_at` behind, which is the signal we want; the relayer's own
 * `tick failed` log line says why.
 */

/** The default table name. */
export const HEARTBEAT_TABLE = 'indexer_heartbeat'

export type HeartbeatOptions = {
  pool: Queryable
  /** Table name for the heartbeat rows. Defaults to `indexer_heartbeat`. */
  table?: string
}

export type Heartbeat = {
  /** Numeric chain id this row describes. */
  chainId: number
  /** Items the source returned this tick. Zero means the board is empty, not broken. */
  polled: number
  /** Items written to the sink this tick. */
  recorded: number
  /** The node's head block, or null when the node did not answer. */
  headBlock?: bigint | number | null
}

export type HeartbeatWriter = {
  migrate(): Promise<void>
  beat(heartbeat: Heartbeat): Promise<void>
}

/**
 * A Postgres-backed heartbeat writer. Call `migrate()` once at startup, then
 * `beat()` from the relayer's `onTick`.
 */
export const postgresHeartbeat = (options: HeartbeatOptions): HeartbeatWriter => {
  const { pool } = options
  const table = options.table ?? HEARTBEAT_TABLE
  return {
    migrate: async () => {
      await pool.query(
        `CREATE TABLE IF NOT EXISTS ${table} (
          chain_id BIGINT PRIMARY KEY,
          last_tick_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          last_message_at TIMESTAMPTZ,
          polled BIGINT NOT NULL DEFAULT 0,
          recorded BIGINT NOT NULL DEFAULT 0,
          head_block BIGINT
        )`,
      )
    },
    beat: async ({ chainId, polled, recorded, headBlock }) => {
      // pg sends a BIGINT parameter as text, so a bigint head block goes over as a
      // string rather than losing precision through a JavaScript number.
      const head = headBlock == null ? null : headBlock.toString()
      await pool.query(
        `INSERT INTO ${table} (chain_id, last_tick_at, last_message_at, polled, recorded, head_block)
         VALUES ($1, now(), CASE WHEN $2 > 0 THEN now() ELSE NULL END, $2, $3, $4)
         ON CONFLICT (chain_id) DO UPDATE SET
           last_tick_at = now(),
           -- keep the previous timestamp on an empty tick, so this column always
           -- answers "when did this board last carry anything?"
           last_message_at = CASE WHEN $2 > 0 THEN now() ELSE ${table}.last_message_at END,
           polled = $2,
           recorded = $3,
           head_block = COALESCE($4, ${table}.head_block)`,
        [chainId, polled, recorded, head],
      )
    },
  }
}
