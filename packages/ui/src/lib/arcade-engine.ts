/**
 * arcade-engine.ts — the HEAVY half of the Arcade, lazy-loaded via dynamic `import()` from the
 * `Arcade` component so `@msgboard/games` + `@msgboard/settle` only enter the bundle when the tab opens.
 *
 * It drives ONE real board-mediated, commit-reveal coin-flip round against the landing house bot, at
 * ZERO stakes (play-money), mirroring the production player path (`games/web` `useSession` →
 * `makeBoardPlayerSession`):
 *
 *   requestOpen (post clientSeedCommit)  → house-signed OpenTerms (rngCommit = house's blind seed head)
 *   runPlayerSide + startServing          → co-sign OPEN (nonce 0) then ROUND (nonce 1) over the board
 *   houseDriver (reveal clientSeed)        → house drives the round, posts back the co-signed transcript
 *
 * FAIRNESS: this module NEVER computes an outcome or a fairness verdict of its own. The commit-reveal
 * check (`keccak256(serverSeed) === rngCommit`) and the anti-house-bias linchpin (`proof.clientSeed ===
 * the player's own committed seed`) are enforced inside `runPlayerSide`/`verifyProposedState`
 * (`@msgboard/games`). We only READ the co-signed ROUND state (via `onAccept`) and the signed transcript,
 * then present them. Every number shown is re-derivable from the public board transcript.
 */
import * as viem from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { categoryHash } from '@msgboard/sdk'
import {
  coinflip,
  runPlayerSide,
  makeDomain,
  commitSeed,
  roundRandom,
  verifyReveal,
  coinFlipSide,
  verifyFinishedSession,
  SESSION_STATE_TYPES,
  type BoardClient,
  type Signer,
  type SessionState,
  type RoundProof,
  type CoinFlipParams,
} from '@msgboard/games'
// Import from @msgboard/settle SUBPATHS, not the barrel: the barrel re-exports optimistic/escrowed/
// settlement, which statically import @msgboard/games-contracts artifacts (on-chain settlement the
// zero-stakes landing flip never uses). Pulling those into the bundle would force games-contracts
// (hardhat-heavy) into the build. These three files only touch boardProtocol/openTerms/@msgboard/games.
import { landingHouseCategory, isRoundTranscript } from '@msgboard/settle/boardProtocol'
import { makeBoardPlayerSession } from '@msgboard/settle/boardSession'
import { verifyOpenTermsSig } from '@msgboard/settle/openTerms'
import { otherSide, type FlipSide, type FlipFeedRecord } from './coinflip'

/**
 * The deployed 943 HouseChannel — the EIP-712 domain `verifyingContract` both the landing player and
 * the house bot bind to. It is NEVER called on-chain in optimistic (play-money) mode; it only anchors
 * the shared signing domain so both sides' co-signatures recover against the same address. Mirrors
 * `DEPLOYMENT_943.houseChannel` in `@msgboard/games-house-service` (liveConfig).
 */
export const LANDING_HOUSE_CHANNEL = '0xd0fe186fd3ad3d5766d2fd8af35215ab5d3dfc94' as viem.Hex

/**
 * The landing house bot's SIGNING address, pinned at build time via `VITE_LANDING_HOUSE_ADDRESS`.
 * When set: the player verifies the house's OpenTerms signature at open (so it's really playing the
 * deployed house, not a racer who substituted itself on the public category), and the public feed only
 * trusts transcripts this house co-signed. When UNSET (dev / undeployed): those pinned checks are skipped
 * — the commit-reveal math still guarantees a fair 50/50 regardless of who the counterparty is; only the
 * counterparty-identity assurance is off. Lowercased for direct comparison.
 */
export const LANDING_HOUSE_ADDRESS: viem.Hex | undefined = (() => {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env
  const a = (env?.VITE_LANDING_HOUSE_ADDRESS ?? '').trim()
  return /^0x[0-9a-fA-F]{40}$/.test(a) ? (a.toLowerCase() as viem.Hex) : undefined
})()

/** Nominal play-money stake per flip (fun-chips, base units). Nothing settles on-chain. */
export const FUN_STAKE = 100n

/** Starting play-money balance seeded into the UI (fun-chips). */
export const FUN_STARTING_BALANCE = 1000n

const ZERO32 = `0x${'00'.repeat(32)}` as viem.Hex

/** localStorage key for the EPHEMERAL player co-sign key — NOT a wallet, holds no funds, co-signs only. */
const PLAYER_KEY_STORAGE = 'arcade:coinflip:playerKey'

type KeyStore = Pick<Storage, 'getItem' | 'setItem'>

/**
 * Load (or first-time create) the ephemeral player co-sign key from localStorage. Generated with the
 * platform CSPRNG (`generatePrivateKey`), used ONLY to EIP-712 co-sign session states — no wallet
 * connection, no on-chain identity, no funds.
 */
export function loadOrCreatePlayerKey(store?: KeyStore): viem.Hex {
  const ls = store ?? (typeof localStorage !== 'undefined' ? localStorage : undefined)
  try {
    const existing = ls?.getItem(PLAYER_KEY_STORAGE)
    if (existing && /^0x[0-9a-fA-F]{64}$/.test(existing)) return existing as viem.Hex
  } catch {
    /* localStorage unavailable — fall through to a fresh in-memory key */
  }
  const key = generatePrivateKey()
  try {
    ls?.setItem(PLAYER_KEY_STORAGE, key)
  } catch {
    /* best-effort persistence; the round still works with an in-memory key */
  }
  return key
}

/**
 * The address of the persisted ephemeral player key — a STABLE pseudonymous identity across refreshes
 * (the key lives in localStorage; see {@link loadOrCreatePlayerKey}). Surfaced in the UI so the
 * persistence is visible: it is NOT regenerated per refresh, even though it holds no funds.
 */
export function loadPlayerAddress(store?: KeyStore): viem.Hex {
  return privateKeyToAccount(loadOrCreatePlayerKey(store)).address
}

/** Adapt a viem local account to the session `Signer` shape (binds the account to its signers). */
function accountSigner(account: ReturnType<typeof privateKeyToAccount>): Signer {
  return {
    address: account.address,
    signTypedData: (a) => account.signTypedData(a as Parameters<typeof account.signTypedData>[0]),
    signMessage: (a) => account.signMessage(a as Parameters<typeof account.signMessage>[0]),
  }
}

/** The four public handshake milestones surfaced as the Arcade's showcase progress. */
export type FlipStep = 'commit' | 'grant' | 'reveal' | 'transcript'

/** A finished, co-signed flip — everything the on-screen result + verify panel needs. */
export type FlipResult = {
  /** What the player called. */
  pick: FlipSide
  /** The face the co-signed round entropy landed on (parity of `raw`). */
  side: FlipSide
  /** pick === side, derived from the co-signed ROUND state (never fabricated). */
  win: boolean
  /** The co-signed player chip delta: win → +stake (2×), lose → −stake. */
  playerDelta: bigint
  /** The stake wagered (play-money). */
  stake: bigint
  /** The session/table id (public board anchor for this round). */
  tableId: viem.Hex
  // ── verify panel (all read from the co-signed OpenTerms / transcript) ──
  /** The house's blind server-seed commit, fixed at OPEN before the player revealed its seed. */
  rngCommit: viem.Hex
  /** The revealed server seed. */
  serverSeed: viem.Hex
  /** The player's client seed (must equal the one it committed — enforced by runPlayerSide). */
  clientSeed: viem.Hex
  /** The round entropy `roundRandom(serverSeed, clientSeed, 1)`. */
  raw: bigint
  /** `keccak256(serverSeed) === rngCommit` — the commit-reveal check the player already enforced. */
  commitOk: boolean
  /** The retained, doubly-co-signed transcript JSON — the player's own auditable book. */
  transcriptJson: string
}

export type RunFlipOpts = {
  /** The board seam (production: `makeWorkerBoard` PoW off-thread; tests: an in-memory board). */
  board: BoardClient
  /** Chain id — scopes the board category + the EIP-712 domain; must match the house bot's chain. */
  chainId: number
  /** The player's call. */
  pick: FlipSide
  /** Play-money stake (fun-chips). Defaults to `FUN_STAKE`. */
  stake?: bigint
  /** Ephemeral co-sign key. Defaults to the localStorage-backed one. */
  playerKey?: viem.Hex
  /** EIP-712 `verifyingContract`. Defaults to `LANDING_HOUSE_CHANNEL`. */
  houseChannel?: viem.Hex
  /** Expected house signer to pin the OpenTerms signature against. Defaults to `LANDING_HOUSE_ADDRESS`. */
  houseAddress?: viem.Hex
  /** Progress callback for the handshake showcase. */
  onStep?: (step: FlipStep) => void
  /**
   * Fires exactly ONCE the moment the ROUND is co-signed — i.e. the outcome is fully DECIDED (the
   * accepted state + verified proof carry the revealed serverSeed) — which happens BEFORE the house
   * posts the transcript to the board. The UI reveals the result + freezes its wall-clock here, so the
   * "you won" celebration lands at the decided moment and the transcript-settle is an ancillary tail.
   * The passed result carries an empty `transcriptJson` (the retained transcript is only in the final
   * return value); nothing displayed depends on it.
   */
  onDecided?: (result: FlipResult) => void
  pollMs?: number
  timeoutMs?: number
}

/**
 * Run ONE real coin-flip round against the house bot over the board and return the co-signed result.
 * Every flip is a fresh session (new tableId + CSPRNG clientSeed) → OPEN (nonce 0) + ROUND (nonce 1),
 * yielding a signed transcript. Throws if the house never completes the round (caller surfaces "house
 * didn't respond — round void, try again").
 */
export async function runBoardFlip(opts: RunFlipOpts): Promise<FlipResult> {
  const { board, chainId, pick } = opts
  const stake = opts.stake ?? FUN_STAKE
  const account = privateKeyToAccount(opts.playerKey ?? loadOrCreatePlayerKey())
  const player = accountSigner(account)
  // SECURITY: CSPRNG per-session client seed — never Math.random, never reused, never house-supplied.
  const clientSeed = generatePrivateKey()
  const tableId = viem.keccak256(
    viem.stringToHex(`mbg:coinflip:${Date.now()}:${account.address}:${generatePrivateKey()}`),
  )
  const domain = makeDomain(chainId, opts.houseChannel ?? LANDING_HOUSE_CHANNEL)
  const category = landingHouseCategory(chainId)
  const params: CoinFlipParams = { pick }

  // onAccept fires AFTER the player co-signs each state (OPEN then ROUND). We capture BOTH the ROUND
  // state (nonce > 0) and its RoundProof — the proof `runPlayerSide`/`verifyProposedState` already
  // validated (reveal-checked serverSeed + the clientSeed linchpin) BEFORE the player signed. Every
  // displayed value is derived from this verified proof, never from the house's re-posted transcript
  // string, so a lying transcript can't make the shown seed/side disagree with the co-signed outcome.
  let acceptedRound: SessionState | undefined
  let acceptedProof: RoundProof<CoinFlipParams> | undefined
  // `fireDecided` is wired up once the OpenTerms are known (below); onAccept invokes it the instant the
  // ROUND is co-signed so `onDecided` lands before the transcript post. Guarded to fire exactly once.
  let decidedFired = false
  let fireDecided: (() => void) | null = null
  const session = makeBoardPlayerSession({
    board,
    chainId,
    tableId,
    category,
    pollMs: opts.pollMs,
    timeoutMs: opts.timeoutMs,
    onAccept: (s, p) => {
      if (s.nonce > 0n) {
        acceptedRound = s
        acceptedProof = p as RoundProof<CoinFlipParams> | undefined
        fireDecided?.()
      }
    },
  })

  // 1. OPEN handshake: post the clientSeed COMMIT only (never the plaintext) → house-signed OpenTerms.
  opts.onStep?.('commit')
  const houseAddress = opts.houseAddress ?? LANDING_HOUSE_ADDRESS
  const { terms, houseSig } = await session.requestOpen({
    tableId,
    player: account.address,
    playerKey: account.address,
    gameId: coinflip.gameId,
    params,
    stake,
    clientSeedCommit: commitSeed(clientSeed),
  })
  // Pin the counterparty: when we know the landing house's address, the OpenTerms MUST be signed by it.
  // Otherwise a racer on the public category substituted itself as the house. (Fairness holds either way
  // via commit-reveal; this asserts you're actually playing the deployed house bot.)
  if (houseAddress && !(await verifyOpenTermsSig(houseAddress, domain, terms, houseSig))) {
    throw new Error('coinflip: OpenTerms not signed by the expected landing house — aborting (possible counterparty substitution)')
  }
  opts.onStep?.('grant')

  // Build a FlipResult from the co-signed ROUND state + its verified proof. The outcome is authoritative
  // the moment the ROUND is accepted (the proof is reveal- and linchpin-checked BEFORE the player signs),
  // so nothing here trusts the house-posted `transcript` string — it's retained only as the artifact.
  const buildResult = (round: SessionState, proof: RoundProof<CoinFlipParams>, transcript: string): FlipResult => {
    const playerDelta = round.balancePlayer - terms.escrowPlayer
    const serverSeed = proof.serverSeed
    const clientSeedUsed = proof.clientSeed
    const raw = roundRandom(serverSeed, clientSeedUsed, round.nonce)
    return {
      pick,
      side: coinFlipSide(raw),
      win: playerDelta > 0n,
      playerDelta,
      stake,
      tableId,
      rngCommit: terms.rngCommit,
      serverSeed,
      clientSeed: clientSeedUsed,
      raw,
      commitOk: verifyReveal(terms.rngCommit, serverSeed),
      transcriptJson: transcript,
    }
  }
  // Now that the OpenTerms are known, arm the decided-fire. onAccept calls this the instant the ROUND is
  // co-signed (mid-houseDriver, before the transcript post) → the UI celebrates + freezes its clock there.
  fireDecided = () => {
    if (decidedFired || !acceptedRound || !acceptedProof) return
    decidedFired = true
    opts.onDecided?.(buildResult(acceptedRound, acceptedProof, ''))
  }
  fireDecided() // no-op unless the ROUND was already accepted synchronously

  const openBalances = { player: terms.escrowPlayer, house: terms.escrowHouse }

  // 2. Serve the co-sign channel + drive the round. runPlayerSide independently RE-DERIVES and verifies
  // every state before signing (commit-reveal + the clientSeed linchpin); a bad house state makes it
  // reject, which surfaces as the houseDriver timeout below.
  let playerErr: unknown
  runPlayerSide(
    {
      domain,
      tableId,
      game: coinflip,
      player,
      houseRemote: true as const,
      clientSeed,
      seedTip: ZERO32,
      chainLength: 1,
      openBalances,
      settlementMode: 0,
    },
    session.playerT,
  ).catch((e) => {
    playerErr = e
  })
  const stopServing = session.startServing()

  opts.onStep?.('reveal')
  let transcriptJson: string
  try {
    transcriptJson = await session.houseDriver<CoinFlipParams>({
      stake,
      params,
      clientSeed,
      playerAddress: account.address,
    })
  } finally {
    stopServing()
  }
  opts.onStep?.('transcript')

  if (!acceptedRound || !acceptedProof) {
    throw playerErr instanceof Error
      ? playerErr
      : new Error('coinflip: no co-signed ROUND state (house did not complete the round)')
  }

  // The transcript has now landed. The authoritative result was already computed at the decided moment
  // (onDecided) — here we return it WITH the retained transcript for the caller's auditable book. Ensure
  // onDecided fired (no-op if it already did during houseDriver).
  fireDecided()
  return buildResult(acceptedRound, acceptedProof, transcriptJson)
}

/** The board category hash for the landing coin-flip feed on `chainId` (what the content poll keys by). */
export function landingCategoryHash(chainId: number): viem.Hex {
  return categoryHash(landingHouseCategory(chainId).category) as viem.Hex
}

/**
 * The set of tableIds that have a round-transcript posted in the given board messages, lowercased.
 *
 * SECURITY: this is a STRUCTURAL read used ONLY to confirm that a round the player already played and
 * cryptographically verified this session actually landed on the public board (an "on board ✓" badge).
 * It deliberately trusts NOTHING about outcomes/seeds — the board category is public and anyone can post
 * a `round-transcript`, so a naive decode of foreign transcripts would render fabricated "flips" as real
 * (any account could forge invented seeds/win). We therefore never surface un-self-verified board data;
 * the feed is built from the player's OWN verified `FlipResult`s, and this only badges which of those are
 * confirmed present on the board. (A house-address-pinned `verifyFinishedSession` over ALL posters'
 * transcripts — a verified public feed — is a follow-up that needs the landing house's signing address.)
 */
export function postedTableIds(messages: ReadonlyArray<{ data: viem.Hex }>): Set<string> {
  const ids = new Set<string>()
  for (const m of messages) {
    try {
      const wire = JSON.parse(viem.hexToString(m.data)) as unknown
      if (!isRoundTranscript(wire)) continue
      const id = (wire as { tableId?: unknown }).tableId
      if (typeof id === 'string') ids.add(id.toLowerCase())
    } catch {
      /* not a round-transcript envelope — skip */
    }
  }
  return ids
}

type SigPair = { player: viem.Hex; house: viem.Hex }
type OpenBody = {
  rngCommit: viem.Hex
  settlementMode?: number
  balances: { player: string; house: string }
  sigs?: SigPair
}
type RoundBody = {
  round?: number
  serverSeed: viem.Hex
  clientSeed: viem.Hex
  outcome?: { win?: boolean }
}
type TranscriptEnvelope = { kind: string; from?: string; body: Record<string, unknown> }

/**
 * Decode recent board round-transcripts into feed records — a genuinely PUBLIC, house-verified feed.
 *
 * Each transcript is fully re-audited with `verifyFinishedSession` PINNED to the landing house's address:
 * the co-signatures must recover to {the transcript's player, THIS house}, the reveal chain must hold, and
 * the recorded outcome must recompute from the revealed seeds. Because an attacker can't forge the house's
 * signature, any transcript that verifies genuinely came from a real round against the deployed house — so
 * foreign/fabricated posts on the public category (the pre-fix spoof) are rejected. Async (per-entry
 * signature recovery). Requires the house address; without it, callers fall back to own-verified rounds.
 */
export async function decodeVerifiedFeed(
  messages: ReadonlyArray<{ data: viem.Hex }>,
  opts: { houseAddress: viem.Hex; chainId: number; houseChannel?: viem.Hex; limit?: number },
): Promise<FlipFeedRecord[]> {
  const domain = makeDomain(opts.chainId, opts.houseChannel ?? LANDING_HOUSE_CHANNEL)
  const house = opts.houseAddress.toLowerCase()
  const out: FlipFeedRecord[] = []
  for (const m of messages) {
    try {
      const wire = JSON.parse(viem.hexToString(m.data)) as unknown
      if (!isRoundTranscript(wire)) continue
      const { tableId, transcriptJson } = wire as { tableId: viem.Hex; transcriptJson: string }
      const t = JSON.parse(transcriptJson) as { tableId?: viem.Hex; entries?: TranscriptEnvelope[] }
      const entries = t.entries ?? []
      const open = entries.find((e) => e.kind === 'OPEN')
      const round = entries.find((e) => e.kind === 'ROUND')
      const ob = open?.body as OpenBody | undefined
      if (!ob?.sigs?.player || !round?.body || !ob.balances || !t.tableId) continue
      // Recover the player's address from the OPEN co-signature: reconstruct the OPEN SessionState EXACTLY
      // as verifyFinishedSession does, then recover who signed the player slot. (verifyFinishedSession
      // needs both parties; the house is our pinned address, the player is recovered here.) A wrong
      // reconstruction just yields a bad address → verifyFinishedSession fails → the round is dropped
      // (fail-closed), never mis-shown.
      const openState = {
        tableId: t.tableId, nonce: 0n,
        balancePlayer: BigInt(ob.balances.player), balanceHouse: BigInt(ob.balances.house),
        settlementMode: Number(ob.settlementMode ?? 0),
        gameId: coinflip.gameId, gameStateHash: ZERO32, rngCommit: ob.rngCommit,
      }
      const player = await viem.recoverTypedDataAddress({
        domain, types: SESSION_STATE_TYPES, primaryType: 'SessionState', message: openState, signature: ob.sigs.player,
      })
      // Full audit, PINNED to our house: co-sigs recover to {player, THIS house}, reveal chain holds,
      // outcome recomputes. Un-forgeable house sig ⇒ only genuine rounds vs the deployed house survive.
      const ok = await verifyFinishedSession(transcriptJson, {
        parties: { player, house: opts.houseAddress }, commit: ob.rngCommit, game: coinflip, domain,
      })
      if (!ok || player.toLowerCase() === house) continue
      const rb = round.body as RoundBody
      const raw = roundRandom(rb.serverSeed, rb.clientSeed, BigInt(rb.round ?? 1))
      const side = coinFlipSide(raw)
      const win = !!rb.outcome?.win
      out.push({ pick: win ? side : otherSide(side), side, win, tableId })
    } catch {
      /* undecodable / failed verification — skip */
    }
  }
  const limit = opts.limit ?? 8
  return out.slice(-limit).reverse()
}
