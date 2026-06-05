import pg from 'pg'
import { hexToString } from 'viem'
import { Relayer, msgboardContentSource, noopAction, postgresSink } from '@msgboard/relayer'
import type { RPCMessage } from '@msgboard/sdk'

const blocklist = (process.env.BLOCKLIST ?? 'spamword,scam').split(',')

const looksBad = (message: RPCMessage): boolean => {
  try {
    const text = hexToString(message.data).toLowerCase()
    return blocklist.some((word) => text.includes(word))
  } catch {
    return false
  }
}

// Note: sink.record runs before the condition in the standard tick pipeline. In
// this flagger, the sink IS the flag table — it is configured as the condition-gated
// sink rather than an archive. Only messages passing `looksBad` reach the action
// (a noop), and `sink.record` is called for every message, so the flagged table
// records ALL messages that match the condition. Messages that do not match are
// neither flagged nor acted upon.
const main = async () => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: false })
  const flagged = postgresSink<RPCMessage>({
    pool,
    table: 'flagged',
    toRow: (message) => ({
      key: message.hash,
      payload: { category: message.category, data: message.data },
    }),
  })
  await flagged.migrate()

  const relayer = new Relayer<RPCMessage>({
    node: { rpcUrl: process.env.RPC_943!, chainId: 943 },
    mode: 'observe',
    intervalMs: 15_000,
    source: msgboardContentSource(),
    condition: looksBad,
    key: (message) => message.hash,
    sink: flagged,
    action: noopAction<RPCMessage>(),
  })
  relayer.start()
}

main()
