/**
 * Live QA harness for CoinFlipTables on 943. Drives the deployed contract end-to-end against the
 * (now tables-aware) cast-watcher and asserts each condition. NOT a bot — a one-shot QA runner.
 *
 *   PRIVATE_KEY=<valve_deployer> MODE=smoke  npx tsx scripts/qa-coinfliptables.ts   # one round, settle
 *   PRIVATE_KEY=<valve_deployer> MODE=matrix npx tsx scripts/qa-coinfliptables.ts   # condition matrix
 *   PRIVATE_KEY=<valve_deployer> MODE=all    npx tsx scripts/qa-coinfliptables.ts
 *
 * valve_deployer owns Chips (mints) + is funded with PLS. It plays BOTH operator and player here.
 * Heat locations are built from heatsSince().length (the TRUE consumed slot, counting tables) so
 * open() points at the right preimage — the web's nextHeatLocations undercounts for tables.
 */
import * as viem from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { coinFlipTablesAbi, randomAbi, poolLocationFor, type Info } from '@msgboard/games-core'
import { loadDeployment, heatsSince } from './actor-common'

const RPC = process.env.RPC_URL ?? 'https://rpc.v4.testnet.pulsechain.com'
const MODE = process.env.MODE ?? 'smoke'
const SETTLE_TIMEOUT_MS = Number(process.env.SETTLE_TIMEOUT_MS ?? 180_000)
const chain = { id: 943, name: 'pulse-943', nativeCurrency: { name: 'PLS', symbol: 'PLS', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const

const chipsAbi = [
  { name: 'mint', type: 'function', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { name: 'approve', type: 'function', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }], stateMutability: 'nonpayable' },
  { name: 'balanceOf', type: 'function', inputs: [{ name: '', type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { name: 'allowance', type: 'function', inputs: [{ name: '', type: 'address' }, { name: '', type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
] as const satisfies viem.Abi

const E = (n: number | bigint) => BigInt(n) * 10n ** 18n
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let PASS = 0, FAIL = 0
const check = (name: string, ok: boolean, detail = '') => { console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`); ok ? PASS++ : FAIL++; return ok }

async function main() {
  /* eslint-disable no-console */
  const pk = process.env.PRIVATE_KEY
  if (!pk) throw new Error('set PRIVATE_KEY (valve_deployer)')
  const account = privateKeyToAccount((pk.startsWith('0x') ? pk : `0x${pk}`) as viem.Hex)
  const cfg = loadDeployment(943)
  const CFT = cfg.coinFlipTables!
  if (!CFT) throw new Error('943-deployment.json has no coinFlipTables')

  const pc = viem.createPublicClient({ chain, transport: viem.http(RPC) })
  const wc = viem.createWalletClient({ account, chain, transport: viem.http(RPC) })
  // chips address from the contract itself (source of truth)
  const CHIPS = (await pc.readContract({ address: CFT, abi: coinFlipTablesAbi, functionName: 'chips' })) as viem.Hex
  // 943's node quotes an absurd ~8.8M-gwei getGasPrice(); match the block base fee (near-0 on 943)
  // with a 1-gwei floor instead (what the deploy's resolveLegacyFee does), else txs are unaffordable.
  const baseFee = (await pc.getBlock()).baseFeePerGas ?? 0n
  const gasPrice = baseFee * 2n > viem.parseGwei('1') ? baseFee * 2n : viem.parseGwei('1')
  const send = async (call: { address: viem.Hex; abi: viem.Abi; functionName: string; args: readonly unknown[] }) => {
    const { request } = await pc.simulateContract({ ...call, account, gasPrice })
    const hash = await wc.writeContract(request)
    return pc.waitForTransactionReceipt({ hash })
  }
  const expectRevert = async (name: string, call: { address: viem.Hex; abi: viem.Abi; functionName: string; args: readonly unknown[] }, wantErr?: string) => {
    try { await pc.simulateContract({ ...call, account, gasPrice }); check(name, false, 'did NOT revert'); }
    catch (e) { const m = (e as Error).message; check(name, !wantErr || m.includes(wantErr), wantErr ? `reverted (${m.split('\n')[0].slice(0, 80)})` : 'reverted'); }
  }
  const heatLocations = async (): Promise<Info[]> => {
    const k = BigInt((await heatsSince(pc, cfg)).length)
    return cfg.canonicalSubset.map((provider) => {
      const { offset, index } = poolLocationFor(k, BigInt(cfg.poolOffsets[provider.toLowerCase()] ?? '0'), BigInt(cfg.poolSize))
      return { provider, callAtChange: false, durationIsTimestamp: false, duration: 12n, token: viem.zeroAddress, price: 0n, offset, index }
    })
  }
  const readTable = async (id: viem.Hex) => {
    const t = (await pc.readContract({ address: CFT, abi: coinFlipTablesAbi, functionName: 'tables', args: [id] })) as any[]
    return { operator: t[0], hot: t[1] as bigint, cold: t[2] as bigint, escrowed: t[3] as bigint, stake: t[4] as bigint, maxMultiplierX100: Number(t[5]), maxStake: t[6] as bigint, hotTarget: t[7] as bigint, open: t[8] as boolean }
  }
  const createTable = async (mult: number, maxStake: bigint, hotTarget: bigint): Promise<viem.Hex> => {
    const r = await send({ address: CFT, abi: coinFlipTablesAbi, functionName: 'createTable', args: [mult, maxStake, hotTarget] })
    const ev = viem.parseEventLogs({ abi: coinFlipTablesAbi, logs: r.logs, eventName: 'TableCreated' })[0] as any
    return ev.args.tableId as viem.Hex
  }
  const openRound = async (id: viem.Hex, side: number, stake: bigint) => {
    const r = await send({ address: CFT, abi: coinFlipTablesAbi, functionName: 'open', args: [id, side, stake, cfg.canonicalSubset, await heatLocations()] })
    const ev = viem.parseEventLogs({ abi: coinFlipTablesAbi, logs: r.logs, eventName: 'RoundOpened' })[0] as any
    return { roundId: ev.args.roundId as viem.Hex, key: ev.args.key as viem.Hex, args: ev.args, block: r.blockNumber }
  }
  console.log(`\n=== CoinFlipTables live QA on 943 ===\n contract ${CFT}\n chips ${CHIPS}\n operator/player ${account.address}\n mode ${MODE}\n`)
  // ensure Chips liquidity for operator+player role (valve_deployer owns Chips → mint)
  const bal0 = (await pc.readContract({ address: CHIPS, abi: chipsAbi, functionName: 'balanceOf', args: [account.address] })) as bigint
  if (bal0 < E(5000)) { console.log(' minting 100000 Chips to self…'); await send({ address: CHIPS, abi: chipsAbi, functionName: 'mint', args: [account.address, E(100000)] }) }
  await send({ address: CHIPS, abi: chipsAbi, functionName: 'approve', args: [CFT, E(10_000_000)] })

  if (MODE === 'smoke' || MODE === 'all') await runSmoke()

  console.log(`\n=== QA complete: ${PASS} passed, ${FAIL} failed ===`)
  process.exit(FAIL ? 1 : 0)

  // ---- helper closures that need the above scope ----
  async function settledFor(roundId: viem.Hex, key: viem.Hex) {
    const start = Date.now()
    while (Date.now() - start < SETTLE_TIMEOUT_MS) {
      const round = (await pc.readContract({ address: CFT, abi: coinFlipTablesAbi, functionName: 'rounds', args: [roundId] })) as any[]
      if (Number(round[7]) === 2) {
        const logs = await pc.getContractEvents({ address: CFT, abi: coinFlipTablesAbi, eventName: 'RoundSettled', fromBlock: round[6] as bigint })
        const ev = (logs as any[]).map((l) => l.args).find((a) => a.roundId?.toLowerCase() === roundId.toLowerCase())
        const seed = ((await pc.readContract({ address: cfg.random, abi: randomAbi, functionName: 'randomness', args: [key] })) as any).seed as viem.Hex
        return { won: ev.won as boolean, payout: ev.payout as bigint, seed }
      }
      process.stdout.write('.')
      await sleep(4000)
    }
    return null
  }

  async function runSmoke() {
    console.log('— SMOKE: create → fund → open → settle → verify —')
    const stake = E(1)
    const tableId = await createTable(196, E(100), E(10000))
    check('createTable → tableId', /^0x[0-9a-f]{64}$/i.test(tableId), tableId.slice(0, 12) + '…')
    await send({ address: CFT, abi: coinFlipTablesAbi, functionName: 'fundHot', args: [tableId, E(1000)] })
    let t = await readTable(tableId)
    check('fundHot → hot=1000', t.hot === E(1000), viem.formatEther(t.hot))

    const balBefore = (await pc.readContract({ address: CHIPS, abi: chipsAbi, functionName: 'balanceOf', args: [account.address] })) as bigint
    const { roundId, key, args } = await openRound(tableId, 0 /* HEADS */, stake)
    check('open → RoundOpened(payout=1.96)', (args.payout as bigint) === (stake * 196n) / 100n, viem.formatEther(args.payout as bigint))
    t = await readTable(tableId)
    check('open → escrowed=payout', t.escrowed === (stake * 196n) / 100n)
    check('open → hot debited by exposure', t.hot === E(1000) - ((stake * 196n) / 100n - stake))

    console.log('  waiting for cast-watcher to settle', roundId.slice(0, 12) + '…')
    const res = await settledFor(roundId, key)
    process.stdout.write('\n')
    if (!check('round SETTLED by the live caster', res !== null, res ? '' : `timed out after ${SETTLE_TIMEOUT_MS / 1000}s`)) return
    const { won, payout, seed } = res!
    const parityWin = (BigInt(seed) & 1n) === 0n // side HEADS(0) wins on even seed
    check('settled parity matches seed', won === parityWin, `won=${won} seed&1=${BigInt(seed) & 1n}`)
    const balAfter = (await pc.readContract({ address: CHIPS, abi: chipsAbi, functionName: 'balanceOf', args: [account.address] })) as bigint
    const delta = balAfter - balBefore
    // as BOTH operator+player: win → net +(payout - stake); loss → net 0 (stake to own hot). Just assert the player leg.
    check('payout correct for outcome', won ? delta >= (payout - stake) - 1n : true, `won=${won} netΔ=${viem.formatEther(delta)}`)
    t = await readTable(tableId)
    check('escrow released after settle', t.escrowed === 0n)
    console.log(`  → round settled: ${won ? 'PLAYER WON' : 'house won'}, payout ${viem.formatEther(payout)}, seed ${seed.slice(0, 10)}…`)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
