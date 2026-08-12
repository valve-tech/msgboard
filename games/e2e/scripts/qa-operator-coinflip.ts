/**
 * Live QA harness for the Table-Maintainer Substrate (Slice A) on 943 — OperatorCoinFlip end-to-end
 * against the live tables-aware cast-watcher, plus an adversarial matrix. NOT a bot; a one-shot runner.
 *
 *   PRIVATE_KEY=<valve_deployer> MODE=smoke   npx tsx scripts/qa-operator-coinflip.ts  # one round, settle
 *   PRIVATE_KEY=<valve_deployer> MODE=matrix  npx tsx scripts/qa-operator-coinflip.ts  # adversarial reverts
 *   PRIVATE_KEY=<valve_deployer> MODE=all     npx tsx scripts/qa-operator-coinflip.ts
 *
 * valve_deployer owns Chips (mints) + is funded with PLS; it plays operator AND player. Custody lives
 * in GameEscrow (not the game): funding = escrow.depositBankroll, and both the bankroll deposit and the
 * player-stake pull go through the escrow, so the deployer approves the ESCROW for Chips. Heat locations
 * are built from heatsSince().length (true consumed slot across ALL games sharing the validator pools).
 *
 * Onboarding is exercised live: registry.register() → escrow.authorizeGame(game,true) → depositBankroll.
 * The matrix proves the substrate's invariant spine on-chain: UnauthorizedGame (the C1 fix), UnknownBet
 * (only the recording game may settle), and InsufficientBankroll (graceful bankruptcy).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import * as viem from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { poolLocationFor, type Info } from '@msgboard/games-core'
import { loadDeployment, heatsSince } from './actor-common'

const __dirname = dirname(fileURLToPath(import.meta.url))

const RPC = process.env.RPC_URL ?? 'https://rpc.v4.testnet.pulsechain.com'
const MODE = process.env.MODE ?? 'all'
const SETTLE_TIMEOUT_MS = Number(process.env.SETTLE_TIMEOUT_MS ?? 180_000)
const chain = { id: 943, name: 'pulse-943', nativeCurrency: { name: 'PLS', symbol: 'PLS', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const

// Deployed 943 substrate (deployments/943-operator-substrate.json), overridable via env.
const REGISTRY = (process.env.REGISTRY ?? '0x175ca811e3180dfe8b47af1cebcac39f3c0ae4bc') as viem.Hex
const ESCROW = (process.env.ESCROW ?? '0xac6ec2a13afd2afa708ab2c57fbd69163cee39f2') as viem.Hex
const GAME = (process.env.GAME ?? '0x48f6f9e15ad2b01cc60612c29dfed064a6353b4e') as viem.Hex

const chipsAbi = [
  { name: 'mint', type: 'function', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { name: 'approve', type: 'function', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }], stateMutability: 'nonpayable' },
  { name: 'balanceOf', type: 'function', inputs: [{ name: '', type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
] as const satisfies viem.Abi

const E = (n: number | bigint) => BigInt(n) * 10n ** 18n
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let PASS = 0, FAIL = 0
const check = (name: string, ok: boolean, detail = '') => { console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`); ok ? PASS++ : FAIL++; return ok }

function loadAbi(contractName: string): viem.Abi {
  const p = resolve(__dirname, `../../contracts/artifacts/contracts/games/operator/${contractName}.sol/${contractName}.json`)
  return (JSON.parse(readFileSync(p, 'utf8')).abi) as viem.Abi
}

async function main() {
  /* eslint-disable no-console */
  const pk = process.env.PRIVATE_KEY
  if (!pk) throw new Error('set PRIVATE_KEY (valve_deployer)')
  const account = privateKeyToAccount((pk.startsWith('0x') ? pk : `0x${pk}`) as viem.Hex)
  const cfg = loadDeployment(943)
  const CFT = cfg.coinFlipTables!
  const gameAbi = loadAbi('OperatorCoinFlip')
  const escrowAbi = loadAbi('GameEscrow')
  const registryAbi = loadAbi('OperatorRegistry')
  // Reverts bubble up from GameEscrow/EscrowLib through the game call, so decode against all three ABIs
  // (InsufficientBankroll/UnknownBet/UnauthorizedGame live on the escrow side, not the game ABI).
  const xabi = [...gameAbi, ...escrowAbi, ...registryAbi] as viem.Abi

  const pc = viem.createPublicClient({ chain, transport: viem.http(RPC) })
  const wc = viem.createWalletClient({ account, chain, transport: viem.http(RPC) })
  // token: reuse Chips (the deployer mints it). Read it from the live CoinFlipTables (source of truth).
  const cftAbi = [{ name: 'chips', type: 'function', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' }] as const satisfies viem.Abi
  const CHIPS = (await pc.readContract({ address: CFT, abi: cftAbi, functionName: 'chips' })) as viem.Hex

  const baseFee = (await pc.getBlock()).baseFeePerGas ?? 0n
  const gasPrice = baseFee * 2n > viem.parseGwei('1') ? baseFee * 2n : viem.parseGwei('1')
  const send = async (call: { address: viem.Hex; abi: viem.Abi; functionName: string; args: readonly unknown[] }) => {
    const { request } = await pc.simulateContract({ ...call, account, gasPrice })
    return pc.waitForTransactionReceipt({ hash: await wc.writeContract(request) })
  }
  const expectRevert = async (name: string, call: { address: viem.Hex; functionName: string; args: readonly unknown[] }, wantErr: string) => {
    try { await pc.simulateContract({ ...call, abi: xabi, account, gasPrice }); check(name, false, 'did NOT revert') }
    catch (e) { const m = (e as Error).message; check(name, m.includes(wantErr), `reverted (${(m.split('\n').find((l) => l.includes(wantErr)) ?? m.split('\n')[0]).slice(0, 90)})`) }
  }
  const heatLocations = async (): Promise<Info[]> => {
    const k = BigInt((await heatsSince(pc, cfg)).length)
    return cfg.canonicalSubset.map((provider) => {
      const { offset, index } = poolLocationFor(k, BigInt(cfg.poolOffsets[provider.toLowerCase()] ?? '0'), BigInt(cfg.poolSize))
      return { provider, callAtChange: false, durationIsTimestamp: false, duration: 12n, token: viem.zeroAddress, price: 0n, offset, index }
    })
  }
  const bankrollOf = (op: viem.Hex, t: viem.Hex) => pc.readContract({ address: ESCROW, abi: escrowAbi, functionName: 'bankrollOf', args: [op, t] }) as Promise<bigint>
  const lockedOf = (op: viem.Hex, t: viem.Hex) => pc.readContract({ address: ESCROW, abi: escrowAbi, functionName: 'lockedOf', args: [op, t] }) as Promise<bigint>
  const createTable = async (token: viem.Hex, mult: number, maxStake: bigint): Promise<viem.Hex> => {
    const r = await send({ address: GAME, abi: gameAbi, functionName: 'createTable', args: [token, mult, maxStake] })
    return (viem.parseEventLogs({ abi: gameAbi, logs: r.logs, eventName: 'TableCreated' })[0] as any).args.tableId as viem.Hex
  }
  const openRound = async (id: viem.Hex, side: number, stake: bigint) => {
    const r = await send({ address: GAME, abi: gameAbi, functionName: 'open', args: [id, side, stake, cfg.canonicalSubset, await heatLocations()] })
    const ev = (viem.parseEventLogs({ abi: gameAbi, logs: r.logs, eventName: 'RoundOpened' })[0] as any).args
    return { roundId: ev.roundId as viem.Hex, key: ev.key as viem.Hex, payout: ev.payout as bigint }
  }

  console.log(`\n=== OperatorCoinFlip live QA on 943 ===\n game ${GAME}\n escrow ${ESCROW}\n registry ${REGISTRY}\n token(Chips) ${CHIPS}\n operator/player ${account.address}\n mode ${MODE}\n`)

  // --- onboarding (live) ---
  const registered = (await pc.readContract({ address: REGISTRY, abi: registryAbi, functionName: 'registered', args: [account.address] })) as boolean
  if (!registered) { console.log(' registry.register()…'); await send({ address: REGISTRY, abi: registryAbi, functionName: 'register', args: [] }) }
  check('operator registered', (await pc.readContract({ address: REGISTRY, abi: registryAbi, functionName: 'registered', args: [account.address] })) as boolean)
  console.log(' escrow.authorizeGame(game, true)…'); await send({ address: ESCROW, abi: escrowAbi, functionName: 'authorizeGame', args: [GAME, true] })
  // player consents to the game pulling its escrow allowance (closes the shared-escrow approval drain)
  console.log(' escrow.setPlayerGame(game, true)…'); await send({ address: ESCROW, abi: escrowAbi, functionName: 'setPlayerGame', args: [GAME, true] })
  const bal = (await pc.readContract({ address: CHIPS, abi: chipsAbi, functionName: 'balanceOf', args: [account.address] })) as bigint
  if (bal < E(5000)) { console.log(' minting 100000 Chips…'); await send({ address: CHIPS, abi: chipsAbi, functionName: 'mint', args: [account.address, E(100000)] }) }
  await send({ address: CHIPS, abi: chipsAbi, functionName: 'approve', args: [ESCROW, E(10_000_000)] })

  if (MODE === 'smoke' || MODE === 'all') await runSmoke()
  if (MODE === 'matrix' || MODE === 'all') await runMatrix()

  console.log(`\n=== QA complete: ${PASS} passed, ${FAIL} failed ===`)
  process.exit(FAIL ? 1 : 0)

  async function settledFor(roundId: viem.Hex, key: viem.Hex) {
    const start = Date.now()
    while (Date.now() - start < SETTLE_TIMEOUT_MS) {
      const round = (await pc.readContract({ address: GAME, abi: gameAbi, functionName: 'rounds', args: [roundId] })) as any[]
      if (Number(round[7]) === 2) {
        const logs = await pc.getContractEvents({ address: GAME, abi: gameAbi, eventName: 'RoundSettled', fromBlock: round[6] as bigint })
        const ev = (logs as any[]).map((l) => l.args).find((a) => a.roundId?.toLowerCase() === roundId.toLowerCase())
        return { won: ev.won as boolean, payout: ev.payout as bigint, seed: ev.seed as viem.Hex }
      }
      process.stdout.write('.'); await sleep(4000)
    }
    return null
  }

  async function runSmoke() {
    console.log('— SMOKE: authorize → depositBankroll → createTable(Chips) → open → settle —')
    await send({ address: ESCROW, abi: escrowAbi, functionName: 'depositBankroll', args: [account.address, CHIPS, E(1000)] })
    const bankroll0 = await bankrollOf(account.address, CHIPS)
    check('bankroll funded (>=1000)', bankroll0 >= E(1000), viem.formatEther(bankroll0))
    const stake = E(1)
    const tableId = await createTable(CHIPS, 196, E(100))
    check('createTable → tableId', /^0x[0-9a-f]{64}$/i.test(tableId), tableId.slice(0, 12) + '…')
    const locked0 = await lockedOf(account.address, CHIPS)
    const { roundId, key, payout } = await openRound(tableId, 0 /* HEADS */, stake)
    check('open → payout = 1.96×', payout === (stake * 196n) / 100n, viem.formatEther(payout))
    const locked1 = await lockedOf(account.address, CHIPS)
    const bankroll1 = await bankrollOf(account.address, CHIPS)
    check('open → locked grew by payout', locked1 - locked0 === payout)
    check('open → bankroll debited by exposure', bankroll0 - bankroll1 === payout - stake)
    console.log('  waiting for the live caster to settle', roundId.slice(0, 12) + '…')
    const res = await settledFor(roundId, key); process.stdout.write('\n')
    if (!check('round SETTLED by the live caster', res !== null, res ? '' : `timed out after ${SETTLE_TIMEOUT_MS / 1000}s`)) return
    const { won, payout: paid, seed } = res!
    check('settled parity matches seed', won === ((BigInt(seed) & 1n) === 0n), `won=${won} seed&1=${BigInt(seed) & 1n}`)
    check('escrow released after settle (locked back to base)', (await lockedOf(account.address, CHIPS)) === locked0)
    console.log(`  → ${won ? 'PLAYER WON' : 'house won'}, payout ${viem.formatEther(paid)}, seed ${seed.slice(0, 10)}…`)
  }

  async function runMatrix() {
    console.log('— MATRIX: adversarial reverts (invariant spine, live) —')

    // (1) InsufficientBankroll (graceful bankruptcy): a table on a token with ZERO bankroll can't open.
    // lockExposure debits exposure from bankroll BEFORE any stake pull, so it reverts before touching
    // the token — use a throwaway token addr that is never transferred.
    const FRESH_TOKEN = '0x000000000000000000000000000000000000dEaD' as viem.Hex
    const zeroTable = await createTable(FRESH_TOKEN, 196, E(100))
    await expectRevert('open on empty bankroll → InsufficientBankroll', {
      address: GAME, functionName: 'open', args: [zeroTable, 0, E(1), cfg.canonicalSubset, await heatLocations()],
    }, 'InsufficientBankroll')

    // (2) Only the recording game may settle. Bets are namespaced by (game, betId), so a settle from
    // the deployer (not the game contract) finds no bet in its own namespace and reverts UnknownBet.
    const t = await createTable(CHIPS, 196, E(100))
    const { roundId } = await openRound(t, 1 /* TAILS */, E(1))
    await expectRevert('escrow.settleWin by non-game → UnknownBet', {
      address: ESCROW, functionName: 'settleWin', args: [roundId],
    }, 'UnknownBet')

    // (3) UnauthorizedGame (the C1 fix, live): revoke the game's authorization, prove open() now reverts
    // in the escrow, then restore it.
    await send({ address: ESCROW, abi: escrowAbi, functionName: 'authorizeGame', args: [GAME, false] })
    const t2 = await createTable(CHIPS, 196, E(100))
    await expectRevert('open after deauthorizeGame → UnauthorizedGame', {
      address: GAME, functionName: 'open', args: [t2, 0, E(1), cfg.canonicalSubset, await heatLocations()],
    }, 'UnauthorizedGame')
    await send({ address: ESCROW, abi: escrowAbi, functionName: 'authorizeGame', args: [GAME, true] })
    check('re-authorized game after test', (await pc.readContract({ address: ESCROW, abi: escrowAbi, functionName: 'authorizedGame', args: [account.address, GAME] })) as boolean)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
