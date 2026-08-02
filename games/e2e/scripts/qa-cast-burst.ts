/**
 * Burst test for the PARALLEL cast-watcher. Opens N table rounds CONCURRENTLY (pre-assigned
 * sequential pool slots + contiguous nonces, exactly how the caster now batches its casts), then
 * watches how the live caster settles them. The batched caster should settle the whole burst within
 * a block or two of each other (the serial caster settled ~1/tick and expired the tail of a burst).
 *
 * Safe for the live system: the caster simulates each cast before assigning a nonce, so if an
 * external heat ever interleaved and shifted a test round's slot, that round's cast fails simulation
 * and is simply dropped (never sent) — the round then refunds via refundStale. No pool corruption.
 *
 *   PRIVATE_KEY=<valve_deployer> [N=5] npx tsx scripts/qa-cast-burst.ts
 */
import * as viem from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { coinFlipTablesAbi, randomAbi, poolLocationFor, type Info } from '@msgboard/games-core'
import { loadDeployment, heatsSince } from './actor-common'

const RPC = process.env.RPC_URL ?? 'https://rpc.v4.testnet.pulsechain.com'
const N = Number(process.env.N ?? 5)
const SETTLE_TIMEOUT_MS = Number(process.env.SETTLE_TIMEOUT_MS ?? 240_000)
const chain = { id: 943, name: 'pulse-943', nativeCurrency: { name: 'PLS', symbol: 'PLS', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const
const chipsAbi = [
  { name: 'mint', type: 'function', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { name: 'approve', type: 'function', inputs: [{ name: 's', type: 'address' }, { name: 'a', type: 'uint256' }], outputs: [{ type: 'bool' }], stateMutability: 'nonpayable' },
  { name: 'balanceOf', type: 'function', inputs: [{ name: '', type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
] as const satisfies viem.Abi
const E = (n: number) => BigInt(n) * 10n ** 18n
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main() {
  /* eslint-disable no-console */
  const pk = process.env.PRIVATE_KEY
  if (!pk) throw new Error('set PRIVATE_KEY (valve_deployer)')
  const account = privateKeyToAccount((pk.startsWith('0x') ? pk : `0x${pk}`) as viem.Hex)
  const cfg = loadDeployment(943)
  const CFT = cfg.coinFlipTables!
  const subset = cfg.canonicalSubset
  const pc = viem.createPublicClient({ chain, transport: viem.http(RPC) })
  const wc = viem.createWalletClient({ account, chain, transport: viem.http(RPC) })
  const CHIPS = (await pc.readContract({ address: CFT, abi: coinFlipTablesAbi, functionName: 'chips' })) as viem.Hex
  const baseFee = (await pc.getBlock()).baseFeePerGas ?? 0n
  const gasPrice = baseFee * 2n > viem.parseGwei('1') ? baseFee * 2n : viem.parseGwei('1')
  const baseOf = (p: string) => BigInt(cfg.poolOffsets[p.toLowerCase()] ?? '0')
  const locsAt = (k: bigint): Info[] => subset.map((provider) => {
    const { offset, index } = poolLocationFor(k, baseOf(provider), BigInt(cfg.poolSize))
    return { provider, callAtChange: false, durationIsTimestamp: false, duration: 12n, token: viem.zeroAddress, price: 0n, offset, index }
  })
  // Serial helper for setup txs (mint/approve/create/fund) — awaits each so nonces settle before the burst.
  const send = async (c: { address: viem.Hex; abi: viem.Abi; functionName: string; args: readonly unknown[] }) => {
    const { request } = await pc.simulateContract({ ...c, account, gasPrice })
    return pc.waitForTransactionReceipt({ hash: await wc.writeContract(request) })
  }

  console.log(`\n=== cast-burst: ${N} concurrent rounds on 943 ===\n contract ${CFT}\n player/operator ${account.address}\n`)
  if (((await pc.readContract({ address: CHIPS, abi: chipsAbi, functionName: 'balanceOf', args: [account.address] })) as bigint) < E(5000)) {
    console.log(' minting 100000 Chips…'); await send({ address: CHIPS, abi: chipsAbi, functionName: 'mint', args: [account.address, E(100000)] })
  }
  await send({ address: CHIPS, abi: chipsAbi, functionName: 'approve', args: [CFT, E(10_000_000)] })
  const tc = await send({ address: CFT, abi: coinFlipTablesAbi, functionName: 'createTable', args: [196, E(1000), E(100000)] })
  const tableId = (viem.parseEventLogs({ abi: coinFlipTablesAbi, logs: tc.logs, eventName: 'TableCreated' })[0] as any).args.tableId as viem.Hex
  await send({ address: CFT, abi: coinFlipTablesAbi, functionName: 'fundHot', args: [tableId, E(10000)] })
  console.log(` table ${tableId.slice(0, 12)}… funded (hot 10000)`)

  // Snapshot the slot base + nonce base as LATE as possible, then fire all N opens at once with
  // pre-assigned sequential slots (k0+i) and contiguous nonces (base+i) — minimal interleave window.
  const k0 = BigInt((await heatsSince(pc, cfg)).length)
  const baseNonce = await pc.getTransactionCount({ address: account.address, blockTag: 'pending' })
  console.log(` bursting ${N} opens at slots ${k0}..${k0 + BigInt(N - 1)} (nonces ${baseNonce}..${baseNonce + N - 1})…`)
  const opened = await Promise.all(
    Array.from({ length: N }, async (_v, i) => {
      const { request } = await pc.simulateContract({
        address: CFT, abi: coinFlipTablesAbi, functionName: 'open',
        args: [tableId, i % 2, E(1), subset, locsAt(k0 + BigInt(i))], account, gasPrice,
      })
      const hash = await wc.writeContract({ ...request, nonce: baseNonce + i })
      const rc = await pc.waitForTransactionReceipt({ hash })
      const ev = (viem.parseEventLogs({ abi: coinFlipTablesAbi, logs: rc.logs, eventName: 'RoundOpened' })[0] as any).args
      const heatLogs = viem.parseEventLogs({ abi: randomAbi, logs: rc.logs, eventName: 'Heat' }) as any[]
      const v0 = subset[0]!
      const trueSlot = BigInt(heatLogs.find((h) => (h.args.provider as string).toLowerCase() === v0.toLowerCase())!.args.index) - baseOf(v0)
      return { i, roundId: ev.roundId as viem.Hex, key: ev.key as viem.Hex, openBlock: rc.blockNumber, expectSlot: k0 + BigInt(i), trueSlot }
    }),
  )
  const openBlocks = [...new Set(opened.map((o) => o.openBlock))].sort((a, b) => (a < b ? -1 : 1))
  console.log(` opened ${N} rounds across block(s) ${openBlocks.join(', ')}`)
  const mismatched = opened.filter((o) => o.trueSlot !== o.expectSlot)
  if (mismatched.length) console.log(` ⚠️  ${mismatched.length} round(s) got a shifted slot (external interleave) — those will refund, not settle`)
  else console.log(` ✅ all ${N} rounds heated at their expected contiguous slots (no interleave)`)

  // Watch the caster settle them. Record each round's settle block; group to reveal batching.
  console.log(`\n watching the live caster settle (timeout ${SETTLE_TIMEOUT_MS / 1000}s)…`)
  const settleBlock = new Map<string, bigint>()
  const expired = new Set<string>()
  const start = Date.now()
  while (Date.now() - start < SETTLE_TIMEOUT_MS && settleBlock.size + expired.size < N) {
    for (const o of opened) {
      if (settleBlock.has(o.roundId) || expired.has(o.roundId)) continue
      const round = (await pc.readContract({ address: CFT, abi: coinFlipTablesAbi, functionName: 'rounds', args: [o.roundId] })) as any[]
      if (Number(round[7]) === 2) {
        // find the RoundSettled block by scanning from the open block
        const logs = await pc.getContractEvents({ address: CFT, abi: coinFlipTablesAbi, eventName: 'RoundSettled', fromBlock: o.openBlock })
        const hit = (logs as any[]).find((l) => (l.args.roundId as string)?.toLowerCase() === o.roundId.toLowerCase())
        settleBlock.set(o.roundId, hit ? (hit.blockNumber as bigint) : 0n)
      } else {
        const timeline = (await pc.readContract({ address: cfg.random, abi: randomAbi, functionName: 'randomness', args: [o.key] }) as any).timeline as bigint
        if ((await pc.readContract({ address: cfg.random, abi: randomAbi, functionName: 'expired', args: [timeline] })) as boolean) expired.add(o.roundId)
      }
    }
    process.stdout.write(`\r  settled ${settleBlock.size}/${N}  expired ${expired.size}/${N}   `)
    if (settleBlock.size + expired.size < N) await sleep(4000)
  }
  process.stdout.write('\n')

  const blocks = [...settleBlock.values()].filter((b) => b > 0n).sort((a, b) => (a < b ? -1 : 1))
  const byBlock = new Map<string, number>()
  for (const b of blocks) byBlock.set(b.toString(), (byBlock.get(b.toString()) ?? 0) + 1)
  const batched = [...byBlock.entries()].filter(([, c]) => c >= 2)
  const spanBlocks = blocks.length ? Number(blocks[blocks.length - 1]! - blocks[0]!) : 0
  console.log(`\n=== RESULT ===`)
  console.log(` settled ${settleBlock.size}/${N}, expired ${expired.size}/${N}`)
  console.log(` settle blocks: ${blocks.join(', ') || '(none)'} (span ${spanBlocks} blocks)`)
  console.log(` same-block batches: ${batched.length ? batched.map(([b, c]) => `${c}@${b}`).join(', ') : 'none'}`)
  if (settleBlock.size === N && spanBlocks <= 2) console.log(`\n🎉 BURST SETTLED: all ${N} rounds settled within ${spanBlocks} block(s) — the parallel caster kept up with the burst.`)
  else if (settleBlock.size === N) console.log(`\n✅ all ${N} settled (span ${spanBlocks} blocks).`)
  else console.log(`\n⚠️ ${expired.size} expired (refundable). ${mismatched.length ? 'Slot interleave, not a caster fault.' : 'Investigate.'}`)
  process.exit(0)
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1) })
