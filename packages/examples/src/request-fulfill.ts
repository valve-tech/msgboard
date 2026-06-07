/**
 * request-fulfill — broadcast a signed request, watch for it, validate, fulfill.
 *
 * This is the shared skeleton behind several msgboard use cases:
 *   • Intent Distribution — a user broadcasts an intent; solvers pick it up.
 *   • Action Requests     — a wallet signals it wants an action taken on its behalf.
 *   • Account Abstraction  — an account authorizes an action by sharing a signature.
 *
 * In every case the message itself is untrusted board data, so the fulfiller must
 * verify a signature before acting. The request is signed off-chain, posted under a
 * category, and any watcher can recover the signer and decide whether to fulfill it.
 *
 * Two modes:
 *   • No MSGBOARD_RPC (default): runs the whole pattern in-process against a freshly
 *     signed request — sign → encode → decode → recover → verify → fulfill — so you
 *     can see the validation logic instantly without a node.
 *   • MSGBOARD_RPC set: runs a relayer-engine watcher over the `intent` category that
 *     validates signatures and fulfills any well-formed signed requests it finds.
 *
 * Usage:
 *   npm run request-fulfill --workspace=packages/examples
 *   MSGBOARD_RPC=https://one.valve.city/rpc/vk_demo/evm/943 npm run request-fulfill --workspace=packages/examples
 */
import { hexToString, toHex, verifyMessage, http, type Address, type Hex } from 'viem'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { fileURLToPath } from 'node:url'
import { Relayer, msgboardContentSource, defaultLogger } from '@msgboard/relayer'
import type { RelayerSource } from '@msgboard/relayer'
import type { RPCMessage } from '@msgboard/sdk'

export const CATEGORY = 'intent'

/** The off-chain request a user authorizes. Signed as canonical JSON. */
export type Request = { action: string; params: string; issuedAt: number; nonce: string }

/** The wire envelope posted to the board: the request, who signed it, and the signature. */
export type Envelope = { request: Request; signer: Address; signature: Hex }

/** Canonical bytes that get signed — deterministic key order so signer and verifier agree. */
export const canonical = (request: Request): string =>
  JSON.stringify({ action: request.action, params: request.params, issuedAt: request.issuedAt, nonce: request.nonce })

/** Signs a request and packages it into a board-ready envelope. */
export const sign = async (request: Request, account: ReturnType<typeof privateKeyToAccount>): Promise<Envelope> => ({
  request,
  signer: account.address,
  signature: await account.signMessage({ message: canonical(request) }),
})

/** Encodes an envelope as the hex `data` field of a board message. */
export const encode = (envelope: Envelope): Hex => toHex(JSON.stringify(envelope))

/** Decodes a board message's hex `data` back into an envelope, or null if it isn't one. */
export const decode = (data: Hex): Envelope | null => {
  try {
    const parsed = JSON.parse(hexToString(data)) as Envelope
    if (!parsed.request || !parsed.signer || !parsed.signature) return null
    return parsed
  } catch {
    return null
  }
}

/**
 * Recovers the signer and confirms it authorized exactly this request. Board data is
 * untrusted, so a malformed signature (which makes verifyMessage throw) is treated as
 * not authentic rather than propagating the error to the watcher.
 */
export const isAuthentic = (envelope: Envelope): Promise<boolean> =>
  verifyMessage({ address: envelope.signer, message: canonical(envelope.request), signature: envelope.signature }).catch(() => false)

export const fulfill = (envelope: Envelope): void => {
  console.log(`  ✓ fulfilling "${envelope.request.action}" (${envelope.request.params}) authorized by ${envelope.signer}`)
}

async function main() {
  const rpcUrl = process.env.MSGBOARD_RPC

  console.log('\nmsgboard request-fulfill')
  console.log('─────────────────────────────────────────')

  if (!rpcUrl) {
    // Offline: demonstrate the full validate→fulfill pipeline against a fresh signature.
    const account = privateKeyToAccount(generatePrivateKey())
    const request: Request = { action: 'swap', params: '100 PLS -> USDC', issuedAt: 1717000000, nonce: 'demo-1' }

    const envelope = await sign(request, account)
    const data = encode(envelope)
    console.log(`\nsigner ${account.address} broadcast a "${request.action}" intent`)
    console.log(`board data (hex): ${data.slice(0, 42)}…  (${(data.length - 2) / 2} bytes)`)

    const received = decode(data)
    if (!received) throw new Error('failed to decode envelope')

    console.log(`\nwatcher decoded the envelope and is verifying the signature…`)
    if (await isAuthentic(received)) {
      fulfill(received)
    } else {
      console.log('  ✗ signature did not verify — ignored')
    }

    // Show the security property: a tampered request fails verification.
    const tampered: Envelope = { ...received, request: { ...received.request, params: '100000 PLS -> USDC' } }
    console.log(`\na tampered copy (params changed) must be rejected…`)
    console.log(await isAuthentic(tampered) ? '  ✗ BUG: tampered request verified' : '  ✓ rejected — signature no longer matches')

    console.log(`\nSet MSGBOARD_RPC to run a live relayer watcher over the "${CATEGORY}" category.\n`)
    process.exit(0)
  }

  // Live: a relayer-engine watcher that validates and fulfills signed requests on the board.
  const logger = defaultLogger('request-fulfill')

  /** Source: read the `intent` category and decode each message into an envelope. */
  const envelopeSource: RelayerSource<Envelope> = {
    poll: async (context) => {
      const messages = (await msgboardContentSource({ category: CATEGORY }).poll(context)) as RPCMessage[]
      return messages.map((message) => decode(message.data)).filter((envelope): envelope is Envelope => envelope !== null)
    },
  }

  const relayer = new Relayer<Envelope>({
    node: { transport: http(rpcUrl) },
    mode: 'observe',
    source: envelopeSource,
    key: (envelope) => `${envelope.signer}:${envelope.request.nonce}`,
    condition: (envelope) => isAuthentic(envelope), // only authentic requests are eligible
    action: {
      describe: (envelope) => `fulfill ${envelope.request.action} from ${envelope.signer}`,
      execute: async (envelope) => {
        fulfill(envelope)
        return { ok: true, ref: envelope.request.nonce }
      },
    },
    logger,
  })

  relayer.start()
  console.log(`watching the "${CATEGORY}" category for signed requests — rpc: ${rpcUrl}`)
  console.log('post signed envelopes there to see them validated and fulfilled.')

  process.on('SIGINT', async () => {
    console.log('\nstopping…')
    await relayer.stop()
    process.exit(0)
  })
}

// Run the demo only when executed directly (not when imported by tests).
if (process.argv[1] === fileURLToPath(import.meta.url)) void main()
