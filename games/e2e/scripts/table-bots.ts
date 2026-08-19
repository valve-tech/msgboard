/**
 * Autonomous CoinFlipTables players + operator — the fleet actor that keeps the player-run tables
 * game MOVING on 943 so real play surfaces bugs (settlement, refund, bankroll accounting) instead
 * of us only theorizing. The other fleet bots (player-bots) play CoinFlip/Raffle in native PLS;
 * this one plays CoinFlipTables, which settles in CHIPS (an ERC-20) — so its funding model differs.
 *
 * ROLES (all fleet-controlled, distinct mnemonic indices so no process shares a signer):
 *   operator (index OP_INDEX, default 40): owns one open table, funds its hot bankroll, and now and
 *     then exercises the operator surface (setParams, promote/demote, stake/unstake, withdrawHot).
 *   players  (index PLAYER_INDEX_BASE.., default 41..): open rounds at varied side/stake against the
 *     operator's table. The separate cast-watcher process settles each round from validator entropy.
 *
 * FUNDING — SEED AND CIRCULATE (no minting, no deployer key, no op session needed at runtime):
 *   Gas (PLS) tops up from the treasury (index 0), the same pattern every funded actor uses.
 *   Chips are NOT minted here (mint is owner-only = the chip-faucet key, a different running process;
 *   minting from two processes would race nonces). Instead Chips CIRCULATE within the fleet: a win
 *   pays the player wallet, a loss sends the stake to the table hot, and the operator periodically
 *   withdrawHot()s to reclaim liquidity and top the players back up. Net drift is only the house edge,
 *   so ONE seed of Chips to the operator wallet sustains play for a long time. If the operator wallet
 *   falls below the seed floor and cannot cover the table, the bot PAUSES all Chips spend and logs the
 *   exact address + amount to seed — play resumes by itself once the seed lands.
 *
 * CAUTION (shared validator ladder): CoinFlipTables heats the SAME price-0 validator pools as
 *   CoinFlip/Raffle (see heatsSince). Opening rounds here interleaves with player-bots' opens on the
 *   shared chronological slot counter, so run at a modest cadence and rely on the hardened
 *   cast-watcher (drift detect + drop-on-verified-drift) as the safety net. Concurrency pressure here
 *   is deliberate — it is how table+shared-pool interaction bugs surface.
 *
 * Env: MNEMONIC (funded; treasury at FUNDER_INDEX=0), CHAIN (default 943), RPC, CONFIG,
 *      PLAYERS (default 3), INTERVAL_MS (default 90000),
 *      OP_INDEX (default 70), PLAYER_INDEX_BASE (default 71), FUNDER_INDEX (default 0)
 *        — indices 70/71.. are a fresh block, clear of validators 1-3, gate 4-8, ops 10-11,
 *          player-bots 20-29, session-bots 30, cosign-bot 40-42, landing-house 50, chip-faucet 51,
 *          petition 60-65 — so no two processes ever share a signer,
 *      MAX_STAKE (Chips, default 5 — biggest stake a player opens), MULT_X100 (default 196),
 *      TABLE_MAX_STAKE (Chips, default 100), HOT_TARGET (Chips, default 5000),
 *      HOT_FLOOR (Chips, default 500 — refund hot to HOT_TARGET when it drops below this),
 *      PLAYER_CHIP_FLOOR (Chips, default 50) / PLAYER_CHIP_TO (default 200): players' Chips band,
 *      SEED_FLOOR (Chips, default 300): pause all Chips spend when the operator wallet drops below it,
 *      GAS_CUSHION / TOP_UP_BELOW / TOP_UP_TO (PLS, defaults 1/50/200 — 943-sized),
 *      ONCE=true for a single pass.
 */
import * as viem from 'viem'
import { coinFlipTablesAbi, poolLocationFor, type GamesChainId, type Info } from '@msgboard/games-core'
import { loadDeployment, makeActor, sendAs, heatsSince, flooredFees } from './actor-common'

const env = process.env
const CHAIN = (env.CHAIN ? Number(env.CHAIN) : 943) as GamesChainId
const PLAYER_COUNT = env.PLAYERS ? Number(env.PLAYERS) : 3
const OP_INDEX = env.OP_INDEX ? Number(env.OP_INDEX) : 70
const PLAYER_INDEX_BASE = env.PLAYER_INDEX_BASE ? Number(env.PLAYER_INDEX_BASE) : 71
const FUNDER_INDEX = env.FUNDER_INDEX ? Number(env.FUNDER_INDEX) : 0
const INTERVAL_MS = env.INTERVAL_MS ? Number(env.INTERVAL_MS) : 90_000

const C = (n: number | bigint) => BigInt(n) * 10n ** 18n // Chips are 18-decimals
const num = (v: string | undefined, d: number) => (v ? Number(v) : d)
const MAX_STAKE = C(num(env.MAX_STAKE, 5))
const MULT_X100 = num(env.MULT_X100, 196)
const TABLE_MAX_STAKE = C(num(env.TABLE_MAX_STAKE, 100))
const HOT_TARGET = C(num(env.HOT_TARGET, 5000))
const HOT_FLOOR = C(num(env.HOT_FLOOR, 500))
const PLAYER_CHIP_FLOOR = C(num(env.PLAYER_CHIP_FLOOR, 50))
const PLAYER_CHIP_TO = C(num(env.PLAYER_CHIP_TO, 200))
const SEED_FLOOR = C(num(env.SEED_FLOOR, 300))

const GAS_CUSHION = viem.parseEther(env.GAS_CUSHION || '1')
const TOP_UP_BELOW = viem.parseEther(env.TOP_UP_BELOW || '50')
const TOP_UP_TO = viem.parseEther(env.TOP_UP_TO || '200')
const OPEN_GAS = 4_000_000n
const SETTLE_GAS = 1_000_000n

// The Chips ERC-20 surface this bot uses. No mint — Chips circulate within the fleet (see header).
const chipsAbi = [
  { name: 'balanceOf', type: 'function', inputs: [{ name: '', type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { name: 'allowance', type: 'function', inputs: [{ name: '', type: 'address' }, { name: '', type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { name: 'approve', type: 'function', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }], stateMutability: 'nonpayable' },
  { name: 'transfer', type: 'function', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }], stateMutability: 'nonpayable' },
] as const satisfies viem.Abi

const main = async () => {
  if (!env.MNEMONIC) throw new Error('MNEMONIC required')
  const config = loadDeployment(CHAIN, env.CONFIG)
  const CFT = config.coinFlipTables
  if (!CFT) throw new Error(`${CHAIN}-deployment.json has no coinFlipTables — nothing to play`)

  const funder = makeActor(CHAIN, env.MNEMONIC, FUNDER_INDEX, env.RPC)
  const operator = makeActor(CHAIN, env.MNEMONIC, OP_INDEX, env.RPC)
  const players = Array.from({ length: PLAYER_COUNT }, (_p, i) => makeActor(CHAIN, env.MNEMONIC!, PLAYER_INDEX_BASE + i, env.RPC))
  const pc = funder.publicClient
  const subset = config.canonicalSubset
  const poolSize = BigInt(config.poolSize)
  const from = BigInt(config.deployBlock)

  // Chips address is read from the contract itself — the source of truth, never a config guess.
  const CHIPS = (await pc.readContract({ address: CFT, abi: coinFlipTablesAbi, functionName: 'chips' })) as viem.Hex
  console.log(`table bots on chain ${CHAIN}: CFT ${CFT} chips ${CHIPS}`)
  console.log(`  operator ${operator.account.address}`)
  console.log(`  players  ${players.map((p) => p.account.address).join(', ')} (tick ${INTERVAL_MS}ms)`)

  const chipBal = (a: viem.Hex) => pc.readContract({ address: CHIPS, abi: chipsAbi, functionName: 'balanceOf', args: [a] }) as Promise<bigint>
  let chipsPaused = false

  // Each opener derives its heat locations from the SHARED price-0 slot counter (heatsSince length),
  // exactly as the web and qa harness do — CoinFlipTables shares CoinFlip/Raffle's validator pools.
  const heatLocations = async (): Promise<Info[]> => {
    const k = BigInt((await heatsSince(pc, config)).length)
    return subset.map((provider) => {
      const { offset, index } = poolLocationFor(k, BigInt(config.poolOffsets[provider.toLowerCase()] ?? '0'), poolSize)
      return { provider, callAtChange: false, durationIsTimestamp: false, duration: 12n, token: viem.zeroAddress, price: 0n, offset, index }
    })
  }

  const readTable = async (id: viem.Hex) => {
    const t = (await pc.readContract({ address: CFT, abi: coinFlipTablesAbi, functionName: 'tables', args: [id] })) as unknown[]
    return { operator: t[0] as viem.Hex, hot: t[1] as bigint, cold: t[2] as bigint, escrowed: t[3] as bigint, maxMultiplierX100: Number(t[5]), maxStake: t[6] as bigint, hotTarget: t[7] as bigint, open: t[8] as boolean }
  }

  // ── gas: keep operator + players between TOP_UP_BELOW and TOP_UP_TO, funded from the treasury ──
  const topUpGas = async () => {
    for (const bot of [operator, ...players]) {
      const balance = await pc.getBalance({ address: bot.account.address })
      if (balance >= TOP_UP_BELOW) continue
      const hash = await funder.wallet.sendTransaction({ to: bot.account.address, value: TOP_UP_TO - balance, ...(await flooredFees(pc)) })
      await pc.waitForTransactionReceipt({ hash })
      console.log(`gas: topped up ${bot.account.address}`)
    }
  }

  // ── the operator's table: reuse an open one it already operates, else create + fund a fresh one ──
  const ensureTable = async (): Promise<viem.Hex | null> => {
    const logs = (await pc.getContractEvents({ address: CFT, abi: coinFlipTablesAbi, eventName: 'TableCreated', fromBlock: from })) as unknown as { args: { tableId: viem.Hex; operator: viem.Hex } }[]
    for (const log of logs) {
      if (log.args.operator?.toLowerCase() !== operator.account.address.toLowerCase()) continue
      const t = await readTable(log.args.tableId)
      if (t.open) return log.args.tableId
    }
    if (chipsPaused) return null
    // none yet — create one and seed its hot bankroll
    const r = await sendAs(operator.publicClient, operator.wallet, { address: CFT, abi: coinFlipTablesAbi, functionName: 'createTable', args: [MULT_X100, TABLE_MAX_STAKE, HOT_TARGET] })
    const ev = viem.parseEventLogs({ abi: coinFlipTablesAbi, logs: r.logs, eventName: 'TableCreated' })[0] as unknown as { args: { tableId: viem.Hex } }
    const tableId = ev.args.tableId
    await ensureChipAllowance(operator, CFT)
    await sendAs(operator.publicClient, operator.wallet, { address: CFT, abi: coinFlipTablesAbi, functionName: 'fundHot', args: [tableId, HOT_TARGET] })
    console.log(`operator created + funded table ${tableId.slice(0, 12)}… hot=${viem.formatEther(HOT_TARGET)}`)
    return tableId
  }

  const ensureChipAllowance = async (bot: typeof operator, spender: viem.Hex) => {
    const allowance = (await pc.readContract({ address: CHIPS, abi: chipsAbi, functionName: 'allowance', args: [bot.account.address, spender] })) as bigint
    if (allowance < C(1_000_000)) {
      await sendAs(bot.publicClient, bot.wallet, { address: CHIPS, abi: chipsAbi, functionName: 'approve', args: [spender, viem.maxUint256] })
    }
  }

  // ── Chips liquidity: pause if the operator wallet is below the seed floor; else refill hot from the
  //    operator and top players up from the operator (Chips circulate within the fleet) ──
  const maintainChips = async (tableId: viem.Hex | null) => {
    const opChips = await chipBal(operator.account.address)
    const nowPaused = opChips < SEED_FLOOR
    if (nowPaused && !chipsPaused) {
      console.log(`Chips below seed floor: operator ${operator.account.address} holds ${viem.formatEther(opChips)} < ${viem.formatEther(SEED_FLOOR)}. PAUSED. Seed Chips to that address to resume.`)
    } else if (!nowPaused && chipsPaused) {
      console.log(`Chips seed restored (${viem.formatEther(opChips)}) — resuming table play`)
    }
    chipsPaused = nowPaused
    if (chipsPaused || !tableId) return

    // reclaim liquidity: pull hot down to target when losers' stakes have grown it past target
    const t = await readTable(tableId)
    if (t.hot > t.hotTarget && t.operator.toLowerCase() === operator.account.address.toLowerCase()) {
      const excess = t.hot - t.hotTarget
      await sendAs(operator.publicClient, operator.wallet, { address: CFT, abi: coinFlipTablesAbi, functionName: 'withdrawHot', args: [tableId, excess] })
      console.log(`operator reclaimed ${viem.formatEther(excess)} hot`)
    }
    // refund hot up to target when wins have drained it below the floor
    if (t.hot < HOT_FLOOR) {
      await ensureChipAllowance(operator, CFT)
      const need = t.hotTarget - t.hot
      const have = await chipBal(operator.account.address)
      const amount = have - SEED_FLOOR < need ? (have > SEED_FLOOR ? have - SEED_FLOOR : 0n) : need
      if (amount > 0n) {
        await sendAs(operator.publicClient, operator.wallet, { address: CFT, abi: coinFlipTablesAbi, functionName: 'fundHot', args: [tableId, amount] })
        console.log(`operator refilled hot by ${viem.formatEther(amount)}`)
      }
    }
    // keep each player within its Chips band, transferring from the operator's circulating balance
    for (const p of players) {
      const bal = await chipBal(p.account.address)
      if (bal >= PLAYER_CHIP_FLOOR) continue
      const opHave = await chipBal(operator.account.address)
      if (opHave <= SEED_FLOOR) break
      const amount = PLAYER_CHIP_TO - bal < opHave - SEED_FLOOR ? PLAYER_CHIP_TO - bal : opHave - SEED_FLOOR
      await sendAs(operator.publicClient, operator.wallet, { address: CHIPS, abi: chipsAbi, functionName: 'transfer', args: [p.account.address, amount] })
      console.log(`operator topped player ${p.account.address} by ${viem.formatEther(amount)} Chips`)
    }
  }

  // ── players open rounds; the cast-watcher settles them ──
  const openRounds = async (tableId: viem.Hex) => {
    if (chipsPaused) return
    const t = await readTable(tableId)
    const cap = t.maxStake < MAX_STAKE ? t.maxStake : MAX_STAKE
    for (const p of players) {
      const bal = await chipBal(p.account.address)
      const gas = await pc.getBalance({ address: p.account.address })
      if (gas < GAS_CUSHION) continue
      // stake: a random 1..cap, but sometimes push to the cap to exercise the max-exposure edge
      const roll = Math.random()
      const stake = roll < 0.2 ? cap : C(1) + BigInt(Math.floor(Math.random() * Number(cap / C(1))))
      if (bal < stake) continue
      const exposure = (stake * BigInt(t.maxMultiplierX100)) / 100n - stake
      if (t.hot < exposure) continue // InsufficientBankroll would revert — let maintainChips refill first
      await ensureChipAllowance(p, CFT)
      const side = Math.random() < 0.5 ? 0 : 1
      try {
        const r = await sendAs(p.publicClient, p.wallet, { address: CFT, abi: coinFlipTablesAbi, functionName: 'open', args: [tableId, side, stake, subset, await heatLocations()], gas: OPEN_GAS })
        const ev = viem.parseEventLogs({ abi: coinFlipTablesAbi, logs: r.logs, eventName: 'RoundOpened' })[0] as unknown as { args: { roundId: viem.Hex } }
        console.log(`open: ${p.account.address} bet ${viem.formatEther(stake)} on ${side === 0 ? 'heads' : 'tails'} → ${ev.args.roundId.slice(0, 12)}…`)
      } catch (e) {
        console.error(`open failed (${p.account.address}): ${(e as Error).message?.split('\n')[0]?.slice(0, 100)}`)
      }
      return // one open per tick — modest cadence on the shared validator ladder
    }
  }

  // ── settle assist: claim() a finalized-but-unpushed round; refundStale() a timed-out one. Both are
  //    permissionless fallbacks; the contract guards decide, so we just try and swallow TooEarly. ──
  const assistPending = async () => {
    const opened = (await pc.getContractEvents({ address: CFT, abi: coinFlipTablesAbi, eventName: 'RoundOpened', fromBlock: from })) as unknown as { args: { roundId: viem.Hex } }[]
    for (const log of opened.slice(-25)) {
      const roundId = log.args.roundId
      const r = (await pc.readContract({ address: CFT, abi: coinFlipTablesAbi, functionName: 'rounds', args: [roundId] })) as unknown[]
      if (Number(r[7]) !== 1) continue // only Pending
      for (const fn of ['claim', 'refundStale'] as const) {
        try {
          await sendAs(operator.publicClient, operator.wallet, { address: CFT, abi: coinFlipTablesAbi, functionName: fn, args: [roundId], gas: SETTLE_GAS })
          console.log(`${fn}: ${roundId.slice(0, 12)}…`)
          break
        } catch { /* TooEarly / AlreadyResolved — expected while the caster still owns the round */ }
      }
    }
  }

  const tick = async () => {
    await topUpGas()
    const tableId = await ensureTable()
    await maintainChips(tableId)
    if (tableId) await openRounds(tableId)
    await assistPending()
  }

  if (env.ONCE === 'true') { await tick(); return }
  for (;;) {
    await tick().catch((e) => console.error(`tick failed: ${(e as Error).message?.split('\n').slice(0, 3).join(' ¦ ')}`))
    const jitter = 0.5 + Math.random()
    await new Promise((resolve) => setTimeout(resolve, Math.round(INTERVAL_MS * jitter)))
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
