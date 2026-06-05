import pg from 'pg'
import { type Hex, isAddress } from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import type { RPCMessage } from '@msgboard/sdk'
import {
  Relayer,
  msgboardContentSource,
  postgresArchiveSink,
  postgresStore,
  sendValueAction,
} from '@msgboard/relayer'

const main = async () => {
  if (!process.env.MNEMONIC) {
    throw new Error('MNEMONIC environment variable is required')
  }
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: false })
  await pool.query('SELECT 1')
  console.log('connected to db')

  const store = postgresStore<RPCMessage>({ pool, table: 'sponsored', maxAgeMs: 60 * 60 * 1000 })
  await store.migrate()
  const archive = postgresArchiveSink({ pool, retention: { days: 365 } })
  await archive.migrate()
  console.log('migration complete')

  const account = mnemonicToAccount(process.env.MNEMONIC)
  const rpcUrl =
    process.env.RPC_943 || process.env.VITE_RPC_943 || 'https://rpc.v4.testnet.pulsechain.com'
  const mode = process.env.FAKE_TRANSFERS ? 'observe' : 'live'
  console.log('sponsoring with %o (mode=%s)', account.address, mode)

  const relayer = new Relayer<RPCMessage>({
    node: { rpcUrl, chainId: 943 },
    mode,
    intervalMs: 20_000,
    source: msgboardContentSource({ category: 'gasmoneyplease' }),
    condition: (message) => isAddress(message.data),
    key: (message) => message.hash.toLowerCase(),
    store,
    sink: archive,
    action: sendValueAction<RPCMessage>({
      account,
      recipient: (message) => message.data.toLowerCase() as Hex,
      amount: 10n * 10n ** 18n,
      gas: 25_200n,
    }),
  })
  relayer.start()
}

main()
