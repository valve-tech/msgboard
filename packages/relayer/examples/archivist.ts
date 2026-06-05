import pg from 'pg'
import { Relayer, msgboardContentSource, noopAction, postgresArchiveSink } from '@msgboard/relayer'
import type { RPCMessage } from '@msgboard/sdk'

const main = async () => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: false })
  const archive = postgresArchiveSink({ pool, retention: { days: 365 } })
  await archive.migrate()

  const relayer = new Relayer<RPCMessage>({
    node: { rpcUrl: process.env.RPC_943!, chainId: 943 },
    mode: 'observe', // an archivist never acts; it only records
    intervalMs: 15_000,
    source: msgboardContentSource(), // all categories
    key: (message) => message.hash,
    sink: archive,
    action: noopAction<RPCMessage>(),
  })
  relayer.start()
  console.log('archivist recording all board traffic')
}

main()
