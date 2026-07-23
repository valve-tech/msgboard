/**
 * Autonomous FlipBook players: keep the P2P coin-flip offer book alive on testnet and soak-test
 * every contract path continuously. Stateless — the book rebuilds from chain events each tick,
 * and the maker's (choice, salt) re-derives deterministically from (seeds0, offerId), so restarts
 * lose nothing and no secret is ever stored.
 *
 * Per tick (with jitter):
 *   maker  — keep up to MAX_OPEN standing offers posted (stake from STAKES, bond = stake/5,
 *            3h take window, 15min reveal window); cancel own offers past their deadline.
 *   taker  — take any open HUMAN offer immediately (stake ≤ MAX_STAKE — humans always find a
 *            counterparty); take the maker bot's offers on the sparing cadence so the book stays
 *            visibly populated between flips.
 *   reveal — open the commit on own taken offers inside the window… except a deterministic
 *            FORFEIT_PCT of them, which the maker deliberately sits out so the forfeit path
 *            (claim pays 2·stake + bond to the taker) gets ambient exercise too.
 *   claim  — crank any taken offer past its reveal window (permissionless).
 *
 * Secret plan: salt(offerId) = keccak(flipKey ‖ offerId), choice = keccak(salt) & 1. The maker
 * posts against the PREDICTED next offerId; if a rare race shifts the id, reveal-time recovery
 * scans a small id window and verifies against the on-chain commit before sending, so a
 * mis-predicted commit is never revealed blind (worst case that offer forfeits its bond).
 *
 * Env: MNEMONIC (funded; maker = addressIndex 30, taker = 31 — clear of validators 1-3, gate
 *      players 4-8, watcher 10, ops 11, player-bots 20+ — topped up from account 0),
 *      SEEDS0 (secret derivation), CHAIN (default 943), RPC, FLIPBOOK (contract address),
 *      FLIPBOOK_DEPLOY_BLOCK (event-scan origin), STAKES (default "0.1,0.25,0.5"),
 *      MAX_OPEN (default 2), MAX_STAKE (take cap, default 25), FORFEIT_PCT (default 10),
 *      INTERVAL_MS (default 120000), SELF_PLAY_INTERVAL_MS (default 0),
 *      VAULT_FLOOR (default 100) — same pause semantics as player-bots. ONCE=true single pass.
 */
import * as viem from 'viem'
import type { GamesChainId } from '@msgboard/games-core'
import { MsgBoardClient } from '@msgboard/sdk'
import { WsBoardTransport } from '@msgboard/games'
import { seeds0Secret } from './seeds0'
import { makeActor, sendAs, flooredFees, chunkedEvents } from './actor-common'

const env = process.env
const CHAIN = (env.CHAIN ? Number(env.CHAIN) : 943) as GamesChainId
const FLIPBOOK = (env.FLIPBOOK ?? '0xb009bd8b849dd33d9c5081ec6e53f29a947f6832') as viem.Hex
const FROM_BLOCK = BigInt(env.FLIPBOOK_DEPLOY_BLOCK ?? '24921235')
const STAKES = (env.STAKES ?? '0.1,0.25,0.5').split(',').map((s) => viem.parseEther(s.trim()))
const MAX_OPEN = env.MAX_OPEN ? Number(env.MAX_OPEN) : 2
const MAX_STAKE = viem.parseEther(env.MAX_STAKE || '25')
const FORFEIT_PCT = env.FORFEIT_PCT ? Number(env.FORFEIT_PCT) : 10
const INTERVAL_MS = env.INTERVAL_MS ? Number(env.INTERVAL_MS) : 120_000
const SELF_PLAY_INTERVAL_MS = env.SELF_PLAY_INTERVAL_MS ? Number(env.SELF_PLAY_INTERVAL_MS) : 0
const VAULT_FLOOR = viem.parseEther(env.VAULT_FLOOR || '100')
const MAKER_INDEX = 30
const TAKER_INDEX = 31
const FLIP_KEY_BASE = 60_000_000 // reserved seeds0 range (player-bots use 50M+, validators i*100k)
const GAS_CUSHION = viem.parseEther('1')
const TOP_UP_BELOW = viem.parseEther('20')
const TOP_UP_TO = viem.parseEther('100')
const TAKE_DEADLINE_S = 3n * 3600n
const REVEAL_WINDOW_S = 900
const ID_RECOVERY_WINDOW = 5n // reveal-time scan for race-shifted predicted ids

// ── variant B (FlipBookX over x402PLS): off-chain signed offers sprayed on msgboard ──────────────
const FLIPBOOKX = (env.FLIPBOOKX ?? '') as viem.Hex // unset → variant B disabled
const FLIPBOOKX_FROM = BigInt(env.FLIPBOOKX_DEPLOY_BLOCK ?? '24932217')
const X402PLS = (env.X402PLS ?? '0xeb274050cb029288B8A4F232Da8d23F393d54A1E') as viem.Hex
// The board is per-chain, so a plain category suffices; the web offer book reads the same one.
const FLIPX_CATEGORY = viem.stringToHex('flipx', { size: 32 })
const WS_URL = env.BOARD_WS ?? `wss://games.msgboard.xyz/rpc/evm/${CHAIN}`
const MAX_OPEN_X = env.MAX_OPEN_X ? Number(env.MAX_OPEN_X) : 2
const STAKES_X = (env.STAKES_X ?? '0.1,0.25').split(',').map((v) => viem.parseEther(v.trim()))
const X_TAKE_DEADLINE_S = 7_200n
const X_REVEAL_WINDOW_S = 900
const FLIPX_KEY_BASE = 61_000_000 // reserved seeds0 range (variant-A flip bots use 60M)
const SALT_SLOTS = 8 // offers per hour bucket the stateless recovery scan covers
const SALT_SCAN_HOURS = 26 // takenAt-anchored scan depth (offer lives ≤ 2h + clock slack)

const flipBookAbi = viem.parseAbi([
  'function post(bytes32 commit, uint256 bond_, uint64 takeDeadline, uint32 revealWindow) payable returns (uint256)',
  'function cancel(uint256 offerId)',
  'function take(uint256 offerId, bool guess) payable',
  'function reveal(uint256 offerId, bool choice, bytes32 salt)',
  'function claim(uint256 offerId)',
  'function nextOfferId() view returns (uint256)',
  'event OfferPosted(uint256 indexed offerId, address indexed maker, bytes32 commit, uint256 stake, uint256 bond, uint64 takeDeadline, uint32 revealWindow)',
  'event OfferCancelled(uint256 indexed offerId)',
  'event OfferTaken(uint256 indexed offerId, address indexed taker, bool guess, uint256 revealBy)',
  'event Revealed(uint256 indexed offerId, bool choice, address indexed winner, uint256 pot)',
  'event Forfeited(uint256 indexed offerId, address indexed taker, uint256 amount)',
])

type Offer = {
  offerId: bigint
  maker: viem.Hex
  commit: viem.Hex
  stake: bigint
  bond: bigint
  takeDeadline: bigint
  status: 'open' | 'taken' | 'settled'
  taker?: viem.Hex
  revealBy?: bigint
}

const flipxAbi = viem.parseAbi([
  'struct Offer { address maker; bytes32 commit; uint256 stake; uint256 makerBond; uint256 takerBond; uint64 takeDeadline; uint32 makerRevealWindow; uint32 takerRevealWindow; }',
  'function take(Offer o, bytes makerSig, address taker, bytes32 guessCommit, bytes takerSig) returns (bytes32)',
  'function revealChoice(bytes32 id, bool choice, bytes32 salt)',
  'function revealGuess(bytes32 id, bool guess, bytes32 salt2)',
  'function claimMakerDefault(bytes32 id)',
  'function claimTakerDefault(bytes32 id)',
  'event Taken(bytes32 indexed offerId, address indexed maker, address indexed taker, uint256 stake, bytes32 guessCommit, uint256 choiceRevealBy)',
  'event ChoiceRevealed(bytes32 indexed offerId, bool choice, uint256 guessRevealBy)',
  'event Settled(bytes32 indexed offerId, bool choice, bool guess, address indexed winner, uint256 pot)',
  'event MakerDefaulted(bytes32 indexed offerId, address indexed taker, uint256 amount)',
  'event TakerDefaulted(bytes32 indexed offerId, address indexed maker, uint256 amount)',
])
const x402Abi = viem.parseAbi([
  'function wrap() payable',
  'function balanceOf(address) view returns (uint256)',
  'function DOMAIN_SEPARATOR() view returns (bytes32)',
  'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)',
])
const RECEIVE_TYPEHASH = viem.keccak256(
  viem.toBytes('ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)'),
)
const OFFER_TAG = viem.keccak256(viem.toBytes('FlipBookX.Offer'))
const TAKE_TAG = viem.keccak256(viem.toBytes('FlipBookX.Take'))

type XOffer = {
  maker: viem.Hex
  commit: viem.Hex
  stake: bigint
  makerBond: bigint
  takerBond: bigint
  takeDeadline: bigint
  makerRevealWindow: number
  takerRevealWindow: number
}
type XNotice = { offer: XOffer; makerSig: viem.Hex }

/** Offline mirror of FlipBookX.offerId — the id doubles as the maker's authorization nonce. */
const xOfferId = (o: XOffer): viem.Hex =>
  viem.keccak256(
    viem.encodeAbiParameters(
      [
        { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }, { type: 'address' },
        { type: 'bytes32' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' },
        { type: 'uint64' }, { type: 'uint32' }, { type: 'uint32' },
      ],
      [OFFER_TAG, BigInt(CHAIN), FLIPBOOKX, o.maker, o.commit, o.stake, o.makerBond, o.takerBond, o.takeDeadline, o.makerRevealWindow, o.takerRevealWindow],
    ),
  )
const xTakerNonce = (id: viem.Hex, taker: viem.Hex): viem.Hex =>
  viem.keccak256(viem.encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'address' }], [TAKE_TAG, id, taker]))

/**
 * Stateless secret plan for variant B: salt = keccak(key ‖ hourBucket ‖ slot). Recovery at
 * reveal time scans (hourBuckets near takenAt) × slots × both bits against the ON-CHAIN commit,
 * so restarts (and even a pruned board) lose nothing — the chain itself re-derives the secret.
 */
const xSalt = (key: viem.Hex, hourBucket: number, slot: number): viem.Hex =>
  viem.keccak256(viem.concatHex([key, viem.toHex(hourBucket, { size: 8 }), viem.toHex(slot, { size: 4 })]))
const xBitOf = (salt: viem.Hex): boolean => (BigInt(viem.keccak256(salt)) & 1n) === 1n
const xForfeit = (salt: viem.Hex): boolean =>
  BigInt(viem.keccak256(viem.concatHex([salt, '0x666f7266656974']))) % 100n < BigInt(FORFEIT_PCT)
const xCommitFor = (who: viem.Hex, bit: boolean, salt: viem.Hex): viem.Hex =>
  viem.keccak256(viem.encodeAbiParameters([{ type: 'address' }, { type: 'bool' }, { type: 'bytes32' }], [who, bit, salt]))
const xRecover = (who: viem.Hex, key: viem.Hex, commit: viem.Hex, aroundTs: number) => {
  const anchor = Math.floor(aroundTs / 3600)
  for (let h = anchor; h > anchor - SALT_SCAN_HOURS; h--) {
    for (let slot = 0; slot < SALT_SLOTS; slot++) {
      const salt = xSalt(key, h, slot)
      const bit = xBitOf(salt)
      if (xCommitFor(who, bit, salt) === commit) return { salt, bit, forfeit: xForfeit(salt) }
    }
  }
  return undefined
}

const main = async () => {
  if (!env.MNEMONIC) throw new Error('MNEMONIC required')
  if (!env.SEEDS0) throw new Error('SEEDS0 required')
  const funder = makeActor(CHAIN, env.MNEMONIC, 0, env.RPC)
  const maker = makeActor(CHAIN, env.MNEMONIC, MAKER_INDEX, env.RPC)
  const taker = makeActor(CHAIN, env.MNEMONIC, TAKER_INDEX, env.RPC)
  const publicClient = funder.publicClient
  const flipKey = seeds0Secret(env.SEEDS0!, FLIP_KEY_BASE)
  console.log(`flipbook bots on chain ${CHAIN} @ ${FLIPBOOK}: maker ${maker.account.address}, taker ${taker.account.address}`)

  let lastSelfPlay = 0
  const selfPlayAllowed = () => Date.now() - lastSelfPlay >= SELF_PLAY_INTERVAL_MS
  const markSelfPlay = () => {
    lastSelfPlay = Date.now()
  }
  let vaultPaused = false

  /** One crank action; a revert must not abort the tick — the other offers still need cranking. */
  const attempt = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn()
    } catch (e) {
      console.error(`${label}: ${(e as Error).message?.split('\n')[0]}`)
    }
  }
  /**
   * Deadlines are BLOCK timestamps — gate on chain time, never the box clock. The box running a
   * few seconds ahead made edge claims revert RevealWindowOpen (and edge reveals RevealWindowOver).
   */
  const chainNow = async () => (await publicClient.getBlock({ blockTag: 'latest' })).timestamp

  /** The maker's deterministic secret for an offer id — recomputable forever from seeds0. */
  const planFor = (offerId: bigint) => {
    const salt = viem.keccak256(viem.concatHex([flipKey, viem.toHex(offerId, { size: 32 })]))
    const choice = (BigInt(viem.keccak256(salt)) & 1n) === 1n
    // The deliberate no-show: a fixed slice of flips is never revealed so the forfeit/claim path
    // stays exercised. Derived from the salt → deterministic across restarts.
    const forfeit = BigInt(viem.keccak256(viem.concatHex([salt, '0x666f7266656974']))) % 100n < BigInt(FORFEIT_PCT)
    return { salt, choice, forfeit }
  }
  const commitFor = (makerAddr: viem.Hex, choice: boolean, salt: viem.Hex): viem.Hex =>
    viem.keccak256(
      viem.encodeAbiParameters([{ type: 'address' }, { type: 'bool' }, { type: 'bytes32' }], [makerAddr, choice, salt]),
    )
  /** Recover (choice, salt) for one of OUR offers by matching its on-chain commit (race-proof). */
  const recoverPlan = (offer: Offer) => {
    for (let id = offer.offerId; id >= 1n && id + ID_RECOVERY_WINDOW >= offer.offerId; id--) {
      const p = planFor(id)
      if (commitFor(maker.account.address, p.choice, p.salt) === offer.commit) return p
    }
    return undefined
  }

  const book = async (): Promise<Offer[]> => {
    const events = (eventName: 'OfferPosted' | 'OfferCancelled' | 'OfferTaken' | 'Revealed' | 'Forfeited') =>
      chunkedEvents(publicClient, { address: FLIPBOOK, abi: flipBookAbi as viem.Abi, eventName, fromBlock: FROM_BLOCK })
    const [posted, cancelled, taken, revealed, forfeited] = await Promise.all([
      events('OfferPosted'),
      events('OfferCancelled'),
      events('OfferTaken'),
      events('Revealed'),
      events('Forfeited'),
    ])
    const byId = new Map<string, Offer>()
    for (const log of posted) {
      const a = log.args as { offerId: bigint; maker: viem.Hex; commit: viem.Hex; stake: bigint; bond: bigint; takeDeadline: bigint }
      byId.set(a.offerId.toString(), { ...a, status: 'open' })
    }
    for (const log of taken) {
      const a = log.args as { offerId: bigint; taker: viem.Hex; revealBy: bigint }
      const o = byId.get(a.offerId.toString())
      if (o) Object.assign(o, { status: 'taken', taker: a.taker, revealBy: a.revealBy })
    }
    for (const log of [...cancelled, ...revealed, ...forfeited]) {
      const o = byId.get(((log.args as { offerId: bigint }).offerId).toString())
      if (o) o.status = 'settled'
    }
    return [...byId.values()]
  }

  const topUp = async () => {
    if (vaultPaused) return
    for (const bot of [maker, taker]) {
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

  // ── variant B wiring ──────────────────────────────────────────────────────────────────────
  const xEnabled = FLIPBOOKX.length === 42
  const wsTransport = xEnabled ? new WsBoardTransport(WS_URL) : undefined
  const wsBoard = wsTransport ? new MsgBoardClient(wsTransport) : undefined
  const makerKey = seeds0Secret(env.SEEDS0!, FLIPX_KEY_BASE)
  const takerKey = seeds0Secret(env.SEEDS0!, FLIPX_KEY_BASE + 1)
  let domainSeparator: viem.Hex | undefined
  let wsHeadsSeen = 0
  let xTickQueued = false
  let xBusy = false

  const authDigest = (from: viem.Hex, value: bigint, validBefore: bigint, nonce: viem.Hex) =>
    viem.keccak256(
      viem.concatHex([
        '0x1901',
        domainSeparator!,
        viem.keccak256(
          viem.encodeAbiParameters(
            [{ type: 'bytes32' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes32' }],
            [RECEIVE_TYPEHASH, from, FLIPBOOKX, value, 0n, validBefore, nonce],
          ),
        ),
      ]),
    )

  const x402Bal = (a: viem.Hex) =>
    publicClient.readContract({ address: X402PLS, abi: x402Abi, functionName: 'balanceOf', args: [a] })
  const ensureWrapped = async (bot: typeof maker, min: bigint) => {
    if ((await x402Bal(bot.account.address)) >= min) return
    await sendAs(bot.publicClient, bot.wallet, {
      address: X402PLS, abi: x402Abi as viem.Abi, functionName: 'wrap', args: [], value: min * 2n,
    })
    console.log(`x: ${bot.account.address} wrapped ${viem.formatEther(min * 2n)} → x402PLS`)
  }

  /** Live offers currently on the board (parsed, de-duped, still takeable, auth unburned). */
  const xReadBoard = async (now: bigint): Promise<{ offer: XOffer; id: viem.Hex; makerSig: viem.Hex }[]> => {
    if (!wsBoard) return []
    // SDK Content is Record<categoryHash, RPCMessage[]> with each message's payload in `data`.
    const content = (await wsBoard.content({ category: FLIPX_CATEGORY })) as unknown as Record<string, Array<{ data: viem.Hex }>>
    const seen = new Map<string, { offer: XOffer; id: viem.Hex; makerSig: viem.Hex }>()
    for (const messages of Object.values(content ?? {})) {
      for (const { data: raw } of messages ?? []) {
        try {
          const n = JSON.parse(viem.hexToString(raw as viem.Hex)) as { t?: string } & XNotice
          if (n.t !== 'offerx' || !n.offer || !n.makerSig) continue
          const offer: XOffer = {
            maker: n.offer.maker,
            commit: n.offer.commit,
            stake: BigInt(n.offer.stake),
            makerBond: BigInt(n.offer.makerBond),
            takerBond: BigInt(n.offer.takerBond),
            takeDeadline: BigInt(n.offer.takeDeadline),
            makerRevealWindow: Number(n.offer.makerRevealWindow),
            takerRevealWindow: Number(n.offer.takerRevealWindow),
          }
          if (offer.takeDeadline <= now) continue
          const id = xOfferId(offer)
          if (!seen.has(id)) seen.set(id, { offer, id, makerSig: n.makerSig })
        } catch {
          /* not an offer notice */
        }
      }
    }
    // drop offers whose maker authorization is already burned (taken or cancelled)
    const live: { offer: XOffer; id: viem.Hex; makerSig: viem.Hex }[] = []
    for (const o of seen.values()) {
      const used = (await publicClient.readContract({
        address: X402PLS, abi: x402Abi, functionName: 'authorizationState', args: [o.offer.maker, o.id],
      })) as boolean
      if (!used) live.push(o)
    }
    return live
  }

  const xPostOffer = async (slotHint: number) => {
    const hour = Math.floor(Date.now() / 1000 / 3600)
    const salt = xSalt(makerKey, hour, slotHint % SALT_SLOTS)
    const stake = STAKES_X[Math.floor(Math.random() * STAKES_X.length)]!
    const bond = stake / 5n
    const offer: XOffer = {
      maker: maker.account.address,
      commit: xCommitFor(maker.account.address, xBitOf(salt), salt),
      stake, makerBond: bond, takerBond: bond,
      takeDeadline: BigInt(Math.floor(Date.now() / 1000)) + X_TAKE_DEADLINE_S,
      makerRevealWindow: X_REVEAL_WINDOW_S, takerRevealWindow: X_REVEAL_WINDOW_S,
    }
    const id = xOfferId(offer)
    const makerSig = await maker.account.sign!({ hash: authDigest(maker.account.address, stake + bond, offer.takeDeadline, id) })
    const notice = {
      v: 1, t: 'offerx', at: Date.now(), makerSig,
      offer: { ...offer, stake: offer.stake.toString(), makerBond: offer.makerBond.toString(), takerBond: offer.takerBond.toString(), takeDeadline: offer.takeDeadline.toString() },
    }
    const data = viem.stringToHex(JSON.stringify(notice))
    const work = await wsBoard!.doPoW(FLIPX_CATEGORY, data)
    await wsBoard!.addMessage(work.message)
    console.log(`x: posted signed offer ${id.slice(0, 10)}… (${viem.formatEther(stake)} + ${viem.formatEther(bond)} bond)${xForfeit(salt) ? ' [destined to forfeit]' : ''}`)
  }

  /** The variant-B pass: maker sprays, taker executes, both sides reveal, cranks clean up.
   *  Mutexed: WS heads arrive faster than a pass completes — overlapping passes would duplicate
   *  scans (and takes) and pile up enough parallel requests to time each other out. */
  const tickX = async () => {
    if (!xEnabled || !wsBoard || xBusy) return
    xBusy = true
    try {
      await tickXInner()
    } finally {
      xBusy = false
    }
  }
  const tickXInner = async () => {
    domainSeparator ??= (await publicClient.readContract({
      address: X402PLS, abi: x402Abi, functionName: 'DOMAIN_SEPARATOR',
    })) as viem.Hex
    const nowTs = await chainNow()
    const nowS = Number(nowTs)

    // chain state first: reveals + claims are deadline-critical
    const takenLogs = await chunkedEvents(publicClient, { address: FLIPBOOKX, abi: flipxAbi as viem.Abi, eventName: 'Taken', fromBlock: FLIPBOOKX_FROM })
    const revealedLogs = await chunkedEvents(publicClient, { address: FLIPBOOKX, abi: flipxAbi as viem.Abi, eventName: 'ChoiceRevealed', fromBlock: FLIPBOOKX_FROM })
    const doneLogs = [
      ...(await chunkedEvents(publicClient, { address: FLIPBOOKX, abi: flipxAbi as viem.Abi, eventName: 'Settled', fromBlock: FLIPBOOKX_FROM })),
      ...(await chunkedEvents(publicClient, { address: FLIPBOOKX, abi: flipxAbi as viem.Abi, eventName: 'MakerDefaulted', fromBlock: FLIPBOOKX_FROM })),
      ...(await chunkedEvents(publicClient, { address: FLIPBOOKX, abi: flipxAbi as viem.Abi, eventName: 'TakerDefaulted', fromBlock: FLIPBOOKX_FROM })),
    ]
    const done = new Set(doneLogs.map((l) => (l.args as { offerId: viem.Hex }).offerId))
    const revealedBy = new Map(revealedLogs.map((l) => {
      const a = l.args as { offerId: viem.Hex; choice: boolean; guessRevealBy: bigint }
      return [a.offerId, a] as const
    }))

    for (const log of takenLogs) {
      const a = log.args as { offerId: viem.Hex; maker: viem.Hex; taker: viem.Hex; guessCommit: viem.Hex; choiceRevealBy: bigint }
      if (done.has(a.offerId)) continue
      const rev = revealedBy.get(a.offerId)
      const takenAtTs = Number(a.choiceRevealBy) - X_REVEAL_WINDOW_S
      if (!rev) {
        if (a.maker.toLowerCase() === maker.account.address.toLowerCase() && nowS <= Number(a.choiceRevealBy)) {
          // recover the commit's plan from chain data alone; skip the deterministic forfeit slice
          const flip = await publicClient.readContract({
            address: FLIPBOOKX, abi: viem.parseAbi(['function flips(bytes32) view returns (address maker, address taker, bytes32 commit, bytes32 guessCommit, uint256 stake, uint256 makerBond, uint256 takerBond, uint64 takenAt, uint64 choiceRevealedAt, uint32 w1, uint32 w2, bool choice)']),
            functionName: 'flips', args: [a.offerId],
          }) as readonly [viem.Hex, viem.Hex, viem.Hex, viem.Hex, bigint, bigint, bigint, bigint, bigint, number, number, boolean]
          if (flip[0] === viem.zeroAddress) continue
          const plan = xRecover(maker.account.address, makerKey, flip[2], takenAtTs)
          if (!plan) { console.error(`x: no plan recovered for ${a.offerId.slice(0, 10)}…`); continue }
          if (plan.forfeit) continue
          await attempt(`x: revealChoice ${a.offerId.slice(0, 10)}…`, async () => {
            await sendAs(maker.publicClient, maker.wallet, { address: FLIPBOOKX, abi: flipxAbi as viem.Abi, functionName: 'revealChoice', args: [a.offerId, plan.bit, plan.salt] })
            console.log(`x: revealed choice on ${a.offerId.slice(0, 10)}…`)
          })
        } else if (nowS > Number(a.choiceRevealBy)) {
          await attempt(`x: claimMakerDefault ${a.offerId.slice(0, 10)}…`, async () => {
            await sendAs(taker.publicClient, taker.wallet, { address: FLIPBOOKX, abi: flipxAbi as viem.Abi, functionName: 'claimMakerDefault', args: [a.offerId] })
            console.log(`x: claimed maker default on ${a.offerId.slice(0, 10)}…`)
          })
        }
      } else {
        if (a.taker.toLowerCase() === taker.account.address.toLowerCase() && nowS <= Number(rev.guessRevealBy)) {
          const plan = xRecover(taker.account.address, takerKey, a.guessCommit, takenAtTs)
          if (!plan) { console.error(`x: no guess plan for ${a.offerId.slice(0, 10)}…`); continue }
          await attempt(`x: revealGuess ${a.offerId.slice(0, 10)}…`, async () => {
            await sendAs(taker.publicClient, taker.wallet, { address: FLIPBOOKX, abi: flipxAbi as viem.Abi, functionName: 'revealGuess', args: [a.offerId, plan.bit, plan.salt] })
            console.log(`x: revealed guess on ${a.offerId.slice(0, 10)}…`)
          })
        } else if (nowS > Number(rev.guessRevealBy)) {
          await attempt(`x: claimTakerDefault ${a.offerId.slice(0, 10)}…`, async () => {
            await sendAs(maker.publicClient, maker.wallet, { address: FLIPBOOKX, abi: flipxAbi as viem.Abi, functionName: 'claimTakerDefault', args: [a.offerId] })
            console.log(`x: claimed taker default on ${a.offerId.slice(0, 10)}…`)
          })
        }
      }
    }
    if (vaultPaused) return

    // taker: execute a live offer (humans' immediately, our own on the sparing cadence)
    const board = await xReadBoard(nowTs)
    const takeable = board.filter((o) => o.offer.maker.toLowerCase() !== taker.account.address.toLowerCase() && o.offer.stake <= MAX_STAKE)
    for (const o of takeable) {
      const own = o.offer.maker.toLowerCase() === maker.account.address.toLowerCase()
      if (own && (!selfPlayAllowed() || Math.random() > 0.5)) continue
      await ensureWrapped(taker, o.offer.stake + o.offer.takerBond)
      const hour = Math.floor(Date.now() / 1000 / 3600)
      const salt2 = xSalt(takerKey, hour, Number(BigInt(o.id) % BigInt(SALT_SLOTS)))
      const guessCommit = xCommitFor(taker.account.address, xBitOf(salt2), salt2)
      const takerSig = await taker.account.sign!({
        hash: authDigest(taker.account.address, o.offer.stake + o.offer.takerBond, o.offer.takeDeadline, xTakerNonce(o.id, taker.account.address)),
      })
      await sendAs(taker.publicClient, taker.wallet, {
        address: FLIPBOOKX, abi: flipxAbi as viem.Abi, functionName: 'take',
        args: [o.offer, o.makerSig, taker.account.address, guessCommit, takerSig],
      })
      if (own) markSelfPlay()
      console.log(`x: took ${o.id.slice(0, 10)}… (${viem.formatEther(o.offer.stake)})`)
      break // one take per pass
    }

    // maker: keep the board stocked
    const mine = board.filter((o) => o.offer.maker.toLowerCase() === maker.account.address.toLowerCase())
    if (mine.length < MAX_OPEN_X && selfPlayAllowed()) {
      await ensureWrapped(maker, STAKES_X[STAKES_X.length - 1]! * 2n)
      await xPostOffer(mine.length)
      markSelfPlay()
    }
  }

  // WS pushes are the taker's clock: every new head triggers a variant-B pass (debounced so a
  // burst of heads coalesces into one). The base interval below stays as the belt-and-braces.
  if (xEnabled && wsTransport && env.ONCE !== 'true') {
    await wsTransport.subscribeNewHeads(() => {
      wsHeadsSeen++
      if (xTickQueued) return
      xTickQueued = true
      setTimeout(() => {
        xTickQueued = false
        void tickX().catch((e) => console.error(`x tick (ws): ${(e as Error).message?.split('\n').slice(0, 3).join(' ¦ ')}`))
      }, 2_000)
    })
    console.log(`variant B armed: FlipBookX ${FLIPBOOKX} over ${WS_URL} (ws newHeads-driven)`)
  }

  const tick = async () => {
    const vault = await publicClient.getBalance({ address: funder.account.address })
    const nowPaused = vault < VAULT_FLOOR
    if (nowPaused !== vaultPaused) {
      console.log(nowPaused ? `vault below floor — flipbook bots paused on chain ${CHAIN}` : 'vault refilled — flipbook bots resume')
    }
    vaultPaused = nowPaused
    await topUp()

    const now = await chainNow()
    const offers = await book()
    const makerAddr = maker.account.address.toLowerCase()
    const takerAddr = taker.account.address.toLowerCase()

    // claim anything whose reveal window lapsed (permissionless crank; pays the offer's taker)
    for (const o of offers) {
      if (o.status !== 'taken' || now <= (o.revealBy ?? 0n)) continue
      await attempt(`claim #${o.offerId}`, async () => {
        await sendAs(taker.publicClient, taker.wallet, {
          address: FLIPBOOK, abi: flipBookAbi, functionName: 'claim', args: [o.offerId],
        })
        console.log(`claimed forfeit on #${o.offerId} (maker sat out the window)`)
      })
    }

    // reveal own taken offers still inside the window — minus the deliberate forfeit slice.
    // A reveal that races the closing window and reverts is still the right call: the revert
    // costs nothing (estimateGas throws locally), while not trying guarantees the bond is lost.
    for (const o of offers) {
      if (o.status !== 'taken' || o.maker.toLowerCase() !== makerAddr || now > (o.revealBy ?? 0n)) continue
      const plan = recoverPlan(o)
      if (!plan) {
        console.error(`no recoverable plan for own offer #${o.offerId} — leaving to forfeit`)
        continue
      }
      if (plan.forfeit) continue // the no-show slice: taker will claim after the window
      await attempt(`reveal #${o.offerId}`, async () => {
        await sendAs(maker.publicClient, maker.wallet, {
          address: FLIPBOOK, abi: flipBookAbi, functionName: 'reveal', args: [o.offerId, plan.choice, plan.salt],
        })
        console.log(`revealed #${o.offerId} (${plan.choice ? 'heads' : 'tails'})`)
      })
    }

    if (vaultPaused) return

    // cancel own offers nobody took before the deadline (full refund; keeps the book fresh)
    for (const o of offers) {
      if (o.status !== 'open' || o.maker.toLowerCase() !== makerAddr || now <= o.takeDeadline) continue
      await sendAs(maker.publicClient, maker.wallet, {
        address: FLIPBOOK, abi: flipBookAbi, functionName: 'cancel', args: [o.offerId],
      })
      console.log(`cancelled own expired offer #${o.offerId}`)
    }

    // take: human offers immediately (service), the bot's own offers on the sparing cadence
    const takeable = offers.filter(
      (o) => o.status === 'open' && now < o.takeDeadline && o.stake <= MAX_STAKE && o.maker.toLowerCase() !== takerAddr,
    )
    for (const o of takeable) {
      const isOwnBook = o.maker.toLowerCase() === makerAddr
      if (isOwnBook && (!selfPlayAllowed() || Math.random() > 0.5)) continue // let the book linger
      const balance = await publicClient.getBalance({ address: taker.account.address })
      if (balance < o.stake + GAS_CUSHION) continue
      const guess = Math.random() < 0.5
      await sendAs(taker.publicClient, taker.wallet, {
        address: FLIPBOOK, abi: flipBookAbi, functionName: 'take', args: [o.offerId, guess], value: o.stake,
      })
      if (isOwnBook) markSelfPlay()
      console.log(`took #${o.offerId} calling ${guess ? 'heads' : 'tails'} (${viem.formatEther(o.stake)} vs ${o.maker})`)
      break // one take per tick — pacing
    }

    // post: keep the book stocked up to MAX_OPEN standing offers
    const myOpen = offers.filter((o) => o.status === 'open' && o.maker.toLowerCase() === makerAddr && now < o.takeDeadline)
    if (myOpen.length < MAX_OPEN && selfPlayAllowed()) {
      const predicted = (await publicClient.readContract({
        address: FLIPBOOK, abi: flipBookAbi, functionName: 'nextOfferId',
      })) as bigint
      const plan = planFor(predicted)
      const stake = STAKES[Number(predicted % BigInt(STAKES.length))]!
      const bond = stake / 5n
      const balance = await publicClient.getBalance({ address: maker.account.address })
      if (balance < stake + bond + GAS_CUSHION) return
      await sendAs(maker.publicClient, maker.wallet, {
        address: FLIPBOOK,
        abi: flipBookAbi,
        functionName: 'post',
        args: [commitFor(maker.account.address, plan.choice, plan.salt), bond, now + TAKE_DEADLINE_S, REVEAL_WINDOW_S],
        value: stake + bond,
      })
      markSelfPlay()
      console.log(`posted offer #${predicted} (${viem.formatEther(stake)} + ${viem.formatEther(bond)} bond${plan.forfeit ? ', destined to forfeit' : ''})`)
    }
  }

  const fullTick = async () => {
    await tick()
    await tickX().catch((e) => console.error(`x tick: ${(e as Error).message?.split('\n').slice(0, 3).join(' ¦ ')}`))
    if (xEnabled) console.log(`x: ws heads seen so far: ${wsHeadsSeen}`)
  }

  if (env.ONCE === 'true') {
    await fullTick()
    wsTransport?.close()
    return
  }
  for (;;) {
    await fullTick().catch((e) => console.error(`tick failed: ${(e as Error).message?.split('\n').slice(0, 3).join(' ¦ ')}`))
    const jitter = 0.5 + Math.random()
    await new Promise((resolve) => setTimeout(resolve, Math.round(INTERVAL_MS * jitter)))
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
