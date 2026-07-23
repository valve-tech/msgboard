import { useCallback, useRef, useState } from 'react'
import * as viem from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { useBoardBroadcaster } from './useBoardBroadcaster'
import {
  ladderAdvance, ladderCashOut, ladderPlayerDelta, hashLadderState, LadderPhase,
  type LadderState, type StepOutcome, type LadderClaim, type LadderVerdict, type Signer,
} from '@msgboard/games'

/**
 * Drives ONE stateful LADDER game (Towers, Chicken, Firewalk, Heist, Hi-Lo, Greed Dice) in the
 * browser, over the shared ladder engine. It is the ladder sibling of `useMinesSession`, with the same
 * trust model ("in-process house + signed move log", see that file): the house generates a random
 * layout SEED, commits it (`adapter.start(seed)` → `commitLayout`), drives each co-signed step through
 * the pure engine (`ladderAdvance`), and only AFTER the game reveals the seed so the player can
 * re-check the whole session with the game's `verify(...)`. Per-step EIP-712 player co-signing +
 * on-chain settle are the production adds (documented in useMinesSession).
 *
 * Game-specific logic is injected via a `LadderAdapter`, so this hook stays game-agnostic: the engine
 * owns the state machine; the adapter supplies start / resolveStep / verify for the chosen game.
 */
const HUNDREDTHS = 100n

export interface LadderAdapter {
  gameLabel: string
  maxSteps: number
  /** commit the layout seed and open the ladder. */
  start: (seed: bigint) => { state: LadderState; commit: viem.Hex }
  /** resolve a step against the seed-derived layout (the house holds the seed). */
  resolveStep: (seed: bigint, step: number, choice: number, currentMultiplierX100: bigint) => StepOutcome
  /** adjudicate the finished session (provably-fair re-check). */
  verify: (claim: LadderClaim, seed: bigint) => LadderVerdict
  /** optional game-specific label for the current step (e.g. Hi-Lo's current card). The hook calls
   *  this with the PRIVATE seed so the seed never leaves the hook — only the rendered string does. */
  label?: (seed: bigint, step: number) => string
}

export type LadderStatus = 'idle' | 'playing' | 'busted' | 'cashed'

export type LadderMoveRecord = {
  seq: number
  move: 'STEP' | 'CASH_OUT'
  choice?: number
  stateHash: viem.Hex
  houseSig: viem.Hex
}

export type LadderGameRecord = {
  id: number
  gameLabel: string
  stake: bigint
  commit: viem.Hex
  status: 'busted' | 'cashed'
  multiplierX100: bigint
  playerDelta: bigint
  steps: number
  /** the revealed layout seed — only present once the game ends. */
  seed: bigint
  verdict: LadderVerdict
  moves: LadderMoveRecord[]
}

export type LadderSessionApi = {
  status: LadderStatus
  error?: string
  state?: LadderState
  stake?: bigint
  commit?: viem.Hex
  multiplierX100: bigint
  playerDelta: bigint
  step: number
  canCashOut: boolean
  /** game-specific label for the current step (e.g. the current card), if the adapter provides one. */
  label?: string
  lastGame?: LadderGameRecord
  history: LadderGameRecord[]
  /** start a fresh game: random seed, commit, open the ladder. */
  newGame: (adapter: LadderAdapter, stake: bigint) => void
  /** take a step with the given choice (tile / lane / higher-lower / vault / roll). */
  takeStep: (choice: number) => void
  /** cash out the running multiplier (only while PLAYING with ≥1 step). */
  cashOut: () => void
}

/** a fresh random 256-bit layout seed (the house). */
const randomSeed = (): bigint => viem.hexToBigInt(viem.bytesToHex(crypto.getRandomValues(new Uint8Array(32))))

const claimFor = (s: LadderState, maxSteps: number): LadderClaim => ({
  commit: s.commit,
  maxSteps,
  choices: s.choices,
  cashedOut: s.phase === LadderPhase.CASHED_OUT,
  claimedMultiplierX100: s.multiplierX100,
})

export const useLadderSession = ({
  walletClient: _walletClient,
  boardRpc,
  chainId = 0,
}: {
  walletClient?: viem.WalletClient
  boardRpc?: string
  chainId?: number
} = {}): LadderSessionApi => {
  const broadcastLobby = useBoardBroadcaster({ boardRpc, chainId })
  const [status, setStatus] = useState<LadderStatus>('idle')
  const [error, setError] = useState<string>()
  const [state, setState] = useState<LadderState>()
  const [stake, setStake] = useState<bigint>()
  const [moves, setMoves] = useState<LadderMoveRecord[]>([])
  const [lastGame, setLastGame] = useState<LadderGameRecord>()
  const [history, setHistory] = useState<LadderGameRecord[]>([])

  const adapterRef = useRef<LadderAdapter>()
  const seedRef = useRef<bigint>(0n)
  const houseRef = useRef<Signer>()
  const seqRef = useRef(0)
  const gameIdRef = useRef(0)

  const newGame = useCallback((adapter: LadderAdapter, nextStake: bigint) => {
    try {
      const seed = randomSeed()
      const { state: initial, commit } = adapter.start(seed)
      broadcastLobby({ kind: 'open', game: adapter.gameLabel, tableId: commit, commit })
      adapterRef.current = adapter
      seedRef.current = seed
      houseRef.current = privateKeyToAccount(generatePrivateKey()) as unknown as Signer
      seqRef.current = 0
      gameIdRef.current += 1
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
  }, [broadcastLobby])

  const recordMove = useCallback(
    async (nextState: LadderState, kind: 'STEP' | 'CASH_OUT', choice: number | undefined) => {
      const stateHash = hashLadderState(nextState)
      let houseSig: viem.Hex = '0x'
      try {
        houseSig = (await houseRef.current?.signMessage({ message: { raw: stateHash } })) ?? '0x'
      } catch {
        houseSig = '0x'
      }
      const seq = ++seqRef.current
      const record: LadderMoveRecord = { seq, move: kind, choice, stateHash, houseSig }
      setMoves((m) => [...m, record])
      return record
    },
    [],
  )

  const finalize = useCallback((terminal: LadderState, terminalStake: bigint, terminalMoves: LadderMoveRecord[]) => {
    const adapter = adapterRef.current
    if (!adapter) return
    const claim = claimFor(terminal, adapter.maxSteps)
    const verdict = adapter.verify(claim, seedRef.current)
    const cashedOut = terminal.phase === LadderPhase.CASHED_OUT
    const record: LadderGameRecord = {
      id: gameIdRef.current,
      gameLabel: adapter.gameLabel,
      stake: terminalStake,
      commit: terminal.commit,
      status: cashedOut ? 'cashed' : 'busted',
      multiplierX100: terminal.multiplierX100,
      playerDelta: ladderPlayerDelta(terminal, terminalStake),
      steps: terminal.step,
      seed: seedRef.current,
      verdict,
      moves: terminalMoves,
    }
    setLastGame(record)
    setHistory((h) => [...h, record])
    setStatus(cashedOut ? 'cashed' : 'busted')
  }, [])

  const takeStep = useCallback((choice: number) => {
    const cur = state
    const adapter = adapterRef.current
    if (!cur || !adapter || cur.phase !== LadderPhase.PLAYING) return
    const outcome = adapter.resolveStep(seedRef.current, cur.step, choice, cur.multiplierX100)
    const res = ladderAdvance(cur, choice, outcome)
    if ('error' in res) { setError(res.error); return }
    const next = res.state
    setState(next)
    void recordMove(next, 'STEP', choice).then((rec) => {
      if (next.phase !== LadderPhase.PLAYING) finalize(next, stake ?? 0n, [...moves, rec])
    })
  }, [state, stake, moves, recordMove, finalize])

  const cashOut = useCallback(() => {
    const cur = state
    if (!cur || cur.phase !== LadderPhase.PLAYING || cur.step === 0) return
    const res = ladderCashOut(cur)
    if ('error' in res) { setError(res.error); return }
    const next = res.state
    setState(next)
    void recordMove(next, 'CASH_OUT', undefined).then((rec) => finalize(next, stake ?? 0n, [...moves, rec]))
  }, [state, stake, moves, recordMove, finalize])

  const multiplierX100 = state ? state.multiplierX100 : HUNDREDTHS
  const step = state?.step ?? 0
  const playerDelta = state && stake !== undefined ? ladderPlayerDelta(state, stake) : 0n
  const canCashOut = status === 'playing' && step > 0
  const label =
    status === 'playing' && adapterRef.current?.label ? adapterRef.current.label(seedRef.current, step) : undefined

  return {
    status, error, state, stake, commit: state?.commit, multiplierX100, playerDelta, step,
    canCashOut, label, lastGame, history, newGame, takeStep, cashOut,
  }
}
