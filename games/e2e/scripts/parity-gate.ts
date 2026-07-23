/**
 * The games platform parity gate, automated and chain-agnostic: deploy CoinFlip + Raffle
 * against core Random on the target chain, allowlist mnemonic-derived validators, ink two
 * price-0 preimages per validator, fund the player wallets, then run one coin-flip duel and
 * one full raffle round end to end, asserting at every settlement that the off-chain `settle`
 * names the on-chain winner. On success (any non-development chain) it appends a run-log
 * entry to examples/games/README.md.
 *
 * Carries over the duel-943.ts conventions: every state-changing call is simulated first,
 * player calls carry explicit gas caps (PulseChain prevalidates eth_call balance against the
 * BLOCK gas limit when no gas is given — harmless elsewhere), players are further address
 * indexes of the same funded mnemonic topped up from account 0, and deployed addresses are
 * cached per chain so a re-run reuses the contracts.
 *
 * Environment variables:
 *   CHAIN        which chain to run against — a chain NAME as exported by viem/chains
 *                (case-insensitive: pulsechainV4, pulsechain, sepolia, foundry, ...), one of
 *                the aliases local/anvil/hardhat/dev (=> 31337), or a numeric chain id.
 *                Default 943 (pulsechainV4). A numeric id viem doesn't know needs RPC too.
 *   RPC          JSON-RPC endpoint. Defaults to the core registry's endpoint (943, 31337) or
 *                the chain's public default from viem/chains. RPC_943 is honored as a
 *                fallback on 943 — override to the valve.city endpoint there for reliability
 *                inside the 12-block heat window.
 *   MNEMONIC     funded recovery phrase (read via `op read`, never logged). Chain 31337
 *                defaults to the standard anvil test mnemonic.
 *   STAKE        stake per player in coins (default '0.1'; also the raffle ticket price).
 *   VALIDATORS   validator count (default 3 == the contract MIN_SUBSET).
 *   COINFLIP     reuse an already-deployed CoinFlip instead of deploying.
 *   RAFFLE       reuse an already-deployed Raffle instead of deploying.
 *   RANDOM_ADDRESS  override the core Random address (NOT named RANDOM because shells
 *                special-case that variable). On 31337 a fresh Random is deployed when unset.
 *   DEPLOY_RANDOM  'true' => deploy a fresh core Random on a LIVE chain too when no address
 *                is known (first-time chain bring-up, e.g. pulsechain mainnet).
 *   EXPECTED_PROVIDER  the address account 0 must derive to (guards against a wrong
 *                mnemonic). Defaults to the known funded account on 943 only; set it
 *                explicitly on other live chains, or empty to skip.
 *   DRY_RUN      'true' => simulate the deploys and an ink, broadcast nothing.
 *   SKIP_FINALISE 'true' => stop after the raffle parity assert (reveals), printing how to
 *                finalise later, instead of waiting out the 100-block claim window.
 *   NO_RUN_LOG   'true' => do not append to the README run log.
 *
 * Run from examples/games/e2e:
 *   MNEMONIC="$(op read 'op://gibs/randomness/recovery phrase')" pnpm gate          # 943
 *   CHAIN=local pnpm gate                                                          # anvil
 *   CHAIN=pulsechain RANDOM_ADDRESS=0x… MNEMONIC=… EXPECTED_PROVIDER=0x… pnpm gate
 */
import * as viem from 'viem'
import * as viemChains from 'viem/chains'
import { mnemonicToAccount } from 'viem/accounts'
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import {
  chains as knownChains,
  defaultRpc,
  randomAddress as knownRandom,
  makeSecret,
  buildHeatLocations,
  coinFlipAbi,
  coinFlipBytecode,
  raffleAbi,
  raffleBytecode,
  randomAbi,
  raffleDraw,
  type Info,
} from '@msgboard/games-core'
import { coinflip } from '@msgboard/coinflip'
import { raffle } from '@msgboard/raffle'
import RandomArtifact from '@gibs/random/artifacts/contracts/Random.sol/Random.json'

const env = process.env

/**
 * Resolve the CHAIN input — a viem/chains export name (case-insensitive), a friendly alias,
 * or a numeric chain id — to a chain object plus the RPC endpoint to use. Precedence for the
 * endpoint: RPC env > RPC_943 (on 943) > the core registry > the chain's viem default.
 */
const resolveChain = (input: string): { chain: viem.Chain; rpc: string } => {
  const aliases: Record<string, number> = { local: 31337, anvil: 31337, hardhat: 31337, dev: 31337, testnet: 943 }
  const isChain = (c: unknown): c is viem.Chain =>
    typeof c === 'object' && c !== null && 'id' in c && 'rpcUrls' in c
  const numeric = /^\d+$/.test(input) ? Number(input) : aliases[input.toLowerCase()]

  let chain: viem.Chain | undefined
  if (numeric !== undefined) {
    chain =
      (knownChains as Record<number, viem.Chain>)[numeric] ??
      (Object.values(viemChains) as unknown[]).find((c): c is viem.Chain => isChain(c) && c.id === numeric)
    if (!chain && !env.RPC) {
      throw new Error(`chain id ${numeric} is unknown to viem/chains; supply RPC`)
    }
    chain ??= {
      id: numeric,
      name: `chain-${numeric}`,
      nativeCurrency: { name: 'Coin', symbol: 'coins', decimals: 18 },
      rpcUrls: { default: { http: [env.RPC!] } },
    }
  } else {
    const wanted = input.toLowerCase()
    const named = Object.entries(viemChains as Record<string, unknown>).find(
      ([name, c]) => isChain(c) && name.toLowerCase() === wanted,
    )?.[1] as viem.Chain | undefined
    if (!named) {
      throw new Error(
        `unknown chain '${input}' — use a viem/chains export name (pulsechainV4, pulsechain, sepolia, ...), ` +
          'an alias (local/anvil), or a numeric chain id',
      )
    }
    // prefer the core registry's object when it covers this id (e.g. the local 31337 chain)
    chain = (knownChains as Record<number, viem.Chain>)[named.id] ?? named
  }

  const rpc =
    env.RPC ||
    (chain.id === 943 ? env.RPC_943 : undefined) ||
    (defaultRpc as Record<number, string>)[chain.id] ||
    chain.rpcUrls.default?.http[0]
  if (!rpc) throw new Error(`chain ${chain.id} (${chain.name}) has no default RPC endpoint; supply RPC`)
  return { chain, rpc }
}

const { chain: CHAIN, rpc: RPC } = resolveChain(env.CHAIN ?? '943')
const CHAIN_ID = CHAIN.id
/** 31337 is the development chain: anvil mining, test mnemonic, fresh Random, no cache/log. */
const IS_DEV = CHAIN_ID === 31337
const STAKE = viem.parseEther(env.STAKE || '0.1')
const VALIDATOR_COUNT = env.VALIDATORS ? Number(env.VALIDATORS) : 3
const DRY_RUN = env.DRY_RUN === 'true'
const SKIP_FINALISE = env.SKIP_FINALISE === 'true'
const KNOWN_PROVIDER_943 = '0xAF2b2118376b51eEcB58327526bc082aED3e4225'
const EXPECTED_PROVIDER =
  env.EXPECTED_PROVIDER !== undefined ? env.EXPECTED_PROVIDER : CHAIN_ID === 943 ? KNOWN_PROVIDER_943 : ''
const TEST_MNEMONIC = 'test test test test test test test test test test test junk'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const ADDRESS_CACHE = path.join(scriptDir, '.gate-deployments.json')
const README = path.join(scriptDir, '..', '..', 'README.md')

// Explicit gas caps for player calls (PulseChain eth_call prevalidation quirk — see header).
const ENTER_HEADS_GAS = 2_000_000n
const ENTER_TAILS_GAS = 4_000_000n // heats N validator preimages
const COMMIT_GAS = 1_000_000n
const REVEAL_GAS = 500_000n
const PLAYER_GAS_BUDGET = 6_000_000n // funding headroom over the largest cap

const RAFFLE_PERIOD = 2n // blocks a raffle round must fill before arming

// Fresh secrets every run: the seed is a deterministic function of the revealed secrets, so
// reuse would reproduce the same winner. Crypto-strong per-run salt models a real validator.
const RUN_SALT = viem.bytesToHex(crypto.getRandomValues(new Uint8Array(32)))
const randomBigint = (maxExclusive: bigint): bigint =>
  BigInt(viem.hexToNumber(viem.bytesToHex(crypto.getRandomValues(new Uint8Array(4))))) % maxExclusive

type Cache = Record<string, { coinFlip?: viem.Hex; raffle?: viem.Hex }>
const loadCache = (): Cache => {
  if (!fs.existsSync(ADDRESS_CACHE)) return {}
  return JSON.parse(fs.readFileSync(ADDRESS_CACHE, 'utf8')) as Cache
}
const saveCache = (entry: { coinFlip: viem.Hex; raffle: viem.Hex }) => {
  if (IS_DEV) return // anvil is ephemeral; never cache development addresses
  const cache = loadCache()
  cache[String(CHAIN_ID)] = entry
  fs.writeFileSync(ADDRESS_CACHE, JSON.stringify(cache, null, 2))
}

const main = async () => {
  const mnemonic = env.MNEMONIC || (IS_DEV ? TEST_MNEMONIC : undefined)
  if (!mnemonic) throw new Error('MNEMONIC is required on a live chain (read it in via `op read`, it is never logged)')

  const account = mnemonicToAccount(mnemonic) // index 0: deployer + funder + caster
  if (!IS_DEV && EXPECTED_PROVIDER && !viem.isAddressEqual(account.address, EXPECTED_PROVIDER as viem.Hex)) {
    throw new Error(
      `derived ${account.address} does not match expected provider ${EXPECTED_PROVIDER}; ` +
        'wrong mnemonic or derivation. Aborting before any transaction.',
    )
  }

  const chain = CHAIN
  const rpc = RPC
  const coins = (value: bigint): string => `${viem.formatEther(value)} ${chain.nativeCurrency.symbol}`
  const transport = viem.http(rpc)
  const publicClient = viem.createPublicClient({ chain, transport })
  const wallet = viem.createWalletClient({ account, chain, transport })
  const walletFor = (acct: viem.Account) => viem.createWalletClient({ account: acct, chain, transport })

  const gasPrice = await publicClient.getGasPrice()
  const maxPriorityFeePerGas = gasPrice / 10n > 0n ? gasPrice / 10n : 1n
  const maxFeePerGas = gasPrice * 2n + maxPriorityFeePerGas
  const fees = { maxFeePerGas, maxPriorityFeePerGas }
  const fundPerPlayer = STAKE + maxFeePerGas * PLAYER_GAS_BUDGET

  /** Simulate then broadcast a contract call, awaiting and checking the receipt. */
  const send = async (
    label: string,
    from: ReturnType<typeof walletFor>,
    address: viem.Hex,
    abi: viem.Abi,
    functionName: string,
    args: readonly unknown[],
    value = 0n,
    gas?: bigint,
  ): Promise<viem.TransactionReceipt> => {
    const { request } = await publicClient.simulateContract({
      address,
      abi,
      functionName,
      args,
      account: from.account!,
      value,
      ...fees,
      ...(gas ? { gas } : {}),
    })
    const hash = await from.writeContract(request)
    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    console.log(`  ${label}: block ${receipt.blockNumber}, gas ${receipt.gasUsed}, ${receipt.status} (${hash})`)
    if (receipt.status !== 'success') throw new Error(`${label} reverted on chain`)
    return receipt
  }

  /** Advance past a target block: mine on the development chain, poll on a live one. */
  const advancePastBlock = async (target: bigint) => {
    if (IS_DEV) {
      const now = await publicClient.getBlockNumber()
      if (now <= target) {
        await publicClient.request({
          method: 'anvil_mine' as any,
          params: [viem.toHex(target - now + 1n) as any],
        })
      }
      return
    }
    for (;;) {
      const now = await publicClient.getBlockNumber()
      if (now > target) return
      console.log(`  waiting for block > ${target} (now ${now}, ${target - now + 1n} to go)`)
      await new Promise((resolve) => setTimeout(resolve, 30_000))
    }
  }

  // --- Account layout: validators 1..V, duel players V+1..V+2, raffle players V+3..V+5 ---
  const validatorAccounts = Array.from({ length: VALIDATOR_COUNT }, (_v, i) =>
    mnemonicToAccount(mnemonic, { addressIndex: i + 1 }),
  )
  const heads = mnemonicToAccount(mnemonic, { addressIndex: VALIDATOR_COUNT + 1 })
  const tails = mnemonicToAccount(mnemonic, { addressIndex: VALIDATOR_COUNT + 2 })
  const rafflePlayers = [3, 4, 5].map((offset) =>
    mnemonicToAccount(mnemonic, { addressIndex: VALIDATOR_COUNT + offset }),
  )
  const subset = validatorAccounts.map((v) => v.address)

  const balance = await publicClient.getBalance({ address: account.address })
  console.log(`--- games platform parity gate (chain ${CHAIN_ID}) ---`)
  console.log(`rpc             : ${rpc}`)
  console.log(`account 0       : ${account.address} (deployer + funder + caster)`)
  console.log(`balance (acct0) : ${coins(balance)}`)
  console.log(`stake           : ${coins(STAKE)} per player; fund/player ${coins(fundPerPlayer)}`)
  console.log(`validators      : ${subset.join(', ')}`)
  console.log('')

  // --- Resolve core Random ---------------------------------------------------------------
  let random = (env.RANDOM_ADDRESS as viem.Hex | undefined) ?? (knownRandom as Record<number, viem.Hex | undefined>)[CHAIN_ID]
  if (!random) {
    if (!IS_DEV && env.DEPLOY_RANDOM !== 'true')
      throw new Error(`no core Random address for chain ${CHAIN_ID}; supply RANDOM_ADDRESS or DEPLOY_RANDOM=true`)
    console.log(`[deploy] ${IS_DEV ? 'development chain' : 'first-time chain bring-up'}: deploying a fresh core Random`)
    const hash = await wallet.deployContract({
      abi: RandomArtifact.abi as viem.Abi,
      bytecode: RandomArtifact.bytecode as viem.Hex,
      args: [],
      ...fees,
    })
    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error('Random deploy reverted')
    random = receipt.contractAddress
    console.log(`  Random at ${random}`)
  }

  // --- DRY_RUN: simulate the deploys and the first ink, then stop -------------------------
  if (DRY_RUN) {
    console.log('[dry-run] simulating CoinFlip + Raffle deploys and one validator ink...')
    for (const [name, bytecode, abi] of [
      ['CoinFlip', coinFlipBytecode, coinFlipAbi],
      ['Raffle', raffleBytecode, raffleAbi],
    ] as const) {
      await publicClient.call({
        account: account.address,
        data: viem.encodeDeployData({ abi, bytecode, args: [random] }),
        ...fees,
      })
      console.log(`  ${name} constructor simulation OK`)
    }
    const probe = makeSecret('dry-run-probe', RUN_SALT)
    const section: Info = {
      provider: validatorAccounts[0]!.address,
      callAtChange: false,
      durationIsTimestamp: false,
      duration: 12n,
      token: viem.zeroAddress,
      price: 0n,
      offset: 0n,
      index: 0n,
    }
    await publicClient.simulateContract({
      address: random,
      abi: randomAbi,
      functionName: 'ink',
      args: [section, probe.preimage],
      account,
      value: 0n,
      ...fees,
    })
    console.log('  ink simulation OK')
    console.log('\nDRY_RUN=true -> nothing was broadcast. Re-run without DRY_RUN for the live gate.')
    return
  }

  // --- Deploy or reuse the games -----------------------------------------------------------
  const cached = IS_DEV ? {} : loadCache()[String(CHAIN_ID)] ?? {}
  const deployGame = async (name: string, reuse: viem.Hex | undefined, abi: viem.Abi, bytecode: viem.Hex) => {
    if (reuse) {
      console.log(`[deploy] reusing ${name} at ${reuse}`)
      return reuse
    }
    console.log(`[deploy] deploying ${name}(random)`)
    const hash = await wallet.deployContract({ abi, bytecode, args: [random], ...fees })
    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error(`${name} deploy reverted`)
    console.log(`  ${name} at ${receipt.contractAddress} (block ${receipt.blockNumber})`)
    return receipt.contractAddress
  }
  const coinFlipAddr = await deployGame(
    'CoinFlip',
    (env.COINFLIP as viem.Hex | undefined) ?? cached.coinFlip,
    coinFlipAbi,
    coinFlipBytecode,
  )
  const raffleAddr = await deployGame(
    'Raffle',
    (env.RAFFLE as viem.Hex | undefined) ?? cached.raffle,
    raffleAbi,
    raffleBytecode,
  )
  saveCache({ coinFlip: coinFlipAddr, raffle: raffleAddr })
  console.log('')

  // --- Allowlist the validators on both games (idempotent: addValidator no-ops if present) --
  console.log('[allowlist] adding validators to both games')
  for (const game of [coinFlipAddr, raffleAddr]) {
    for (const v of subset) {
      const already = (await publicClient.readContract({
        address: game,
        abi: raffleAbi,
        functionName: 'isValidator',
        args: [v],
      })) as boolean
      if (already) continue
      await send(`addValidator ${v.slice(0, 10)}`, wallet, game, raffleAbi, 'addValidator', [v])
    }
  }
  console.log('')

  // --- Ink two fresh price-0 preimages per validator (account 0 pays; provider = validator) --
  // Random.ink records the pool under info.provider, so the validators need no gas of their
  // own. A preimage is one-shot — once heated and cast it cannot ignite again — so the run
  // needs one per game: pool index 0 feeds the duel, index 1 feeds the raffle. The Ink event
  // returns the pool's start offset (high 128 bits) — load-bearing on a reused chain, where a
  // validator's Nth ink lands at a nonzero offset.
  console.log('[ink] inking two preimages per validator (duel + raffle)')
  const poolOffsetByProvider: Record<string, bigint> = {}
  const secretsByProvider: Record<string, [viem.Hex, viem.Hex]> = {}
  for (const [i, v] of validatorAccounts.entries()) {
    const duelSecret = makeSecret(`validator-${i}-duel-${v.address}`, RUN_SALT)
    const raffleSecret = makeSecret(`validator-${i}-raffle-${v.address}`, RUN_SALT)
    const section: Info = {
      provider: v.address,
      callAtChange: false,
      durationIsTimestamp: false,
      duration: 12n,
      token: viem.zeroAddress,
      price: 0n,
      offset: 0n,
      index: 0n,
    }
    const receipt = await send(
      `ink validator ${i}`,
      wallet,
      random,
      randomAbi,
      'ink',
      [section, viem.concatHex([duelSecret.preimage, raffleSecret.preimage])],
    )
    const inkArgs = viem.parseEventLogs({ abi: randomAbi, eventName: 'Ink', logs: receipt.logs })[0]?.args as
      | { offset?: bigint }
      | undefined
    const poolOffset = inkArgs?.offset !== undefined ? BigInt.asUintN(128, inkArgs.offset >> 128n) : 0n
    poolOffsetByProvider[v.address.toLowerCase()] = poolOffset
    secretsByProvider[v.address.toLowerCase()] = [duelSecret.secret, raffleSecret.secret]
  }
  const locationsAt = (index: bigint): Info[] =>
    buildHeatLocations(subset, poolOffsetByProvider).map((l) => ({ ...l, index }))
  const duelLocations = locationsAt(0n)
  const raffleLocations = locationsAt(1n)
  const duelSecrets = subset.map((v) => secretsByProvider[v.toLowerCase()]![0])
  const raffleSecrets = subset.map((v) => secretsByProvider[v.toLowerCase()]![1])
  console.log('')

  // --- Fund the player wallets from account 0 ----------------------------------------------
  console.log('[fund] topping up player wallets')
  for (const [label, player] of [
    ['heads', heads],
    ['tails', tails],
    ['raffle 0', rafflePlayers[0]!],
    ['raffle 1', rafflePlayers[1]!],
    ['raffle 2', rafflePlayers[2]!],
  ] as const) {
    const have = await publicClient.getBalance({ address: player.address })
    if (have >= fundPerPlayer) {
      console.log(`  ${label} already holds ${coins(have)}`)
      continue
    }
    const top = fundPerPlayer - have
    const hash = await wallet.sendTransaction({ to: player.address, value: top, ...fees })
    await publicClient.waitForTransactionReceipt({ hash })
    console.log(`  ${label} <- ${coins(top)}`)
  }
  console.log('')

  // === The duel =============================================================================
  console.log('[duel] heads enters (queues)')
  await send('enter-heads', walletFor(heads), coinFlipAddr, coinFlipAbi, 'enterAndMatch', [0, subset, []], STAKE, ENTER_HEADS_GAS)
  console.log('[duel] tails enters (pairs + heats the subset)')
  const matchReceipt = await send(
    'enter-tails',
    walletFor(tails),
    coinFlipAddr,
    coinFlipAbi,
    'enterAndMatch',
    [1, subset, duelLocations],
    STAKE,
    ENTER_TAILS_GAS,
  )
  const heated = viem.parseEventLogs({ abi: coinFlipAbi, eventName: 'Heated', logs: matchReceipt.logs })[0]
    ?.args as { key?: viem.Hex } | undefined
  if (!heated?.key) throw new Error('no Heated event — pairing failed')

  console.log('[duel] casting the validator secrets (within the 12-block window)')
  const duelCastReceipt = await send('cast', wallet, random, randomAbi, 'cast', [heated.key, duelLocations, duelSecrets])
  const settled = viem.parseEventLogs({ abi: coinFlipAbi, eventName: 'Settled', logs: duelCastReceipt.logs })[0]
    ?.args as { winner?: viem.Hex; seed?: viem.Hex } | undefined
  if (!settled?.winner || !settled.seed) throw new Error('no Settled event in the cast receipt')

  const duelOffChain = coinflip.settle(
    { stake: STAKE, validatorSubset: subset },
    [
      { player: heads.address, side: 'heads' },
      { player: tails.address, side: 'tails' },
    ],
    settled.seed,
  )
  console.log(`  seed      : ${settled.seed}`)
  console.log(`  off-chain : ${duelOffChain.winner} (${duelOffChain.winningSide})`)
  console.log(`  on-chain  : ${settled.winner}`)
  if (!viem.isAddressEqual(duelOffChain.winner, settled.winner)) throw new Error('DUEL PARITY MISMATCH')
  console.log('  DUEL PARITY OK')
  console.log('')

  // === The raffle ===========================================================================
  console.log('[raffle] three players commit hidden guesses')
  const guesses = rafflePlayers.map(() => 1n + randomBigint(256n))
  const salts = rafflePlayers.map((_p, i) => viem.keccak256(viem.toHex(`raffle-salt-${i}-${RUN_SALT}`)))
  const commitmentFor = (guess: bigint, salt: viem.Hex, player: viem.Hex): viem.Hex =>
    viem.keccak256(
      viem.encodeAbiParameters([{ type: 'uint256' }, { type: 'bytes32' }, { type: 'address' }], [guess, salt, player]),
    )
  const ticketIds: bigint[] = []
  const committedAtBlocks: bigint[] = []
  let roundId: viem.Hex | undefined
  for (const [i, player] of rafflePlayers.entries()) {
    const receipt = await send(
      `commit ${i}`,
      walletFor(player),
      raffleAddr,
      raffleAbi,
      'commit',
      [STAKE, 3n, RAFFLE_PERIOD, subset, commitmentFor(guesses[i]!, salts[i]!, player.address)],
      STAKE,
      COMMIT_GAS,
    )
    const committed = viem.parseEventLogs({ abi: raffleAbi, eventName: 'Committed', logs: receipt.logs })[0]
      ?.args as { ticketId?: bigint; roundId?: viem.Hex } | undefined
    if (committed?.ticketId === undefined || !committed.roundId) throw new Error('no Committed event')
    ticketIds.push(committed.ticketId)
    committedAtBlocks.push(receipt.blockNumber)
    roundId = committed.roundId
  }

  console.log('[raffle] arming (heats the subset) and casting')
  const createdRound = (await publicClient.readContract({
    address: raffleAddr,
    abi: raffleAbi,
    functionName: 'rounds',
    args: [roundId!],
  })) as any[]
  await advancePastBlock((createdRound[4] as bigint) + RAFFLE_PERIOD - 1n) // period must elapse before arm
  const armReceipt = await send('arm', wallet, raffleAddr, raffleAbi, 'arm', [roundId!, raffleLocations])
  const armed = viem.parseEventLogs({ abi: raffleAbi, eventName: 'Armed', logs: armReceipt.logs })[0]?.args as
    | { key?: viem.Hex }
    | undefined
  if (!armed?.key) throw new Error('no Armed event')
  const raffleCastReceipt = await send('cast', wallet, random, randomAbi, 'cast', [armed.key, raffleLocations, raffleSecrets])
  const drawn = viem.parseEventLogs({ abi: raffleAbi, eventName: 'Drawn', logs: raffleCastReceipt.logs })[0]
    ?.args as { draw?: bigint; claimDeadline?: bigint } | undefined
  if (drawn?.draw === undefined || drawn.claimDeadline === undefined) throw new Error('no Drawn event')
  const seed = (await publicClient.readContract({
    address: random,
    abi: randomAbi,
    functionName: 'randomness',
    args: [armed.key],
  })) as { seed: viem.Hex }
  if (raffleDraw(seed.seed) !== drawn.draw) throw new Error('seed/draw mismatch — wrong key?')

  console.log('[raffle] all three reveal')
  for (const [i, player] of rafflePlayers.entries()) {
    await send(
      `reveal ${i}`,
      walletFor(player),
      raffleAddr,
      raffleAbi,
      'reveal',
      [ticketIds[i]!, guesses[i]!, salts[i]!],
      0n,
      REVEAL_GAS,
    )
  }

  const entries = rafflePlayers.map((player, i) => ({
    ticketId: ticketIds[i]!,
    player: player.address as viem.Hex,
    guess: guesses[i]!,
    committedAtBlock: committedAtBlocks[i]!,
    revealed: true,
  }))
  const raffleOffChain = raffle.settle(
    { stake: STAKE, threshold: 3n, period: RAFFLE_PERIOD, validatorSubset: subset },
    entries,
    seed.seed,
  )
  const roundAfterReveals = (await publicClient.readContract({
    address: raffleAddr,
    abi: raffleAbi,
    functionName: 'rounds',
    args: [roundId!],
  })) as any[]
  const onChainBestTicket = roundAfterReveals[12] as bigint
  console.log(`  draw      : ${drawn.draw}`)
  console.log(`  off-chain : ticket ${raffleOffChain?.ticketId} (${raffleOffChain?.player})`)
  console.log(`  on-chain  : ticket ${onChainBestTicket}`)
  if (raffleOffChain?.ticketId !== onChainBestTicket) throw new Error('RAFFLE PARITY MISMATCH')
  console.log('  RAFFLE PARITY OK')

  // --- Finalise (the payout) — needs the 100-block claim window to lapse -------------------
  let finaliseNote = ''
  if (SKIP_FINALISE) {
    finaliseNote = `finalise skipped; after block ${drawn.claimDeadline} anyone may call Raffle.finalise(${roundId})`
    console.log(`[raffle] ${finaliseNote}`)
  } else {
    console.log(`[raffle] waiting out the claim window (deadline block ${drawn.claimDeadline})`)
    await advancePastBlock(drawn.claimDeadline)
    const finaliseReceipt = await send('finalise', wallet, raffleAddr, raffleAbi, 'finalise', [roundId!])
    const finalised = viem.parseEventLogs({ abi: raffleAbi, eventName: 'Finalised', logs: finaliseReceipt.logs })[0]
      ?.args as { winner?: viem.Hex; payout?: bigint } | undefined
    if (!finalised?.winner) throw new Error('no Finalised event')
    if (!viem.isAddressEqual(finalised.winner, raffleOffChain!.player)) throw new Error('FINALISE PARITY MISMATCH')
    finaliseNote = `finalised, payout ${coins(finalised.payout ?? 0n)} to ${finalised.winner}`
    console.log(`  ${finaliseNote}`)
  }
  console.log('')

  // --- Run log ------------------------------------------------------------------------------
  const logEntry = [
    `### Run ${new Date().toISOString().slice(0, 10)} (chain ${CHAIN_ID})`,
    '',
    `- Random: \`${random}\``,
    `- CoinFlip: \`${coinFlipAddr}\``,
    `- Raffle: \`${raffleAddr}\``,
    `- Duel: seed \`${settled.seed}\`, winner \`${settled.winner}\` (${duelOffChain.winningSide}) — off-chain == on-chain ✓`,
    `- Raffle: draw ${drawn.draw}, winning ticket ${onChainBestTicket} (\`${raffleOffChain!.player}\`) — off-chain == on-chain ✓; ${finaliseNote}`,
    '',
  ].join('\n')
  console.log('--- run log entry ---')
  console.log(logEntry)
  if (!IS_DEV && env.NO_RUN_LOG !== 'true') {
    const readme = fs.readFileSync(README, 'utf8')
    const marker = '## Run log'
    const placeholder = /\n_No live run recorded yet[^\n]*\n/
    const updated = readme.includes(marker)
      ? readme
          .replace(placeholder, '\n')
          .replace(marker, `${marker}\n\n${logEntry}`)
      : `${readme}\n${marker}\n\n${logEntry}`
    fs.writeFileSync(README, updated)
    console.log(`appended to ${path.relative(process.cwd(), README)}`)
  }
  console.log('ALL PARITY CHECKS PASSED')
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
