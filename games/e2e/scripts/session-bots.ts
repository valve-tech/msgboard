/**
 * Autonomous testnet players for the OFF-CHAIN SESSION games (chain 943).
 *
 * Where player-bots.ts keeps the ON-CHAIN coinflip/raffle tables moving, this driver keeps EVERY
 * off-chain `@msgboard/games` table alive. The on-chain games already have bots — this one does NOT
 * touch them. Full roster, by how each is driven:
 *   - single-draw Game<TParams> via HouseSession.playRound (runDrawTable):
 *       dice, limbo, plinko, keno, baccarat, dragonTiger, andarBahar, craps, crash, monte, pachinko,
 *       wheel, dicex2, cascade
 *   - stateful mines (its own reveal/cash-out driver): mines
 *   - ladder push-your-luck on the shared ladder engine (runLadderTable):
 *       towers, chicken, firewalk, heist, hilo (the card ladder, HILO_GAME_ID 18), greedDice, cipher
 *   - decision one-shots — pick a random legal decision, settle, broadcast (runDecisionTable):
 *       blackjack, threeCardPoker, videoPoker, paiGow
 *   - direct-settle single-draws that can't ride HouseSession (also runDecisionTable):
 *       roulette (params carry nested bigint bet stakes the transcript can't JSON-serialize),
 *       wordle (a SkillGame — settles from a verified result, has no encodeRound)
 *   - sudoku: a TIMED LEADERBOARD, not a wager — the bot posts a solve entry (runSudokuTable)
 *   - hilo-war: the two-peer ZK-masked-deck duel (runHiLoTable; keyed 'hilo-war', was 'hilo')
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
 *   GAMES        comma list to restrict which games run (default: the FULL roster above). E.g.
 *                GAMES=dice,towers,blackjack,hilo-war. Names match the ALL_GAMES keys; unknown names
 *                are dropped. The two-peer duel is keyed 'hilo-war'; 'hilo' is the ladder card game.
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
  // ---- single-draw Game<TParams> (ride runDrawTable) ----
  dice,
  limbo,
  plinko,
  keno,
  baccarat,
  dragonTiger,
  andarBahar,
  craps,
  crash,
  monte,
  pachinko,
  wheel,
  dicex2,
  cascade,
  // roulette IS a single-draw Game<TParams>, but its params carry nested bigint bet stakes that the
  // session transcript's serializeParams can't JSON-encode — so it can't ride HouseSession. It settles
  // directly via runDecisionTable instead (still recompute-settle over game.settleRound). See below.
  roulette,
  RouletteBetType,
  rouletteWinningPocket,
  // ---- mines (stateful, its own driver) ----
  start as minesStart,
  reveal as minesReveal,
  cashOut as minesCashOut,
  hashBoard as minesHashBoard,
  hashGameState as minesHashGameState,
  playerDelta as minesPlayerDelta,
  multiplierX100At as minesMultiplierX100At,
  MinesPhase,
  // ---- shared ladder engine (drives every ladder game via runLadderTable) ----
  ladderAdvance,
  ladderCashOut,
  ladderPlayerDelta,
  hashLadderState,
  commitLayout,
  LadderPhase,
  type LadderState,
  type StepOutcome,
  // ---- ladder games: start<Name>(config, seed) + <name>ResolveStep(seed, config) ----
  startTowers,
  towersResolveStep,
  startChicken,
  chickenResolveStep,
  startFirewalk,
  firewalkResolveStep,
  startHeist,
  heistResolveStep,
  startHiLo,
  hiloResolveStep,
  startGreedDice,
  greedDiceResolveStep,
  startCipher,
  cipherResolveStep,
  cipherSymbols,
  // ---- decision one-shot games (pick a legal decision → settle fn) ----
  commitBlackjack,
  settleBlackjack,
  blackjackPlayerView,
  type BlackjackAction,
  commitThreeCard,
  settleThreeCard,
  commitVideoPoker,
  settleVideoPoker,
  commitPaiGow,
  settlePaiGow,
  playerHouseWayPositions,
  // ---- wordle: a SkillGame (settles from a verified result, no encodeRound) → its own thin driver ----
  wordle,
  WORDLE_MAX_GUESSES,
  type WordleResult,
  // ---- sudoku: a timed leaderboard (no wager/session) → solver driver ----
  sudokuElapsed,
  sudokuLeaderboard,
  type SudokuSolveEntry,
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

// The FULL roster. Categories: single-draw (HouseSession), stateful mines, ladder games (shared engine),
// decision one-shots, the two-peer hilo-war ZK duel, and the sudoku leaderboard. The war game is keyed
// 'hilo-war' (its old key was 'hilo') so the ladder card game hilo.ts can take the 'hilo' key.
const ALL_GAMES = [
  // single-draw Game<TParams> via runDrawTable
  'dice', 'limbo', 'plinko', 'keno',
  'baccarat', 'dragonTiger', 'andarBahar', 'craps', 'crash', 'monte', 'pachinko', 'wheel', 'dicex2', 'cascade',
  // stateful mines (own driver)
  'mines',
  // ladder games via runLadderTable
  'towers', 'chicken', 'firewalk', 'heist', 'hilo', 'greedDice', 'cipher',
  // decision one-shots via runDecisionTable (roulette + wordle settle directly here too)
  'blackjack', 'threeCardPoker', 'videoPoker', 'paiGow', 'roulette', 'wordle',
  // timed leaderboard (solver driver)
  'sudoku',
  // two-peer ZK-masked-deck duel (own driver)
  'hilo-war',
] as const
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
// new single-draw games — sane bounded params cribbed from each module's test/valid ranges.
const baccaratParams = () => ({ bet: pick(['player', 'banker', 'tie'] as const) })
const dragonTigerParams = () => ({ bet: pick(['dragon', 'tiger', 'tie'] as const) })
const andarBaharParams = () => ({ bet: pick(['andar', 'bahar'] as const) })
const crapsParams = () => ({ bet: pick(['pass', 'dontpass'] as const) })
const crashParams = () => ({ autoCashoutX100: BigInt(110 + randInt(890)) }) // 1.10x..10.00x auto-cashout
const monteParams = () => ({ pick: randInt(3) }) // one of 3 positions
const pachinkoParams = () => ({ rows: 12, risk: pick(['low', 'medium', 'high'] as const) }) // 12 = shipped table
const wheelParams = () => ({ segments: pick([10, 20, 30, 40, 50] as const), risk: pick(['low', 'medium', 'high'] as const) })
const dicex2Params = () => ({ targetX100: BigInt(1000 + randInt(6000)), mode: pick(['both', 'either'] as const) }) // 10%..70%
const cascadeParams = () => ({}) // no bet config (Record<string, never>)
// roulette: a single even-money / dozen / column / straight bet whose stake == STAKE (settle requires
// the bet stakes to sum to the round stake). Settled directly (see the roulette DecisionAdapter).
const rouletteParams = () => {
  const type = pick([
    RouletteBetType.RED, RouletteBetType.BLACK, RouletteBetType.ODD, RouletteBetType.EVEN,
    RouletteBetType.HIGH, RouletteBetType.LOW, RouletteBetType.DOZEN, RouletteBetType.COLUMN,
    RouletteBetType.STRAIGHT,
  ] as const)
  let selection = 0
  if (type === RouletteBetType.STRAIGHT) selection = randInt(37) // 0..36
  else if (type === RouletteBetType.DOZEN || type === RouletteBetType.COLUMN) selection = randInt(3)
  return { bets: [{ type, selection, stake: STAKE }] }
}
/** two distinct front positions in [0,6] for a pai gow split. */
const randomFront = (): [number, number] => {
  const a = randInt(7)
  let b = randInt(6)
  if (b >= a) b++
  return [a, b]
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
// endpoint built from VALVE_RPC_KEY; absent both, bots run in-process only.
//
// OPT-IN: the lobby feed is gated behind BOARD_FEED=1 and is OFF by default. The PoW stamp runs in
// pow-worker via @msgboard/pow-grinder's PORTABLE WASM engine — its bytes are embedded in the bundle
// (pow-grinder-wasm-b64.ts), so it works inside the self-contained esbuild .mjs the fleet ships (the
// native .node addon is NOT in that bundle). Play never depends on the feed, so it stays off by
// default; set BOARD_FEED=1 to light up the lobby feed on a deploy.
const BOARD_FEED_ON = env.BOARD_FEED === '1'
const BOARD_RPC = !BOARD_FEED_ON
  ? ''
  : env.BOARD_RPC || (env.VALVE_RPC_KEY ? `https://one.valve.city/rpc/${env.VALVE_RPC_KEY}/evm/${CHAIN}` : '')
const board = BOARD_RPC ? createMsgBoardClient(BOARD_RPC) : null
// All lifecycle notices go to ONE shared, discoverable category so a viewer (the web app, the archive,
// anyone) can poll a single category to watch every table on the chain; the per-table id rides in the
// body. The proof-of-work STAMP (the slow part) is minted in a worker_threads grinder (Rust→WASM
// @msgboard/pow-grinder, ~1.2–1.8s) so it never starves the game loops on this thread — the worker gets only
// encoded bytes, never a key. The thin RPC bits (read difficulty + head, then submit) run here via
// `post`. One post in flight at a time; notices arriving mid-stamp are dropped (drop-if-busy) — the
// games turn over faster than a post, and the board is a live signal, not a log.
const LOBBY_CATEGORY = `games.msgboard.xyz:lobby:${CHAIN}`
const STAMP_MAX_ITERS = 50_000_000 // ample for the 943 floor (~190k iters); the wasm grinder finds it in ~1-2s

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
  console.log(`[board] live feed → ${LOBBY_CATEGORY} via ${BOARD_RPC.replace(/\/rpc\/[^/]+\//, '/rpc/<key>/')} [wasm stamp worker]`)
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
// LADDER games (towers / chicken / firewalk / heist / hilo / greedDice / cipher): the mines pattern
// generalized onto the shared ladder engine (ladder.ts). One generic driver, parameterized by a small
// per-game adapter: {start, resolver, choice, maxSteps}. A layout is committed up front (DERIVED from
// the sealed round seed), the bot random-walks revealing steps with a randomized think delay, stops
// early at a random height, cashes out, and settles the terminal delta via ladderPlayerDelta. Broadcast
// is open+summary only, exactly like mines. Each per-game `choice()` draws a legal move: a single-path
// game (chicken/firewalk/greedDice) always picks 0; towers/heist/cipher/hilo pick within their choice
// space — a random guess, so the bot busts about as often as an uninformed player would (that is fine).
// ---------------------------------------------------------------------------------------------
interface LadderAdapter {
  label: GameName
  /** open the ladder from a seed → the initial co-signed state + its layout commitment. */
  start: (seed: bigint) => { state: LadderState; commit: viem.Hex }
  /** the per-step resolver bound to the seed-derived layout: (step, choice, runningMult) → StepOutcome. */
  resolver: (seed: bigint) => (step: number, choice: number, mult: bigint) => StepOutcome
  /** draw a legal move for the next step (uniform over that game's choice space). */
  choice: () => number
}

const runLadderTable = async (a: LadderAdapter) => {
  let session = 0
  while (running) {
    session++
    const tableId = newTableId(a.label)
    const seed = BigInt(randBytes32()) // the sealed layout seed (commit published, revealed at dispute)
    const { state: opened, commit } = a.start(seed)
    const resolve = a.resolver(seed)
    let state = opened
    console.log(`[${a.label}] table ${session} open commit=${commit.slice(0, 10)} maxSteps=${state.maxSteps}`)
    broadcast(tableId, { kind: 'open', game: a.label, commit, maxSteps: state.maxSteps })

    // randomized early stop: aim to climb somewhere in [1, maxSteps] before cashing out.
    const target = 1 + randInt(state.maxSteps)
    const t0 = Date.now()
    let decisionTotal = 0
    let busted = false
    for (let step = 0; running && state.phase === LadderPhase.PLAYING && step < target; step++) {
      const d = thinkDelay()
      await idle(d) // think before each step
      if (!running) break
      decisionTotal += d
      const choice = a.choice()
      const res = ladderAdvance(state, choice, resolve(step, choice, state.multiplierX100))
      if ('error' in res) break // shouldn't happen (legal choice, non-terminal) — stop the climb if it does
      state = res.state
      if (state.phase === LadderPhase.BUSTED) {
        busted = true
        break
      }
    }
    if (!running) break
    // cash out if still climbing with at least one safe step (reaching the top auto-cashes-out already).
    if (state.phase === LadderPhase.PLAYING && state.step > 0) {
      const d = thinkDelay()
      await idle(d)
      decisionTotal += d
      const res = ladderCashOut(state)
      if (!('error' in res)) state = res.state
    }
    const stateHash = hashLadderState(state)
    const delta = ladderPlayerDelta(state, STAKE)
    const mult = state.multiplierX100
    const phase = busted ? 'BUST' : state.phase === LadderPhase.CASHED_OUT ? 'cashout' : 'open'
    console.log(
      `[${a.label}] session ${session} steps=${state.step}/${state.maxSteps} ${phase} ` +
        `x${(Number(mult) / 100).toFixed(2)} delta=${delta >= 0n ? '+' : ''}${fmt(delta)} ` +
        `decision=${decisionTotal}ms total=${Date.now() - t0}ms hash=${stateHash.slice(0, 10)}`,
    )
    broadcast(tableId, { kind: 'summary', game: a.label, steps: state.step, busted, multiplierX100: mult.toString(), delta: fmt(delta) })
    if (env.ONCE === 'true') return
    await idle(ROUND_GAP_MS * (0.5 + randUint()))
  }
}

// per-game ladder adapters (valid configs cribbed from test/ladderGames.test.ts + test/towers.test.ts).
const TOWERS_CFG = { floors: 8, tilesPerFloor: 3, safePerFloor: 2 }
const CHICKEN_CFG = { difficulty: 'medium' as const, lanes: 10 }
const FIREWALK_CFG = { tiles: 8 }
const HEIST_CFG = { rooms: 6, vaults: 4, baseAlarms: 1 }
const HILO_CFG = { steps: 10, capX100: 100_000n } // cap 1000x
const GREED_DICE_CFG = { rolls: 8, bustFaces: 2 }
const CIPHER_CFG = { rungs: 5, difficulty: 'hard' as const } // 4 symbols
const LADDER_TABLES: Partial<Record<GameName, LadderAdapter>> = {
  towers: { label: 'towers', start: (s) => startTowers(TOWERS_CFG, s), resolver: (s) => towersResolveStep(s, TOWERS_CFG), choice: () => randInt(TOWERS_CFG.tilesPerFloor) },
  chicken: { label: 'chicken', start: (s) => startChicken(CHICKEN_CFG, s), resolver: (s) => chickenResolveStep(s, CHICKEN_CFG), choice: () => 0 },
  firewalk: { label: 'firewalk', start: (s) => startFirewalk(FIREWALK_CFG, s), resolver: (s) => firewalkResolveStep(s), choice: () => 0 },
  heist: { label: 'heist', start: (s) => startHeist(HEIST_CFG, s), resolver: (s) => heistResolveStep(s, HEIST_CFG), choice: () => randInt(HEIST_CFG.vaults) },
  hilo: { label: 'hilo', start: (s) => startHiLo(HILO_CFG, s), resolver: (s) => hiloResolveStep(s, HILO_CFG), choice: () => randInt(2) },
  greedDice: { label: 'greedDice', start: (s) => startGreedDice(GREED_DICE_CFG, s), resolver: (s) => greedDiceResolveStep(s, GREED_DICE_CFG), choice: () => 0 },
  cipher: { label: 'cipher', start: (s) => startCipher(CIPHER_CFG, s), resolver: (s) => cipherResolveStep(s, CIPHER_CFG), choice: () => randInt(cipherSymbols(CIPHER_CFG.difficulty)) },
}

// ---------------------------------------------------------------------------------------------
// DECISION one-shots (blackjack / threeCardPoker / videoPoker / paiGow) + the two direct-settle
// single-draws that can't ride HouseSession (roulette: nested-bigint params; wordle: a SkillGame with
// no encodeRound). One generic driver: commit the sealed seed, sleep a think delay, pick a random LEGAL
// decision, call the settle fn, log + broadcast open/summary. Each adapter's `play(seed)` returns the
// common {playerDelta, multiplierX100, win, detail} shape.
// ---------------------------------------------------------------------------------------------
interface DecisionAdapter {
  label: GameName
  commit: (seed: bigint) => viem.Hex
  play: (seed: bigint) => { playerDelta: bigint; multiplierX100: bigint; win: boolean; detail: string }
}

const runDecisionTable = async (a: DecisionAdapter) => {
  let session = 0
  while (running) {
    session++
    const tableId = newTableId(a.label)
    const seed = BigInt(randBytes32())
    const commit = a.commit(seed)
    console.log(`[${a.label}] table ${session} open commit=${commit.slice(0, 10)}`)
    broadcast(tableId, { kind: 'open', game: a.label, commit })
    const think = thinkDelay()
    await idle(think) // think before deciding
    if (!running) break
    let out: { playerDelta: bigint; multiplierX100: bigint; win: boolean; detail: string }
    try {
      out = a.play(seed)
    } catch (e) {
      console.log(`[${a.label}] play error: ${(e as Error).message?.split('\n')[0]}`)
      if (env.ONCE === 'true') return
      await idle(ROUND_GAP_MS * (0.5 + randUint()))
      continue
    }
    console.log(
      `[${a.label}] session ${session} ${out.win ? 'WIN ' : 'lose'} ` +
        `x${(Number(out.multiplierX100) / 100).toFixed(2)} delta=${out.playerDelta >= 0n ? '+' : ''}${fmt(out.playerDelta)} ` +
        `${out.detail} decision=${think}ms`,
    )
    broadcast(tableId, { kind: 'summary', game: a.label, multiplierX100: out.multiplierX100.toString(), delta: fmt(out.playerDelta), detail: out.detail })
    if (env.ONCE === 'true') return
    await idle(ROUND_GAP_MS * (0.5 + randUint()))
  }
}

/** Build a random LEGAL blackjack action sequence, using the player-view to know when the turn ends. */
const randomBlackjackActions = (seed: bigint): BlackjackAction[] => {
  const actions: BlackjackAction[] = []
  if (blackjackPlayerView(seed, []).finished) return actions // a natural blackjack allows no actions
  for (;;) {
    const first = actions.length === 0
    const act = pick(first ? (['hit', 'stand', 'double'] as const) : (['hit', 'stand'] as const))
    actions.push(act)
    if (act !== 'hit') break // stand/double ends the turn
    if (blackjackPlayerView(seed, actions).finished) break // hit to 21 / bust ends the turn
  }
  return actions
}

const DECISION_TABLES: Partial<Record<GameName, DecisionAdapter>> = {
  blackjack: {
    label: 'blackjack',
    commit: commitBlackjack,
    play: (seed) => {
      const actions = randomBlackjackActions(seed)
      const r = settleBlackjack(STAKE, seed, actions)
      return { playerDelta: r.playerDelta, multiplierX100: r.multiplierX100, win: r.win, detail: `p=${r.playerTotal} d=${r.dealerTotal} acts=[${actions.join(',')}]${r.doubled ? ' x2' : ''}` }
    },
  },
  threeCardPoker: {
    label: 'threeCardPoker',
    commit: commitThreeCard,
    play: (seed) => {
      const decision = coinFlip() ? 'play' : 'fold'
      const o = settleThreeCard(STAKE, seed, decision)
      return { playerDelta: o.playerDelta, multiplierX100: o.multiplierX100, win: o.win, detail: `decision=${decision}` }
    },
  },
  videoPoker: {
    label: 'videoPoker',
    commit: commitVideoPoker,
    play: (seed) => {
      const holdMask = randInt(32) // random 5-bit hold mask
      const o = settleVideoPoker(STAKE, seed, holdMask)
      return { playerDelta: o.playerDelta, multiplierX100: o.multiplierX100, win: o.win, detail: `hold=${holdMask.toString(2).padStart(5, '0')} cat=${o.category}` }
    },
  },
  paiGow: {
    label: 'paiGow',
    commit: commitPaiGow,
    play: (seed) => {
      const positions = coinFlip() ? playerHouseWayPositions(seed) : randomFront() // house-way or a random split
      const o = settlePaiGow(STAKE, seed, positions)
      return { playerDelta: o.playerDelta, multiplierX100: o.multiplierX100, win: o.win, detail: `result=${o.result} front=[${positions.join(',')}]${o.fouled ? ' FOUL' : ''}` }
    },
  },
  roulette: {
    label: 'roulette',
    commit: commitLayout, // the seed doubles as the round random; commit it before the spin
    play: (seed) => {
      const params = rouletteParams()
      const o = roulette.settleRound(STAKE, params, seed)
      const b = params.bets[0]!
      const sel = b.type === RouletteBetType.STRAIGHT || b.type === RouletteBetType.DOZEN || b.type === RouletteBetType.COLUMN ? `/${b.selection}` : ''
      return { playerDelta: o.playerDelta, multiplierX100: o.multiplierX100, win: o.win, detail: `bet=${RouletteBetType[b.type]}${sel} pocket=${rouletteWinningPocket(seed)}` }
    },
  },
  wordle: {
    label: 'wordle',
    commit: commitLayout, // nominal commitment to the round seed (the ZK word-commit lives in @msgboard/zk-skill)
    play: (_seed) => {
      // a random VERIFIED result: solve in 1..6 guesses, or (~15%) a miss. skill payout curve does the rest.
      const solved = randUint() > 0.15
      const guessesUsed = 1 + randInt(WORDLE_MAX_GUESSES)
      const result: WordleResult = solved ? { solved: true, guessesUsed } : { solved: false, guessesUsed: 0 }
      const o = wordle.settleRound(STAKE, { maxGuesses: WORDLE_MAX_GUESSES }, result)
      return { playerDelta: o.playerDelta, multiplierX100: o.multiplierX100, win: o.win, detail: solved ? `solved in ${guessesUsed}` : 'unsolved' }
    },
  },
}

// ---------------------------------------------------------------------------------------------
// SUDOKU — a TIMED LEADERBOARD, not a wagered HouseSession game (no stake / multiplier / escrow — see
// sudoku.ts: a flat bet on a public, bot-automatable solve is strictly -EV for the house). It doesn't
// fit the player↔house session model at all, so rather than a table loop the bot acts as a SOLVER: it
// "solves" a committed puzzle and posts a leaderboard entry (SudokuSolveEntry) — exactly what the
// on-chain SudokuLog.Solved event records — then ranks it via sudokuLeaderboard. One solve → one row.
// ---------------------------------------------------------------------------------------------
const runSudokuTable = async () => {
  let solve = 0
  while (running) {
    solve++
    const tableId = newTableId('sudoku')
    const puzzleId = BigInt(randBytes32())
    const openedAt = BigInt(Math.floor(Date.now() / 1000))
    console.log(`[sudoku] solve ${solve} puzzle opened id=${puzzleId.toString(16).slice(0, 8)}`)
    broadcast(tableId, { kind: 'open', game: 'sudoku', puzzle: `0x${puzzleId.toString(16).slice(0, 10)}` })
    const think = thinkDelay()
    await idle(think) // "solving time" before the finish line
    if (!running) break
    // the solve: a plausible elapsed time (seconds); the nullifier binds the solve to the player address.
    const elapsedS = BigInt(20 + randInt(600))
    const solvedAt = openedAt + elapsedS
    const player = BigInt((playerSigner as { address: viem.Hex }).address)
    const entry: SudokuSolveEntry = { puzzleId, player, nullifier: BigInt(randBytes32()), solvedAt, elapsed: sudokuElapsed(openedAt, solvedAt) }
    const rows = sudokuLeaderboard([entry])
    const me = rows[0]!
    console.log(`[sudoku] solve ${solve} puzzle=${puzzleId.toString(16).slice(0, 8)} elapsed=${me.elapsed}s rank=#${me.rank} decision=${think}ms`)
    broadcast(tableId, { kind: 'summary', game: 'sudoku', elapsed: me.elapsed.toString(), rank: me.rank })
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
    const tableId = newTableId('hilo-war')
    const a = new HiLoPlayer({ role: 'A', wallet: wa, peer: wb.address, transport: ta, deck, domain, tableId, ante: HILO_ANTE, escrowEach: HILO_ESCROW, clock: clockA })
    const b = new HiLoPlayer({ role: 'B', wallet: wb, peer: wa.address, transport: tb, deck, domain, tableId, ante: HILO_ANTE, escrowEach: HILO_ESCROW })

    try {
      await openHiLoSession(a, b)
    } catch (e) {
      console.log(`[hilo-war] open failed, retrying: ${(e as Error).message?.split('\n')[0]}`)
      await idle(ROUND_GAP_MS)
      continue
    }
    const genesis = a.channel.latest!.state
    console.log(`[hilo-war] table ${table} open deck=${genesis.deckCommitment.slice(0, 10)} escrowEach=${fmt(HILO_ESCROW)}`)
    broadcast(tableId, { kind: 'open', game: 'hilo-war', deck: genesis.deckCommitment, escrowEach: fmt(HILO_ESCROW) })

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
        console.log(`[hilo-war] flip error, reopening table: ${(e as Error).message?.split('\n')[0]}`)
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
        `[hilo-war] flip ${flips} A=${myCard} B=${opponentCard ?? 'hidden'} ${winner === 'tie' ? 'TIE ' : `win=${winner}`} ` +
          `deltaA=${delta >= 0n ? '+' : ''}${fmt(delta)} balA=${fmt(after.balanceA)} balB=${fmt(after.balanceB)} ` +
          `pot=${fmt(after.pot)} decision=${dMs ?? '?'}ms network=${nMs ?? '?'}ms total=${tMs ?? '?'}ms`,
      )
      if (env.ONCE === 'true') {
        // settle once for a clean smoke, then exit.
        const [settled] = await Promise.all([a.requestSettle(), b.acceptSettle()])
        console.log(`[hilo-war] settled phase=${settled.state.phase === HiLoPhase.SETTLED ? 'SETTLED' : settled.state.phase} balA=${fmt(settled.state.balanceA)} balB=${fmt(settled.state.balanceB)}`)
        return
      }
      await idle(ROUND_GAP_MS * (0.5 + randUint()))
    }
    if (!running) break
    // cooperative settle at the end of a table run (splits any war carry, zeroes the pot).
    try {
      const [settled] = await Promise.all([a.requestSettle(), b.acceptSettle()])
      console.log(`[hilo-war] table ${table} settled balA=${fmt(settled.state.balanceA)} balB=${fmt(settled.state.balanceB)} after ${flips} flips`)
      broadcast(tableId, { kind: 'summary', game: 'hilo-war', flips, balA: fmt(settled.state.balanceA), balB: fmt(settled.state.balanceB) })
    } catch (e) {
      console.log(`[hilo-war] settle failed: ${(e as Error).message?.split('\n')[0]}`)
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
    // single-draw Game<TParams> tables (HouseSession.playRound)
    if (g === 'dice') tables.push(runDrawTable('dice', dice, domain, diceParams))
    else if (g === 'limbo') tables.push(runDrawTable('limbo', limbo, domain, limboParams))
    else if (g === 'plinko') tables.push(runDrawTable('plinko', plinko, domain, plinkoParams))
    else if (g === 'keno') tables.push(runDrawTable('keno', keno, domain, kenoParams))
    else if (g === 'baccarat') tables.push(runDrawTable('baccarat', baccarat, domain, baccaratParams))
    else if (g === 'dragonTiger') tables.push(runDrawTable('dragonTiger', dragonTiger, domain, dragonTigerParams))
    else if (g === 'andarBahar') tables.push(runDrawTable('andarBahar', andarBahar, domain, andarBaharParams))
    else if (g === 'craps') tables.push(runDrawTable('craps', craps, domain, crapsParams))
    else if (g === 'crash') tables.push(runDrawTable('crash', crash, domain, crashParams))
    else if (g === 'monte') tables.push(runDrawTable('monte', monte, domain, monteParams))
    else if (g === 'pachinko') tables.push(runDrawTable('pachinko', pachinko, domain, pachinkoParams))
    else if (g === 'wheel') tables.push(runDrawTable('wheel', wheel, domain, wheelParams))
    else if (g === 'dicex2') tables.push(runDrawTable('dicex2', dicex2, domain, dicex2Params))
    else if (g === 'cascade') tables.push(runDrawTable('cascade', cascade, domain, cascadeParams))
    // stateful mines
    else if (g === 'mines') tables.push(runMinesTable())
    // ladder games (shared engine)
    else if (LADDER_TABLES[g]) tables.push(runLadderTable(LADDER_TABLES[g]!))
    // decision one-shots + roulette + wordle (direct-settle)
    else if (DECISION_TABLES[g]) tables.push(runDecisionTable(DECISION_TABLES[g]!))
    // timed leaderboard
    else if (g === 'sudoku') tables.push(runSudokuTable())
    // two-peer ZK-masked-deck duel
    else if (g === 'hilo-war') {
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
