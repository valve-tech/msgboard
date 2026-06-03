import pg from 'pg'
import { pulsechainV4 } from 'viem/chains'
import * as msgboard from '@msgboard/sdk'
import {
  createPublicClient,
  createWalletClient,
  type Hex,
  http,
  isAddress,
  numberToHex,
  stringToHex,
} from 'viem'
import { mnemonicToAccount } from 'viem/accounts'

const migrateDB = async (pool: pg.Pool) => {
  await pool.query(queries.CREATE_TABLE)
  await pool.query(queries.NORMALIZE_CASE)
}

const clearOldSponsorships = async (pool: pg.Pool) => {
  await pool.query(queries.DELETE_OLD)
}

const queries = {
  CREATE_TABLE: `CREATE TABLE IF NOT EXISTS sponsored (
	work_hash TEXT PRIMARY KEY,
	address TEXT,
	tx_hash TEXT,
	created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`,
  GET_BY_WORK_HASH: `SELECT work_hash, address, tx_hash
FROM sponsored
WHERE work_hash = $1
LIMIT 1`,
  NORMALIZE_CASE: `UPDATE sponsored
SET work_hash = LOWER(work_hash), address = LOWER(address), tx_hash = LOWER(tx_hash)
WHERE work_hash != LOWER(work_hash) OR address != LOWER(address) OR tx_hash != LOWER(tx_hash)`,
  DELETE_OLD: `DELETE FROM sponsored
WHERE created_at < NOW() - INTERVAL '1 hour'`,
  INSERT_SPONSORSHIP: `INSERT INTO sponsored (work_hash, address, tx_hash)
VALUES ($1, $2, $3)
ON CONFLICT (work_hash)
DO UPDATE SET tx_hash = $3`,
}

const main = async () => {
  if (!process.env.MNEMONIC) {
    throw new Error('MNEMONIC environment variable is required')
  }
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: false })
  await pool.query('SELECT 1')
  console.log('connected to db')
  await migrateDB(pool)
  console.log('migration complete')
  const rpc = process.env.RPC_943 || process.env.VITE_RPC_943 || 'https://rpc.v4.testnet.pulsechain.com'
  const transport = http(rpc, { timeout: 30_000 })
  const provider = createPublicClient({ chain: pulsechainV4, transport })
  const account = mnemonicToAccount(process.env.MNEMONIC)
  const wallet = createWalletClient({ account, chain: pulsechainV4, transport })
  const worker = new msgboard.MsgBoardClient(provider as msgboard.Provider)
  const categoryText = 'gasmoneyplease'
  const gasplease = stringToHex(categoryText, { size: 32 })
  console.log('sponsoring with %o', wallet.account.address)
  console.log('content under category=%o text=%o', gasplease, categoryText)
  while (true) {
    try {
      await clearOldSponsorships(pool)
      const content = await worker.content({ category: gasplease })
      console.log('content under category=%o text=%o', gasplease, categoryText)
      if (content[gasplease]) {
        const contentUnder = Object.values(content[gasplease] ?? {})
        console.log('content under count=%o', contentUnder.length)
        for (const msg of contentUnder) {
          const hash = msg.hash.toLowerCase() as Hex
          const data = msg.data.toLowerCase() as Hex
          const { rows: sponsored } = await pool.query(queries.GET_BY_WORK_HASH, [hash])
          if (sponsored.length > 0 || !isAddress(data)) {
            continue
          }
          console.log('sponsoring work %o -> %o', hash, data)
          if (process.env.FAKE_TRANSFERS) {
            await pool.query(queries.INSERT_SPONSORSHIP, [hash, data, numberToHex(Date.now(), { size: 32 })])
            continue
          }
          const txhash = await wallet.sendTransaction({
            value: 10n * 10n ** 18n,
            to: data,
            gas: 25_200n,
          })
          await pool.query(queries.INSERT_SPONSORSHIP, [hash, data, txhash])
          const receipt = await provider.waitForTransactionReceipt({ hash: txhash })
          console.log('sponsored %o', receipt.transactionHash)
        }
      }
    } catch (e) {
      console.error('loop iteration failed, retrying in 20s: %o', e instanceof Error ? e.message : e)
    }
    await new Promise((resolve) => setTimeout(resolve, 20_000))
  }
}

main()
