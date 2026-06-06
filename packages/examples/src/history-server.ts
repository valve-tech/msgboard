/**
 * history-server — the full historical-data flow, end to end.
 *
 * The board is ephemeral (it keeps only ~120 blocks of messages), so durable history has to be
 * recorded as messages flow by. This example runs both halves over a single Postgres table:
 *
 *   • write side — an archivist relayer watches the board and records every message it sees,
 *     using @msgboard/relayer's postgresArchiveSink (which is backed by @msgboard/history).
 *   • read side  — @msgboard/history's archiveServer exposes an HTTP query API over the same
 *     archive, so anything can ask "what messages were posted to category X since time T?".
 *
 * Usage:
 *   DATABASE_URL=postgres://user:pass@localhost:5432/msgboard \
 *   MSGBOARD_RPC=https://one.valve.city/rpc/vk_demo/evm/369 \
 *     npm run history-server --workspace=packages/examples
 *
 * Then query it:
 *   curl 'http://localhost:4040/messages?category=gasmoneyplease&limit=20'
 *   curl 'http://localhost:4040/health'
 *
 * Optional env vars:
 *   PORT             query-server port (default 4040)
 *   HISTORY_TOKEN    require Authorization: Bearer <token> on /messages
 *   RETENTION_DAYS   prune rows older than this (default 365)
 */
import pg from 'pg'
import { http } from 'viem'
import { Relayer, msgboardContentSource, postgresArchiveSink, noopAction } from '@msgboard/relayer'
import { createArchive, archiveServer } from '@msgboard/history'
import type { RPCMessage } from '@msgboard/sdk'

const databaseUrl = process.env.DATABASE_URL
const rpcUrl = process.env.MSGBOARD_RPC ?? 'https://one.valve.city/rpc/vk_demo/evm/369'
const port = Number(process.env.PORT ?? 4040)
const token = process.env.HISTORY_TOKEN
const retentionDays = Number(process.env.RETENTION_DAYS ?? 365)

console.log('\nmsgboard history-server')
console.log('─────────────────────────────────────────')

if (!databaseUrl) {
  console.log('\nDATABASE_URL is not set — nothing was started.')
  console.log('This example needs a Postgres database to archive into and query from.\n')
  console.log('The flow is:')
  console.log('  • an archivist relayer records every board message into a message_archive table')
  console.log('  • archiveServer serves an HTTP query API over that same table\n')
  console.log('Run it for real:')
  console.log('  DATABASE_URL=postgres://user:pass@localhost:5432/msgboard \\')
  console.log('  MSGBOARD_RPC=https://one.valve.city/rpc/vk_demo/evm/369 \\')
  console.log('    npm run history-server --workspace=packages/examples\n')
  process.exit(0)
}

const pool = new pg.Pool({ connectionString: databaseUrl, ssl: false })
const retention = { days: retentionDays }

// One table, two views of it: the archive (read) and the sink (write) share the pool.
const archive = createArchive({ pool, retention })
await archive.migrate()

// Write side: an archivist relayer populates the archive from live board traffic.
const archivist = new Relayer<RPCMessage>({
  node: { transport: http(rpcUrl) },
  mode: 'observe', // the sink always runs; 'observe' just skips the (no-op) action
  intervalMs: 20_000,
  source: msgboardContentSource(),
  key: (message) => message.hash.toLowerCase(),
  action: noopAction<RPCMessage>(),
  sink: postgresArchiveSink({ pool, retention }),
})
archivist.start()

// Read side: an HTTP query API over the archive.
const server = archiveServer({ archive, port, token })

console.log(`archiving board traffic from ${rpcUrl}`)
console.log(`query API: http://localhost:${port}/messages   (health: /health)`)
console.log(`example:   curl 'http://localhost:${port}/messages?category=gasmoneyplease&limit=20'`)
if (token) console.log('queries require: Authorization: Bearer <HISTORY_TOKEN>')

process.on('SIGINT', async () => {
  console.log('\nshutting down…')
  await archivist.stop()
  await server.close()
  await pool.end()
  process.exit(0)
})
