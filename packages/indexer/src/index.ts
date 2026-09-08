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
 * ONE RELAYER PER ENDPOINT, NOT PER CHAIN. A chain is served by several replicas, and
 * replicas do not necessarily hold the same board: on 2026-09-08 the two mainnet nodes
 * held completely disjoint boards — 33 messages against 0, not one hash in common — for
 * weeks, because a devp2p capability race left their link unable to carry board traffic.
 * A gateway pins each API key to one replica, so an archivist reading through one URL
 * had been recording one replica's view and silently missing everything posted to the
 * other. The board keeps messages for only ~20 minutes, so whatever the archive misses
 * is gone for good.
 *
 * `RPC_<chainId>` therefore takes a COMMA-SEPARATED LIST. Every endpoint gets its own
 * relayer, and all of them write to the same archive, which is idempotent on
 * (hash, chain_id) — so the archive holds the UNION of what the replicas saw. That is
 * the closest thing to a durable record the board can have, and it stays correct even
 * while the replicas disagree.
 *
 * Each relayer writes a heartbeat row per tick, keyed (chain_id, source). Two rows for
 * one chain with very different `polled` counts is a replica split, visible. See
 * @msgboard/relayer's heartbeat module for what each column means, and
 * @msgboard/node-check's convergence check for the test that fails on it.
 *
 * Environment:
 *   DATABASE_URL         Postgres connection string (required)
 *   INDEXER_CHAINS       comma-separated chain ids to index (default "1,369,943")
 *   RPC_<chainId>        msgboard-serving RPC(s) for each chain — one URL, or several
 *                        separated by commas to archive the union across replicas
 *   INDEXER_INTERVAL_MS  poll cadence per chain (default 20000)
 *   RETENTION_DAYS       prune archive rows older than this (default 365)
 */
import {
  Relayer,
  msgboardContentSource,
  postgresArchiveSink,
  postgresHeartbeat,
  noopAction,
  defaultLogger,
  installConsoleRedactor,
  sourceLabel,
} from '@msgboard/relayer'
import pg from 'pg'
import { http } from 'viem'
import type { RPCMessage } from '@msgboard/sdk'

// The first statement this module runs. RPC_<chainId> carries the access key in
// its path, and viem repeats the whole URL in every error it throws, so any later
// log line could print a live key to container stdout. This one did, for 17 days.
installConsoleRedactor()

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
const archive = postgresArchiveSink({
  pool,
  retention: { days: retentionDays },
})
await archive.migrate()

const heartbeat = postgresHeartbeat({ pool })
await heartbeat.migrate()

/** Split `RPC_<chainId>` into its endpoints, dropping blanks and duplicates. */
export const endpointsFor = (raw: string | undefined): string[] => [
  ...new Set(
    (raw ?? '')
      .split(',')
      .map((url) => url.trim())
      .filter(Boolean),
  ),
]

const relayers: Relayer<RPCMessage>[] = []
/** Every (chain, source) this process owns, for the startup reconcile below. */
const sources: { chainId: number; source: string }[] = []
for (const chainId of chains) {
  const endpoints = endpointsFor(process.env[`RPC_${chainId}`])
  if (endpoints.length === 0) {
    console.error(`msgboard-indexer: no RPC_${chainId} set — skipping chain ${chainId}`)
    continue
  }
  for (const rpcUrl of endpoints) {
    // Identifies this replica in logs and in the heartbeat table. NOT the raw url — that
    // carries the access key — and NOT merely the redacted url either: two replicas reached
    // through the same gateway with different keys redact to the SAME string, so they would
    // share one heartbeat row and overwrite each other, hiding the very split that table
    // exists to reveal. `sourceLabel` appends a short digest of the whole url.
    const source = sourceLabel(rpcUrl)
    const logger = defaultLogger(
      endpoints.length > 1 ? `indexer:${chainId}:${source}` : `indexer:${chainId}`,
    )
    const relayer = new Relayer<RPCMessage>({
      node: { transport: http(rpcUrl) },
      mode: 'observe', // the sink always runs; there is no on-chain action
      intervalMs,
      source: msgboardContentSource(), // every category
      key: (message) => message.hash.toLowerCase(),
      action: noopAction<RPCMessage>(),
      // The archive sink runs before this check, so nothing stops being indexed.
      // What stops is `observe: noop`, which the noop action printed once per
      // message per poll — 205,000 lines a day on 943 to write 3,400 rows. That
      // volume hid a dead chain for 17 days. The heartbeat below replaces it.
      condition: () => false,
      sink: archive,
      logger,
      onTick: async (report, context) => {
        let headBlock: bigint | null = null
        try {
          headBlock = await context.publicClient.getBlockNumber()
        } catch {
          headBlock = null // the node did not answer; the tick itself still counts
        }
        logger(
          'tick polled=%d recorded=%d head=%s',
          report.polled,
          report.recorded,
          // Node's %s renders a bigint as "123n". Operators read this line; give them the digits.
          headBlock === null ? 'unknown' : headBlock.toString(),
        )
        await heartbeat.beat({
          chainId: context.chain.id,
          source,
          polled: report.polled,
          recorded: report.recorded,
          headBlock,
        })
      },
    })
    relayer.start()
    relayers.push(relayer)
    sources.push({ chainId: Number(chainId), source })
    console.log(`msgboard-indexer: indexing chain ${chainId} via ${source}`)
  }
}

// Labels change — an endpoint is repointed, or the way they are derived improves — and a
// row under the old label would never tick again and would alarm forever. Drop anything for
// our chains that is not one of ours, now that every relayer is registered.
await heartbeat.reconcile(sources)

if (relayers.length === 0) {
  console.error('msgboard-indexer: no chains configured — set RPC_<chainId> for at least one chain')
  await pool.end()
  process.exit(1)
}

console.log(
  `msgboard-indexer: running — ${relayers.length} endpoint(s) across ${chains.length} chain(s), ` +
    'archiving the union to message_archive',
)

process.on('SIGINT', async () => {
  console.log('msgboard-indexer: shutting down…')
  await Promise.all(relayers.map((relayer) => relayer.stop()))
  await pool.end()
  process.exit(0)
})
