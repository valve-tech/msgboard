/**
 * Live QA harness for the forfeit-activated OperatorCoinFlip on 943 — the staking model end to end.
 * A one-shot runner (NOT a bot). It lifts the proven anvil integration test (test/operator-forfeit.test.ts)
 * onto live 943 against the REAL @gibs/random Random: it self-inks each validator's staked (Chips, tierPrice)
 * pool from the validator's OWN key, then drives BOTH outcomes on chain — a normal round that SETTLES and a
 * forced-abort round whose withheld stake chopAndRoute banks into the operator's bankroll. Being
 * self-contained (it casts and chops itself), it does NOT depend on the live cast-watcher fleet, so it
 * proves the mechanism on a fresh forfeit deploy before the fleet is switched over.
 *
 *   PRIVATE_KEY="$(op read op://valve/valve_deployer/pk)" \
 *   MNEMONIC="$(op read 'op://valve/randomness/recovery phrase')" \
 *   SEEDS0="$(op read op://valve/randomness/seeds0)" \
 *   MODE=all npx tsx scripts/qa-operator-coinflip.ts
 *
 * Roles (all secrets read via `op`, never the faucet key):
 *   valve_deployer (PRIVATE_KEY) — game owner + operator + player + caster; funds validator stakes by
 *                    TRANSFERRING its own Chips (it is not the Chips owner and never touches the faucet key).
 *   validators     (MNEMONIC indices 1..3) — the canonical 943 subset; each self-inks + stakes its own Chips.
 *   SEEDS0         — the caster's secret-derivation seed; the qa inks the (Chips, tierPrice) pools with it so
 *                    they match exactly what the live cast-watcher's operatorPass would produce.
 *
 * Modes: smoke = settle path; forfeit = forced-abort path; matrix = adversarial reverts; all = every mode.
 * Addresses come from contracts/deployments/943-operator-substrate.json (env-overridable), so this picks up
 * the redeployed forfeit game automatically.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import * as viem from 'viem'
import { privateKeyToAccount, mnemonicToAccount } from 'viem/accounts'
import { randomAbi } from '@msgboard/games-core'
import {
  loadDeployment,
  sendAs,
  flooredFees,
  erc20Abi,
  heatsSincePriced,
  operatorSecret,
  operatorLocationsAt,
  inkValidatorStakedPool,
} from './actor-common'

const __dirname = dirname(fileURLToPath(import.meta.url))

const RPC = process.env.RPC_URL ?? 'https://rpc.v4.testnet.pulsechain.com'
const MODE = process.env.MODE ?? 'all'
const CHAIN = 943
const chain = { id: CHAIN, name: 'pulse-943', nativeCurrency: { name: 'PLS', symbol: 'PLS', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const

const E = (n: number | bigint) => BigInt(n) * 10n ** 18n
const TIER = process.env.TIER ? BigInt(process.env.TIER) : E(1) // single-tier table: tierPrice == TIER
const MULT = 196 // 1.96x
const BANKROLL = E(1000)
const FEES = E(100)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let PASS = 0, FAIL = 0
const check = (name: string, ok: boolean, detail = '') => { console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`); ok ? PASS++ : FAIL++; return ok }

function loadAbi(contractName: string): viem.Abi {
  const p = resolve(__dirname, `../../contracts/artifacts/contracts/games/operator/${contractName}.sol/${contractName}.json`)
  return JSON.parse(readFileSync(p, 'utf8')).abi as viem.Abi
}
function loadSubstrate(): { random: viem.Hex; contracts: Record<string, viem.Hex> } {
  const p = resolve(__dirname, '../../contracts/deployments/943-operator-substrate.json')
  return JSON.parse(readFileSync(p, 'utf8'))
}

async function main() {
  /* eslint-disable no-console */
  const pk = process.env.PRIVATE_KEY
  const mnemonic = process.env.MNEMONIC
  const seeds0 = process.env.SEEDS0
  if (!pk) throw new Error('set PRIVATE_KEY (valve_deployer)')
  if (!mnemonic) throw new Error("set MNEMONIC (op read 'op://valve/randomness/recovery phrase')")
  if (!seeds0) throw new Error('set SEEDS0 (op read op://valve/randomness/seeds0)')

  const sub = loadSubstrate()
  const RANDOM = (process.env.RANDOM ?? sub.random) as viem.Hex
  const REGISTRY = (process.env.REGISTRY ?? sub.contracts.OperatorRegistry) as viem.Hex
  const ESCROW = (process.env.ESCROW ?? sub.contracts.GameEscrow) as viem.Hex
  const GAME = (process.env.GAME ?? sub.contracts.OperatorCoinFlip) as viem.Hex

  const cfg = loadDeployment(CHAIN)
  // GAME comes from the substrate file, cfg.operatorCoinFlip (which heatsSincePriced counts on) from the
  // e2e file — the redeploy script syncs both. Fail fast if they ever drift, so a stale slot counter can't
  // send this run into a confusing mid-flight revert.
  if (!cfg.operatorCoinFlip || viem.getAddress(GAME) !== viem.getAddress(cfg.operatorCoinFlip))
    throw new Error(`GAME (${GAME}, substrate json) != cfg.operatorCoinFlip (${cfg.operatorCoinFlip}, 943-deployment.json) — redeploy sync drifted`)
  const poolSize = BigInt(cfg.poolSize)
  const subset = cfg.canonicalSubset
  const account = privateKeyToAccount((pk.startsWith('0x') ? pk : `0x${pk}`) as viem.Hex)

  const pc = viem.createPublicClient({ chain, transport: viem.http(RPC) })
  const deployerWallet = viem.createWalletClient({ account, chain, transport: viem.http(RPC) })
  // validator wallets (indices 1..3) — sign their OWN staking ink/handoff so the staked capital is theirs.
  const validatorWallets = subset.map((_v, i) =>
    viem.createWalletClient({ account: mnemonicToAccount(mnemonic, { addressIndex: i + 1 }), chain, transport: viem.http(RPC) }),
  )
  // sanity: the mnemonic's indices 1..3 must equal the deployed/allowlisted subset
  validatorWallets.forEach((w, i) => {
    if (viem.getAddress(w.account!.address) !== viem.getAddress(subset[i]!))
      throw new Error(`validator index ${i + 1} (${w.account!.address}) != subset[${i}] (${subset[i]})`)
  })

  const gameAbi = loadAbi('OperatorCoinFlip')
  const escrowAbi = loadAbi('GameEscrow')
  const registryAbi = loadAbi('OperatorRegistry')
  const xabi = [...gameAbi, ...escrowAbi, ...registryAbi] as viem.Abi
  const chipsAbi = [...erc20Abi, { type: 'function', name: 'mint', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [] }] as const satisfies viem.Abi

  // token: reuse the live Chips (deployer can mint the test ERC-20). Source of truth = live CoinFlipTables.
  const CFT = cfg.coinFlipTables!
  const cftAbi = [{ name: 'chips', type: 'function', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' }] as const satisfies viem.Abi
  const CHIPS = (await pc.readContract({ address: CFT, abi: cftAbi, functionName: 'chips' })) as viem.Hex

  // reads
  const bankrollOf = () => pc.readContract({ address: ESCROW, abi: escrowAbi, functionName: 'bankrollOf', args: [account.address, CHIPS] }) as Promise<bigint>
  const lockedOf = () => pc.readContract({ address: ESCROW, abi: escrowAbi, functionName: 'lockedOf', args: [account.address, CHIPS] }) as Promise<bigint>
  const feeBalanceOf = () => pc.readContract({ address: GAME, abi: gameAbi, functionName: 'feeBalance', args: [account.address, CHIPS] }) as Promise<bigint>
  const custodyOf = (a: viem.Hex) => pc.readContract({ address: RANDOM, abi: randomAbi, functionName: 'balanceOf', args: [a, CHIPS] }) as Promise<bigint>
  const chipsBal = (a: viem.Hex) => pc.readContract({ address: CHIPS, abi: chipsAbi, functionName: 'balanceOf', args: [a] }) as Promise<bigint>
  const readRound = (roundId: viem.Hex) => pc.readContract({ address: GAME, abi: gameAbi, functionName: 'rounds', args: [roundId] }) as Promise<unknown[]>
  const roundStatus = async (roundId: viem.Hex) => Number((await readRound(roundId))[8]) // Status is field 9
  const seedOf = async (key: viem.Hex) => ((await pc.readContract({ address: RANDOM, abi: randomAbi, functionName: 'randomness', args: [key] })) as { seed: viem.Hex }).seed

  // Retry transient valve-RPC hiccups ("all upstream attempts failed" / InternalRpcError) — a real contract
  // revert has a decodable reason and is rethrown immediately, so a genuine failure still fails fast.
  const send = async (call: { address: viem.Hex; abi: viem.Abi; functionName: string; args: readonly unknown[] }): Promise<viem.TransactionReceipt> => {
    for (let attempt = 1; ; attempt++) {
      try { return await sendAs(pc, deployerWallet, call) }
      catch (e) {
        const m = (e as Error).message
        const transient = /all upstream attempts failed|InternalRpcError|internal error|timeout|fetch failed|ECONNRESET/i.test(m)
        if (!transient || attempt >= 6) throw e
        console.log(`  ${call.functionName} attempt ${attempt} hit an RPC hiccup — retrying`)
        await sleep(6000)
      }
    }
  }
  const expectRevert = async (name: string, call: { address: viem.Hex; functionName: string; args: readonly unknown[] }, wantErr: string) => {
    const fees = await flooredFees(pc)
    try { await pc.simulateContract({ ...call, abi: xabi, account, ...fees }); check(name, false, 'did NOT revert') }
    catch (e) { const m = (e as Error).message; const line = m.split('\n').find((l) => l.includes(wantErr)) ?? m.split('\n')[0] ?? m; check(name, m.includes(wantErr), `reverted (${line.slice(0, 90)})`) }
  }
  const waitBlocks = async (n: number) => {
    const start = await pc.getBlockNumber()
    process.stdout.write(`  waiting ${n} blocks for the cast window to expire`)
    while ((await pc.getBlockNumber()) < start + BigInt(n)) { process.stdout.write('.'); await sleep(4000) }
    process.stdout.write('\n')
  }

  // Ensure each validator has inked its staked (CHIPS, TIER) pool covering chronological slot `k`.
  const inkPoolFor = async (k: bigint): Promise<bigint> => {
    const poolStart = (k / poolSize) * poolSize
    for (let i = 0; i < validatorWallets.length; i++) {
      const v = validatorWallets[i]!.account!.address as viem.Hex
      const bal = await chipsBal(v)
      const need = TIER * poolSize
      // Fund the validator's stake capital by TRANSFERRING the deployer's own Chips (the deployer is not
      // the Chips owner and cannot mint; the chip-faucet key at mnemonic index 51 is — and we never touch it).
      if (bal < need) await send({ address: CHIPS, abi: chipsAbi, functionName: 'transfer', args: [v, need * 4n] })
      const r = await inkValidatorStakedPool(pc, validatorWallets[i]!, RANDOM, seeds0!, i, CHIPS, TIER, poolStart, Number(poolSize))
      check(`validator ${i + 1} staked pool @${poolStart} (${r})`, r === 'inked' || r === 'exists', v.slice(0, 10) + '…')
    }
    return poolStart
  }
  const openRound = async (tableId: viem.Hex, side: number, stake: bigint) => {
    // Assumes this qa is the only opener on the (CHIPS, TIER) ladder for the run. A concurrent opener
    // between this snapshot and open() landing would desync k, but Random's consumed-bitmap makes that a
    // loud UnableToService revert (never a silent wrong result), so it self-detects.
    const k = BigInt((await heatsSincePriced(pc, cfg, CHIPS, TIER)).length)
    await inkPoolFor(k)
    const locations = operatorLocationsAt(subset, k, poolSize, CHIPS, TIER)
    const r = await send({ address: GAME, abi: gameAbi, functionName: 'open', args: [tableId, side, stake, subset, locations] })
    const ev = (viem.parseEventLogs({ abi: gameAbi, logs: r.logs, eventName: 'RoundOpened' })[0] as any).args
    return { roundId: ev.roundId as viem.Hex, key: ev.key as viem.Hex, payout: ev.payout as bigint, tierPrice: ev.tierPrice as bigint, k, locations }
  }
  const createTable = async (token: viem.Hex, mult: number, minStake: bigint, maxStake: bigint): Promise<viem.Hex> => {
    const r = await send({ address: GAME, abi: gameAbi, functionName: 'createTable', args: [token, mult, minStake, maxStake] })
    return (viem.parseEventLogs({ abi: gameAbi, logs: r.logs, eventName: 'TableCreated' })[0] as any).args.tableId as viem.Hex
  }

  console.log(`\n=== OperatorCoinFlip forfeit QA on 943 ===\n game ${GAME}\n escrow ${ESCROW}\n registry ${REGISTRY}\n random ${RANDOM}\n token(Chips) ${CHIPS}\n operator/player ${account.address}\n validators ${subset.join(', ')}\n tier ${viem.formatEther(TIER)} Chips  mode ${MODE}\n`)

  // --- onboarding (live) ---
  const registered = (await pc.readContract({ address: REGISTRY, abi: registryAbi, functionName: 'registered', args: [account.address] })) as boolean
  if (!registered) { console.log(' registry.register()…'); await send({ address: REGISTRY, abi: registryAbi, functionName: 'register', args: [] }) }
  check('operator registered', (await pc.readContract({ address: REGISTRY, abi: registryAbi, functionName: 'registered', args: [account.address] })) as boolean)
  await send({ address: ESCROW, abi: escrowAbi, functionName: 'authorizeGame', args: [GAME, true] })
  await send({ address: ESCROW, abi: escrowAbi, functionName: 'setPlayerGame', args: [GAME, true] })
  // The deployer plays operator+player and funds validator stakes by transfer, so it must already hold Chips.
  // It is NOT the Chips owner (mnemonic index 51 is), so it cannot self-mint — get Chips via the chip-faucet
  // board flow if this ever trips.
  if ((await chipsBal(account.address)) < BANKROLL + FEES + TIER * poolSize * 3n * 4n)
    throw new Error(`deployer Chips too low (${viem.formatEther(await chipsBal(account.address))}) — fund ${account.address} via the chip-faucet`)
  await send({ address: CHIPS, abi: chipsAbi, functionName: 'approve', args: [ESCROW, viem.maxUint256] })
  await send({ address: CHIPS, abi: chipsAbi, functionName: 'approve', args: [GAME, viem.maxUint256] })
  await send({ address: ESCROW, abi: escrowAbi, functionName: 'depositBankroll', args: [account.address, CHIPS, BANKROLL] })
  await send({ address: GAME, abi: gameAbi, functionName: 'depositFees', args: [account.address, CHIPS, FEES] })
  check('bankroll funded', (await bankrollOf()) >= BANKROLL, viem.formatEther(await bankrollOf()))
  check('fee pool funded', (await feeBalanceOf()) >= FEES, viem.formatEther(await feeBalanceOf()))

  // validator gas floor — the staking ink/handoff/cast/chop are on-chain txs signed by the validators.
  for (let i = 0; i < validatorWallets.length; i++) {
    const g = await pc.getBalance({ address: validatorWallets[i]!.account!.address })
    check(`validator ${i + 1} has gas`, g > viem.parseEther('0.05'), viem.formatEther(g) + ' PLS')
  }

  if (MODE === 'ladder' || MODE === 'all') await runLadder()
  if (MODE === 'smoke' || MODE === 'all') await runSettle()
  if (MODE === 'forfeit' || MODE === 'all') await runForfeit()
  if (MODE === 'matrix' || MODE === 'all') await runMatrix()

  console.log(`\n=== QA complete: ${PASS} passed, ${FAIL} failed ===`)
  process.exit(FAIL ? 1 : 0)

  // --- ladder: prove tierPrice rounds a stake UP to the smallest tier >= stake ---
  async function runLadder() {
    console.log('— LADDER: createTable(minStake..maxStake) → tierPriceOf rounds up —')
    const t = await createTable(CHIPS, MULT, E(1), E(8)) // ladder: 1,2,4,8
    const tp = (stake: bigint) => pc.readContract({ address: GAME, abi: gameAbi, functionName: 'tierPriceOf', args: [t, stake] }) as Promise<bigint>
    check('tierPriceOf(1) == 1', (await tp(E(1))) === E(1))
    check('tierPriceOf(3) == 4', (await tp(E(3))) === E(4))
    check('tierPriceOf(5) == 8', (await tp(E(5))) === E(8))
    check('tierPriceOf(8) == 8', (await tp(E(8))) === E(8))
    await expectRevert('tierPriceOf(9) → StakeOutOfRange', { address: GAME, functionName: 'tierPriceOf', args: [t, E(9)] }, 'StakeOutOfRange')
  }

  // --- settle: all three validators reveal → seed forms → round settles from validator entropy ---
  async function runSettle() {
    console.log('— SMOKE: createTable → open → cast(all 3) → SETTLE —')
    const tableId = await createTable(CHIPS, MULT, TIER, TIER)
    const feeBefore = await feeBalanceOf()
    const custodyBefore = await Promise.all(subset.map((a) => custodyOf(a)))
    const { roundId, key, payout, tierPrice, k, locations } = await openRound(tableId, 0 /* HEADS */, TIER)
    check('open → tierPrice == TIER', tierPrice === TIER, viem.formatEther(tierPrice))
    check('open → payout == 1.96×', payout === (TIER * BigInt(MULT)) / 100n, viem.formatEther(payout))

    const secrets = subset.map((_a, i) => operatorSecret(seeds0!, i, CHIPS, TIER, k))
    const castReceipt = await send({ address: RANDOM, abi: randomAbi, functionName: 'cast', args: [key, locations, secrets] })
    const cast = viem.parseEventLogs({ abi: randomAbi, logs: castReceipt.logs, eventName: 'Cast' })[0]
    check('seed cast', Boolean(cast))
    check('round SETTLED', (await roundStatus(roundId)) === 2)
    const seed = await seedOf(key)
    const settled = viem.parseEventLogs({ abi: gameAbi, logs: castReceipt.logs, eventName: 'RoundSettled' })[0] as any
    if (settled) check('settled parity matches seed', settled.args.won === ((BigInt(seed) & 1n) === 0n), `won=${settled.args.won} seed&1=${BigInt(seed) & 1n}`)

    // stakes returned + exactly one validator earned the round fee (n*TIER)
    const custodyAfter = await Promise.all(subset.map((a) => custodyOf(a)))
    const deltas = custodyAfter.map((c, i) => c - custodyBefore[i]!)
    check('all stakes returned + one fee bonus', deltas.reduce((s, d) => s + d, 0n) === TIER * 3n + TIER * 3n, deltas.map((d) => viem.formatEther(d)).join('/'))
    check('exactly one validator earned the fee', deltas.filter((d) => d === TIER + TIER * 3n).length === 1)
    check('fee pool debited by n*tierPrice', feeBefore - (await feeBalanceOf()) === TIER * 3n)
  }

  // --- forfeit: one validator withholds → chopAndRoute banks the withheld stake, refunds the player ---
  async function runForfeit() {
    console.log('— FORFEIT: open → cast(2 of 3, withhold #3) → wait → chopAndRoute —')
    const tableId = await createTable(CHIPS, MULT, TIER, TIER)
    const bankrollBefore = await bankrollOf()
    const lockedBefore = await lockedOf()
    const feeBefore = await feeBalanceOf()
    const custodyBefore = await Promise.all(subset.map((a) => custodyOf(a)))
    const playerBefore = await chipsBal(account.address)

    const { roundId, key, k, locations } = await openRound(tableId, 1 /* TAILS */, TIER)

    // validators 0,1 reveal; validator 2 WITHHOLDS (zero placeholder). Partial cast flicks the two honest
    // stakes back and leaves the seed unformed — exactly what the caster's chop pass does first.
    const withheld = [operatorSecret(seeds0!, 0, CHIPS, TIER, k), operatorSecret(seeds0!, 1, CHIPS, TIER, k), viem.padHex('0x0', { size: 32 })]
    await send({ address: RANDOM, abi: randomAbi, functionName: 'cast', args: [key, locations, withheld] })
    check('seed withheld (no reveal from #3)', (await seedOf(key)) === viem.padHex('0x0', { size: 32 }))

    await waitBlocks(18) // comfortably past HEAT_DURATION (12 blocks) so the round is choppable

    const chopReceipt = await send({ address: GAME, abi: gameAbi, functionName: 'chopAndRoute', args: [roundId, locations] })
    const forfeitEv = (viem.parseEventLogs({ abi: gameAbi, logs: chopReceipt.logs, eventName: 'ForfeitRouted' })[0] as any)?.args as { forfeit: bigint } | undefined
    check('ForfeitRouted forfeit == tierPrice', forfeitEv?.forfeit === TIER, forfeitEv ? viem.formatEther(forfeitEv.forfeit) : 'no event')
    check('round REFUNDED', (await roundStatus(roundId)) === 3)

    check('forfeit banked to operator bankroll (+tierPrice)', (await bankrollOf()) - bankrollBefore === TIER, viem.formatEther((await bankrollOf()) - bankrollBefore))
    check('exposure released (locked back to base)', (await lockedOf()) === lockedBefore)
    check('player made whole (stake returned)', (await chipsBal(account.address)) === playerBefore, viem.formatEther((await chipsBal(account.address)) - playerBefore))
    const custodyAfter = await Promise.all(subset.map((a) => custodyOf(a)))
    check('validator 1 stake returned', custodyAfter[0]! - custodyBefore[0]! === TIER)
    check('validator 2 stake returned', custodyAfter[1]! - custodyBefore[1]! === TIER)
    check('withholder (#3) stake forfeited', custodyAfter[2]! - custodyBefore[2]! === 0n)
    check('operator fee pool restored', (await feeBalanceOf()) === feeBefore)
  }

  // --- matrix: the invariant spine, live ---
  async function runMatrix() {
    console.log('— MATRIX: adversarial reverts —')
    // (1) InsufficientBankroll: a table on a token with ZERO bankroll can't open. Heat charges fee first,
    // so fund a tiny fee pool on the fresh token but leave its bankroll empty.
    const FRESH = '0x000000000000000000000000000000000000dEaD' as viem.Hex
    const zeroTable = await createTable(FRESH, MULT, TIER, TIER)
    const k0 = BigInt((await heatsSincePriced(pc, cfg, FRESH, TIER)).length)
    const locs0 = operatorLocationsAt(subset, k0, poolSize, FRESH, TIER)
    await expectRevert('open with empty fee pool → InsufficientFees', { address: GAME, functionName: 'open', args: [zeroTable, 0, TIER, subset, locs0] }, 'InsufficientFees')

    // (2) Only the recording game may settle a bet in its own namespace.
    await expectRevert('escrow.settleWin by non-game → UnknownBet', { address: ESCROW, functionName: 'settleWin', args: [viem.padHex('0xbeef', { size: 32 })] }, 'UnknownBet')

    // (3) UnauthorizedGame (the C1 fix): revoke authorization → open reverts in the escrow → restore.
    await send({ address: ESCROW, abi: escrowAbi, functionName: 'authorizeGame', args: [GAME, false] })
    const t2 = await createTable(CHIPS, MULT, TIER, TIER)
    const k2 = BigInt((await heatsSincePriced(pc, cfg, CHIPS, TIER)).length)
    await inkPoolFor(k2)
    const locs2 = operatorLocationsAt(subset, k2, poolSize, CHIPS, TIER)
    await expectRevert('open after deauthorizeGame → UnauthorizedGame', { address: GAME, functionName: 'open', args: [t2, 0, TIER, subset, locs2] }, 'UnauthorizedGame')
    await send({ address: ESCROW, abi: escrowAbi, functionName: 'authorizeGame', args: [GAME, true] })
    check('re-authorized game after test', (await pc.readContract({ address: ESCROW, abi: escrowAbi, functionName: 'authorizedGame', args: [account.address, GAME] })) as boolean)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
