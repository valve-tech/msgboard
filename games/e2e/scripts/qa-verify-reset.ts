/**
 * Verify the pool reset: with the fresh 943-deployment.json (new offsets + new deployBlock), open a
 * table round at the current on-chain slot, cast it with seeds0 at its true slot, and confirm it
 * SETTLES. Proves the fresh pools are correctly inked and the caster logic works.
 *
 *   PRIVATE_KEY=<valve_deployer> SEEDS0=<seeds0 mnemonic> npx tsx scripts/qa-verify-reset.ts
 */
import * as viem from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { coinFlipTablesAbi, randomAbi, poolLocationFor, type Info } from '@msgboard/games-core'
import { loadDeployment, heatsSince } from './actor-common'
import { seeds0Secret, SECRET_STRIDE } from './seeds0'

const RPC = process.env.RPC_URL ?? 'https://rpc.v4.testnet.pulsechain.com'
const ZERO32 = viem.padHex('0x0', { size: 32 })
const chain = { id: 943, name: 'p', nativeCurrency: { name: 'PLS', symbol: 'PLS', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const
const chipsAbi = [
  { name: 'approve', type: 'function', inputs: [{ name: 's', type: 'address' }, { name: 'a', type: 'uint256' }], outputs: [{ type: 'bool' }], stateMutability: 'nonpayable' },
  { name: 'balanceOf', type: 'function', inputs: [{ name: '', type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
] as const satisfies viem.Abi
const E = (n: number) => BigInt(n) * 10n ** 18n

async function main() {
  /* eslint-disable no-console */
  const account = privateKeyToAccount(((process.env.PRIVATE_KEY!.startsWith('0x') ? '' : '0x') + process.env.PRIVATE_KEY!) as viem.Hex)
  const SEEDS0 = process.env.SEEDS0!
  const cfg = loadDeployment(943)
  const CFT = cfg.coinFlipTables!
  const pc = viem.createPublicClient({ chain, transport: viem.http(RPC) })
  const wc = viem.createWalletClient({ account, chain, transport: viem.http(RPC) })
  const CHIPS = (await pc.readContract({ address: CFT, abi: coinFlipTablesAbi, functionName: 'chips' })) as viem.Hex
  const bf = (await pc.getBlock()).baseFeePerGas ?? 0n
  const gasPrice = bf * 2n > viem.parseGwei('2') ? bf * 2n : viem.parseGwei('2')
  const subset = cfg.canonicalSubset
  const baseOf = (p: string) => BigInt(cfg.poolOffsets[p.toLowerCase()] ?? '0')
  const send = async (c: { address: viem.Hex; abi: viem.Abi; functionName: string; args: readonly unknown[] }) => {
    const { request } = await pc.simulateContract({ ...c, account, gasPrice }); return pc.waitForTransactionReceipt({ hash: await wc.writeContract(request) })
  }
  const locsAt = (k: bigint): Info[] => subset.map((provider) => {
    const { offset, index } = poolLocationFor(k, baseOf(provider), BigInt(cfg.poolSize))
    return { provider, callAtChange: false, durationIsTimestamp: false, duration: 12n, token: viem.zeroAddress, price: 0n, offset, index }
  })

  console.log(`config: deployBlock ${cfg.deployBlock}, offsets ${JSON.stringify(cfg.poolOffsets)}`)
  const nextSlot = BigInt((await heatsSince(pc, cfg)).length)
  console.log(`heats since new deployBlock = ${nextSlot} → open at slot ${nextSlot}`)

  if (((await pc.readContract({ address: CHIPS, abi: chipsAbi, functionName: 'balanceOf', args: [account.address] })) as bigint) < E(50)) throw new Error('need Chips')
  await send({ address: CHIPS, abi: chipsAbi, functionName: 'approve', args: [CFT, E(1_000_000)] })
  const tc = await send({ address: CFT, abi: coinFlipTablesAbi, functionName: 'createTable', args: [196, E(10), E(10000)] })
  const tableId = (viem.parseEventLogs({ abi: coinFlipTablesAbi, logs: tc.logs, eventName: 'TableCreated' })[0] as any).args.tableId as viem.Hex
  await send({ address: CFT, abi: coinFlipTablesAbi, functionName: 'fundHot', args: [tableId, E(100)] })

  let openRc: viem.TransactionReceipt | undefined
  for (const s of [nextSlot, nextSlot + 1n, nextSlot + 2n, nextSlot + 3n]) {
    try { openRc = await send({ address: CFT, abi: coinFlipTablesAbi, functionName: 'open', args: [tableId, 0, E(1), subset, locsAt(s)] }); break }
    catch (e) { console.log(`  open at slot ${s} failed (${(e as Error).message.split('\n')[0].slice(0, 70)}), retry…`) }
  }
  if (!openRc) throw new Error('open failed at all candidate slots')
  const opened = (viem.parseEventLogs({ abi: coinFlipTablesAbi, logs: openRc.logs, eventName: 'RoundOpened' })[0] as any).args
  const roundId = opened.roundId as viem.Hex, key = opened.key as viem.Hex
  const heatLogs = viem.parseEventLogs({ abi: randomAbi, logs: openRc.logs, eventName: 'Heat' }) as any[]
  const trueSlot = BigInt(heatLogs.find((h) => (h.args.provider as string).toLowerCase() === subset[0].toLowerCase())!.args.index) - baseOf(subset[0])
  console.log(`opened round, key ${key.slice(0, 12)}…, trueSlot ${trueSlot}`)

  const secrets = subset.map((_p, i) => seeds0Secret(SEEDS0, i * SECRET_STRIDE + Number(trueSlot)))
  const castRc = await send({ address: cfg.random, abi: randomAbi, functionName: 'cast', args: [key, locsAt(trueSlot), secrets] })
  console.log(`✅ cast landed block ${castRc.blockNumber}`)
  const seed = ((await pc.readContract({ address: cfg.random, abi: randomAbi, functionName: 'randomness', args: [key] })) as any).seed as viem.Hex
  const round = (await pc.readContract({ address: CFT, abi: coinFlipTablesAbi, functionName: 'rounds', args: [roundId] })) as any[]
  const settled = Number(round[7]) === 2
  console.log(`\nseed ${seed.slice(0, 14)}… round ${settled ? '✅ SETTLED' : 'status ' + round[7]} parity ${(BigInt(seed) & 1n) === 0n ? 'HEADS' : 'TAILS'}`)
  console.log(seed !== ZERO32 && settled ? '\n🎉 RESET VERIFIED: fresh pool cast at trueSlot → round settled with seeds0.' : '\n⚠️ not settled')
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1) })
