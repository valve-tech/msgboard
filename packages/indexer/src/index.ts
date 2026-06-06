/**
 * msgboard-indexer — a dedicated, multichain archivist process.
 *
 * Runs one relayer per configured chain, each watching every category on its board
 * (`msgboardContentSource`) and recording what it sees into a shared Postgres
 * `message_archive` table (`postgresArchiveSink`, backed by @msgboard/history). The
 * board is ephemeral (~120 blocks), so this is what turns the live boards into
 * durable, queryable history. A separate GraphQL layer (Hasura) reads that table.
 *
 * This is intentionally its own process, not bolted onto the sponsor scripts: its
 * only job is to index, so it can be scaled, restarted, and reasoned about alone.
 *
 * Environment:
 *   DATABASE_URL         Postgres connection string (required)
 *   INDEXER_CHAINS       comma-separated chain ids to index (default "1,369,943")
 *   RPC_<chainId>        msgboard-serving RPC for each chain (e.g. RPC_369, RPC_943)
 *   INDEXER_INTERVAL_MS  poll cadence per chain (default 20000)
 *   RETENTION_DAYS       prune archive rows older than this (default 365)
 */
import pg from 'pg'
import { http } from 'viem'
import { Relayer, msgboardContentSource, postgresArchiveSink, noopAction, defaultLogger } from '@msgboard/relayer'
import type { RPCMessage } from '@msgboard/sdk'

const databaseUrl = process.env.DATABASE_URL
const chains = (process.env.INDEXER_CHAINS ?? '1,369,943')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean)
const intervalMs = Number(process.env.INDEXER_INTERVAL_MS ?? 20_000)
const retentionDays = Number(process.env.RETENTION_DAYS ?? 365)

if (!databaseUrl) {
  console.error('msgboard-indexer: DATABASE_URL is required')
  process.exit(1)
}

const pool = new pg.Pool({ connectionString: databaseUrl, ssl: false })

// One archive sink shared by every chain's relayer: it is stateless, and each
// record is stamped with the chain id from its own relayer's tick context, so
// rows are keyed (hash, chain_id) and never collide across chains.
const archive = postgresArchiveSink({ pool, retention: { days: retentionDays } })
await archive.migrate()

const relayers: Relayer<RPCMessage>[] = []
for (const chainId of chains) {
  const rpcUrl = process.env[`RPC_${chainId}`]
  if (!rpcUrl) {
    console.error(`msgboard-indexer: no RPC_${chainId} set — skipping chain ${chainId}`)
    continue
  }
  const relayer = new Relayer<RPCMessage>({
    node: { transport: http(rpcUrl) },
    mode: 'observe', // the sink always runs; there is no on-chain action
    intervalMs,
    source: msgboardContentSource(), // every category
    key: (message) => message.hash.toLowerCase(),
    action: noopAction<RPCMessage>(),
    sink: archive,
    logger: defaultLogger(`indexer:${chainId}`),
  })
  relayer.start()
  relayers.push(relayer)
  console.log(`msgboard-indexer: indexing chain ${chainId} via ${rpcUrl}`)
}

if (relayers.length === 0) {
  console.error('msgboard-indexer: no chains configured — set RPC_<chainId> for at least one chain')
  await pool.end()
  process.exit(1)
}

console.log(`msgboard-indexer: running — ${relayers.length} chain(s) archiving to message_archive`)

process.on('SIGINT', async () => {
  console.log('msgboard-indexer: shutting down…')
  await Promise.all(relayers.map((relayer) => relayer.stop()))
  await pool.end()
  process.exit(0)
})
