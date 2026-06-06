/**
 * "Write for me" relay example
 *
 * Clients solve proof-of-work locally and POST the resulting RLP to this relay.
 * The relay forwards every accepted submission on-chain without doing any PoW
 * itself — it just needs a wallet-free msgboard node connection.
 *
 * Usage:
 *   RPC_URL=https://rpc.pulsechain.com npx ts-node write-for-me.ts
 *
 * Submitting a message from a client (curl):
 *   curl -X POST http://localhost:3001/submit \
 *     -H 'Content-Type: application/json' \
 *     -d '{"rlp":"0x..."}'
 *
 * To protect the endpoint, set RELAY_TOKEN and pass the same value as:
 *   -H 'Authorization: Bearer <token>'
 */
import { http, isHex, type Hex } from 'viem'
import { Relayer, httpQueueSource, forwardMessageAction, defaultLogger } from '@msgboard/relayer'

const rpcUrl = process.env['RPC_URL'] ?? 'https://rpc.pulsechain.com'
const port = Number(process.env['PORT'] ?? 3001)
const token = process.env['RELAY_TOKEN']
const logger = defaultLogger('write-for-me')

const queue = httpQueueSource<Hex>({
  port,
  token,
  parse: (body) => {
    if (
      typeof body !== 'object' ||
      body === null ||
      !('rlp' in body) ||
      typeof (body as { rlp: unknown }).rlp !== 'string'
    ) {
      throw new Error('body must be { rlp: "0x..." }')
    }
    const rlp = (body as { rlp: string }).rlp
    if (!isHex(rlp)) throw new Error('rlp must be a hex string starting with 0x')
    return rlp as Hex
  },
})

const relayer = new Relayer<Hex>({
  node: { transport: http(rpcUrl) },
  mode: 'live',
  source: queue,
  key: (rlp) => rlp,
  action: forwardMessageAction(),
  logger,
})

relayer.start()

logger(`write-for-me relay listening on port ${port} — rpc: ${rpcUrl}`)

process.on('SIGINT', async () => {
  logger('shutting down…')
  await relayer.stop()
  await queue.close()
  process.exit(0)
})
