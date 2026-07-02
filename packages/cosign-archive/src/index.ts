/**
 * cosign-archive — the READ side of the @msgboard/cosign archivist.
 *
 * The live board keeps only ~120 blocks of messages, so cosign signature-shares age out fast.
 * The box's `indexer` service is the WRITE side: it records every board message (including the
 * per-UTC-day cosign categories) into the shared `message_archive` table. THIS service is the
 * read side — it serves @msgboard/history's `archiveServer` with the opt-in `cosign` endpoint
 * group, so the cosign UI's archive fallback (`GET /cosign/:namespace/:scope/signatures?days=N`)
 * can still count shares that have aged out of the live board toward the quorum.
 *
 * There is NO relayer/write-side here — the box's `indexer` container owns the write path and
 * the schema. This process only reads: the shared Postgres archive (aged-out shares) plus the
 * live board over RPC (fresh shares), unioned + decoded by the cosign handler.
 *
 * Env:
 *   DATABASE_URL           (required) Postgres connection to the shared message_archive table.
 *   MSGBOARD_RPC           board-chain RPC. Default https://one.valve.city/rpc/vk_demo/evm/943.
 *   MSGBOARD_CHAIN_ID      board chain id (1 | 369 | 943). Default 943.
 *   PORT                   listen port. Default 4040.
 *   HOST                   bind interface. Default 0.0.0.0 (requires COSIGN_ARCHIVE_TOKEN).
 *   COSIGN_ARCHIVE_TOKEN   bearer token. REQUIRED for a non-loopback HOST (server enforces it);
 *                          Caddy injects it upstream so the browser stays token-free.
 *   COSIGN_TEAM_FILE       team-file path. Default /app/deploy/cosign/team-file.json.
 *   BOARD_RETENTION_DAYS   conservative board-retention cutoff (days) for the board-vs-archive
 *                          split. Default 1.
 *   RETENTION_DAYS         archive prune window (days). Default 365. (Read-only here: we never
 *                          migrate — the indexer owns the schema — but the Archive is configured
 *                          with the same retention for consistency.)
 */
import pg from 'pg'
import { createPublicClient, http, type Hex, type PublicClient } from 'viem'
import { mainnet, pulsechain, pulsechainV4 } from 'viem/chains'
import * as msgboard from '@msgboard/sdk'
import type { Content } from '@msgboard/sdk'
import { archiveServer, createArchive, loadTeamFile } from '@msgboard/history'

const databaseUrl = process.env.DATABASE_URL
const rpcUrl = process.env.MSGBOARD_RPC ?? 'https://one.valve.city/rpc/vk_demo/evm/943'
const chainId = Number(process.env.MSGBOARD_CHAIN_ID ?? 943)
const port = Number(process.env.PORT ?? 4040)
const host = process.env.HOST ?? '0.0.0.0'
const token = process.env.COSIGN_ARCHIVE_TOKEN
const teamFilePath = process.env.COSIGN_TEAM_FILE ?? '/app/deploy/cosign/team-file.json'
const boardRetentionDays = Number(process.env.BOARD_RETENTION_DAYS ?? 1)
const retentionDays = Number(process.env.RETENTION_DAYS ?? 365)

console.log('\nmsgboard cosign-archive (read side)')
console.log('─────────────────────────────────────────')

if (!databaseUrl) {
  console.error('DATABASE_URL is required — refusing to start.')
  process.exit(1)
}

const chainFor = (id: number) => {
  switch (id) {
    case mainnet.id:
      return mainnet
    case pulsechain.id:
      return pulsechain
    case pulsechainV4.id:
      return pulsechainV4
    default:
      return pulsechainV4
  }
}

// Read-only view of the shared archive. We do NOT call archive.migrate(): the `indexer` service
// owns the schema (calling migrate() would be idempotent + safe, but this process is read-only by
// design). If the table does not yet exist, cosign fetches degrade to a 502 until the indexer runs.
const pool = new pg.Pool({ connectionString: databaseUrl, ssl: false })
const archive = createArchive({ pool, retention: { days: retentionDays } })

// The board seam cosign needs: a read-only MsgBoardClient wrapped to satisfy @msgboard/cosign's
// `BoardClient` ({ addMessage, content }). This service never posts — `addMessage` throws.
const provider = createPublicClient({ chain: chainFor(chainId), transport: http(rpcUrl) }) as PublicClient
const readClient = new msgboard.MsgBoardClient(provider as unknown as msgboard.Provider)
const board = {
  addMessage(_arg: { category: Hex; data: Hex }): Promise<unknown> {
    return Promise.reject(new Error('cosign-archive is read-only: addMessage is not supported'))
  },
  async content({ category }: { category: Hex }): Promise<Content> {
    return readClient.content({ category })
  },
}

const teamFile = loadTeamFile(teamFilePath)

const server = archiveServer({
  archive,
  port,
  host,
  token,
  cosign: { teamFile, board, boardRetentionDays },
})

console.log(`archive:        ${databaseUrl.replace(/:[^:@/]+@/, ':****@')}`)
console.log(`board RPC:      ${rpcUrl} (chain ${chainId})`)
console.log(`team-file:      ${teamFilePath} (namespace=${teamFile.namespace}, windowDays=${teamFile.windowDays})`)
console.log(`board cutoff:   ${boardRetentionDays} day(s)`)
console.log(`listening:      http://${host}:${port}  (health: /health)`)
console.log(`cosign route:   GET /cosign/${teamFile.namespace}/:scope/signatures?days=N`)
console.log(token ? 'auth:           Authorization: Bearer <COSIGN_ARCHIVE_TOKEN> required' : 'auth:           OPEN (loopback bind — no token)')

const shutdown = async (signal: string) => {
  console.log(`\n${signal} — shutting down…`)
  try {
    await server.close()
    await pool.end()
  } finally {
    process.exit(0)
  }
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
