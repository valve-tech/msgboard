import { useCallback, useMemo, useRef, useState } from 'react'
import * as viem from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { useBoardBroadcaster } from './useBoardBroadcaster'
import {
  start as minesStart,
  reveal as minesReveal,
  cashOut as minesCashOut,
  hashBoard as minesHashBoard,
  hashGameState as minesHashGameState,
  encodeMove as minesEncodeMove,
  playerDelta as minesPlayerDelta,
  verify as minesVerify,
  MinesPhase,
  type MinesBoard,
  type MinesConfig,
  type MinesState,
  type MinesClaim,
  type MinesVerdict,
  type Signer,
} from '@msgboard/games'

/**
 * Drives ONE stateful Mines game in the browser.
 *
 * Mines is the only STATEFUL game in the roster: it cannot use the single-shot
 * `useSession`/`HouseSession.playRound` path (start a board → reveal tiles one at a time →
 * cash out, or bust on a mine). This hook is the thin in-browser "house" driver that mirrors
 * the headless mines driver in `examples/games/e2e/scripts/session-bots.ts` (`runMinesTable`):
 *  - generate a random board client-side (the house), commit it via `hashBoard`,
 *    and `start(config, commit)`;
 *  - `revealTile` looks up mine-ness FROM the committed board (the house knows the layout) and
 *    applies the pure `reveal(state, tile, isMine)` transition; a mine busts the game;
 *  - `cashOut` applies the pure `cashOut(state)` transition;
 *  - only AFTER the game ends is the board (mine positions + salt) revealed, so the player can
 *    re-check the whole game with the module's `verify(...)` (provably fair).
 *
 * ───────────────────────────────────────────────────────────────────────────────────────────
 * TRUST MODEL (this pass) — "in-process house + signed move log".
 *
 *   The house key is a fresh EPHEMERAL in-browser key (`privateKeyToAccount(generatePrivateKey())`),
 *   exactly as `useSession.ts` / `session-bots.ts` construct theirs. Both the board commit (binding
 *   the hidden layout before any reveal) and every move are produced in-process. We keep an honest
 *   MOVE LOG: each move is canonically encoded with the module's `encodeMove(...)`, chained into the
 *   game-state hash via `hashGameState(state)`, and SIGNED by the house key (EIP-191 over the move +
 *   resulting state hash). The player can, after the game, recompute every state-hash from the
 *   revealed board and check the verdict via `verify(...)`.
 *
 *   What this gives you: provable fairness (the commit binds the layout BEFORE reveals, so the house
 *   can't move a mine onto a tile you pick), an auditable ordered move log, and a tamper-evident
 *   running state hash.
 *
 *   What this pass deliberately does NOT do (vs. a production co-signed session): it does not have the
 *   PLAYER co-sign each step. In a real deployment each REVEAL/CASH_OUT would be an EIP-712 co-signed
 *   `SessionState` step (like `HouseSession`), with the house on its own machine behind the same
 *   MsgBoard transport, and on-chain settlement of the terminal delta against a settle contract that
 *   does not yet exist. Full per-move EIP-712 co-signing is disproportionate for this single-process
 *   browser demo, so we use the simpler signed/hashed move log here and document the gap. The pure
 *   transitions, the commit, the state-hash chain, and `verify(...)` are all already the production
 *   shapes — only the second signature + transport + on-chain settle are stubbed.
 * ───────────────────────────────────────────────────────────────────────────────────────────
 */

const HUNDREDTHS = 100n

export type MinesStatus = 'idle' | 'playing' | 'busted' | 'cashed'

/** A revealed cell, surfaced for the grid. `mine` is only ever true on the bust tile. */
export type MinesCell = {
  tile: number
  revealed: boolean
  /** true once revealed: a mine (the bust tile) vs. a safe gem. */
  mine: boolean
}

/** One signed entry in the honest move log (board stays hidden until the game ends). */
export type MinesMoveRecord = {
  seq: number
  move: 'REVEAL' | 'CASH_OUT'
  tile?: number
  /** canonical `encodeMove(...)` of this move. */
  encodedMove: viem.Hex
  /** `hashGameState(state)` AFTER applying this move — the co-signed preimage in production. */
  stateHash: viem.Hex
  /** house EIP-191 signature over keccak(encodedMove ‖ stateHash). */
  houseSig: viem.Hex
  /** wall-clock marks for this move (offered when the tile became clickable → confirmed). */
  timing: { offeredAt: number; signedAt: number; broadcastAt: number; confirmedAt: number }
}

/** A finished game, for the history list. */
export type MinesGameRecord = {
  id: number
  config: MinesConfig
  stake: bigint
  commit: viem.Hex
  status: 'busted' | 'cashed'
  /** the running edged multiplier at settlement (0 on a bust). */
  multiplierX100: bigint
  /** signed player delta for the terminal state given the stake. */
  playerDelta: bigint
  /** number of safe tiles revealed before the game ended. */
  safeRevealed: number
  /** the revealed board (mine positions + salt) — only present once the game ends. */
  board: MinesBoard
  /** the claim handed to `verify(...)`. */
  claim: MinesClaim
  /** the provably-fair verdict re-checked client-side from the revealed board. */
  verdict: MinesVerdict
  /** whole-game timing: first reveal offered → settlement confirmed. */
  timing: { decisionMs?: number; networkMs?: number; totalMs?: number }
  /** the ordered, signed move log. */
  moves: MinesMoveRecord[]
}

export type MinesSessionApi = {
  status: MinesStatus
  error?: string
  /** the live pure-transition state, or undefined before the first `newGame`. */
  state?: MinesState
  config?: MinesConfig
  stake?: bigint
  /** board commitment for the in-flight game (published before any reveal). */
  commit?: viem.Hex
  /** the full grid (config.tiles cells), each marked revealed + safe/mine once revealed. */
  cells: MinesCell[]
  /** running edged multiplier in hundredths (100 == 1.00x); 0 once busted. */
  multiplierX100: bigint
  /** current signed player delta for the in-flight stake (0 while still PLAYING). */
  playerDelta: bigint
  /** number of safe tiles revealed so far. */
  safeRevealed: number
  /** true while a game is in progress with at least one safe reveal (cash-out enabled). */
  canCashOut: boolean
  /** the in-flight signed move log. */
  moves: MinesMoveRecord[]
  /** the verified board + verdict for the just-finished game (provably-fair receipt). */
  lastGame?: MinesGameRecord
  /** finished games, newest last. */
  history: MinesGameRecord[]
  /** start a fresh game: random board, commit, `start(config, commit)`. */
  newGame: (config: MinesConfig, stake: bigint) => void
  /** reveal a tile; resolves mine-ness from the committed board. Busts on a mine. */
  revealTile: (tile: number) => void
  /** cash out the running multiplier (only while PLAYING with ≥1 safe reveal). */
  cashOut: () => void
}

/** A fresh random board (the house). Mirrors `randomMinesBoard` in session-bots.ts. */
const randomBoard = (config: MinesConfig): MinesBoard => {
  const mineTiles = new Set<number>()
  while (mineTiles.size < config.mines) {
    mineTiles.add(Math.floor(Math.random() * config.tiles))
  }
  return {
    config,
    mineTiles: [...mineTiles].sort((a, b) => a - b),
    salt: viem.bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
  }
}

/** Build the claim handed to `verify(...)` from a terminal state. */
const claimFor = (state: MinesState): MinesClaim => ({
  config: state.config,
  commit: state.commit,
  reveals: state.revealed,
  cashedOut: state.phase === MinesPhase.CASHED_OUT,
  claimedMultiplierX100: state.multiplierX100,
})

/**
 * Drives one stateful mines game. The injected `walletClient` is the player (used only to anchor
 * the player address for the move log / receipt today; per-move co-signing is the production add).
 */
export const useMinesSession = ({
  walletClient: _walletClient,
  boardRpc,
  chainId = 0,
}: {
  walletClient?: viem.WalletClient
  boardRpc?: string
  chainId?: number
} = {}): MinesSessionApi => {
  const broadcastLobby = useBoardBroadcaster({ boardRpc, chainId })
  const [status, setStatus] = useState<MinesStatus>('idle')
  const [error, setError] = useState<string>()
  const [state, setState] = useState<MinesState>()
  const [stake, setStake] = useState<bigint>()
  const [moves, setMoves] = useState<MinesMoveRecord[]>([])
  const [lastGame, setLastGame] = useState<MinesGameRecord>()
  const [history, setHistory] = useState<MinesGameRecord[]>([])

  // mutable engine bits that must not trigger re-renders: the hidden board, the ephemeral house
  // signer, the move sequence counter, the game id counter, and the whole-game start mark.
  const boardRef = useRef<MinesBoard>()
  const houseRef = useRef<Signer>()
  const seqRef = useRef(0)
  const gameIdRef = useRef(0)
  const gameStartRef = useRef<number>(0)

  const newGame = useCallback((config: MinesConfig, nextStake: bigint) => {
    try {
      const board = randomBoard(config)
      const commit = minesHashBoard(board)
      const initial = minesStart(config, commit)
      // announce on the shared live feed (PoW in a Web Worker — never the UI thread).
      broadcastLobby({ kind: 'open', game: 'mines', tableId: commit, commit, mines: config.mines, tiles: config.tiles })
      boardRef.current = board
      houseRef.current = privateKeyToAccount(generatePrivateKey()) as unknown as Signer
      seqRef.current = 0
      gameIdRef.current += 1
      gameStartRef.current = Date.now()
      setState(initial)
      setStake(nextStake)
      setMoves([])
      setLastGame(undefined)
      setError(undefined)
      setStatus('playing')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStatus('idle')
    }
  }, [])

  /** Sign + record a move, returning the appended record (best-effort house signature). */
  const recordMove = useCallback(
    async (encodedMove: viem.Hex, nextState: MinesState, kind: 'REVEAL' | 'CASH_OUT', tile: number | undefined, offeredAt: number) => {
      const stateHash = minesHashGameState(nextState)
      const signedAt = Date.now()
      const digest = viem.keccak256(viem.concatHex([encodedMove, stateHash]))
      let houseSig: viem.Hex = '0x'
      try {
        houseSig = (await houseRef.current?.signMessage({ message: { raw: digest } })) ?? '0x'
      } catch {
        houseSig = '0x'
      }
      const confirmedAt = Date.now()
      const seq = ++seqRef.current
      const record: MinesMoveRecord = {
        seq,
        move: kind,
        tile,
        encodedMove,
        stateHash,
        houseSig,
        timing: { offeredAt, signedAt, broadcastAt: signedAt, confirmedAt },
      }
      setMoves((m) => [...m, record])
      return record
    },
    [],
  )

  /** Finalize a terminal state: reveal the board, build the claim, verify, push history. */
  const finalize = useCallback(
    (terminal: MinesState, terminalStake: bigint, terminalMoves: MinesMoveRecord[]) => {
      const board = boardRef.current
      if (!board) return
      const claim = claimFor(terminal)
      const verdict = minesVerify(claim, board)
      const firstOffered = terminalMoves[0]?.timing.offeredAt ?? gameStartRef.current
      const lastConfirmed = terminalMoves.at(-1)?.timing.confirmedAt ?? Date.now()
      const cashedOut = terminal.phase === MinesPhase.CASHED_OUT
      const record: MinesGameRecord = {
        id: gameIdRef.current,
        config: terminal.config,
        stake: terminalStake,
        commit: terminal.commit,
        status: cashedOut ? 'cashed' : 'busted',
        multiplierX100: terminal.multiplierX100,
        playerDelta: minesPlayerDelta(terminal, terminalStake),
        safeRevealed: terminal.revealed.length,
        board,
        claim,
        verdict,
        timing: {
          // in-browser, decision ≈ time spent before signing each move (summed isn't meaningful
          // for the whole game, so we report the FINAL move's decision span as the headline);
          // network is the in-process co-sign latency; total is the whole-game wall-clock.
          decisionMs: terminalMoves.at(-1)
            ? terminalMoves.at(-1)!.timing.signedAt - terminalMoves.at(-1)!.timing.offeredAt
            : undefined,
          networkMs: terminalMoves.at(-1)
            ? terminalMoves.at(-1)!.timing.confirmedAt - terminalMoves.at(-1)!.timing.broadcastAt
            : undefined,
          totalMs: lastConfirmed - firstOffered,
        },
        moves: terminalMoves,
      }
      setLastGame(record)
      setHistory((h) => [...h, record])
      setStatus(cashedOut ? 'cashed' : 'busted')
    },
    [],
  )

  const revealTile = useCallback(
    (tile: number) => {
      const cur = state
      const board = boardRef.current
      if (!cur || !board || cur.phase !== MinesPhase.PLAYING) return
      if (cur.revealed.includes(tile)) return
      const offeredAt = Date.now()
      const isMine = board.mineTiles.includes(tile)
      const res = minesReveal(cur, tile, isMine)
      if ('error' in res) {
        setError(res.error)
        return
      }
      const next = res.state
      setState(next)
      const encoded = minesEncodeMove({ kind: 'REVEAL', tile })
      void recordMove(encoded, next, 'REVEAL', tile, offeredAt).then((rec) => {
        if (next.phase === MinesPhase.BUSTED) {
          finalize(next, stake ?? 0n, [...moves, rec])
        }
      })
    },
    [state, stake, moves, recordMove, finalize],
  )

  const cashOut = useCallback(() => {
    const cur = state
    if (!cur || cur.phase !== MinesPhase.PLAYING || cur.revealed.length === 0) return
    const offeredAt = Date.now()
    const res = minesCashOut(cur)
    if ('error' in res) {
      setError(res.error)
      return
    }
    const next = res.state
    setState(next)
    const encoded = minesEncodeMove({ kind: 'CASH_OUT' })
    void recordMove(encoded, next, 'CASH_OUT', undefined, offeredAt).then((rec) => {
      finalize(next, stake ?? 0n, [...moves, rec])
    })
  }, [state, stake, moves, recordMove, finalize])

  // ── derived render state ──────────────────────────────────────────────────────────────────
  const cells = useMemo<MinesCell[]>(() => {
    const tiles = state?.config.tiles ?? 0
    const revealedSet = new Set(state?.revealed ?? [])
    const bustTile = state?.bustTile ?? null
    return Array.from({ length: tiles }, (_v, tile) => ({
      tile,
      revealed: revealedSet.has(tile) || tile === bustTile,
      mine: tile === bustTile,
    }))
  }, [state])

  const multiplierX100 = state ? state.multiplierX100 : HUNDREDTHS
  const safeRevealed = state?.revealed.length ?? 0
  const playerDelta = state && stake !== undefined ? minesPlayerDelta(state, stake) : 0n
  const canCashOut = status === 'playing' && safeRevealed > 0

  return {
    status,
    error,
    state,
    config: state?.config,
    stake,
    commit: state?.commit,
    cells,
    multiplierX100,
    playerDelta,
    safeRevealed,
    canCashOut,
    moves,
    lastGame,
    history,
    newGame,
    revealTile,
    cashOut,
  }
}
