import { describe, it, expect } from 'vitest'
import {
  LadderPhase, commitLayout, ladderAdvance, ladderCashOut, type LadderState, type StepOutcome,
} from '../src/ladder'
import {
  startCipher, cipherResolveStep, cipherMaxMultiplierX100, cipherMultiplierX100, cipherDigit,
  cipherSymbols, validateCipherConfig, verifyCipher, CIPHER_SYMBOLS, type CipherConfig, type CipherDifficulty,
} from '../src/games/cipher'

/** drive a session to terminal picking `choose(step)`; outcome from `resolve`. */
function play(
  start: { state: LadderState },
  resolve: (step: number, choice: number, mult: bigint) => StepOutcome,
  choose: (step: number, state: LadderState) => number,
  cashAfter?: number,
): LadderState {
  let state = start.state
  for (let step = 0; state.phase === LadderPhase.PLAYING; step++) {
    if (cashAfter !== undefined && step === cashAfter) {
      const out = ladderCashOut(state)
      if ('error' in out) throw new Error(out.error)
      return out.state
    }
    const choice = choose(step, state)
    const res = ladderAdvance(state, choice, resolve(step, choice, state.multiplierX100))
    if ('error' in res) throw new Error(res.error)
    state = res.state
  }
  return state
}

describe('cipher (code-cracking ladder)', () => {
  const difficulties: CipherDifficulty[] = ['easy', 'medium', 'hard', 'expert']

  it('symbols per rung grow with difficulty (2,3,4,5)', () => {
    expect(cipherSymbols('easy')).toBe(2)
    expect(cipherSymbols('medium')).toBe(3)
    expect(cipherSymbols('hard')).toBe(4)
    expect(cipherSymbols('expert')).toBe(5)
    for (const d of difficulties) expect(CIPHER_SYMBOLS[d]).toBe(cipherSymbols(d))
  })

  it('the correct digit is in [0, symbols-1] and derived from the seed', () => {
    const seed = 12345n
    for (const difficulty of difficulties) {
      const N = cipherSymbols(difficulty)
      for (let rung = 0; rung < 10; rung++) {
        const d = cipherDigit(seed, difficulty, rung)
        expect(d).toBeGreaterThanOrEqual(0)
        expect(d).toBeLessThan(N)
      }
    }
  })

  it('the multiplier compounds by symbols^k, edged, and grows with rungs', () => {
    const config: CipherConfig = { rungs: 5, difficulty: 'hard' } // 4 symbols
    // fair after k rungs is 4^k, edged: edged(4^k * 100)/... check monotonic + top == ceiling
    const m1 = cipherMultiplierX100(config, 1)
    const m2 = cipherMultiplierX100(config, 2)
    expect(m2).toBeGreaterThan(m1)
    // edged(4^1) = floor(400*99/100) = 396
    expect(m1).toBe(396n)
    expect(cipherMaxMultiplierX100(config)).toBe(cipherMultiplierX100(config, 5))
  })

  it('guessing the correct digit advances; a wrong guess busts', () => {
    const config: CipherConfig = { rungs: 6, difficulty: 'medium' }
    const seed = 7n
    const resolve = cipherResolveStep(seed, config)
    const correct = cipherDigit(seed, 'medium', 0)
    const start = startCipher(config, seed)
    const advance = ladderAdvance(start.state, correct, resolve(0, correct))
    expect('error' in advance).toBe(false)
    if (!('error' in advance)) expect(advance.state.phase).toBe(LadderPhase.PLAYING)
    const wrong = (correct + 1) % cipherSymbols('medium')
    const bust = ladderAdvance(start.state, wrong, resolve(0, wrong))
    if (!('error' in bust)) expect(bust.state.phase).toBe(LadderPhase.BUSTED)
  })

  it('always guessing the correct digit reaches the ceiling; verify round-trips', () => {
    const config: CipherConfig = { rungs: 5, difficulty: 'expert' }
    const seed = 99n
    const resolve = cipherResolveStep(seed, config)
    const end = play(startCipher(config, seed), (s, c) => resolve(s, c),
      (step) => cipherDigit(seed, config.difficulty, step))
    expect(end.phase).toBe(LadderPhase.CASHED_OUT)
    expect(end.multiplierX100).toBe(cipherMaxMultiplierX100(config))
    const claim = { commit: commitLayout(seed), maxSteps: config.rungs, choices: end.choices,
      cashedOut: true, claimedMultiplierX100: end.multiplierX100 }
    expect(verifyCipher(claim, seed, config).ok).toBe(true)
    expect(verifyCipher({ ...claim, claimedMultiplierX100: end.multiplierX100 + 1n }, seed, config).ok).toBe(false)
    expect(verifyCipher(claim, seed + 1n, config).ok).toBe(false)
  })

  it('cashing out mid-ladder banks the running multiplier and verify accepts it', () => {
    const config: CipherConfig = { rungs: 8, difficulty: 'easy' }
    const seed = 3n
    const resolve = cipherResolveStep(seed, config)
    const end = play(startCipher(config, seed), (s, c) => resolve(s, c),
      (step) => cipherDigit(seed, config.difficulty, step), 3)
    expect(end.phase).toBe(LadderPhase.CASHED_OUT)
    expect(end.step).toBe(3)
    expect(end.multiplierX100).toBe(cipherMultiplierX100(config, 3))
    const claim = { commit: commitLayout(seed), maxSteps: config.rungs, choices: end.choices,
      cashedOut: true, claimedMultiplierX100: end.multiplierX100 }
    expect(verifyCipher(claim, seed, config).ok).toBe(true)
  })

  it('rejects malformed config', () => {
    expect(() => validateCipherConfig({ rungs: 0, difficulty: 'easy' })).toThrow()
    expect(() => validateCipherConfig({ rungs: 33, difficulty: 'easy' })).toThrow()
    expect(() => validateCipherConfig({ rungs: 5, difficulty: 'nope' as CipherDifficulty })).toThrow()
  })
})
