/**
 * archivist — archives all msgboard messages to Postgres.
 *
 * Usage:
 *   DATABASE_URL=postgres://... npm run archivist --workspace=packages/examples
 *
 * Required env vars:
 *   DATABASE_URL   Postgres connection string
 *
 * Optional env vars:
 *   MSGBOARD_RPC   JSON-RPC endpoint (defaults to public demo node)
 *   CHAIN_ID       Chain identifier (defaults to 943 — PulseChain testnet v4)
 */
import pg from 'pg'
import { Relayer, msgboardContentSource, postgresArchiveSink, noopAction } from '@msgboard/relayer'
import type { RPCMessage } from '@msgboard/sdk'

const rpcUrl = process.env.MSGBOARD_RPC ?? 'https://one.valve.city/rpc/vk_demo/evm/943'
const chainId = Number(process.env.CHAIN_ID ?? 943)
const dbUrl = process.env.DATABASE_URL

if (!dbUrl) {
  console.error('DATABASE_URL is required for the archivist example')
  process.exit(1)
}

const pool = new pg.Pool({ connectionString: dbUrl, ssl: false })
const archive = postgresArchiveSink({ pool, retention: { days: 365 } })
await archive.migrate()

const relayer = new Relayer<RPCMessage>({
  node: { rpcUrl, chainId },
  mode: 'observe', // sink always runs; 'observe' means action.execute is skipped
  intervalMs: 20_000,
  source: msgboardContentSource(),
  key: (message) => message.hash.toLowerCase(),
  action: noopAction<RPCMessage>(),
  sink: archive,
})

relayer.start()
console.log(`archivist running on chain ${chainId} (${rpcUrl})`)
