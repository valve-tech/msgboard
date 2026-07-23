/**
 * Autonomous testnet players: keep the games moving and the historical record growing.
 * Stateless — every fact rebuilds from chain state each tick, and raffle guess/salt pairs
 * re-derive deterministically from (bot key, commit ordinal), so restarts lose nothing.
 *
 * Per tick (with jitter):
 *   coin flip  — if ANY open entry waits at a stake up to MAX_STAKE (a bot's or a human's —
 *                stakes are manual inputs on the site now), a bot with the balance for it
 *                enters the opposite side and pairs it (humans always find a counterparty);
 *                otherwise, sometimes queue a fresh canonical entry.
 *   raffle     — fill ANY filling round on the canonical subset with stake up to MAX_STAKE
 *                (custom stake/threshold tuples included), one bot-commit at a time; arm at
 *                threshold once the period elapses; reveal own tickets during the claim
 *                window; finalise after.
 *
 * The cast-watcher (separate process) finalizes seeds; this script never casts.
 *
 * Env: MNEMONIC (funded; bots are addressIndex 20..20+BOTS-1, topped up from account 0 —
 *      the treasury, which only ever transfers; arms/finalises sign from the OPS wallet
 *      at OPS_INDEX, default 11, also topped from the treasury),
 *      SEEDS0 (bot guess/salt derivation), CHAIN (default 943), RPC, CONFIG,
 *      BOTS (default 3), INTERVAL_MS (default 90000), ENTER_PROBABILITY (default 0.35),
 *      MAX_STAKE (coins, default 25 — the biggest human stake a bot will take on),
 *      VAULT_FLOOR (coins, default 100): when the funder (account 0) drops below this, the
 *      bots PAUSE all spending on that chain — no top-ups, entries, commits, arms or
 *      finalises (reveals still go out; they recover escrowed stakes). Play resumes by
 *      itself once the vault is refilled.
 *      GAS_CUSHION / TOP_UP_BELOW / TOP_UP_TO (coins, defaults 1/50/200 — 943-sized): the
 *      play-eligibility cushion and the treasury top-up band. MUST be chain-sized: see the
 *      note at the constants below (369 needs a ~3.5k-PLS cushion at mainnet gas prices).
 *      SELF_PLAY_INTERVAL_MS (default 0 = off): minimum gap between SELF-INITIATED spends
 *      (fresh queue entries, opening rounds, filling bot-only rounds). Pairing a human
 *      entry or filling a round a human sits in stays immediate — sparing cadence never
 *      leaves a human hanging.
 *      ONCE=true for a single pass.
 */
import * as viem from 'viem'
import {
  coinFlipAbi,
  raffleAbi,
  poolLocationFor,
  type GamesChainId,
  type Info,
} from '@msgboard/games-core'
import { makePresets as coinflipPresets } from '@msgboard/coinflip'
import { makePresets as rafflePresets } from '@msgboard/raffle'
import { seeds0Secret } from './seeds0'
import { loadDeployment, makeActor, sendAs, heatsSince, flooredFees, chunkedEvents } from './actor-common'

const env = process.env
const CHAIN = (env.CHAIN ? Number(env.CHAIN) : 943) as GamesChainId
const BOT_COUNT = env.BOTS ? Number(env.BOTS) : 3
const FIRST_BOT_INDEX = 20 // clear of validators (1-3) and the gate's players (4-8)
const BOT_KEY_BASE = 50_000_000 // reserved seeds0 range for bot salt derivation
const INTERVAL_MS = env.INTERVAL_MS ? Number(env.INTERVAL_MS) : 90_000
const ENTER_PROBABILITY = env.ENTER_PROBABILITY ? Number(env.ENTER_PROBABILITY) : 0.35
const MAX_STAKE = viem.parseEther(env.MAX_STAKE || '25') // biggest entry/ticket a bot takes on
const VAULT_FLOOR = viem.parseEther(env.VAULT_FLOOR || '100')
const SELF_PLAY_INTERVAL_MS = env.SELF_PLAY_INTERVAL_MS ? Number(env.SELF_PLAY_INTERVAL_MS) : 0
// Float sizing is CHAIN-SIZED via env: the defaults fit 943 (wei-level gas), but on 369 the
// pre-flight cost check compares balance against the EXPLICIT gas cap × maxFee — ~3.5k PLS for a
// 4M-gas enter at ~4e5-gwei mainnet prices — so testnet-sized floats wedge every play before it
// is ever sent (and a wedged bot above TOP_UP_BELOW never self-heals). Size GAS_CUSHION to one
// worst-case envelope and TOP_UP_BELOW above GAS_CUSHION + MAX_STAKE.
const GAS_CUSHION = viem.parseEther(env.GAS_CUSHION || '1') // keep enough aside to always afford the gas
const TOP_UP_BELOW = viem.parseEther(env.TOP_UP_BELOW || '50')
const TOP_UP_TO = viem.parseEther(env.TOP_UP_TO || '200')
const COMMIT_GAS = 1_000_000n
const ENTER_GAS = 4_000_000n
const REVEAL_GAS = 500_000n

const main = async () => {
  if (!env.MNEMONIC) throw new Error('MNEMONIC required')
  if (!env.SEEDS0) throw new Error('SEEDS0 required')
  const config = loadDeployment(CHAIN, env.CONFIG)
  const funder = makeActor(CHAIN, env.MNEMONIC, 0, env.RPC)
  // arms/finalises sign from ops, never from the treasury (index 11 ≠ the watcher's 10 — two
  // processes sharing a signer would race nonces)
  const ops = makeActor(CHAIN, env.MNEMONIC!, env.OPS_INDEX ? Number(env.OPS_INDEX) : 11, env.RPC)
  const bots = Array.from({ length: BOT_COUNT }, (_b, i) => ({
    ...makeActor(CHAIN, env.MNEMONIC!, FIRST_BOT_INDEX + i, env.RPC),
    saltKey: seeds0Secret(env.SEEDS0!, BOT_KEY_BASE + i),
  }))
  const publicClient = funder.publicClient
  const subset = config.canonicalSubset
  const poolSize = BigInt(config.poolSize)
  const flipParams = coinflipPresets(subset)[0]!.params // the 0.1 preset only — bounded spend
  const raffleParams = rafflePresets(subset)[0]!.params
  const from = BigInt(config.deployBlock)
  console.log(
    `player bots on chain ${CHAIN}: ${bots.map((b) => b.account.address).join(', ')} (tick ${INTERVAL_MS}ms)`,
  )

  const botAddresses = new Set(bots.map((b) => b.account.address.toLowerCase()))
  const randomPick = <T,>(items: T[]): T => items[Math.floor(Math.random() * items.length)]!

  // sparing cadence: self-initiated spends respect a minimum gap; human-facing ones don't
  let lastSelfPlay = 0
  const selfPlayAllowed = () => Date.now() - lastSelfPlay >= SELF_PLAY_INTERVAL_MS
  const markSelfPlay = () => {
    lastSelfPlay = Date.now()
  }
  let vaultPaused = false

  /** salt_n/guess_n for a bot's n-th raffle commit — recomputable forever from seeds0. */
  const ticketPlan = (saltKey: viem.Hex, ordinal: number) => {
    const salt = viem.keccak256(viem.concatHex([saltKey, viem.toHex(ordinal, { size: 32 })]))
    const guess = 1n + (BigInt(viem.keccak256(salt)) % 256n)
    return { salt, guess }
  }
  const commitmentFor = (guess: bigint, salt: viem.Hex, player: viem.Hex): viem.Hex =>
    viem.keccak256(
      viem.encodeAbiParameters([{ type: 'uint256' }, { type: 'bytes32' }, { type: 'address' }], [guess, salt, player]),
    )

  const heatLocations = async (): Promise<Info[]> => {
    const k = BigInt((await heatsSince(publicClient, config)).length)
    return subset.map((provider) => {
      const { offset, index } = poolLocationFor(k, BigInt(config.poolOffsets[provider.toLowerCase()] ?? '0'), poolSize)
      return {
        provider,
        callAtChange: false,
        durationIsTimestamp: false,
        duration: 12n,
        token: viem.zeroAddress,
        price: 0n,
        offset,
        index,
      }
    })
  }

  const topUp = async () => {
    if (vaultPaused) return
    for (const bot of [...bots, ops]) {
      const balance = await publicClient.getBalance({ address: bot.account.address })
      if (balance >= TOP_UP_BELOW) continue
      const hash = await funder.wallet.sendTransaction({
        to: bot.account.address,
        value: TOP_UP_TO - balance,
        ...(await flooredFees(publicClient)),
      })
      await publicClient.waitForTransactionReceipt({ hash })
      console.log(`topped up ${bot.account.address}`)
    }
  }

  // --- coin flip ---------------------------------------------------------------------------
  const tickCoinFlip = async () => {
    if (vaultPaused) return
    // open entries = Entered minus anything no longer active (paired or cancelled), straight
    // from the contract's own entries(id).active flag — no event-derivation heuristics
    const entered = await chunkedEvents(publicClient, {
      address: config.coinFlip,
      abi: coinFlipAbi as viem.Abi,
      eventName: 'Entered',
      fromBlock: from,
    })
    const open: { id: bigint; player: viem.Hex; side: number; stake: bigint }[] = []
    for (const log of entered.slice(-40)) {
      const args = log.args as { id: bigint; player: viem.Hex; side: number; stake: bigint }
      if (args.stake > MAX_STAKE) continue // manual stakes on the site — bounded spend per take
      const entry = (await publicClient.readContract({
        address: config.coinFlip,
        abi: coinFlipAbi,
        functionName: 'entries',
        args: [args.id],
      })) as unknown[]
      if (entry[5] === true) open.push(args) // .active
    }

    if (open.length > 0) {
      const target = open[0]!
      const targetIsBot = botAddresses.has(target.player.toLowerCase())
      if (targetIsBot && !selfPlayAllowed()) return // bot-vs-bot is self-play; humans never wait
      const candidates = bots.filter((b) => b.account.address.toLowerCase() !== target.player.toLowerCase())
      const funded: typeof candidates = []
      for (const b of candidates) {
        const balance = await publicClient.getBalance({ address: b.account.address })
        if (balance >= target.stake + GAS_CUSHION) funded.push(b)
      }
      const taker = randomPick(funded)
      if (!taker) return
      const opposite = Number(target.side) === 0 ? 1 : 0
      await sendAs(taker.publicClient, taker.wallet, {
        address: config.coinFlip,
        abi: coinFlipAbi,
        functionName: 'enterAndMatch',
        args: [opposite, subset, await heatLocations()],
        value: target.stake,
        gas: ENTER_GAS,
      })
      if (targetIsBot) markSelfPlay()
      console.log(`flip: ${taker.account.address} took the ${opposite === 0 ? 'heads' : 'tails'} side vs ${target.player}`)
      return
    }
    if (selfPlayAllowed() && Math.random() < ENTER_PROBABILITY) {
      const bot = randomPick(bots)
      const side = Math.random() < 0.5 ? 0 : 1
      await sendAs(bot.publicClient, bot.wallet, {
        address: config.coinFlip,
        abi: coinFlipAbi,
        functionName: 'enterAndMatch',
        args: [side, subset, []],
        value: flipParams.stake,
        gas: ENTER_GAS,
      })
      markSelfPlay()
      console.log(`flip: ${bot.account.address} queued ${side === 0 ? 'heads' : 'tails'}`)
    }
  }

  // --- raffle ------------------------------------------------------------------------------
  const tickRaffle = async () => {
    const subsetHash = viem.keccak256(viem.encodeAbiParameters([{ type: 'address[]' }], [subset]))
    const currentBlock = await publicClient.getBlockNumber()
    const committedLogs = await chunkedEvents(publicClient, {
      address: config.raffle,
      abi: raffleAbi as viem.Abi,
      eventName: 'Committed',
      fromBlock: from,
    })
    const commitsByBot = new Map<string, { ticketId: bigint; roundId: viem.Hex }[]>()
    const humanRounds = new Set<viem.Hex>()
    for (const log of committedLogs) {
      const args = log.args as { ticketId: bigint; roundId: viem.Hex; player: viem.Hex }
      const key = args.player.toLowerCase()
      if (!botAddresses.has(key)) {
        humanRounds.add(args.roundId) // a human holds a ticket — filling this round is service, not self-play
        continue
      }
      commitsByBot.set(key, [...(commitsByBot.get(key) ?? []), { ticketId: args.ticketId, roundId: args.roundId }])
    }

    // 1. fill / arm ANY filling round on our subset — manual stake/threshold tuples included,
    // capped at MAX_STAKE per ticket so a whale round can't drain the bots
    const openedLogs = await chunkedEvents(publicClient, {
      address: config.raffle,
      abi: raffleAbi as viem.Abi,
      eventName: 'RoundOpened',
      fromBlock: from,
    })
    let sawFillable = false
    for (const log of openedLogs) {
      const opened = log.args as { roundId: viem.Hex; stake: bigint; threshold: bigint; period: bigint; subsetHash: viem.Hex }
      if (opened.subsetHash !== subsetHash || opened.stake > MAX_STAKE) continue
      const round = (await publicClient.readContract({
        address: config.raffle,
        abi: raffleAbi,
        functionName: 'rounds',
        args: [opened.roundId],
      })) as unknown[]
      if (Number(round[7]) !== 1) continue // 1 = Filling
      sawFillable = true
      if (vaultPaused) continue
      const commitCount = round[5] as bigint
      const createdAtBlock = round[4] as bigint
      if (commitCount < opened.threshold) {
        if (!humanRounds.has(opened.roundId) && !selfPlayAllowed()) continue // bot-only round: sparing cadence
        for (const fresh of bots) {
          const mine = commitsByBot.get(fresh.account.address.toLowerCase()) ?? []
          if (mine.some((c) => c.roundId === opened.roundId)) continue
          const balance = await publicClient.getBalance({ address: fresh.account.address })
          if (balance < opened.stake + GAS_CUSHION) continue
          const ordinal = mine.length
          const { salt, guess } = ticketPlan(fresh.saltKey, ordinal)
          await sendAs(fresh.publicClient, fresh.wallet, {
            address: config.raffle,
            abi: raffleAbi,
            functionName: 'commit',
            args: [opened.stake, opened.threshold, opened.period, subset, commitmentFor(guess, salt, fresh.account.address)],
            value: opened.stake,
            gas: COMMIT_GAS,
          })
          if (!humanRounds.has(opened.roundId)) markSelfPlay()
          console.log(`raffle: ${fresh.account.address} committed (ordinal ${ordinal}) to ${opened.roundId.slice(0, 10)}`)
          return
        }
      } else if (currentBlock >= createdAtBlock + opened.period) {
        await sendAs(ops.publicClient, ops.wallet, {
          address: config.raffle,
          abi: raffleAbi,
          functionName: 'arm',
          args: [opened.roundId, await heatLocations()],
        })
        console.log(`raffle: armed ${opened.roundId.slice(0, 10)}`)
        return
      }
    }
    if (!sawFillable && !vaultPaused && selfPlayAllowed() && Math.random() < ENTER_PROBABILITY) {
      // no active round — open one
      const bot = randomPick(bots)
      const ordinal = (commitsByBot.get(bot.account.address.toLowerCase()) ?? []).length
      const { salt, guess } = ticketPlan(bot.saltKey, ordinal)
      await sendAs(bot.publicClient, bot.wallet, {
        address: config.raffle,
        abi: raffleAbi,
        functionName: 'commit',
        args: [raffleParams.stake, raffleParams.threshold, raffleParams.period, subset, commitmentFor(guess, salt, bot.account.address)],
        value: raffleParams.stake,
        gas: COMMIT_GAS,
      })
      markSelfPlay()
      console.log(`raffle: ${bot.account.address} opened a new round (ordinal ${ordinal})`)
      return
    }

    // 2. reveal own tickets in claiming rounds; finalise closed ones
    const seenRounds = new Set<viem.Hex>()
    for (const bot of bots) {
      const mine = commitsByBot.get(bot.account.address.toLowerCase()) ?? []
      for (const [ordinal, commit] of mine.entries()) {
        const ticket = (await publicClient.readContract({
          address: config.raffle,
          abi: raffleAbi,
          functionName: 'tickets',
          args: [commit.ticketId],
        })) as unknown[]
        const active = ticket[4] as boolean
        const revealed = ticket[5] as boolean
        if (!active || revealed) continue
        const round = (await publicClient.readContract({
          address: config.raffle,
          abi: raffleAbi,
          functionName: 'rounds',
          args: [commit.roundId],
        })) as unknown[]
        const status = Number(round[7])
        const claimDeadline = round[11] as bigint
        if (status === 3 && currentBlock <= claimDeadline) {
          const { salt, guess } = ticketPlan(bot.saltKey, ordinal)
          if (commitmentFor(guess, salt, bot.account.address) !== (ticket[2] as viem.Hex)) {
            console.error(`raffle: derived plan mismatch for ticket ${commit.ticketId} — skipping (ordinal drift?)`)
            continue
          }
          await sendAs(bot.publicClient, bot.wallet, {
            address: config.raffle,
            abi: raffleAbi,
            functionName: 'reveal',
            args: [commit.ticketId, guess, salt],
            gas: REVEAL_GAS,
          })
          console.log(`raffle: ${bot.account.address} revealed ticket ${commit.ticketId} (guess ${guess})`)
        } else if (status === 3 && currentBlock > claimDeadline && !seenRounds.has(commit.roundId) && !vaultPaused) {
          seenRounds.add(commit.roundId)
          await sendAs(ops.publicClient, ops.wallet, {
            address: config.raffle,
            abi: raffleAbi,
            functionName: 'finalise',
            args: [commit.roundId],
          })
          console.log(`raffle: finalised ${commit.roundId.slice(0, 10)}`)
        }
      }
    }
  }

  const tick = async () => {
    const vault = await publicClient.getBalance({ address: funder.account.address })
    const nowPaused = vault < VAULT_FLOOR
    if (nowPaused !== vaultPaused) {
      console.log(
        nowPaused
          ? `vault below floor (${viem.formatEther(vault)} < ${viem.formatEther(VAULT_FLOOR)}) — tables paused on chain ${CHAIN} until refilled`
          : `vault refilled (${viem.formatEther(vault)}) — tables back open on chain ${CHAIN}`,
      )
    }
    vaultPaused = nowPaused
    await topUp()
    await tickCoinFlip().catch((e) => console.error(`flip tick: ${(e as Error).message?.split('\n').slice(0, 3).join(' ¦ ')}`))
    await tickRaffle().catch((e) => console.error(`raffle tick: ${(e as Error).message?.split('\n').slice(0, 3).join(' ¦ ')}`))
  }

  if (env.ONCE === 'true') {
    await tick()
    return
  }
  for (;;) {
    await tick().catch((e) => console.error(`tick failed: ${(e as Error).message?.split('\n').slice(0, 3).join(' ¦ ')}`))
    const jitter = 0.5 + Math.random() // 0.5x..1.5x the interval
    await new Promise((resolve) => setTimeout(resolve, Math.round(INTERVAL_MS * jitter)))
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
