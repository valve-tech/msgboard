import { beforeAll, describe, expect, it } from 'vitest'
import {
  buildDictTree,
  buildWordleSolveWitnessInput,
  guessesCommit,
  packWord,
  prove,
  setupCircuit,
  TEST_DICTIONARY,
  verify,
  wordToIndices,
  type CircuitSetup,
  type DictTree,
} from '../src/index.js'

// A committed 6-guess sequence that first goes all-green on "crane" at guess #2.
const WORD = wordToIndices('crane')
const SALT = 424242n
const SEQUENCE = ['slate', 'crane', 'ghost', 'dozen', 'jumbo', 'unfit'].map(wordToIndices)

describe('wordle_solve circuit (sequence binding + dictionary membership)', () => {
  let setup: CircuitSetup
  let dict: DictTree

  beforeAll(async () => {
    setup = setupCircuit('wordle_solve')
    dict = await buildDictTree([...TEST_DICTIONARY])
  }, 300_000)

  it('packs words base-26 injectively (equal words ⟺ equal packing)', () => {
    expect(packWord(wordToIndices('crane'))).toEqual(packWord(wordToIndices('crane')))
    expect(packWord(wordToIndices('crane'))).not.toEqual(packWord(wordToIndices('crank')))
    // little-endian: 'aaaaa' == 0, 'baaaa' == 1
    expect(packWord(wordToIndices('aaaaa'))).toBe(0n)
    expect(packWord(wordToIndices('baaaa'))).toBe(1n)
  })

  it('proves the first all-green position (guesses-used = 2) and binds every commitment', async () => {
    const input = await buildWordleSolveWitnessInput({ word: WORD, salt: SALT, guesses: SEQUENCE, dict })
    expect(input.guessesUsed).toBe('2')
    const { proof, publicSignals } = await prove(setup, input)
    expect(await verify(setup, publicSignals, proof)).toBe(true)
    // public-signal order: [commit, guessesCommit, dictRoot, guessesUsed]
    expect(publicSignals).toHaveLength(4)
    expect(publicSignals[1]).toBe((await guessesCommit(SEQUENCE)).toString())
    expect(publicSignals[2]).toBe(dict.root.toString())
    expect(publicSignals[3]).toBe('2')
  })

  it('proves a solve-in-1 (guesses-used = 1)', async () => {
    const word = wordToIndices('proxy')
    const seq = ['proxy', 'slate', 'ghost', 'dozen', 'jumbo', 'unfit'].map(wordToIndices)
    const input = await buildWordleSolveWitnessInput({ word, salt: 7n, guesses: seq, dict })
    expect(input.guessesUsed).toBe('1')
    const { proof, publicSignals } = await prove(setup, input)
    expect(await verify(setup, publicSignals, proof)).toBe(true)
    expect(publicSignals[3]).toBe('1')
  })

  it('rejects UNDERSTATING guesses-used (claim solve-in-1 with a solve-in-2 sequence)', async () => {
    const input = await buildWordleSolveWitnessInput({ word: WORD, salt: SALT, guesses: SEQUENCE, dict })
    await expect(prove(setup, { ...input, guessesUsed: '1' })).rejects.toThrow()
  })

  it('rejects a tampered guess-sequence commitment', async () => {
    const input = await buildWordleSolveWitnessInput({ word: WORD, salt: SALT, guesses: SEQUENCE, dict })
    const bad = (BigInt(input.guessesCommit) + 1n).toString()
    await expect(prove(setup, { ...input, guessesCommit: bad })).rejects.toThrow()
  })

  it('rejects a wrong dictionary root (answer not in the committed dictionary)', async () => {
    const input = await buildWordleSolveWitnessInput({ word: WORD, salt: SALT, guesses: SEQUENCE, dict })
    const bad = (BigInt(input.dictRoot) + 1n).toString()
    await expect(prove(setup, { ...input, dictRoot: bad })).rejects.toThrow()
  })

  it('rejects a wrong word commitment', async () => {
    const input = await buildWordleSolveWitnessInput({ word: WORD, salt: SALT, guesses: SEQUENCE, dict })
    const bad = (BigInt(input.commit) + 1n).toString()
    await expect(prove(setup, { ...input, commit: bad })).rejects.toThrow()
  })

  it('cannot build a settlement proof for a sequence that never solves', async () => {
    const seq = ['slate', 'ghost', 'dozen', 'jumbo', 'unfit', 'humid'].map(wordToIndices) // no "crane"
    await expect(
      buildWordleSolveWitnessInput({ word: WORD, salt: SALT, guesses: seq, dict }),
    ).rejects.toThrow(/never solves/)
  })

  it('cannot build a proof when the answer is outside the dictionary', async () => {
    // "zzzzz" is a valid 5-letter string but not in TEST_DICTIONARY → no Merkle path.
    const word = wordToIndices('zzzzz')
    const seq = ['zzzzz', 'slate', 'ghost', 'dozen', 'jumbo', 'unfit'].map(wordToIndices)
    await expect(
      buildWordleSolveWitnessInput({ word, salt: 1n, guesses: seq, dict }),
    ).rejects.toThrow(/not in dictionary/)
  })
})
