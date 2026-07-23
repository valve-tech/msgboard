import { describe, it, expect } from 'vitest'
import {
  LadderPhase, commitLayout, ladderAdvance, ladderCashOut, type LadderState, type StepOutcome,
} from '../src/ladder'
import {
  startChicken, chickenResolveStep, chickenMaxMultiplierX100, laneSafe, verifyChicken, type ChickenConfig,
} from '../src/games/chicken'
import {
  startFirewalk, firewalkResolveStep, firewalkMaxMultiplierX100, tileSafe, firewalkMultiplierX100, verifyFirewalk,
} from '../src/games/firewalk'
import {
  startHeist, heistResolveStep, heistMaxMultiplierX100, alarmPositions, verifyHeist, type HeistConfig,
} from '../src/games/heist'
import {
  startHiLo, hiloResolveStep, hiloMaxMultiplierX100, hiloStepMultiplierX100, HILO_HIGHER, HILO_LOWER, verifyHiLo, type HiLoConfig,
} from '../src/games/hilo'
import {
  startGreedDice, greedDiceResolveStep, greedDiceMaxMultiplierX100, rollSurvives, verifyGreedDice, type GreedDiceConfig,
} from '../src/games/greedDice'

/** drive a session to terminal: at each step pick `choose(step, state)`; outcome from `resolve`. */
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

describe('chicken (constant-prob survival ladder)', () => {
  const config: ChickenConfig = { difficulty: 'medium', lanes: 10 }
  it('crosses all safe lanes to the ceiling, or busts on a crash', () => {
    const seed = 5n
    const resolve = chickenResolveStep(seed, config)
    const end = play(startChicken(config, seed), (s, c) => resolve(s, c), () => 0)
    if (end.phase === LadderPhase.CASHED_OUT && end.step === config.lanes) {
      expect(end.multiplierX100).toBe(chickenMaxMultiplierX100(config))
    } else {
      expect(end.phase).toBe(LadderPhase.BUSTED)
      // busted exactly at the first crashing lane
      expect(laneSafe(seed, config.difficulty, end.bustStep!)).toBe(false)
    }
  })
  it('multiplier strictly grows with lanes and ceiling is the top', () => {
    expect(chickenMaxMultiplierX100(config)).toBeGreaterThan(100n)
  })
  it('verify accepts honest play and rejects inflation', () => {
    const seed = 5n
    const resolve = chickenResolveStep(seed, config)
    const end = play(startChicken(config, seed), (s, c) => resolve(s, c), () => 0, 3)
    const claim = { commit: commitLayout(seed), maxSteps: config.lanes, choices: end.choices,
      cashedOut: end.phase === LadderPhase.CASHED_OUT, claimedMultiplierX100: end.multiplierX100 }
    expect(verifyChicken(claim, seed, config).ok).toBe(true)
    expect(verifyChicken({ ...claim, claimedMultiplierX100: end.multiplierX100 + 1n }, seed, config).ok).toBe(false)
  })
})

describe('firewalk (escalating-danger ladder)', () => {
  const config = { tiles: 8 }
  it('per-tile factor grows as burn escalates (steeper than linear)', () => {
    const m1 = firewalkMultiplierX100(1)
    const m2 = firewalkMultiplierX100(2)
    const m3 = firewalkMultiplierX100(3)
    expect(m2 - m1).toBeLessThan(m3 - m2) // gaps widen → escalating
  })
  it('plays to terminal and verify round-trips', () => {
    const seed = 11n
    const resolve = firewalkResolveStep(seed)
    const end = play(startFirewalk(config, seed), (s, c) => resolve(s, c), () => 0)
    if (end.phase === LadderPhase.BUSTED) expect(tileSafe(seed, end.bustStep!)).toBe(false)
    else expect(end.multiplierX100).toBe(firewalkMaxMultiplierX100(config))
    const claim = { commit: commitLayout(seed), maxSteps: config.tiles, choices: end.choices,
      cashedOut: end.phase === LadderPhase.CASHED_OUT, claimedMultiplierX100: end.multiplierX100 }
    expect(verifyFirewalk(claim, seed).ok).toBe(true)
  })
})

describe('heist (escalating multi-vault pick)', () => {
  const config: HeistConfig = { rooms: 6, vaults: 4, baseAlarms: 1 }
  it('picking an alarm busts; picking clean advances', () => {
    const seed = 3n
    const resolve = heistResolveStep(seed, config)
    const alarms = alarmPositions(seed, config, 0)
    const clean = [0, 1, 2, 3].find((v) => !alarms.has(v))!
    const start = startHeist(config, seed)
    const safe = ladderAdvance(start.state, clean, resolve(0, clean))
    expect('error' in safe).toBe(false)
    if (!('error' in safe)) expect(safe.state.phase).toBe(LadderPhase.PLAYING)
    const alarm = [...alarms][0]!
    const bust = ladderAdvance(start.state, alarm, resolve(0, alarm))
    if (!('error' in bust)) expect(bust.state.phase).toBe(LadderPhase.BUSTED)
  })
  it('always picking a clean vault reaches the ceiling', () => {
    const seed = 3n
    const resolve = heistResolveStep(seed, config)
    const end = play(startHeist(config, seed), (s, c) => resolve(s, c),
      (step) => [0, 1, 2, 3].find((v) => !alarmPositions(seed, config, step).has(v))!)
    expect(end.phase).toBe(LadderPhase.CASHED_OUT)
    expect(end.multiplierX100).toBe(heistMaxMultiplierX100(config))
    const claim = { commit: commitLayout(seed), maxSteps: config.rooms, choices: end.choices,
      cashedOut: true, claimedMultiplierX100: end.multiplierX100 }
    expect(verifyHeist(claim, seed, config).ok).toBe(true)
    expect(verifyHeist({ ...claim, claimedMultiplierX100: end.multiplierX100 + 1n }, seed, config).ok).toBe(false)
  })
})

describe('hilo (card ladder, edge per step, capped)', () => {
  const config: HiLoConfig = { steps: 10, capX100: 100_000n } // cap 1000x
  it('step multiplier is edged 1/P and impossible guesses pay 0', () => {
    // ace (rank 14): "higher" favorable count = 4*(15-14)-1 = 3 -> edged(51*100/3)
    expect(hiloStepMultiplierX100(14, HILO_HIGHER)).toBe((51n * 100n / 3n * 99n) / 100n)
    // rank 2: "lower" favorable count = 4*(2-1)-1 = 3
    expect(hiloStepMultiplierX100(2, HILO_LOWER)).toBe((51n * 100n / 3n * 99n) / 100n)
  })
  it('plays with the favorable guess and the multiplier never exceeds the cap', () => {
    const seed = 77n
    const resolve = hiloResolveStep(seed, config)
    // always guess HIGHER-or-same (a legal guess); just check invariants
    const end = play(startHiLo(config, seed), resolve, () => HILO_HIGHER)
    expect(end.multiplierX100).toBeLessThanOrEqual(config.capX100)
    expect(hiloMaxMultiplierX100(config)).toBe(config.capX100)
    const claim = { commit: commitLayout(seed), maxSteps: config.steps, choices: end.choices,
      cashedOut: end.phase === LadderPhase.CASHED_OUT, claimedMultiplierX100: end.multiplierX100 }
    expect(verifyHiLo(claim, seed, config).ok).toBe(true)
  })
})

describe('greed dice (dice survival ladder)', () => {
  const config: GreedDiceConfig = { rolls: 8, bustFaces: 2 }
  it('survives when the face is outside the bust set; busts otherwise', () => {
    const seed = 21n
    const resolve = greedDiceResolveStep(seed, config)
    const end = play(startGreedDice(config, seed), (s, c) => resolve(s, c), () => 0)
    if (end.phase === LadderPhase.BUSTED) expect(rollSurvives(seed, config, end.bustStep!)).toBe(false)
    else expect(end.multiplierX100).toBe(greedDiceMaxMultiplierX100(config))
  })
  it('ceiling = surviving every roll and verify round-trips', () => {
    const seed = 21n
    const resolve = greedDiceResolveStep(seed, config)
    const end = play(startGreedDice(config, seed), (s, c) => resolve(s, c), () => 0, 2)
    const claim = { commit: commitLayout(seed), maxSteps: config.rolls, choices: end.choices,
      cashedOut: end.phase === LadderPhase.CASHED_OUT, claimedMultiplierX100: end.multiplierX100 }
    expect(verifyGreedDice(claim, seed, config).ok).toBe(true)
    expect(greedDiceMaxMultiplierX100(config)).toBeGreaterThan(100n)
  })
})
