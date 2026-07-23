/**
 * Autonomous testnet players for the OFF-CHAIN SESSION games (chain 943).
 *
 * Where player-bots.ts keeps the ON-CHAIN coinflip/raffle tables moving, this driver keeps the
 * off-chain `@msgboard/games` HouseSession tables alive: dice, limbo, plinko, keno, and the
 * stateful mines. The on-chain games already have bots — this one does NOT touch them.
 *
 * Each game runs its own table loop. A table is a `HouseSession` constructed exactly the way the
 * web hook (examples/games/web/src/hooks/useSession.ts) builds one:
 *   - PLAYER signer  : a viem account derived from MNEMONIC (mnemonicToAccount). A viem account
 *                      satisfies the session `Signer` shape (signTypedData + signMessage).
 *   - HOUSE signer   : a fresh ephemeral in-process key per table (privateKeyToAccount). The
 *                      HouseSession is documented as an in-process player↔house driver; a real
 *                      deployment splits the house onto its own machine over the same transport.
 *   - SEED source    : a 32-byte random tip generated locally; buildSeedChain hashes it down and
 *                      the OPEN envelope publishes only the `commit`. Every round's server seed is
 *                      revealed + chain-verified by the session itself (provably fair, in-process).
 *   - DOMAIN         : makeDomain(chainId, verifyingContract). chainId comes from the deployment;
 *                      verifyingContract defaults to the on-chain `random` address from
 *                      943-deployment.json as a stable anchor (no on-chain settle yet — see notes).
 *
 * NOTE on seeds/RPC: the current HouseSession is fully in-process and does NOT pull on-chain
 * validator reveals; the seed chain is built locally. We therefore load the deployment only to pin
 * the EIP-712 domain (chainId + verifyingContract) on the same 943 config the other bots use via
 * actor-common. If/when the session pulls on-chain reveals, the RPC wiring in actor-common drops in
 * unchanged. No 943 RPC round-trips are made by this driver today.
 *
 * Hi-Lo War IS covered here too, as a separate paired-client driver (it is a TWO-peer ZK-card
 * session — @msgboard/hilo-war needs a MaskedDeckProvider + a paired counterpart client over a transport,
 * not a single-process HouseSession). Both peers are in-process random-strategy bots over a
 * `LocalTransport.pair()` sharing one `AttestedElGamalDeck` (exactly the session test's setup); the
 * randomness is the masked-deck double shuffle, not an entropy beacon. duel.ts covers on-chain
 * coinflip parity, NOT hilo-war, so nothing is duplicated either way.
 *
 * Pacing: before signing each turn the bot sleeps a randomized human-like "think" delay
 * (~0.3–3s). Because the session stamps offeredAt/signedAt around that sleep and
 * broadcastAt/confirmedAt around the (near-instant, in-process) co-sign, decisionMs comes out
 * dominated by the think delay and networkMs by the local round-trip — a non-trivial decomposition.
 * Randomness is drawn from node crypto (NOT Math.random) so it is genuinely varied per turn.
 *
 * Env (mirrors actor-common conventions):
 *   MNEMONIC     required — the player signer is addressIndex SESSION_BOT_INDEX (default 30, clear
 *                of validators 1-3, gate players 4-8, and player-bots 11/20+).
 *   CHAIN        default 943 — selects the deployment loaded for the domain.
 *   CONFIG       optional explicit deployment path (else <CHAIN>-deployment.json next to this file).
 *   RPC          accepted for parity with the other bots; unused today (in-process seeds).
 *   GAMES        comma list to restrict which games run (default: dice,limbo,plinko,keno,mines,hilo).
 *   HILO_ANTE / HILO_ESCROW  hilo-war ante / per-peer escrow (ether, default 0.01 / 1).
 *   HILO_FLIPS   flips before a hilo table cooperatively settles + reopens (default 32).
 *   CHAIN_LENGTH default 256 — rounds the committed seed chain affords before a table reopens.
 *   THINK_MIN_MS / THINK_MAX_MS  default 300 / 3000 — the randomized per-turn think window.
 *   ROUND_GAP_MS default 1500 — extra idle gap between rounds on a table (jittered 0.5x..1.5x).
 *   START_BALANCE / HOUSE_BALANCE  opening chip balances (ether units, default 100 / 100000).
 *   ONCE=true    play a single round on each table then exit (smoke check).
 */
import { Worker } from 'node:worker_threads'
import * as viem from 'viem'
import { mnemonicToAccount, privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import {
  HouseSession,
  makeDomain,
  createMsgBoardClient,
  post,
  type StampInput,
  type Stamp,
  decisionMs,
  networkMs,
  totalMs,
  dice,
  limbo,
  plinko,
  keno,
  start as minesStart,
  reveal as minesReveal,
  cashOut as minesCashOut,
  hashBoard as minesHashBoard,
  hashGameState as minesHashGameState,
  playerDelta as minesPlayerDelta,
  multiplierX100At as minesMultiplierX100At,
  MinesPhase,
  type Game,
  type Signer,
  type MinesBoard,
  type MinesConfig,
} from '@msgboard/games'
import {
  AttestedElGamalDeck,
  LocalTransport,
  makeDomain as makeZkDomain,
  TEST_DOMAIN as ZK_TEST_DOMAIN,
} from '@msgboard/zk-cards-core'
import {
  Player as HiLoPlayer,
  openSession as openHiLoSession,
  Phase as HiLoPhase,
  decisionMs as hiloDecisionMs,
  networkMs as hiloNetworkMs,
  totalMs as hiloTotalMs,
  type Bet as HiLoBet,
  type FlipChoices as HiLoFlipChoices,
  type WalletSigner as HiLoWalletSigner,
} from '@msgboard/hilo-war'
import { loadDeployment } from './actor-common'

const env = process.env
const CHAIN = env.CHAIN ? Number(env.CHAIN) : 943
const SESSION_BOT_INDEX = env.SESSION_BOT_INDEX ? Number(env.SESSION_BOT_INDEX) : 30
const CHAIN_LENGTH = env.CHAIN_LENGTH ? Number(env.CHAIN_LENGTH) : 256
const THINK_MIN_MS = env.THINK_MIN_MS ? Number(env.THINK_MIN_MS) : 300
const THINK_MAX_MS = env.THINK_MAX_MS ? Number(env.THINK_MAX_MS) : 3000
const ROUND_GAP_MS = env.ROUND_GAP_MS ? Number(env.ROUND_GAP_MS) : 1500
const START_BALANCE = viem.parseEther(env.START_BALANCE || '100')
const HOUSE_BALANCE = viem.parseEther(env.HOUSE_BALANCE || '100000')
const STAKE = viem.parseEther(env.STAKE || '1')
const HILO_ANTE = viem.parseEther(env.HILO_ANTE || '0.01')
const HILO_ESCROW = viem.parseEther(env.HILO_ESCROW || '1')
const HILO_FLIPS = env.HILO_FLIPS ? Number(env.HILO_FLIPS) : 32

const ALL_GAMES = ['dice', 'limbo', 'plinko', 'keno', 'mines', 'hilo'] as const
type GameName = (typeof ALL_GAMES)[number]
const SELECTED: GameName[] = (env.GAMES ? env.GAMES.split(',').map((s) => s.trim()) : [...ALL_GAMES]).filter(
  (g): g is GameName => (ALL_GAMES as readonly string[]).includes(g),
)

let running = true

// ---- randomness / pacing -----------------------------------------------------------------------
// crypto-derived varied delays (NOT Math.random, per the task) — uniform in [min, max].
const randUint = (): number => crypto.getRandomValues(new Uint32Array(1))[0]! / 0x1_0000_0000
const thinkDelay = (): number => Math.round(THINK_MIN_MS + randUint() * (THINK_MAX_MS - THINK_MIN_MS))
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)))
/** sleepable cancel-aware wait that resolves early on shutdown. */
const idle = async (ms: number) => {
  const end = Date.now() + ms
  while (running && Date.now() < end) await sleep(Math.min(100, end - Date.now()))
}
const randBytes32 = (): viem.Hex => viem.bytesToHex(crypto.getRandomValues(new Uint8Array(32)))
const randInt = (n: number): number => Math.floor(randUint() * n)
const pick = <T,>(xs: readonly T[]): T => xs[randInt(xs.length)]!

// ---- per-game param generators ------------------------------------------------------------------
// Sane, bounded params so a table doesn't drain the house or hit a module range error.
const diceParams = () => ({ targetX100: BigInt(2000 + randInt(6000)) }) // roll-under 20%..80%
const limboParams = () => ({ targetX100: BigInt(150 + randInt(850)) }) // 1.50x..10.00x target
const plinkoParams = () => ({ rows: 16, risk: pick(['low', 'medium', 'high'] as const) })
const kenoParams = () => {
  const count = 1 + randInt(10) // 1..10 distinct picks of 1..40
  const picks = new Set<number>()
  while (picks.size < count) picks.add(1 + randInt(40))
  return { picks: [...picks] }
}

// ---- signer construction (mirrors useSession.ts) ------------------------------------------------
const playerSigner = mnemonicToAccount(env.MNEMONIC ?? 'test test test test test test test test test test test junk', {
  addressIndex: SESSION_BOT_INDEX,
}) as unknown as Signer
const newHouse = (): Signer => privateKeyToAccount(generatePrivateKey()) as unknown as Signer

const newTableId = (label: string): viem.Hex =>
  viem.keccak256(viem.stringToHex(`mbg:${label}:${Date.now()}:${randInt(1_000_000)}`))

const fmt = (wei: bigint) => viem.formatEther(wei)

// ---- real MsgBoard broadcast (testnet-visible lifecycle notices) --------------------------------
// Posting requires proof-of-work (~30s/msg on the 943 board), so we DON'T post per round — we post a
// compact notice when a table OPENS and a SUMMARY when it closes. Broadcasts are SERIALIZED through a
// single queue so the N concurrent games don't peg N cores grinding PoW at once, and best-effort (a
// post failure never interrupts play). Enabled when a board RPC resolves: BOARD_RPC, or a valve.city
// endpoint built from VALVE_RPC_KEY (the deploy passes one); absent both, bots run in-process only.
const BOARD_RPC =
  env.BOARD_RPC || (env.VALVE_RPC_KEY ? `https://one.valve.city/rpc/${env.VALVE_RPC_KEY}/evm/${CHAIN}` : '')
const board = BOARD_RPC ? createMsgBoardClient(BOARD_RPC) : null
// All lifecycle notices go to ONE shared, discoverable category so a viewer (the web app, the archive,
// anyone) can poll a single category to watch every table on the chain; the per-table id rides in the
// body. The proof-of-work STAMP (the slow part) is minted in a worker_threads grinder (native Rust
// @msgboard/pow-grinder, ~0.7s) so it never starves the game loops on this thread — the worker gets only
// encoded bytes, never a key. The thin RPC bits (read difficulty + head, then submit) run here via
// `post`. One post in flight at a time; notices arriving mid-stamp are dropped (drop-if-busy) — the
// games turn over faster than a post, and the board is a live signal, not a log.
const LOBBY_CATEGORY = `games.msgboard.xyz:lobby:${CHAIN}`
const STAMP_MAX_ITERS = 50_000_000 // ample for the 943 floor (~190k iters); native finds it in ~0.7s

let powWorker: Worker | null = null
let posting = false
let jobSeq = 0
const stampJobs = new Map<number, { resolve: (s: Stamp) => void; reject: (e: Error) => void }>()
if (board) {
  const isTs = import.meta.url.endsWith('.ts')
  powWorker = new Worker(
    new URL(isTs ? './pow-worker.ts' : './pow-worker.mjs', import.meta.url),
    isTs ? { execArgv: ['--import', 'tsx'] } : undefined,
  )
  powWorker.on('message', (reply: { id: number; nonce?: string; hash?: string; error?: string }) => {
    const job = stampJobs.get(reply.id)
    if (!job) return
    stampJobs.delete(reply.id)
    if (reply.error || !reply.nonce || !reply.hash) job.reject(new Error(reply.error ?? 'stamp failed'))
    else job.resolve({ nonce: BigInt(reply.nonce), hash: reply.hash as viem.Hex })
  })
  powWorker.on('error', (e) => {
    for (const job of stampJobs.values()) job.reject(e)
    stampJobs.clear()
  })
  powWorker.unref() // don't keep the process alive solely for the grinder
  console.log(`[board] live feed → ${LOBBY_CATEGORY} via ${BOARD_RPC.replace(/\/rpc\/[^/]+\//, '/rpc/<key>/')} [native stamp worker]`)
}

/** Mint the PoW stamp in the worker (off the main loop). Pure compute — no key crosses over. */
const stamper = (input: StampInput): Promise<Stamp> =>
  new Promise<Stamp>((resolve, reject) => {
    if (!powWorker) return reject(new Error('no grinder'))
    const id = ++jobSeq
    stampJobs.set(id, { resolve, reject })
    powWorker.postMessage({
      id,
      category: input.category,
      data: input.data,
      wm: Number(input.workMultiplier),
      wd: Number(input.workDivisor),
      blockHash: input.blockHash,
      maxIters: STAMP_MAX_ITERS,
    })
  })

let inFlight: Promise<void> = Promise.resolve()
const broadcast = (tableId: viem.Hex, msg: Record<string, unknown>): void => {
  if (!board || !powWorker || posting) return
  posting = true
  const started = Date.now()
  console.log(`[board] stamping ${msg.kind}/${msg.game}…`)
  inFlight = post({ board, category: LOBBY_CATEGORY, notice: { v: 1, tableId, at: started, ...msg }, stamp: stamper })
    .then((hash) => console.log(`[board] posted ${msg.kind}/${msg.game} in ${Date.now() - started}ms ${String(hash).slice(0, 12)}…`))
    .catch((e: unknown) => console.log(`[board] post failed (${msg.kind}/${msg.game}) after ${Date.now() - started}ms: ${(e as Error).message?.split('\n')[0]}`))
    .finally(() => {
      posting = false
    })
}

// ---------------------------------------------------------------------------------------------
// single-draw games (dice / limbo / plinko / keno): one HouseSession.playRound per turn.
// ---------------------------------------------------------------------------------------------
const runDrawTable = async <TParams>(
  name: GameName,
  game: Game<TParams>,
  domain: ReturnType<typeof makeDomain>,
  genParams: () => TParams,
) => {
  // Controllable clock: the session captures offeredAt as the FIRST now() of a round, then signedAt
  // after co-sign. We sleep the think delay BEFORE the round, so to make that show up as decisionMs
  // we backdate ONLY that first read by the think duration via a one-shot offset. The remaining
  // marks (signedAt/broadcastAt/confirmedAt) read true wall-clock, so signedAt-offeredAt ≈ think
  // and confirmedAt-broadcastAt stays the real in-process co-sign latency.
  let pendingThinkMs = 0
  const clock = () => {
    const t = Date.now() - pendingThinkMs
    pendingThinkMs = 0 // one-shot: only the offeredAt read is backdated
    return t
  }
  while (running) {
    const tableId = newTableId(name)
    const session = new HouseSession<TParams>({
      domain,
      tableId,
      game,
      player: playerSigner,
      house: newHouse(),
      seedTip: randBytes32(),
      chainLength: CHAIN_LENGTH,
      openBalances: { player: START_BALANCE, house: HOUSE_BALANCE },
      settlementMode: 0,
      clock,
    })
    await session.open()
    console.log(`[${name}] table open commit=${session.chain.commit.slice(0, 10)} player=${fmt(session.state.balancePlayer)}`)
    broadcast(tableId, { kind: 'open', game: name, commit: session.chain.commit, player: (playerSigner as { address: viem.Hex }).address })

    let round = 0
    while (running && Number(session.state.nonce) < CHAIN_LENGTH - 1) {
      // think before signing — this is the decision delay the timing decomposition measures.
      const think = thinkDelay()
      await idle(think)
      if (!running) break
      pendingThinkMs = think // backdate this round's offeredAt so decisionMs ≈ think
      const before = session.state.balancePlayer
      try {
        await session.playRound({ stake: STAKE, params: genParams(), clientSeed: randBytes32() })
      } catch (e) {
        // session throws on balance underflow — reopen a fresh table with topped-up chips.
        console.log(`[${name}] reopening table: ${(e as Error).message?.split('\n')[0]}`)
        break
      }
      round++
      const last = session.transcript.entries.at(-1)
      const body = last?.body as { outcome?: { win: boolean; playerDelta: string; multiplierX100: string } } | undefined
      const delta = session.state.balancePlayer - before
      const dMs = decisionMs(last?.timing)
      const nMs = networkMs(last?.timing)
      const tMs = totalMs(last?.timing)
      console.log(
        `[${name}] round ${round} stake=${fmt(STAKE)} ` +
          `${body?.outcome?.win ? 'WIN ' : 'lose'} x${(Number(body?.outcome?.multiplierX100 ?? 0n) / 100).toFixed(2)} ` +
          `delta=${delta >= 0n ? '+' : ''}${fmt(delta)} bal=${fmt(session.state.balancePlayer)} ` +
          `decision=${dMs ?? '?'}ms network=${nMs ?? '?'}ms total=${tMs ?? '?'}ms`,
      )
      if (env.ONCE === 'true') return
      await idle(ROUND_GAP_MS * (0.5 + randUint()))
    }
    broadcast(tableId, { kind: 'summary', game: name, rounds: round, balance: fmt(session.state.balancePlayer) })
    if (env.ONCE === 'true') return
  }
}

// ---------------------------------------------------------------------------------------------
// MINES (stateful): start a board → reveal several safe tiles → cash out (randomized stop).
// Mines is NOT a single-draw `Game<TParams>`; it uses its own pure transitions. We drive it
// here directly (the HouseSession class only knows single-draw games), reusing the same
// player/house signers + a per-board committed layout, and report decision timing per move.
// Each tile reveal and the cash-out gets its own randomized think delay (multi-step turns).
// ---------------------------------------------------------------------------------------------
const randomMinesBoard = (config: MinesConfig): MinesBoard => {
  const mineTiles = new Set<number>()
  while (mineTiles.size < config.mines) mineTiles.add(randInt(config.tiles))
  return { config, mineTiles: [...mineTiles].sort((a, b) => a - b), salt: randBytes32() }
}

const runMinesTable = async () => {
  const config: MinesConfig = { tiles: 25, mines: 3 } // 5x5, 3 mines — common safe default
  let session = 0
  while (running) {
    session++
    const tableId = newTableId('mines')
    const layout = randomMinesBoard(config)
    const commit = minesHashBoard(layout)
    let state = minesStart(config, commit)
    broadcast(tableId, { kind: 'open', game: 'mines', commit, mines: config.mines, tiles: config.tiles })
    const safe = config.tiles - config.mines
    // randomized stop: aim to reveal somewhere in [1, safe-1] tiles before cashing out.
    const target = 1 + randInt(Math.max(1, Math.min(safe - 1, 6)))
    const order = Array.from({ length: config.tiles }, (_v, i) => i).sort(() => randUint() - 0.5)
    let reveals = 0
    let busted = false
    const t0 = Date.now()
    let decisionTotal = 0
    for (const tile of order) {
      if (!running) break
      if (reveals >= target) break
      const d = thinkDelay()
      await idle(d) // think before each reveal
      if (!running) break
      decisionTotal += d
      const res = minesReveal(state, tile, layout.mineTiles.includes(tile))
      if ('error' in res) continue // tile already revealed (shouldn't happen with shuffled order)
      state = res.state
      reveals++
      if (state.phase === MinesPhase.BUSTED) {
        busted = true
        break
      }
    }
    if (!running) break
    let multX100 = 0n
    if (!busted && state.phase === MinesPhase.PLAYING && reveals > 0) {
      const d = thinkDelay()
      await idle(d)
      decisionTotal += d
      const res = minesCashOut(state)
      if (!('error' in res)) {
        state = res.state
        multX100 = minesMultiplierX100At(config, reveals)
      }
    }
    // the running state is the co-signed game-state hash preimage (each step would be co-signed
    // in a real session; here we settle the terminal delta against the stake).
    const stateHash = minesHashGameState(state)
    const delta = minesPlayerDelta(state, STAKE)
    console.log(
      `[mines] session ${session} reveals=${reveals}/${safe} ` +
        `${busted ? 'BUST' : 'cashout'} x${(Number(multX100) / 100).toFixed(2)} ` +
        `delta=${delta >= 0n ? '+' : ''}${fmt(delta)} ` +
        `decision=${decisionTotal}ms total=${Date.now() - t0}ms hash=${stateHash.slice(0, 10)}`,
    )
    broadcast(tableId, { kind: 'summary', game: 'mines', reveals, busted, multiplierX100: multX100.toString(), delta: fmt(delta) })
    if (env.ONCE === 'true') return
    await idle(ROUND_GAP_MS * (0.5 + randUint()))
  }
}

// ---------------------------------------------------------------------------------------------
// HI-LO WAR (two-peer ZK-masked-deck session): NOT a HouseSession. Two in-process random-strategy
// bot Players over a LocalTransport.pair() sharing one AttestedElGamalDeck (the session test's
// setup). openSession co-signs genesis (the shuffled-deck commitment IS the randomness), then a
// continuous loop of SIMULTANEOUS random playFlips (Promise.all, as both sides must call together).
// The table cooperatively settles + reopens after HILO_FLIPS or when either peer's escrow runs low.
// Pacing mirrors the draw tables: a randomized think delay before each flip, backdated into Player
// A's offeredAt via a one-shot clock offset so decisionMs ≈ think and networkMs stays the in-process
// co-sign latency (a non-trivial decomposition).
// ---------------------------------------------------------------------------------------------
const randBet = (): HiLoBet => (coinFlip() ? 'RAISE' : 'HOLD')
const coinFlip = (): boolean => randUint() < 0.5
const randFlipChoices = (): HiLoFlipChoices => ({ bet: randBet(), onRaise: coinFlip() ? 'CALL' : 'FOLD' })

const runHiLoTable = async (domain: ReturnType<typeof makeZkDomain>) => {
  // one-shot backdating clock for Player A: the next now() read is pushed back by the think delay so
  // the flip's offeredAt lands ~think ago, surfacing the think window as decisionMs.
  let pendingThinkMs = 0
  const clockA = () => {
    const t = Date.now() - pendingThinkMs
    pendingThinkMs = 0
    return t
  }
  let table = 0
  while (running) {
    table++
    const [ta, tb] = LocalTransport.pair()
    const deck = new AttestedElGamalDeck()
    // both peers are in-process bots — ephemeral keys, random strategy.
    const wa = privateKeyToAccount(generatePrivateKey()) as unknown as HiLoWalletSigner
    const wb = privateKeyToAccount(generatePrivateKey()) as unknown as HiLoWalletSigner
    const tableId = newTableId('hilo')
    const a = new HiLoPlayer({ role: 'A', wallet: wa, peer: wb.address, transport: ta, deck, domain, tableId, ante: HILO_ANTE, escrowEach: HILO_ESCROW, clock: clockA })
    const b = new HiLoPlayer({ role: 'B', wallet: wb, peer: wa.address, transport: tb, deck, domain, tableId, ante: HILO_ANTE, escrowEach: HILO_ESCROW })

    try {
      await openHiLoSession(a, b)
    } catch (e) {
      console.log(`[hilo] open failed, retrying: ${(e as Error).message?.split('\n')[0]}`)
      await idle(ROUND_GAP_MS)
      continue
    }
    const genesis = a.channel.latest!.state
    console.log(`[hilo] table ${table} open deck=${genesis.deckCommitment.slice(0, 10)} escrowEach=${fmt(HILO_ESCROW)}`)
    broadcast(tableId, { kind: 'open', game: 'hilo', deck: genesis.deckCommitment, escrowEach: fmt(HILO_ESCROW) })

    let flips = 0
    while (running && flips < HILO_FLIPS) {
      // either side too low to cover two antes (ante + a possible raise) → settle and reopen.
      const s = a.channel.latest!.state
      if (s.balanceA < 2n * HILO_ANTE || s.balanceB < 2n * HILO_ANTE) break

      const think = thinkDelay()
      await idle(think)
      if (!running) break
      pendingThinkMs = think // backdate A's offeredAt so decisionMs ≈ think
      const balABefore = s.balanceA
      let myCard: number, opponentCard: number | null, winner: string
      try {
        // BOTH peers must call playFlip simultaneously — independent random strategies.
        const [ra] = await Promise.all([a.playFlip(randFlipChoices()), b.playFlip(randFlipChoices())])
        myCard = ra.myCard
        opponentCard = ra.opponentCard
        winner = ra.flip.result ? ra.flip.result.winner : 'tie'
      } catch (e) {
        console.log(`[hilo] flip error, reopening table: ${(e as Error).message?.split('\n')[0]}`)
        break
      }
      flips++
      const after = a.channel.latest!.state
      const delta = after.balanceA - balABefore
      const t = a.timing.get(after.nonce)
      const dMs = hiloDecisionMs(t)
      const nMs = hiloNetworkMs(t)
      const tMs = hiloTotalMs(t)
      console.log(
        `[hilo] flip ${flips} A=${myCard} B=${opponentCard ?? 'hidden'} ${winner === 'tie' ? 'TIE ' : `win=${winner}`} ` +
          `deltaA=${delta >= 0n ? '+' : ''}${fmt(delta)} balA=${fmt(after.balanceA)} balB=${fmt(after.balanceB)} ` +
          `pot=${fmt(after.pot)} decision=${dMs ?? '?'}ms network=${nMs ?? '?'}ms total=${tMs ?? '?'}ms`,
      )
      if (env.ONCE === 'true') {
        // settle once for a clean smoke, then exit.
        const [settled] = await Promise.all([a.requestSettle(), b.acceptSettle()])
        console.log(`[hilo] settled phase=${settled.state.phase === HiLoPhase.SETTLED ? 'SETTLED' : settled.state.phase} balA=${fmt(settled.state.balanceA)} balB=${fmt(settled.state.balanceB)}`)
        return
      }
      await idle(ROUND_GAP_MS * (0.5 + randUint()))
    }
    if (!running) break
    // cooperative settle at the end of a table run (splits any war carry, zeroes the pot).
    try {
      const [settled] = await Promise.all([a.requestSettle(), b.acceptSettle()])
      console.log(`[hilo] table ${table} settled balA=${fmt(settled.state.balanceA)} balB=${fmt(settled.state.balanceB)} after ${flips} flips`)
      broadcast(tableId, { kind: 'summary', game: 'hilo', flips, balA: fmt(settled.state.balanceA), balB: fmt(settled.state.balanceB) })
    } catch (e) {
      console.log(`[hilo] settle failed: ${(e as Error).message?.split('\n')[0]}`)
    }
    if (env.ONCE === 'true') return
    await idle(ROUND_GAP_MS * (0.5 + randUint()))
  }
}

// ---- main -------------------------------------------------------------------------------------
const main = async () => {
  if (!env.MNEMONIC) throw new Error('MNEMONIC required')
  if (SELECTED.length === 0) throw new Error(`GAMES selected none of ${ALL_GAMES.join(',')}`)
  const config = loadDeployment(CHAIN, env.CONFIG)
  // verifyingContract: the on-chain `random` address anchors the EIP-712 domain on this chain.
  const domain = makeDomain(config.chainId, (config.random as viem.Hex) ?? viem.zeroAddress)
  console.log(
    `session bots on chain ${CHAIN}: player=${(playerSigner as { address: viem.Hex }).address} ` +
      `games=[${SELECTED.join(', ')}] stake=${fmt(STAKE)} think=${THINK_MIN_MS}-${THINK_MAX_MS}ms` +
      (env.ONCE === 'true' ? ' (ONCE)' : ''),
  )

  const tables: Promise<void>[] = []
  for (const g of SELECTED) {
    if (g === 'dice') tables.push(runDrawTable('dice', dice, domain, diceParams))
    else if (g === 'limbo') tables.push(runDrawTable('limbo', limbo, domain, limboParams))
    else if (g === 'plinko') tables.push(runDrawTable('plinko', plinko, domain, plinkoParams))
    else if (g === 'keno') tables.push(runDrawTable('keno', keno, domain, kenoParams))
    else if (g === 'mines') tables.push(runMinesTable())
    else if (g === 'hilo') {
      // hilo-war pins its own EIP-712 "ZkTable" domain (not the msgboard-games HouseChannel domain).
      // verifyingContract is a placeholder anchored on the same chainId — no on-chain channel settle
      // is wired yet (the deployed HouseChannel is the real anchor for later).
      const zkDomain = config.chainId
        ? makeZkDomain(config.chainId, (config.random as viem.Hex) ?? viem.zeroAddress)
        : ZK_TEST_DOMAIN
      tables.push(runHiLoTable(zkDomain))
    }
  }
  await Promise.all(tables)
  await inFlight // flush any in-flight lifecycle broadcast (PoW grind) before exit
}

// graceful SIGINT shutdown (mirrors player-bots' clean-exit intent).
const shutdown = () => {
  if (!running) return
  running = false
  console.log('\nshutting down session bots — finishing in-flight turns…')
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e)
    process.exit(1)
  })
