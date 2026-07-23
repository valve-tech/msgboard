import { useCallback, useMemo, useRef, useState } from 'react'
import * as viem from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { useBoardBroadcaster } from './useBoardBroadcaster'
import {
  MsgBoardTransport,
  makeDomain,
  runPlayerSide,
  runHouseSide,
  type BoardClient,
  type Game,
  type Signer,
  type CoSignTransport,
  type SessionState,
  type RoundProof,
} from '@msgboard/games'
import { buildOpenRequest, DUMMY_SEED_TIP } from '../lib/playerCoSign'
import { saveClientSeed, removeClientSeed, type SeedStore } from '../lib/clientSeeds'

/**
 * Drives a split co-sign session game in the browser. The PLAYER holds its own key; the HOUSE
 * key is REMOTE — it lives on the house machine and never enters the browser. Co-signatures are
 * exchanged over a `CoSignTransport` backed by a `MsgBoardTransport`.
 *
 * Security model:
 *  1. CSPRNG clientSeed: `generatePrivateKey()` (platform CSPRNG) is called per-session in
 *     `start()`. The clientSeed is NEVER derived from Math.random or a house-supplied value.
 *  2. Commit-only at open: only `keccak256(clientSeed)` (= `commitSeed(clientSeed)`) is sent
 *     in the open-request. The raw seed stays in memory (+ localStorage backup) and is sent
 *     to the house ONLY at round time — after the open co-sig has fixed `terms.rngCommit`.
 *  3. Refund-floor consistency: when `assertEscrowBalances` is provided, `start()` asserts
 *     `openBalances === { player: terms.escrowPlayer, house: terms.escrowHouse }` before
 *     building the session config. Throws if they diverge so the refund floor is always safe.
 *
 * Game-agnostic: the only game-specific bit is the `Game<TParams>` module passed in. All
 * game screens (Dice, Limbo, Plinko, Keno, …) plug in by supplying their `Game` module + params UI.
 */

/** One settled round, surfaced for the receipt/history UI. Game-agnostic. */
export type RoundRecord = {
  round: number
  stake: bigint
  /** the per-round randomness the outcome was computed from (post-reveal). */
  raw: bigint
  win: boolean
  playerDelta: bigint
  multiplierX100: bigint
  /** running co-signed balance after this round. */
  balancePlayer: bigint
  balanceHouse: bigint
  /**
   * per-round wall-clock timing, derived from the round envelope's non-signed `.timing` metadata.
   */
  timing?: { decisionMs?: number; networkMs?: number; totalMs?: number }
}

export type SessionStatus = 'idle' | 'opening' | 'open' | 'playing' | 'error'

export type SessionApi<TParams> = {
  status: SessionStatus
  error?: string
  /** true once OPEN is co-signed and the table is ready to play. */
  ready: boolean
  /** rounds played so far this session, newest last. */
  history: RoundRecord[]
  /** live co-signed balances; undefined before the table opens. */
  balances?: { player: bigint; house: bigint }
  /** the published server-seed commit for this session (provably-fair anchor). */
  commit?: viem.Hex
  /** rounds remaining in the committed seed chain. */
  roundsLeft: number
  /** open a fresh table (new seed chain, new house key, new transcript). */
  start: () => Promise<void>
  /** play one round with this game's params; resolves to the round it produced. */
  play: (stake: bigint, params: TParams) => Promise<RoundRecord | undefined>
  /** the retained transcript JSON — the player's own auditable book. */
  transcriptJson: () => string | undefined
}

/** Input passed to the injected house driver for each round. */
export type HouseDriverInput<TParams> = {
  stake: bigint
  params: TParams
  clientSeed: viem.Hex
  tableId: viem.Hex
  currentBalances: { player: bigint; house: bigint }
  playerAddress: viem.Hex
  houseT: CoSignTransport
}

/**
 * Injectable house co-sign driver. Receives round inputs (including the in-memory houseT
 * transport half) and returns a finished co-signed transcript JSON string.
 *
 * SECURITY: The browser production path must NEVER use a hardcoded house key here.
 * Production: implement a board-backed driver (TODO Task 9/live).
 * Tests/demo: inject makeInMemoryHouseDriver(game, cfg).
 */
export type HouseDriver<TParams> = (input: HouseDriverInput<TParams>) => Promise<string>

export type UseSessionConfig<TParams> = {
  game: Game<TParams>
  /** the injected wallet — the player. Undefined until connected. */
  walletClient?: viem.WalletClient
  chainId: number
  /**
   * HouseChannel contract address — the EIP-712 `verifyingContract` for the session domain.
   * Sessions bind co-signatures to this address so the player's worst case is always "reclaim
   * my stake" via disputeFromOpen. Pass `deployment.houseChannel` from config.
   *
   * When provided this takes precedence over the deprecated `verifyingContract` field.
   * Falls back to `PLACEHOLDER_VERIFIER` only when absent (dev/headless/test contexts).
   */
  houseChannel?: viem.Hex
  /**
   * @deprecated Pass `houseChannel` instead. This field is retained for backward compatibility
   * but is overridden by `houseChannel` when both are present.
   */
  verifyingContract?: viem.Hex
  /** how many rounds the committed seed chain affords. */
  chainLength?: number
  /**
   * Opening chip balances co-signed into the first state.
   *
   * SECURITY — refund-floor consistency: these MUST equal the on-chain escrow amounts
   * (terms.escrowPlayer / terms.escrowHouse) when using a real HouseChannel. The hook
   * asserts this when `assertEscrowBalances` is provided. See start().
   */
  openBalances?: { player: bigint; house: bigint }
  /**
   * When provided, `start()` asserts that `openBalances` matches these on-chain escrow amounts
   * before building the session config. Pass `{ player: terms.escrowPlayer, house: terms.escrowHouse }`
   * from the house's reviewOpen response. Throws if they diverge.
   */
  assertEscrowBalances?: { player: bigint; house: bigint }
  /** transport client; defaults to an in-memory board so play works headlessly. */
  boardClient?: BoardClient
  /** MsgBoard RPC for the live lobby feed — when set, opening a table posts an `open` notice (PoW in
   *  a Web Worker, never the UI thread). Absent → no broadcast. */
  boardRpc?: string
  /** short game name used in the lobby notice (e.g. 'dice'). Defaults to `game-<gameId>`. */
  gameLabel?: string
  /** localStorage-compatible store for persisting the clientSeed across page refreshes.
   *  Defaults to `window.localStorage` in the browser. Inject a Map-backed fake in tests. */
  seedStore?: SeedStore
  /**
   * Injectable house co-sign driver. Receives round inputs and returns finished co-signed
   * transcript JSON. REQUIRED in production (board-backed) and in tests (inject
   * makeInMemoryHouseDriver). When absent, play() throws with a clear message.
   *
   * SECURITY: Never hardcode a house key in the production browser path.
   * TODO(Task 9/live): implement the board-backed production driver.
   */
  houseDriver?: HouseDriver<TParams>
}

const ZERO_ADDR = '0x0000000000000000000000000000000000000000' as viem.Hex
/** Sentinel used when no HouseChannel address is available (dev/headless/test contexts). */
export const PLACEHOLDER_VERIFIER = '0x00000000000000000000000000000000000a3eb1' as viem.Hex

/**
 * Demo-only house signing key for the in-process co-sign demo (Task 7).
 *
 * IMPORTANT: this is NOT the production house key. The real house key lives on the house
 * machine and never enters the browser. This key is used ONLY to simulate the house side
 * in the local demo / dev environment where no house server is running. In production this
 * entire block is replaced by a round-trip to the house server over the board transport.
 */
const DEMO_HOUSE_KEY = `0x${'de'.repeat(32)}` as viem.Hex

/**
 * Demo seed tip for the in-process demo house (paired with DEMO_HOUSE_KEY above).
 * The player never sees this — it sees only the derived rngCommit in the OPEN state.
 */
const DEMO_SEED_TIP = `0x${'55'.repeat(32)}` as viem.Hex

/**
 * The address of the demo house derived from DEMO_HOUSE_KEY.
 * Exported so tests and screens can build ReplayContext / EscrowedSettlement without re-deriving it.
 */
export const DEMO_HOUSE_ADDRESS = privateKeyToAccount(DEMO_HOUSE_KEY).address

/**
 * Resolve the EIP-712 `verifyingContract` for a session.
 *
 * Priority: `houseChannel` (from the deployment) > deprecated `verifyingContract` > `PLACEHOLDER_VERIFIER`.
 *
 * Exported for unit-testing — the hook calls this internally.
 */
export function resolveVerifyingContract(
  houseChannel?: viem.Hex,
  verifyingContractProp?: viem.Hex,
): viem.Hex {
  return houseChannel ?? verifyingContractProp ?? PLACEHOLDER_VERIFIER
}

/** Adapt the injected viem WalletClient to the session `Signer` shape by binding its account. */
const walletClientToSigner = (client: viem.WalletClient): Signer => {
  const account = client.account
  if (!account) throw new Error('wallet client has no account')
  return {
    address: account.address,
    signTypedData: (args: Parameters<viem.WalletClient['signTypedData']>[0]) =>
      client.signTypedData({ ...args, account }),
    signMessage: (args: { message: { raw: viem.Hex } }) => client.signMessage({ ...args, account }),
  }
}

/** A minimal in-memory `BoardClient` — same surface a real `MsgBoardClient` exposes to the transport.
 *  Used as a fallback when no real boardClient is provided (headless / test mode). */
const inMemoryBoardClient = (): BoardClient => {
  const store: Record<string, Array<{ data: viem.Hex }>> = {}
  return {
    async addMessage(seed: { category: viem.Hex; data: viem.Hex }) {
      ;(store[seed.category] ??= []).push({ data: seed.data })
      return seed.data
    },
    async content(filter: { category?: viem.Hex }) {
      if (filter.category) return { [filter.category]: store[filter.category] ?? [] }
      return store
    },
  }
}

/**
 * Generate a cryptographically secure per-session client seed.
 *
 * SECURITY: uses `generatePrivateKey()` which is backed by the platform CSPRNG (crypto.getRandomValues
 * in the browser, node:crypto in Node). Never Math.random.
 *
 * The returned seed is committed at open time (only keccak256(seed) is sent to the house) and
 * revealed to the house only at round time — after the open co-sig has fixed `terms.rngCommit`
 * on-chain. This prevents the house from grinding its seed tip against a known clientSeed.
 */
const generateClientSeed = (): viem.Hex => generatePrivateKey()

/**
 * The reference session hook. Adding a new session-game screen is then ~mechanical:
 *   const session = useSession({ game: dice, walletClient, chainId, verifyingContract: deployment.houseChannel })
 *   // render params UI, call session.play(stake, params) on the action.
 */
export const useSession = <TParams>(config: UseSessionConfig<TParams>): SessionApi<TParams> => {
  const {
    game,
    walletClient,
    chainId,
    houseChannel,
    verifyingContract: verifyingContractProp,
    chainLength = 64,
    openBalances = { player: 10n ** 18n, house: 10n ** 21n },
    assertEscrowBalances,
    boardClient,
    boardRpc,
    gameLabel,
    seedStore,
    houseDriver,
  } = config

  // Resolve the EIP-712 verifyingContract from houseChannel (preferred) or the deprecated
  // verifyingContract prop, falling back to PLACEHOLDER_VERIFIER only in dev/headless contexts
  // where neither is available. In production, deployment.houseChannel should always be set.
  const verifyingContract = resolveVerifyingContract(houseChannel, verifyingContractProp)
  const broadcastLobby = useBoardBroadcaster({ boardRpc, chainId })

  const [status, setStatus] = useState<SessionStatus>('idle')
  const [error, setError] = useState<string>()
  const [history, setHistory] = useState<RoundRecord[]>([])
  const [balances, setBalances] = useState<{ player: bigint; house: bigint }>()
  const [commit, setCommit] = useState<viem.Hex>()
  const [roundsLeft, setRoundsLeft] = useState(0)

  // Mutable session state — engine state that changes on every round, not render state.
  const clientSeedRef = useRef<viem.Hex>()
  const tableIdRef = useRef<viem.Hex>()
  const transcriptRef = useRef<string>()
  const busy = useRef(false)

  // Co-sign transport pair: houseT drives the house side, playerT serves the player side.
  // Set by start(), consumed by play(). Each call to start() creates a fresh pair.
  const coSignPairRef = useRef<{ playerT: CoSignTransport; houseT: CoSignTransport }>()
  // The last co-signed ROUND SessionState (nonce > 0) accepted by the player side.
  // Captured in buildCoSignPair's onAccept callback and read by play() to derive the RoundRecord.
  const acceptedRoundStateRef = useRef<SessionState>()

  // The transport board is stable for the hook's lifetime (in-memory fallback unless one is passed).
  const board = useMemo(() => boardClient ?? inMemoryBoardClient(), [boardClient])

  const start = useCallback(async () => {
    if (!walletClient) {
      setError('connect a wallet to open a table')
      return
    }
    if (busy.current) return
    busy.current = true
    setStatus('opening')
    setError(undefined)
    try {
      const player = walletClientToSigner(walletClient)

      // ── SECURITY 3: refund-floor consistency ──────────────────────────────
      // Assert openBalances === on-chain escrow amounts before building the session config.
      // If they diverge, the off-chain nonce-0 co-signed refund floor != the on-chain
      // disputeFromOpen floor, meaning the player cannot reclaim the full stake on dispute.
      if (assertEscrowBalances) {
        if (
          openBalances.player !== assertEscrowBalances.player ||
          openBalances.house !== assertEscrowBalances.house
        ) {
          throw new Error(
            `openBalances (player=${openBalances.player}, house=${openBalances.house}) ` +
            `must equal on-chain escrow amounts (player=${assertEscrowBalances.player}, ` +
            `house=${assertEscrowBalances.house}) for the refund floor to be safe`,
          )
        }
      }

      // ── SECURITY 1: CSPRNG clientSeed per session ─────────────────────────
      // Never reuse, never derive from Math.random, never use a house-supplied value.
      const clientSeed = generateClientSeed()
      const tableId = viem.keccak256(
        viem.stringToHex(`mbg:${Date.now()}:${player.address}`)
      ) as viem.Hex

      // Persist the client seed to localStorage (mirrors Raffle salt backup) so a page refresh
      // mid-session doesn't lose the ability to play. Removed after the round completes.
      const store = seedStore ?? (typeof localStorage !== 'undefined' ? localStorage : undefined)
      if (store) saveClientSeed(store, chainId, tableId, clientSeed)
      clientSeedRef.current = clientSeed
      tableIdRef.current = tableId

      // ── SECURITY 2: commit-only open-request ─────────────────────────────
      // Build the open-request with clientSeedCommit = keccak256(clientSeed). Send it to the
      // house via the board transport. The house sees ONLY the commit at open time, so it cannot
      // grind its seed tip against a known clientSeed to bias the outcome.
      const openReq = buildOpenRequest(tableId, clientSeed)
      const boardTransport = new MsgBoardTransport(board, tableId)
      await boardTransport.send(openReq)

      // Build the in-memory co-sign pair and launch runPlayerSide.
      // The onAccept callback captures the accepted ROUND state (nonce > 0) so play() can derive
      // the RoundRecord from the real co-signed outcome rather than a fabricated literal.
      const { playerT, houseT } = buildCoSignPair((state) => {
        if (state.nonce > 0n) {
          acceptedRoundStateRef.current = state
        }
      })
      coSignPairRef.current = { playerT, houseT }
      acceptedRoundStateRef.current = undefined

      const domain = makeDomain(chainId, verifyingContract)
      // Launch the player side. It registers a listener (via playerT.serve) that co-signs OPEN
      // then ROUND as the house drives them via houseT.request. If the house sends a tampered
      // state or substituted clientSeed, runPlayerSide throws — the .catch surfaces this to the
      // UI via setError so the player sees the rejection, never a swallowed unhandled rejection.
      runPlayerSide(
        { domain, tableId, game, player, houseRemote: true as const, clientSeed,
          seedTip: DUMMY_SEED_TIP, chainLength, openBalances, settlementMode: 1 },
        playerT,
      ).catch((err) => setError(err instanceof Error ? err.message : String(err)))

      setCommit(undefined) // rngCommit comes from the house's seed chain; set when received
      setBalances(openBalances)
      setHistory([])
      setRoundsLeft(chainLength)
      setStatus('open')
      broadcastLobby({
        kind: 'open',
        game: gameLabel ?? `game-${game.gameId}`,
        tableId,
        commit: undefined,
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStatus('error')
    } finally {
      busy.current = false
    }
  }, [walletClient, chainId, houseChannel, verifyingContractProp, game, chainLength, openBalances, assertEscrowBalances, board, boardRpc, gameLabel, seedStore, verifyingContract])

  const play = useCallback(
    async (stake: bigint, params: TParams): Promise<RoundRecord | undefined> => {
      const clientSeed = clientSeedRef.current
      const tableId = tableIdRef.current
      const pair = coSignPairRef.current
      if (!clientSeed || !tableId || !pair) {
        setError('open a table first')
        return undefined
      }
      if (busy.current) return undefined
      busy.current = true
      setStatus('playing')
      setError(undefined)
      try {
        const currentBalances = balances ?? openBalances

        // ── House co-sign: call the injected driver ──────────────────────────────────
        // The driver holds the houseT transport (set up in start()) and drives one round,
        // returning the finished co-signed transcript JSON. In tests/demo the caller injects
        // makeInMemoryHouseDriver; in production this posts over the board.
        if (!houseDriver) {
          throw new Error(
            'useSession: no houseDriver injected. ' +
            'For tests/demo inject makeInMemoryHouseDriver(game, cfg) from this module. ' +
            'TODO(Task 9/live): implement the board-backed production driver.',
          )
        }
        const playerAddress = walletClient?.account?.address ?? viem.zeroAddress
        const json = await houseDriver({
          stake,
          params,
          clientSeed,
          tableId,
          currentBalances,
          playerAddress,
          houseT: pair.houseT,
        })
        transcriptRef.current = json

        // Derive the RoundRecord from the co-signed ROUND SessionState captured in
        // buildCoSignPair's onAccept callback. NEVER fabricated — this is the state both parties
        // signed, so it is exactly what the contract would settle.
        const roundState = acceptedRoundStateRef.current
        if (!roundState) throw new Error('play: no accepted ROUND state after co-sign')

        const prevBalance = currentBalances.player
        const record: RoundRecord = {
          round: Number(roundState.nonce),
          stake,
          raw: 0n, // raw entropy is in the transcript body; not needed for the UI record
          win: roundState.balancePlayer > prevBalance,
          playerDelta: roundState.balancePlayer - prevBalance,
          multiplierX100: 0n, // can be parsed from transcript body if needed by the UI
          balancePlayer: roundState.balancePlayer,
          balanceHouse: roundState.balanceHouse,
          timing: undefined,
        }

        setHistory((h) => [...h, record])
        setBalances({ player: roundState.balancePlayer, house: roundState.balanceHouse })
        setRoundsLeft((n) => Math.max(0, n - 1))

        // Clean up the persisted client seed once the round completes.
        const store = seedStore ?? (typeof localStorage !== 'undefined' ? localStorage : undefined)
        if (store) removeClientSeed(store, chainId, tableId)

        setStatus('open')
        return record
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        setStatus('error')
        return undefined
      } finally {
        busy.current = false
      }
    },
    [chainId, openBalances, balances, seedStore, game, walletClient, verifyingContract, chainLength, houseDriver],
  )

  const transcriptJson = useCallback(() => transcriptRef.current, [])

  return {
    status,
    error,
    ready: status === 'open' || status === 'playing',
    history,
    balances,
    commit,
    roundsLeft,
    start,
    play,
    transcriptJson,
  }
}

/**
 * Build a linked in-memory CoSignTransport pair for session co-signing.
 * `houseT` is used by the house side (calls `request`); `playerT` is used by the player
 * side (calls `serve`). In production, both would be backed by the board transport.
 *
 * This mirrors `memoryCoSignPair` in @msgboard/games/test/helpers but is defined here
 * for production use without importing test-only code.
 *
 * @param onAccept Optional callback invoked AFTER the player successfully signs a state.
 *   Called with the accepted SessionState and its proof. Used by useSession to capture the
 *   co-signed ROUND state (nonce > 0) so play() can derive the RoundRecord from it.
 */
function buildCoSignPair(
  onAccept?: (state: SessionState, proof?: RoundProof<unknown>) => void,
): { houseT: CoSignTransport; playerT: CoSignTransport } {
  type Pending = {
    state: SessionState
    proof?: RoundProof<unknown>
    resolve: (sig: viem.Hex) => void
    reject: (err: unknown) => void
  }
  const queue: Pending[] = []
  const waiters: Array<(p: Pending) => void> = []

  const push = (p: Pending) => {
    const w = waiters.shift()
    if (w) w(p)
    else queue.push(p)
  }
  const pull = (): Promise<Pending> =>
    new Promise((res) => {
      const q = queue.shift()
      if (q) res(q)
      else waiters.push(res)
    })

  const houseT: CoSignTransport = {
    request: (state, proof) =>
      new Promise<viem.Hex>((resolve, reject) => push({ state, proof, resolve, reject })),
    serve: () => {
      throw new Error('houseT.serve is not used in this pair')
    },
  }

  const playerT: CoSignTransport = {
    request: () => {
      throw new Error('playerT.request is not used in this pair')
    },
    serve: (sign) => {
      const loop = async () => {
        for (;;) {
          const p = await pull()
          try {
            const sig = await sign(p.state, p.proof)
            // Notify the caller that the player accepted this state BEFORE resolving,
            // so the caller can capture it before runHouseSide's await returns.
            onAccept?.(p.state, p.proof)
            p.resolve(sig)
          } catch (err) {
            p.reject(err)
          }
        }
      }
      void loop()
    },
  }

  return { houseT, playerT }
}

/**
 * Create an in-memory house driver for TESTS and DEMO use only.
 *
 * Drives `runHouseSide` using the demo keys (DEMO_HOUSE_KEY, DEMO_SEED_TIP) over the
 * in-memory houseT transport passed in HouseDriverInput. Always uses settlementMode: 1.
 *
 * SECURITY: Uses DEMO_HOUSE_KEY. NEVER use in production. Only inject in test harnesses
 * and the local dev demo where no house service is running.
 */
export function makeInMemoryHouseDriver<TParams>(
  game: Game<TParams>,
  baseCfg: {
    domain: ReturnType<typeof makeDomain>
    chainLength: number
  },
): HouseDriver<TParams> {
  const demoHouseAccount = privateKeyToAccount(DEMO_HOUSE_KEY)
  const houseSigner: Signer = {
    address: demoHouseAccount.address,
    signTypedData: (args) =>
      demoHouseAccount.signTypedData(args as Parameters<typeof demoHouseAccount.signTypedData>[0]),
    signMessage: (args) =>
      demoHouseAccount.signMessage(args as Parameters<typeof demoHouseAccount.signMessage>[0]),
  }
  return (input: HouseDriverInput<TParams>) =>
    runHouseSide(
      {
        domain: baseCfg.domain,
        tableId: input.tableId,
        game,
        player: {
          address: input.playerAddress,
          signTypedData: () => Promise.resolve('0x' as viem.Hex),
          signMessage: () => Promise.resolve('0x' as viem.Hex),
        },
        house: houseSigner,
        seedTip: DEMO_SEED_TIP,
        chainLength: baseCfg.chainLength,
        openBalances: input.currentBalances,
        settlementMode: 1,
      },
      input.houseT,
      { stake: input.stake, params: input.params, clientSeed: input.clientSeed },
    )
}

export { ZERO_ADDR }
