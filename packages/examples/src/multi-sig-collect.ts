/**
 * multi-sig-collect — collect M-of-N signatures off-chain, assemble when the
 * threshold is met.
 *
 * Multi-sig owners can share their individual signatures over the board instead
 * of coordinating through a central server or writing partial state on chain. Each
 * owner signs the same payload and posts the signature under a category; a collector
 * watches, verifies each signature against the known owner set, dedups by signer,
 * and once it has >= threshold signatures it assembles them (sorted by signer, the
 * convention most on-chain multi-sig verifiers expect) into a ready-to-submit set.
 *
 * Two modes:
 *   • No MSGBOARD_RPC (default): simulates N owners signing one payload and walks the
 *     collector from "waiting" to "threshold met → assembled", in-process and instantly.
 *     Also shows that a non-owner signature and a duplicate signer are both ignored.
 *   • MSGBOARD_RPC set: runs a relayer-engine watcher over the `multisig` category that
 *     accumulates signatures across polls until the threshold is reached.
 *
 * Usage:
 *   npm run multi-sig-collect --workspace=packages/examples
 *   MSGBOARD_RPC=https://one.valve.city/rpc/vk_demo/evm/943 npm run multi-sig-collect --workspace=packages/examples
 */
import { hexToString, keccak256, stringToHex, verifyMessage, http, type Address, type Hex } from 'viem'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { fileURLToPath } from 'node:url'
import { Relayer, msgboardContentSource, defaultLogger } from '@msgboard/relayer'
import type { RelayerSource } from '@msgboard/relayer'
import type { RPCMessage } from '@msgboard/sdk'

export const CATEGORY = 'multisig'
export const THRESHOLD = 2

/** One owner's signature over a shared payload, as posted to the board. */
export type Partial = { payload: string; signer: Address; signature: Hex }

/** Groups signatures: a payload's stable id is the hash of its bytes. */
export const payloadId = (payload: string): Hex => keccak256(stringToHex(payload))

// Owners encode a partial as toHex(JSON.stringify(partial)) when posting; this collector decodes.
export const decode = (data: Hex): Partial | null => {
  try {
    const parsed = JSON.parse(hexToString(data)) as Partial
    if (!parsed.payload || !parsed.signer || !parsed.signature) return null
    return parsed
  } catch {
    return null
  }
}

/**
 * Accumulates verified, deduped signatures per payload and reports when a payload
 * crosses the threshold. Owners outside the known set, bad signatures, and repeat
 * signers are all rejected.
 */
export const makeCollector = (owners: readonly Address[], threshold: number) => {
  const ownerSet = new Set(owners.map((address) => address.toLowerCase()))
  const collected = new Map<Hex, Map<Address, Hex>>() // payloadId -> (signer -> signature)
  const assembled = new Set<Hex>() // payloadIds already reported as complete

  const offer = async (partial: Partial): Promise<{ accepted: boolean; reason?: string; complete?: Partial[] }> => {
    if (!ownerSet.has(partial.signer.toLowerCase())) return { accepted: false, reason: 'not an owner' }
    // Board data is untrusted: a malformed signature makes verifyMessage throw, so treat
    // any failure (false or thrown) as a bad signature rather than crashing the watcher.
    const authentic = await verifyMessage({ address: partial.signer, message: partial.payload, signature: partial.signature }).catch(() => false)
    if (!authentic) return { accepted: false, reason: 'bad signature' }

    const id = payloadId(partial.payload)
    const signatures = collected.get(id) ?? new Map<Address, Hex>()
    if (signatures.has(partial.signer)) return { accepted: false, reason: 'duplicate signer' }
    signatures.set(partial.signer, partial.signature)
    collected.set(id, signatures)

    if (signatures.size < threshold || assembled.has(id)) return { accepted: true }

    assembled.add(id)
    // Assemble sorted by signer ascending — the order on-chain verifiers expect.
    const complete = [...signatures.entries()]
      .sort(([a], [b]) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1))
      .map(([signer, signature]) => ({ payload: partial.payload, signer, signature }))
    return { accepted: true, complete }
  }

  return { offer }
}

export const sign = async (payload: string, account: ReturnType<typeof privateKeyToAccount>): Promise<Partial> => ({
  payload,
  signer: account.address,
  signature: await account.signMessage({ message: payload }),
})

async function main() {
  const rpcUrl = process.env.MSGBOARD_RPC

  console.log('\nmsgboard multi-sig-collect')
  console.log('─────────────────────────────────────────')

  if (!rpcUrl) {
    // Offline: three owners, threshold of two, one payload.
    const owners = [0, 1, 2].map(() => privateKeyToAccount(generatePrivateKey()))
    const stranger = privateKeyToAccount(generatePrivateKey())
    const payload = 'transfer 1000 PLS to 0xBEEF…'
    const collector = makeCollector(owners.map((owner) => owner.address), THRESHOLD)

    console.log(`\n${THRESHOLD}-of-${owners.length} multi-sig authorizing: "${payload}"\n`)

    // A stranger's signature is ignored even though it is cryptographically valid.
    const intruder = await collector.offer(await sign(payload, stranger))
    console.log(`stranger ${stranger.address.slice(0, 10)}… → ${intruder.accepted ? 'accepted' : `ignored (${intruder.reason})`}`)

    // Owner 0 signs, then signs again (duplicate), then owner 1 signs (reaches threshold).
    const owner0 = await collector.offer(await sign(payload, owners[0]))
    console.log(`owner ${owners[0].address.slice(0, 10)}… → ${owner0.accepted ? 'accepted (1/2)' : `ignored (${owner0.reason})`}`)

    const dup = await collector.offer(await sign(payload, owners[0]))
    console.log(`owner ${owners[0].address.slice(0, 10)}… again → ${dup.accepted ? 'accepted' : `ignored (${dup.reason})`}`)

    const owner1 = await collector.offer(await sign(payload, owners[1]))
    if (owner1.complete) {
      console.log(`owner ${owners[1].address.slice(0, 10)}… → accepted (2/2) — THRESHOLD MET`)
      console.log('\nassembled signature set (sorted by signer):')
      for (const part of owner1.complete) console.log(`  ${part.signer}  ${part.signature.slice(0, 22)}…`)
      console.log('\nthis set is ready to submit to an on-chain multi-sig verifier.\n')
    }

    console.log(`Set MSGBOARD_RPC to run a live collector over the "${CATEGORY}" category.\n`)
    process.exit(0)
  }

  // Live: accumulate signatures from the board until the threshold is reached.
  // In a real deployment OWNERS would be the multi-sig's on-chain owner set; here the
  // owners are unknown ahead of time, so this watcher accepts the first THRESHOLD distinct
  // signers per payload as a demonstration of accumulation (swap in your real owner set).
  const owners = (process.env.MULTISIG_OWNERS ?? '')
    .split(',')
    .map((address) => address.trim())
    .filter((address): address is Address => address.startsWith('0x'))

  if (owners.length === 0) {
    console.log('\nSet MULTISIG_OWNERS to a comma-separated list of owner addresses to run the live watcher.')
    console.log('(The live collector verifies each signature against that known owner set.)\n')
    process.exit(0)
  }

  const logger = defaultLogger('multi-sig-collect')
  const collector = makeCollector(owners, THRESHOLD)

  const partialSource: RelayerSource<Partial> = {
    poll: async (context) => {
      const messages = (await msgboardContentSource({ category: CATEGORY }).poll(context)) as RPCMessage[]
      return messages.map((message) => decode(message.data)).filter((partial): partial is Partial => partial !== null)
    },
  }

  const relayer = new Relayer<Partial>({
    node: { transport: http(rpcUrl) },
    mode: 'observe',
    source: partialSource,
    key: (partial) => `${payloadId(partial.payload)}:${partial.signer}`,
    action: {
      describe: (partial) => `collect signature from ${partial.signer}`,
      execute: async (partial) => {
        const result = await collector.offer(partial)
        if (result.complete) {
          console.log(`THRESHOLD MET for "${partial.payload}" — assembled ${result.complete.length} signatures`)
          for (const part of result.complete) console.log(`  ${part.signer}  ${part.signature.slice(0, 22)}…`)
        } else {
          console.log(`signature ${result.accepted ? 'collected' : `ignored (${result.reason})`} from ${partial.signer}`)
        }
        return { ok: result.accepted, ref: partial.signer }
      },
    },
    logger,
  })

  relayer.start()
  console.log(`collecting ${THRESHOLD}-of-${owners.length} signatures on the "${CATEGORY}" category — rpc: ${rpcUrl}`)

  process.on('SIGINT', async () => {
    console.log('\nstopping…')
    await relayer.stop()
    process.exit(0)
  })
}

// Run the demo only when executed directly (not when imported by tests).
if (process.argv[1] === fileURLToPath(import.meta.url)) void main()
