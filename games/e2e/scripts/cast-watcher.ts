/**
 * The minimal always-on validator service for a live chain. Each pass:
 *   1. casts every outstanding request key (CoinFlip `Heated` + Raffle `Armed` since the
 *      deployment origin, with no finalized seed) — the k-th heat chronologically maps to
 *      pool slot k via the rotation arithmetic (core poolLocationFor), and validator i's
 *      secret re-derives from seeds0 at HD account i*STRIDE + k (nothing stored);
 *   2. keeps the NEXT pool inked: when the heat count nears the current pool's boundary, it
 *      inks pool n+1 at the predicted offset (idempotent — Random.pointer is nonzero once a
 *      pool exists).
 *
 * Env: MNEMONIC (funded caster/payer), SEEDS0, CHAIN (default 943), RPC, CONFIG (path to
 *      <chain>-deployment.json), INTERVAL_MS (default 5000), ONCE=true for a single pass.
 *      OPS_INDEX (default 10): HD index of the OPERATIONS wallet that signs casts and
 *      inks. Account 0 is the treasury/vault — it only ever tops the ops wallet up, so the
 *      explorer never shows the treasury touching game contracts.
 *      VAULT_FLOOR (coins, default 100): below this VAULT (account 0) balance the watcher stops
 *      SPENDING on pool maintenance — casts still go out (settling open games is an
 *      obligation), but no new pools are inked until the vault is refilled.
 *      MSGBOARD_RPC (default the keyed vk_demo valve endpoint for CHAIN): a node running
 *      the msgboard_ module. After each cast the watcher posts a compact settlement notice
 *      to MsgBoard (category msgboard-games, proof-of-work stamp, no gas) — the venue's
 *      coordination trail that archive.msgboard.xyz keeps queryable. Failures are non-fatal.
 *
 * Run from examples/games/e2e:  MNEMONIC=… SEEDS0=… pnpm cast-watcher
 */
import * as viem from 'viem'
import { MsgBoardClient } from '@msgboard/sdk'
import { randomAbi, poolLocationFor, type GamesChainId, type Info } from '@msgboard/games-core'
import { seeds0Secret, SECRET_STRIDE } from './seeds0'
import {
  loadDeployment,
  makeActor,
  sendAs,
  heatsSince,
  heatsSincePriced,
  flooredFees,
  tierLadder,
  operatorTables,
  operatorSecret,
  operatorLocationsAt,
  inkValidatorStakedPool,
} from './actor-common'

const env = process.env
const CHAIN = (env.CHAIN ? Number(env.CHAIN) : 943) as GamesChainId
const INTERVAL_MS = env.INTERVAL_MS ? Number(env.INTERVAL_MS) : 5_000
const VAULT_FLOOR = viem.parseEther(env.VAULT_FLOOR || '100')
// padded-bytes32 text, NOT a plain string: the sdk's categoryHash passes 32-byte hex
// through but keccaks plain strings — a hashed category archives with category_text NULL
// and the site's prefilled archive queries (category_text = "msgboard-games") miss it.
const MSGBOARD_CATEGORY = viem.stringToHex('msgboard-games', { size: 32 })
const ZERO32 = viem.padHex('0x0', { size: 32 })
/** Ink pool n+1 once fewer than this many slots remain in pool n. */
const INK_AHEAD = 8n

const OPS_INDEX = env.OPS_INDEX ? Number(env.OPS_INDEX) : 10
const OPS_TOP_UP_BELOW = viem.parseEther('20')
const OPS_TOP_UP_TO = viem.parseEther('100')

// The operator game's validators are the canonicalSubset, derived from the SAME mnemonic at
// addressIndex VALIDATOR_INDEX_BASE + i (matches ink-pools.ts / deploy.ts). The caster holds the
// mnemonic so it can sign the stake deposit + ink AS each validator, staking each validator's OWN
// capital in the table token.
const VALIDATOR_INDEX_BASE = env.VALIDATOR_INDEX_BASE ? Number(env.VALIDATOR_INDEX_BASE) : 1

/** Minimal OperatorCoinFlip surface the watcher needs beyond Random: map a heat key to its round, and
 *  wrap Random.chop with the forfeit routing. instanceByKey is inherited from GameBase. */
const operatorGameAbi = [
  { type: 'function', name: 'instanceByKey', stateMutability: 'view', inputs: [{ name: '', type: 'bytes32' }], outputs: [{ type: 'bytes32' }] },
  {
    type: 'function',
    name: 'chopAndRoute',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'roundId', type: 'bytes32' },
      {
        name: 'info',
        type: 'tuple[]',
        components: [
          { name: 'provider', type: 'address' },
          { name: 'callAtChange', type: 'bool' },
          { name: 'durationIsTimestamp', type: 'bool' },
          { name: 'duration', type: 'uint256' },
          { name: 'token', type: 'address' },
          { name: 'price', type: 'uint256' },
          { name: 'offset', type: 'uint256' },
          { name: 'index', type: 'uint256' },
        ],
      },
    ],
    outputs: [],
  },
] as const satisfies viem.Abi

const main = async () => {
  if (!env.MNEMONIC) throw new Error('MNEMONIC (funded treasury) required')
  if (!env.SEEDS0) throw new Error('SEEDS0 required')
  const config = loadDeployment(CHAIN, env.CONFIG)
  const treasury = makeActor(CHAIN, env.MNEMONIC, 0, env.RPC)
  const { account, publicClient, wallet } = makeActor(CHAIN, env.MNEMONIC, OPS_INDEX, env.RPC)
  const poolSize = BigInt(config.poolSize)
  console.log(`cast watcher on chain ${CHAIN} as ${account.address} (ops; treasury ${treasury.account.address}); origin block ${config.deployBlock}, pool size ${poolSize}`)

  /** Keep the ops wallet runnable off the vault — the treasury's only job is transfers. */
  const topUpOps = async () => {
    const balance = await publicClient.getBalance({ address: account.address })
    if (balance >= OPS_TOP_UP_BELOW) return
    const vault = await publicClient.getBalance({ address: treasury.account.address })
    if (vault < VAULT_FLOOR) return // dry vault: don't scrape the bottom
    const hash = await treasury.wallet.sendTransaction({
      to: account.address,
      value: OPS_TOP_UP_TO - balance,
      ...(await flooredFees(publicClient)),
    })
    await publicClient.waitForTransactionReceipt({ hash })
    console.log(`ops wallet topped up to ${viem.formatEther(OPS_TOP_UP_TO)}`)
  }

  // The venue's town crier: a PoW-stamped MsgBoard notice per settlement — costs work, not
  // gas, so it keeps running even when the vault is too dry to spend.
  const msgboardRpc = env.MSGBOARD_RPC || `https://one.valve.city/rpc/vk_demo/evm/${CHAIN}`
  const board = new MsgBoardClient(
    viem.createPublicClient({ transport: viem.http(msgboardRpc) }) as ConstructorParameters<typeof MsgBoardClient>[0],
  )
  const postNotice = async (data: string) => {
    try {
      const work = await board.doPoW(MSGBOARD_CATEGORY, data)
      await board.addMessage(work.message)
      console.log(`msgboard notice: ${data}`)
    } catch (error) {
      console.error(`msgboard notice failed (non-fatal): ${(error as Error).message?.split('\n').slice(0, 3).join(' ¦ ')}`)
    }
  }

  const locationsAt = (k: bigint): Info[] =>
    config.canonicalSubset.map((provider) => {
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

  // Read the FIRST committed preimage-hash inked at a pool location. The `pointer` is an SSTORE2 data
  // contract: its runtime code is a 0x00 STOP byte followed by the raw 32-byte preimage hashes, so the
  // first hash is code bytes [1..33). Returns null when the location is uninked.
  const committedFirstHash = async (probe: Info): Promise<viem.Hex | null> => {
    const ptr = (await publicClient.readContract({
      address: config.random,
      abi: randomAbi,
      functionName: 'pointer',
      args: [probe],
    })) as viem.Hex
    if (ptr === viem.zeroAddress) return null
    const code = await publicClient.getCode({ address: ptr })
    if (!code || code.length < 4 + 64) return null
    return ('0x' + code.slice(4, 4 + 64)) as viem.Hex // skip '0x' + the leading 00 STOP byte, take 32 bytes
  }

  // A pool is DRIFTED when its on-chain commitment doesn't match the secret the cast reveals for that
  // slot — i.e. it was inked with the WRONG pool's preimages (an append/offset drift; happened once at
  // 943 pool 25 / slots 1600-1663). Such a pool can never be cast for any slot, so the caster must stop
  // re-simulating it every tick (the failing sims otherwise spin forever and slow the tick), and those
  // rounds settle via each game's own timeout/refund, not the caster. Cached per-process.
  const driftedPools = new Set<string>()
  const isPoolDrifted = async (poolStart: bigint): Promise<boolean> => {
    if (driftedPools.has(poolStart.toString())) return true
    for (const [i, provider] of config.canonicalSubset.entries()) {
      const base = BigInt(config.poolOffsets[provider.toLowerCase()] ?? '0')
      const pool = poolLocationFor(poolStart, base, poolSize)
      const probe: Info = { provider, callAtChange: false, durationIsTimestamp: false, duration: 12n, token: viem.zeroAddress, price: 0n, offset: pool.offset, index: 0n }
      const got = await committedFirstHash(probe)
      if (got === null) return false // uninked (not drifted) — maintainPools will ink it
      const expected = viem.keccak256(seeds0Secret(env.SEEDS0!, i * SECRET_STRIDE + Number(poolStart)))
      if (got !== expected) {
        driftedPools.add(poolStart.toString())
        return true
      }
    }
    return false
  }

  /**
   * Ensure the pool the CURRENT heat slot lives in exists, and pre-ink pool n+1 when the live
   * pool is nearly spent. The current-pool check is the recovery path: if this watcher was down
   * across a pool boundary (exactly what happens when its sends stop mining), heatCount sits at
   * the start of a pool nobody ever inked — and the old "only ink n+1 when nearly spent" logic
   * would never repair it (remaining == poolSize > INK_AHEAD), wedging the games permanently.
   */
  const maintainPools = async (heatCount: bigint) => {
    const remaining = poolSize - (heatCount % poolSize)
    const poolStarts = [(heatCount / poolSize) * poolSize] // the CURRENT pool must always exist
    if (remaining <= INK_AHEAD) poolStarts.push(((heatCount / poolSize) + 1n) * poolSize)
    for (const poolStart of poolStarts) {
      for (const [i, provider] of config.canonicalSubset.entries()) {
        const base = BigInt(config.poolOffsets[provider.toLowerCase()] ?? '0')
        const pool = poolLocationFor(poolStart, base, poolSize)
        const probe: Info = {
          provider,
          callAtChange: false,
          durationIsTimestamp: false,
          duration: 12n,
          token: viem.zeroAddress,
          price: 0n,
          offset: pool.offset,
          index: 0n,
        }
        const pointer = (await publicClient.readContract({
          address: config.random,
          abi: randomAbi,
          functionName: 'pointer',
          args: [probe],
        })) as viem.Hex
        if (pointer !== viem.zeroAddress) continue // this pool already inked
        const vault = await publicClient.getBalance({ address: treasury.account.address })
        if (vault < VAULT_FLOOR) {
          console.log(`vault below floor (${viem.formatEther(vault)} < ${viem.formatEther(VAULT_FLOOR)}) — pool inking paused until refilled`)
          return
        }
        const firstSecretIndex = Number(poolStart)
        const preimages = Array.from({ length: config.poolSize }, (_p, j) =>
          viem.keccak256(seeds0Secret(env.SEEDS0!, i * SECRET_STRIDE + firstSecretIndex + j)),
        )
        await sendAs(publicClient, wallet, {
          address: config.random,
          abi: randomAbi,
          functionName: 'ink',
          args: [{ ...probe, offset: 0n }, viem.concatHex(preimages)],
        })
        console.log(`inked pool at slot ${poolStart} for validator ${i} (${provider}) at offset ${pool.offset}`)
        // Read back what actually landed at this location — the ink APPENDS (offset:0n), so a duplicate
        // or out-of-order append silently lands a pool's preimages at the wrong offset (the 943 pool-25
        // drift). Verify committed[0] matches this pool's first secret; alarm loudly if it doesn't.
        const committed = await committedFirstHash(probe)
        const expected = viem.keccak256(seeds0Secret(env.SEEDS0!, i * SECRET_STRIDE + firstSecretIndex))
        if (committed !== expected) {
          console.error(`POOL INK DRIFT slot ${poolStart} validator ${i}: committed[0] ${committed} != expected ${expected} — casts for this pool will SecretMismatch; needs manual repair`)
        }
      }
    }
  }

  // Keys past the point of casting — finalized (already settled) OR expired (window closed, can
  // never be cast). Both are terminal, so once a key lands here we never read it again. Without this
  // the per-tick scan re-reads EVERY heat since the origin, and fanning those reads out concurrently
  // (below) would hammer the RPC as history grows. With it, each tick reads only the handful of
  // still-in-flight rounds. Process-lifetime cache; a restart re-scans once (harmless).
  const resolved = new Set<string>()

  // The validator wallets for the operator game, derived from the mnemonic. The caster signs the stake
  // deposit + ink AS each validator so the staked capital is the validator's own.
  const validatorWallets = config.operatorCoinFlip
    ? config.canonicalSubset.map((addr, i) => {
        const v = makeActor(CHAIN, env.MNEMONIC!, VALIDATOR_INDEX_BASE + i, env.RPC)
        if (v.account.address.toLowerCase() !== addr.toLowerCase()) {
          console.warn(`validator ${i} mnemonic index ${VALIDATOR_INDEX_BASE + i} = ${v.account.address} != canonicalSubset ${addr}`)
        }
        return v.wallet
      })
    : []

  /**
   * The operator game runs on its OWN staked (token, tierPrice) pool ladders (heatsSincePriced), NEVER
   * the shared price-0 counter. Each pass: (1) keeps each validator's staked pool inked for every open
   * table tier (self-inked from the validator's key, so the stake is the validator's own capital); (2)
   * casts live operator rounds on their priced ladder; (3) chops any round left unfinalized past its cast
   * window — first casting whatever secrets exist (flicking honest stakes back), then chopAndRoute, which
   * wraps Random.chop and routes the withholder's forfeited stake into the operator's bankroll.
   */
  const operatorPass = async () => {
    if (!config.operatorCoinFlip) return
    const game = config.operatorCoinFlip
    const tables = await operatorTables(publicClient, config)
    // The distinct (token, price) tiers in play across all OPEN tables.
    const tiers = new Map<string, { token: viem.Hex; price: bigint }>()
    for (const t of tables) {
      if (!t.open) continue
      for (const price of tierLadder(t.minStake, t.maxStake)) tiers.set(`${t.token.toLowerCase()}:${price}`, { token: t.token, price })
    }

    for (const { token, price } of tiers.values()) {
      // (1) keep each validator's staked pool inked ahead of the ladder boundary.
      const heats = await heatsSincePriced(publicClient, config, token, price)
      const k = BigInt(heats.length)
      const remaining = poolSize - (k % poolSize)
      const poolStarts = [(k / poolSize) * poolSize]
      if (remaining <= INK_AHEAD) poolStarts.push(((k / poolSize) + 1n) * poolSize)
      for (const poolStart of poolStarts) {
        for (let i = 0; i < config.canonicalSubset.length; i++) {
          try {
            const result = await inkValidatorStakedPool(
              publicClient, validatorWallets[i]!, config.random, env.SEEDS0!, i, token, price, poolStart, Number(poolSize),
            )
            if (result === 'inked') console.log(`validator ${i} inked staked pool ${token}@${price} slot ${poolStart}`)
            else if (result === 'underfunded') console.warn(`validator ${i} underfunded for ${token}@${price} — pool not inked`)
          } catch (error) {
            console.error(`ink ${token}@${price} slot ${poolStart} validator ${i} failed: ${(error as Error).message?.split('\n').slice(0, 2).join(' ¦ ')}`)
          }
        }
      }

      // (2)+(3) cast live rounds, chop the stalled ones.
      for (let idx = 0; idx < heats.length; idx++) {
        const heat = heats[idx]!
        if (resolved.has(heat.key)) continue
        const randomness = (await publicClient.readContract({ address: config.random, abi: randomAbi, functionName: 'randomness', args: [heat.key] })) as { seed: viem.Hex; timeline: bigint }
        if (randomness.seed !== ZERO32) { resolved.add(heat.key); continue }
        const slot = BigInt(idx)
        const locations = operatorLocationsAt(config.canonicalSubset, slot, poolSize, token, price)
        const secrets = config.canonicalSubset.map((_v, i) => operatorSecret(env.SEEDS0!, i, token, price, slot))
        const isExpired = (await publicClient.readContract({ address: config.random, abi: randomAbi, functionName: 'expired', args: [randomness.timeline] })) as boolean
        // Best-effort cast: settles a live round, or flicks the honest stakes back on a stalled one.
        // Explicit gas: Random._call swallows an onCast revert, so eth_estimateGas can under-provision
        // the push-settlement sub-call (starved by EIP-150 63/64), leaving the round Pending after a
        // "successful" cast that the receipt.status guard won't catch. A generous limit funds onCast;
        // you pay for gas USED, not the limit. claim() is still the backstop if a cast is ever short.
        try {
          await sendAs(publicClient, wallet, { address: config.random, abi: randomAbi, functionName: 'cast', args: [heat.key, locations, secrets], gas: 1_500_000n })
        } catch (error) {
          if (!isExpired) console.error(`operator cast ${heat.key} slot ${slot} failed: ${(error as Error).message?.split('\n').slice(0, 2).join(' ¦ ')}`)
        }
        const after = (await publicClient.readContract({ address: config.random, abi: randomAbi, functionName: 'randomness', args: [heat.key] })) as { seed: viem.Hex }
        if (after.seed !== ZERO32) { resolved.add(heat.key); console.log(`operator round settled ${heat.key} slot ${slot}`); continue }
        if (!isExpired) continue // still castable next tick
        // Stalled past its window: route the forfeit through the game (chop + bank the withheld stake).
        try {
          const roundId = (await publicClient.readContract({ address: game, abi: operatorGameAbi, functionName: 'instanceByKey', args: [heat.key] })) as viem.Hex
          await sendAs(publicClient, wallet, { address: game, abi: operatorGameAbi, functionName: 'chopAndRoute', args: [roundId, locations] })
          resolved.add(heat.key)
          console.log(`operator round chopped + forfeit routed ${heat.key} slot ${slot}`)
        } catch (error) {
          console.error(`chopAndRoute ${heat.key} slot ${slot} failed: ${(error as Error).message?.split('\n').slice(0, 2).join(' ¦ ')}`)
        }
      }
    }
  }

  const pass = async () => {
    await topUpOps()
    const heats = await heatsSince(publicClient, config)
    await maintainPools(BigInt(heats.length))
    await operatorPass()
    // Decide which heats are castable this tick — unfinalized AND with the cast window still open.
    // These reads are independent, so fan them out: a serial per-heat scan of a long backlog is
    // itself slow enough to let fresh heats expire before the caster reaches them.
    //
    // A stuck/expired request can NEVER be cast, so re-attempting it every tick (a failing simulate
    // + revert) only wastes time — and a slow tick makes FRESH heats expire before they're cast, the
    // exact death spiral that wedged this watcher for 10 days. Dropping dead keys keeps the tick short
    // enough to hit the ~12-block window.
    const castable = (
      await Promise.all(
        heats.map(async (heat, index) => {
          const k = BigInt(index)
          if (resolved.has(heat.key)) return null // finalized or expired on an earlier tick
          const randomness = (await publicClient.readContract({
            address: config.random,
            abi: randomAbi,
            functionName: 'randomness',
            args: [heat.key],
          })) as { seed: viem.Hex; timeline: bigint }
          if (randomness.seed !== ZERO32) {
            resolved.add(heat.key) // already finalized
            return null
          }
          const isExpired = (await publicClient.readContract({
            address: config.random,
            abi: randomAbi,
            functionName: 'expired',
            args: [randomness.timeline],
          })) as boolean
          if (isExpired) {
            resolved.add(heat.key) // dead key — can never be cast
            return null
          }
          const secrets = config.canonicalSubset.map((_v, i) =>
            seeds0Secret(env.SEEDS0!, i * SECRET_STRIDE + Number(k)),
          )
          return { key: heat.key, k, secrets }
        }),
      )
    ).filter((c): c is { key: viem.Hex; k: bigint; secrets: viem.Hex[] } => c !== null)
    if (castable.length === 0) return

    // Simulate every castable cast concurrently. A sim failure (raced by another caster, or the
    // window closing between the expired-check and now) drops just that one — the rest still go out.
    // Simulating BEFORE assigning nonces means only viable casts consume a nonce, so a dropped cast
    // can't leave a nonce gap that strands every later cast in the batch as unminable-pending.
    const fees = await flooredFees(publicClient)
    const simulated = (
      await Promise.all(
        castable.map(async (c) => {
          try {
            const { request } = await publicClient.simulateContract({
              address: config.random,
              abi: randomAbi,
              functionName: 'cast',
              args: [c.key, locationsAt(c.k), c.secrets],
              account,
              ...fees,
              gas: 1_500_000n, // fund the swallowed onCast sub-call (see the operator-cast note above)
            })
            return { c, request }
          } catch (error) {
            const msg = (error as Error).message ?? ''
            // A drifted pool (wrong preimages inked) can NEVER be cast — drop the heat so the caster
            // stops re-simulating it every tick (the death-spiral). Its round settles via the game's
            // own timeout/refund, not here. Only SecretMismatch is treated as terminal, and only once
            // the pool is verified drifted (a transient race still retries next tick).
            if (msg.includes('SecretMismatch') && (await isPoolDrifted((c.k / poolSize) * poolSize))) {
              resolved.add(c.key)
              console.error(`cast ${c.key} (slot ${c.k}) DROPPED: pool ${(c.k / poolSize) * poolSize} inked with the wrong preimages (drift) — cannot be cast; settle via the game's timeout`)
            } else {
              console.error(`cast ${c.key} (slot ${c.k}) sim failed: ${msg.split('\n').slice(0, 3).join(' ¦ ')}`)
            }
            return null
          }
        }),
      )
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ).filter(Boolean) as { c: { key: viem.Hex; k: bigint; secrets: viem.Hex[] }; request: any }[]
    if (simulated.length === 0) return

    // All casts fire from the one ops wallet, so they MUST carry explicit, contiguous nonces — viem
    // would otherwise fetch the same 'pending' count for every concurrent send and they'd collide on
    // a single slot. topUpOps/maintainPools already awaited their ops-wallet sends above, so the
    // pending count here is a clean base for the batch.
    const baseNonce = await publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' })
    const results = await Promise.allSettled(
      simulated.map(async ({ c, request }, i) => {
        const hash = await wallet.writeContract({ ...request, nonce: baseNonce + i })
        const receipt = await publicClient.waitForTransactionReceipt({ hash })
        if (receipt.status !== 'success') throw new Error(`cast ${c.key} reverted`)
        console.log(`cast key ${c.key} (slot ${c.k}) in block ${receipt.blockNumber}`)
        return { c, receipt }
      }),
    )
    // PoW-stamp the settlement notices sequentially AFTER the batch lands — grinding several stamps
    // at once would spike CPU and stall the concurrent sends' receipts.
    for (const r of results) {
      if (r.status === 'fulfilled') {
        resolved.add(r.value.c.key) // our cast finalized it — don't re-read next tick
        await postNotice(`cast ${r.value.c.key.slice(0, 10)} blk ${r.value.receipt.blockNumber} chain ${CHAIN}`)
      } else {
        console.error(`cast failed: ${(r.reason as Error)?.message?.split('\n').slice(0, 3).join(' ¦ ')}`)
      }
    }
  }

  if (env.ONCE === 'true') {
    await pass()
    return
  }
  for (;;) {
    try {
      await pass()
    } catch (error) {
      console.error(`pass failed: ${(error as Error).message?.split('\n').slice(0, 3).join(' ¦ ')}`)
    }
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS))
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
