/**
 * "Write for me" relay example
 *
 * Clients solve proof-of-work locally and POST the resulting RLP to this relay.
 * The relay forwards every accepted submission on-chain without doing any PoW
 * itself — it just needs a wallet-free msgboard node connection.
 *
 * Usage:
 *   npm run write-for-me --workspace=packages/examples
 *
 * Set MSGBOARD_RPC to point the relay at the chain you want to forward to.
 * Defaults to the public demo testnet endpoint (chain 943) so a misconfigured
 * relay never posts to mainnet by accident.
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

// Note: rpc.pulsechain.com does NOT serve the msgboard_ namespace — only nodes
// running the msgboard reth fork (e.g. valve.city) do. Use such an endpoint.
const rpcUrl = process.env['MSGBOARD_RPC'] ?? 'https://one.valve.city/rpc/vk_demo/evm/943'
const port = Number(process.env['PORT'] ?? 3001)
const token = process.env['RELAY_TOKEN']
const logger = defaultLogger('write-for-me')

/** 4 KiB — well above any real msgboard message; rejects obviously oversized payloads early. */
const MAX_RLP_BYTES = 4096

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
    const rlpBytes = (rlp.length - 2) / 2
    if (rlpBytes > MAX_RLP_BYTES) throw new Error(`rlp exceeds maximum size of ${MAX_RLP_BYTES} bytes`)
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

// User-facing startup banner via console.log so it shows without DEBUG set
// (the relayer's own logger is debug-gated: run with DEBUG='*' for relay internals).
console.log(`write-for-me relay listening on port ${port} — rpc: ${rpcUrl}`)
console.log(`POST { "rlp": "0x..." } to http://localhost:${port}/submit`)

process.on('SIGINT', async () => {
  console.log('\nshutting down…')
  await relayer.stop()
  await queue.close()
  process.exit(0)
})
