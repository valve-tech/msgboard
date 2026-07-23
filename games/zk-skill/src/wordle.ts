// Wordle clue scoring + commitment helpers (JS mirror of circuits/wordle_clue.circom).

import { buildPoseidon } from 'circomlibjs'

export type Clue = 0 | 1 | 2 // 0=grey, 1=yellow, 2=green

let poseidonPromise: ReturnType<typeof buildPoseidon> | undefined

function getPoseidon() {
  poseidonPromise ??= buildPoseidon()
  return poseidonPromise
}

export function letterToIndex(letter: string): number {
  const code = letter.toLowerCase().charCodeAt(0) - 'a'.charCodeAt(0)
  if (code < 0 || code > 25) throw new Error(`not a letter: ${letter}`)
  return code
}

export function wordToIndices(word: string): number[] {
  if (word.length !== 5) throw new Error('word must be 5 letters')
  return [...word].map(letterToIndex)
}

/**
 * Reference (non-circuit) Wordle scorer, with the SAME duplicate-letter
 * handling the circuit enforces:
 *  - pass 1: mark greens (guess[i] === word[i])
 *  - avail[i] = count of guess[i] among non-green word positions
 *  - usedBefore[i] = count of earlier non-green guess positions with the
 *    same letter as guess[i]
 *  - yellow[i] = !green[i] && usedBefore[i] < avail[i]
 */
export function scoreGuess(word: number[], guess: number[]): Clue[] {
  if (word.length !== 5 || guess.length !== 5) {
    throw new Error('word and guess must have length 5')
  }
  const green = guess.map((g, i) => (g === word[i] ? 1 : 0))
  const avail = guess.map((g) =>
    word.reduce((acc, w, j) => acc + (w === g && !green[j] ? 1 : 0), 0),
  )
  const clue: Clue[] = []
  for (let i = 0; i < 5; i++) {
    if (green[i] === 1) {
      clue.push(2)
      continue
    }
    let usedBefore = 0
    for (let k = 0; k < i; k++) {
      if (guess[k] === guess[i] && !green[k]) usedBefore++
    }
    clue.push(usedBefore < avail[i]! ? 1 : 0)
  }
  return clue
}

/** Poseidon(word[0],...,word[4],salt) -- the circuit's commitment. */
export async function wordleCommit(word: number[], salt: bigint): Promise<bigint> {
  const poseidon = await getPoseidon()
  const F = poseidon.F
  const h = poseidon([...word.map(BigInt), salt])
  return BigInt(F.toString(h))
}

export interface WordleWitnessInput {
  commit: string
  guess: number[]
  clue: number[]
  word: number[]
  salt: string
  [key: string]: unknown
}

export async function buildWordleWitnessInput(params: {
  word: number[]
  salt: bigint
  guess: number[]
  clue?: Clue[]
}): Promise<WordleWitnessInput> {
  const commit = await wordleCommit(params.word, params.salt)
  const clue = params.clue ?? scoreGuess(params.word, params.guess)
  return {
    commit: commit.toString(),
    guess: params.guess,
    clue,
    word: params.word,
    salt: params.salt.toString(),
  }
}
