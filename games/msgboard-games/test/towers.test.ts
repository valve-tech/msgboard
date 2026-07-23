import { describe, it, expect } from 'vitest'
import {
  startTowers, towersResolveStep, towersAdvance, towersCashOut, towersPlayerDelta,
  towersMultiplierX100, towersMaxMultiplierX100, safeTilesOnFloor, verifyTowers, type TowersConfig,
} from '../src/games/towers'
import { LadderPhase, commitLayout, type LadderState } from '../src/ladder'

const STAKE = 1_000_000n
const CONFIG: TowersConfig = { floors: 8, tilesPerFloor: 3, safePerFloor: 2 }

/** drive a full session by always picking a SAFE tile each floor (climbs to the top). */
function climbAllSafe(seed: bigint, config: TowersConfig): LadderState {
  const resolve = towersResolveStep(seed, config)
  let { state } = startTowers(config, seed)
  for (let floor = 0; state.phase === LadderPhase.PLAYING; floor++) {
    const safe = [...safeTilesOnFloor(seed, config, floor)][0]!
    const res = towersAdvance(state, safe, resolve(floor, safe))
    if ('error' in res) throw new Error(res.error)
    state = res.state
  }
  return state
}

describe('towers (ladder engine)', () => {
  it('safe set has exactly safePerFloor distinct tiles in range', () => {
    for (let floor = 0; floor < 8; floor++) {
      const set = safeTilesOnFloor(123n, CONFIG, floor)
      expect(set.size).toBe(CONFIG.safePerFloor)
      for (const t of set) expect(t).toBeGreaterThanOrEqual(0), expect(t).toBeLessThan(CONFIG.tilesPerFloor)
    }
  })

  it('running multiplier compounds (T/S)^k, edged; ceiling = top of ladder', () => {
    // T/S = 3/2 = 1.5x fair per floor; 8 floors -> 1.5^8 = 25.6289..x fair, edged *0.99
    expect(towersMultiplierX100(CONFIG, 1)).toBe(148n) // floor(1.5*100*0.99) = 148
    expect(towersMaxMultiplierX100(CONFIG)).toBe(towersMultiplierX100(CONFIG, 8))
    expect(towersMaxMultiplierX100(CONFIG)).toBeGreaterThan(2000n) // >20x
  })

  it('climbing all-safe reaches the top and auto-cashes-out at the ceiling', () => {
    const end = climbAllSafe(42n, CONFIG)
    expect(end.phase).toBe(LadderPhase.CASHED_OUT)
    expect(end.step).toBe(CONFIG.floors)
    expect(end.multiplierX100).toBe(towersMaxMultiplierX100(CONFIG))
    expect(towersPlayerDelta(end, STAKE)).toBe((STAKE * end.multiplierX100) / 100n - STAKE)
  })

  it('an unsafe pick busts and loses the stake', () => {
    const seed = 7n
    const resolve = towersResolveStep(seed, CONFIG)
    const { state } = startTowers(CONFIG, seed)
    const unsafe = [...Array(CONFIG.tilesPerFloor).keys()].find((t) => !safeTilesOnFloor(seed, CONFIG, 0).has(t))!
    const res = towersAdvance(state, unsafe, resolve(0, unsafe))
    if ('error' in res) throw new Error(res.error)
    expect(res.state.phase).toBe(LadderPhase.BUSTED)
    expect(towersPlayerDelta(res.state, STAKE)).toBe(-STAKE)
  })

  it('cash out after some safe floors pays the running multiplier', () => {
    const seed = 99n
    const resolve = towersResolveStep(seed, CONFIG)
    let { state } = startTowers(CONFIG, seed)
    for (let floor = 0; floor < 3; floor++) {
      const safe = [...safeTilesOnFloor(seed, CONFIG, floor)][0]!
      const res = towersAdvance(state, safe, resolve(floor, safe))
      if ('error' in res) throw new Error(res.error)
      state = res.state
    }
    const out = towersCashOut(state)
    if ('error' in out) throw new Error(out.error)
    expect(out.state.phase).toBe(LadderPhase.CASHED_OUT)
    expect(out.state.multiplierX100).toBe(towersMultiplierX100(CONFIG, 3))
  })

  it('verify accepts an honest cash-out and rejects an inflated multiplier / wrong commit', () => {
    const seed = 1234n
    const end = climbAllSafe(seed, CONFIG)
    const claim = {
      commit: commitLayout(seed), maxSteps: CONFIG.floors, choices: end.choices,
      cashedOut: true, claimedMultiplierX100: end.multiplierX100,
    }
    expect(verifyTowers(claim, seed, CONFIG).ok).toBe(true)
    expect(verifyTowers({ ...claim, claimedMultiplierX100: end.multiplierX100 + 1n }, seed, CONFIG).ok).toBe(false)
    expect(verifyTowers(claim, seed + 1n, CONFIG).ok).toBe(false) // seed doesn't match commit
  })
})
