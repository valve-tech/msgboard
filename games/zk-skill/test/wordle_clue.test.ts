import { beforeAll, describe, expect, it } from 'vitest'
import {
  buildWordleWitnessInput,
  prove,
  scoreGuess,
  setupCircuit,
  verify,
  wordToIndices,
  wordleCommit,
  type CircuitSetup,
} from '../src/index.js'

describe('wordle_clue circuit', () => {
  let setup: CircuitSetup

  beforeAll(async () => {
    setup = setupCircuit('wordle_clue')
  }, 300_000)

  const word = wordToIndices('crane') // [2,17,0,13,4]
  const guess = wordToIndices('eerie') // repeated letter 'e'
  const salt = 424242n

  it('matches the fixed word/guess vector', () => {
    expect(word).toEqual([2, 17, 0, 13, 4])
    expect(guess).toEqual([4, 4, 17, 8, 4])
  })

  it('JS reference scorer produces the expected duplicate-letter clue', () => {
    const clue = scoreGuess(word, guess)
    // only one 'e' in "crane" (at position 4, already green) -> both extra
    // 'e's in "eerie" are grey; the 'r' is present but misplaced -> yellow.
    expect(clue).toEqual([0, 0, 1, 0, 2])
  })

  it('proves and verifies the honest clue', async () => {
    const clue = scoreGuess(word, guess)
    const input = await buildWordleWitnessInput({ word, salt, guess, clue })
    const { proof, publicSignals } = await prove(setup, input)
    const ok = await verify(setup, publicSignals, proof)
    expect(ok).toBe(true)
  })

  it('rejects a tampered clue (flipped trit) at witness generation', async () => {
    const clue = scoreGuess(word, guess)
    const tampered = [...clue]
    tampered[0] = tampered[0] === 0 ? 1 : 0 // flip grey->yellow at a grey position
    const input = await buildWordleWitnessInput({ word, salt, guess, clue: tampered as any })
    await expect(prove(setup, input)).rejects.toThrow()
  })

  it('rejects a wrong commit', async () => {
    const clue = scoreGuess(word, guess)
    const input = await buildWordleWitnessInput({ word, salt, guess, clue })
    const wrongCommit = (BigInt(input.commit) + 1n).toString()
    await expect(prove(setup, { ...input, commit: wrongCommit })).rejects.toThrow()
  })

  it('commit is stable for the same word+salt', async () => {
    const c1 = await wordleCommit(word, salt)
    const c2 = await wordleCommit(word, salt)
    expect(c1).toBe(c2)
  })
})
