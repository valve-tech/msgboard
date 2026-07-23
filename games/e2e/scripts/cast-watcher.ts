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
import { loadDeployment, makeActor, sendAs, heatsSince, flooredFees } from './actor-common'

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
      }
    }
  }

  const pass = async () => {
    await topUpOps()
    const heats = await heatsSince(publicClient, config)
    await maintainPools(BigInt(heats.length))
    for (const [index, heat] of heats.entries()) {
      const k = BigInt(index)
      const randomness = (await publicClient.readContract({
        address: config.random,
        abi: randomAbi,
        functionName: 'randomness',
        args: [heat.key],
      })) as { seed: viem.Hex }
      if (randomness.seed !== ZERO32) continue
      const secrets = config.canonicalSubset.map((_v, i) =>
        seeds0Secret(env.SEEDS0!, i * SECRET_STRIDE + Number(k)),
      )
      try {
        const receipt = await sendAs(publicClient, wallet, {
          address: config.random,
          abi: randomAbi,
          functionName: 'cast',
          args: [heat.key, locationsAt(k), secrets],
        })
        console.log(`cast key ${heat.key} (slot ${k}) in block ${receipt.blockNumber}`)
        await postNotice(`cast ${heat.key.slice(0, 10)} blk ${receipt.blockNumber} chain ${CHAIN}`)
      } catch (error) {
        // expired window, raced by another caster, etc. — log and keep watching
        console.error(`cast ${heat.key} failed: ${(error as Error).message?.split('\n').slice(0, 3).join(' ¦ ')}`)
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
