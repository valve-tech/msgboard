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
  type BoardClient,
  type Signer,
  type SessionState,
  type RoundProof,
  type CoinFlipParams,
} from '@msgboard/games'
import {
  makeBoardPlayerSession,
  landingHouseCategory,
  isRoundTranscript,
} from '@msgboard/settle'
import { type FlipSide } from './coinflip'

/**
 * The deployed 943 HouseChannel — the EIP-712 domain `verifyingContract` both the landing player and
 * the house bot bind to. It is NEVER called on-chain in optimistic (play-money) mode; it only anchors
 * the shared signing domain so both sides' co-signatures recover against the same address. Mirrors
 * `DEPLOYMENT_943.houseChannel` in `@msgboard/games-house-service` (liveConfig).
 */
export const LANDING_HOUSE_CHANNEL = '0xd0fe186fd3ad3d5766d2fd8af35215ab5d3dfc94' as viem.Hex

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
  /** Progress callback for the handshake showcase. */
  onStep?: (step: FlipStep) => void
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
      }
    },
  })

  // 1. OPEN handshake: post the clientSeed COMMIT only (never the plaintext) → house-signed OpenTerms.
  opts.onStep?.('commit')
  const { terms } = await session.requestOpen({
    tableId,
    player: account.address,
    playerKey: account.address,
    gameId: coinflip.gameId,
    params,
    stake,
    clientSeedCommit: commitSeed(clientSeed),
  })
  opts.onStep?.('grant')

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

  // ── outcome + verify-panel inputs, ALL from the co-signed ROUND state + its VERIFIED proof ──────────
  // playerDelta/win from the co-signed balances; seeds from the proof runPlayerSide already reveal- and
  // linchpin-checked. Nothing here trusts `transcriptJson` (the house-posted string) — it's retained
  // only as the auditable artifact. So the shown seed/side can never diverge from the co-signed result.
  const playerDelta = acceptedRound.balancePlayer - terms.escrowPlayer
  const win = playerDelta > 0n
  const serverSeed = acceptedProof.serverSeed
  const clientSeedUsed = acceptedProof.clientSeed
  const raw = roundRandom(serverSeed, clientSeedUsed, acceptedRound.nonce)
  const side = coinFlipSide(raw)
  const commitOk = verifyReveal(terms.rngCommit, serverSeed)

  return {
    pick,
    side,
    win,
    playerDelta,
    stake,
    tableId,
    rngCommit: terms.rngCommit,
    serverSeed,
    clientSeed: clientSeedUsed,
    raw,
    commitOk,
    transcriptJson,
  }
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
