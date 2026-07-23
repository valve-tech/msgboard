import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as viem from 'viem'
import { wordToIndices, type Clue } from '@msgboard/zk-skill/wordle'
import { WORDLE_SOLVE_MAX_GUESSES } from '@msgboard/zk-skill/wordleSolve'
import type { GameDeployment } from '../config'
import { useWordleBoard, type WordleMsg } from './useWordleBoard'
import {
  proveWordleClue,
  verifyWordleClue,
  decodeCluePublicSignals,
  proveWordleSolve,
  verifyWordleSolve,
  type SolveProof,
} from '../lib/wordleProving'

export type WordleRole = 'setter' | 'guesser'

/** One row of the guesser's grid: their guess + (once the setter answers) the honest, verified clue. */
export type GuessRow = {
  n: number
  guess: number[]
  clue?: Clue[]
  /** pending = awaiting the setter's clue; ok = clue proof verified; cheat = proof failed / mismatched. */
  status: 'pending' | 'ok' | 'cheat'
}

const ALL_GREEN: Clue[] = [2, 2, 2, 2, 2]
const isAllGreen = (clue: Clue[]): boolean => clue.length === 5 && clue.every((c) => c === 2)
/** Non-solving filler used to pad the committed sequence to WORDLE_SOLVE_MAX_GUESSES for the solve proof. */
const FILLER: number[] = [0, 0, 0, 0, 0] // 'aaaaa'

const newId = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

// ── setter-secret persistence: a page refresh mustn't brick a challenge (mirrors the session seed backup) ──
const secretKey = (chainId: number, challengeId: string) => `wordle:secret:${chainId}:${challengeId}`
export type WordleSecret = { word: number[]; salt: string }
export const loadSecret = (chainId: number, challengeId: string): WordleSecret | undefined => {
  if (typeof localStorage === 'undefined') return undefined
  const raw = localStorage.getItem(secretKey(chainId, challengeId))
  if (!raw) return undefined
  try {
    const s = JSON.parse(raw) as WordleSecret
    return Array.isArray(s.word) && typeof s.salt === 'string' ? s : undefined
  } catch {
    return undefined
  }
}
export const saveSecret = (chainId: number, challengeId: string, secret: WordleSecret): void => {
  if (typeof localStorage !== 'undefined') localStorage.setItem(secretKey(chainId, challengeId), JSON.stringify(secret))
}

export type SolveState = {
  status: 'idle' | 'proving' | 'submitting' | 'done' | 'error'
  message?: string
  proof?: SolveProof
  txHash?: viem.Hex
}

export type WordleGame = {
  boardReady: boolean
  messages: WordleMsg[]
  /** the challenge's commit (from the setter's `open` notice), once seen. */
  commit?: string
  // ── setter view ──
  setterStatus: 'idle' | 'proving' | 'error'
  setterError?: string
  cluesAnswered: number
  pendingGuesses: number
  // ── guesser view ──
  rows: GuessRow[]
  solved: boolean
  guessesUsed?: number
  cheatDetected: boolean
  reveal?: { word: number[]; salt: string }
  submitGuess: (word: string) => Promise<void>
  submitError?: string
  submitting: boolean
  // ── optional on-chain anchor (guesser) ──
  solve: SolveState
  anchorWin: () => Promise<void>
}

/**
 * Drives one ZK-Wordle challenge over msgboard for a single role.
 *
 * SETTER (holds `secret`): watches for `guess` notices, scores each against the hidden word, proves the
 * clue honest (`wordle_clue`, in a worker) and posts it back; auto-reveals `word,salt` once a guess goes
 * all-green so the solver can build a solve proof.
 *
 * GUESSER (`secret` undefined): submits guesses, verifies every incoming clue proof locally (a failing
 * verify ⇒ a cheating setter, surfaced via `cheatDetected`), renders the grid, and on all-green can build
 * a `wordle_solve` proof (worker) to optionally anchor the win on-chain (`anchorWin`).
 */
export const useWordle = ({
  deployment,
  myAddress,
  walletClient,
  role,
  challengeId,
  secret,
  onChainAnchor,
}: {
  deployment: GameDeployment
  myAddress?: viem.Hex
  walletClient?: viem.WalletClient
  role: WordleRole
  challengeId: string | null
  /** setter only: the hidden word (letter indices) + salt (decimal string). */
  secret?: WordleSecret
  /** guesser only: called to submit WordleLog.logSolve when anchoring a win. */
  onChainAnchor?: (proof: SolveProof) => Promise<viem.Hex>
}): WordleGame => {
  const board = useWordleBoard({ boardRpc: deployment.boardRpc, chainId: deployment.chainId, challengeId })
  const { messages, post: boardPost } = board

  const [setterStatus, setSetterStatus] = useState<'idle' | 'proving' | 'error'>('idle')
  const [setterError, setSetterError] = useState<string>()
  const [submitError, setSubmitError] = useState<string>()
  const [submitting, setSubmitting] = useState(false)
  const [solve, setSolve] = useState<SolveState>({ status: 'idle' })
  // Verification cache: clue message id → verified colours (or null when the proof is bad).
  const [verified, setVerified] = useState<Record<string, Clue[] | null>>({})

  const me = myAddress?.toLowerCase()
  const openMsg = useMemo(() => messages.find((m): m is Extract<WordleMsg, { t: 'open' }> => m.t === 'open'), [messages])
  const commit = openMsg?.commit
  const revealMsg = useMemo(
    () => messages.find((m): m is Extract<WordleMsg, { t: 'reveal' }> => m.t === 'reveal'),
    [messages],
  )

  // ── SETTER: answer each unanswered guess with an honest clue proof ────────────────────────────────
  const processing = useRef<Set<string>>(new Set())
  const verifying = useRef<Set<string>>(new Set())
  const revealed = useRef(false)
  useEffect(() => {
    if (role !== 'setter' || !secret || !challengeId) return
    const guesses = messages.filter((m): m is Extract<WordleMsg, { t: 'guess' }> => m.t === 'guess')
    const answeredKey = (guesser: string, n: number) => `${guesser.toLowerCase()}:${n}`
    const answered = new Set(
      messages
        .filter((m): m is Extract<WordleMsg, { t: 'clue' }> => m.t === 'clue')
        .map((m) => answeredKey(m.guesser, m.n)),
    )
    // Each (guesser,n) is proven at most once via the persistent `processing` ref, so this effect is
    // safe to re-run on every `messages` change: in-flight proving is NEVER cancelled/discarded (that
    // would strand a clue with its key still marked processing), it always runs to completion and posts.
    const run = async () => {
      for (const g of guesses) {
        const key = answeredKey(g.guesser, g.n)
        if (answered.has(key) || processing.current.has(key)) continue
        processing.current.add(key)
        setSetterStatus('proving')
        setSetterError(undefined)
        try {
          const { clue, proof, publicSignals } = await proveWordleClue({
            word: secret.word,
            salt: BigInt(secret.salt),
            guess: g.guess,
          })
          await boardPost({
            v: 1,
            t: 'clue',
            id: newId(),
            challengeId,
            guesser: g.guesser,
            n: g.n,
            clue,
            proof,
            publicSignals,
            at: Date.now(),
          })
          // Auto-reveal once someone solves — enables their optional solve proof (fairness commit-reveal
          // layer is out of scope for this first playable; see the screen's notes).
          if (isAllGreen(clue) && !revealed.current) {
            revealed.current = true
            await boardPost({
              v: 1,
              t: 'reveal',
              id: newId(),
              challengeId,
              word: secret.word,
              salt: secret.salt,
              at: Date.now(),
            })
          }
          setSetterStatus('idle')
        } catch (e) {
          processing.current.delete(key) // allow a retry on the next poll
          setSetterStatus('error')
          setSetterError(e instanceof Error ? e.message : String(e))
        }
      }
    }
    void run()
  }, [role, secret, challengeId, messages, boardPost])

  // ── GUESSER: verify every clue proof addressed to me ──────────────────────────────────────────────
  useEffect(() => {
    if (role !== 'guesser' || !me || !commit) return
    const myGuesses = new Map(
      messages.filter((m): m is Extract<WordleMsg, { t: 'guess' }> => m.t === 'guess' && m.guesser.toLowerCase() === me).map((m) => [m.n, m.guess]),
    )
    const clues = messages.filter(
      (m): m is Extract<WordleMsg, { t: 'clue' }> => m.t === 'clue' && m.guesser.toLowerCase() === me,
    )
    const run = async () => {
      for (const c of clues) {
        if (c.id in verified || verifying.current.has(c.id)) continue
        verifying.current.add(c.id) // don't double-verify the same clue across overlapping effect runs
        try {
          const dec = decodeCluePublicSignals(c.publicSignals)
          const mine = myGuesses.get(c.n)
          const ok =
            dec.commit.toString() === commit && // bound to THIS challenge's committed word
            mine !== undefined &&
            dec.guess.join(',') === mine.join(',') && // bound to the guess I actually sent
            dec.clue.join(',') === c.clue.join(',') && // the colours match the proof's public clue
            (await verifyWordleClue(c.publicSignals, c.proof)) // the PLONK proof itself checks out
          setVerified((v) => ({ ...v, [c.id]: ok ? dec.clue : null }))
        } catch {
          setVerified((v) => ({ ...v, [c.id]: null }))
        }
      }
    }
    void run()
  }, [role, me, commit, messages, verified])

  // ── derived guesser grid ──
  const rows = useMemo<GuessRow[]>(() => {
    if (role !== 'guesser' || !me) return []
    const myGuesses = messages
      .filter((m): m is Extract<WordleMsg, { t: 'guess' }> => m.t === 'guess' && m.guesser.toLowerCase() === me)
      .sort((a, b) => a.n - b.n)
    return myGuesses.map((g) => {
      const clueMsg = messages.find(
        (m): m is Extract<WordleMsg, { t: 'clue' }> => m.t === 'clue' && m.guesser.toLowerCase() === me && m.n === g.n,
      )
      if (!clueMsg) return { n: g.n, guess: g.guess, status: 'pending' as const }
      const v = verified[clueMsg.id]
      if (v === undefined) return { n: g.n, guess: g.guess, clue: clueMsg.clue as Clue[], status: 'pending' as const }
      if (v === null) return { n: g.n, guess: g.guess, clue: clueMsg.clue as Clue[], status: 'cheat' as const }
      return { n: g.n, guess: g.guess, clue: v, status: 'ok' as const }
    })
  }, [role, me, messages, verified])

  const winningRow = useMemo(() => rows.find((r) => r.status === 'ok' && r.clue && isAllGreen(r.clue)), [rows])
  const cheatDetected = useMemo(() => rows.some((r) => r.status === 'cheat'), [rows])

  const submitGuess = useCallback(
    async (word: string): Promise<void> => {
      setSubmitError(undefined)
      if (!challengeId) return setSubmitError('no challenge joined')
      if (!me) return setSubmitError('connect a wallet to guess')
      const clean = word.trim().toLowerCase()
      if (!/^[a-z]{5}$/.test(clean)) return setSubmitError('enter a 5-letter word (a–z)')
      const priorMine = messages.filter((m) => m.t === 'guess' && m.guesser.toLowerCase() === me)
      if (priorMine.length >= WORDLE_SOLVE_MAX_GUESSES) return setSubmitError(`max ${WORDLE_SOLVE_MAX_GUESSES} guesses`)
      if (winningRow) return setSubmitError('already solved')
      setSubmitting(true)
      try {
        await boardPost({
          v: 1,
          t: 'guess',
          id: newId(),
          challengeId,
          guesser: myAddress!,
          n: priorMine.length,
          guess: wordToIndices(clean),
          at: Date.now(),
        })
      } catch (e) {
        setSubmitError(e instanceof Error ? e.message : String(e))
      } finally {
        setSubmitting(false)
      }
    },
    [challengeId, me, myAddress, messages, boardPost, winningRow],
  )

  // ── optional on-chain anchor: build the wordle_solve proof (worker) then logSolve ──
  const anchorWin = useCallback(async (): Promise<void> => {
    if (!winningRow || !revealMsg) {
      setSolve({ status: 'error', message: 'need the setter to reveal the word first' })
      return
    }
    setSolve({ status: 'proving', message: undefined })
    try {
      // The committed ordered sequence: my guesses in order, padded to MAX with a non-solving filler.
      const ordered = rows.map((r) => r.guess)
      const padded = [...ordered]
      while (padded.length < WORDLE_SOLVE_MAX_GUESSES) padded.push(FILLER)
      const proof = await proveWordleSolve({
        word: revealMsg.word,
        salt: BigInt(revealMsg.salt),
        guesses: padded.slice(0, WORDLE_SOLVE_MAX_GUESSES),
      })
      if (!(await verifyWordleSolve(proof.publicSignals, proof.proof))) {
        throw new Error('the solve proof failed local verification — not submitting')
      }
      if (!onChainAnchor || !walletClient) {
        // Proof built + verified but no wallet/anchor wired: surface it as done (msgboard-only win).
        setSolve({ status: 'done', proof, message: `solve proof verified — ${proof.guessesUsed} guesses (not anchored on-chain)` })
        return
      }
      setSolve({ status: 'submitting', proof })
      const txHash = await onChainAnchor(proof)
      setSolve({ status: 'done', proof, txHash, message: `win anchored on-chain — ${proof.guessesUsed} guesses` })
    } catch (e) {
      setSolve({ status: 'error', message: e instanceof Error ? e.message : String(e) })
    }
  }, [winningRow, revealMsg, rows, onChainAnchor, walletClient])

  const pendingGuesses = useMemo(() => {
    if (role !== 'setter') return 0
    const answered = new Set(
      messages.filter((m) => m.t === 'clue').map((m) => `${(m as Extract<WordleMsg, { t: 'clue' }>).guesser.toLowerCase()}:${(m as Extract<WordleMsg, { t: 'clue' }>).n}`),
    )
    return messages.filter(
      (m) => m.t === 'guess' && !answered.has(`${(m as Extract<WordleMsg, { t: 'guess' }>).guesser.toLowerCase()}:${(m as Extract<WordleMsg, { t: 'guess' }>).n}`),
    ).length
  }, [role, messages])

  return {
    boardReady: board.ready,
    messages,
    commit,
    setterStatus,
    setterError,
    cluesAnswered: messages.filter((m) => m.t === 'clue').length,
    pendingGuesses,
    rows,
    solved: !!winningRow,
    guessesUsed: winningRow ? winningRow.n + 1 : undefined,
    cheatDetected,
    reveal: revealMsg ? { word: revealMsg.word, salt: revealMsg.salt } : undefined,
    submitGuess,
    submitError,
    submitting,
    solve,
    anchorWin,
  }
}
