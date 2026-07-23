/**
 * secrecy.test.ts — the "won't be evil" property, made testable. Every game's fairness rests on
 * commit-BEFORE-reveal: the secrets that decide an outcome (server seed, client seed, hidden board /
 * ladder layout) are PUBLISHED only as commitments before the bet, and the raw values are exposed
 * ONLY when they are supposed to be (at round/settlement/dispute) — never early, and never derivable
 * from what was published. These tests assert the OBSERVABLE guarantees:
 *   1. a published commitment is not the secret, and binds it (tampering is detected);
 *   2. the live, in-flight state objects do NOT carry the secret;
 *   3. the outcome cannot be computed from one party's secret + the other's commitment;
 *   4. revealing round k's seed never yields round k+1's.
 * (Pre-image resistance itself is a keccak property; we test the protocol shapes that rely on it.)
 */
import { describe, it, expect } from 'vitest'
import { keccak256, encodeAbiParameters, type Hex } from 'viem'
import {
  buildSeedChain, verifyReveal, commitSeed, roundRandom,
  hashBoard, start as minesStart, reveal as minesReveal, cashOut as minesCashOut, verify as minesVerify,
  MinesPhase, type MinesBoard,
  commitLayout, startTowers, towersResolveStep, towersAdvance, safeTilesOnFloor, verifyTowers,
  LadderPhase, type TowersConfig,
} from '../src'

const s = (n: number): Hex => (`0x${n.toString(16).padStart(64, '0')}`) as Hex

describe('server seed chain: commit hides seeds, reveals verify backward, future stays hidden', () => {
  const chain = buildSeedChain(s(0xabc), 8) // tip + length 8; commit = seeds[0]

  it('the published commit is not any round seed', () => {
    for (let k = 1; k <= chain.length; k++) expect(chain.commit).not.toBe(chain.seeds[k])
  })

  it("revealing round k's seed verifies against the prior link but does NOT reveal round k+1", () => {
    for (let k = 1; k <= chain.length; k++) {
      // the reveal checks against the previously-known link (seeds[k-1]); the commit is seeds[0].
      expect(verifyReveal(chain.seeds[k - 1]!, chain.seeds[k]!)).toBe(true)
      if (k < chain.length) {
        // you can hash FORWARD (seeds[k] = keccak(seeds[k+1])) to verify, but you cannot invert it to
        // GET seeds[k+1]; the only forward op on seeds[k] is keccak(seeds[k]) == seeds[k-1] (the past).
        expect(keccak256(chain.seeds[k + 1]!)).toBe(chain.seeds[k]) // k+1 is pre-committed under k
        expect(keccak256(chain.seeds[k]!)).toBe(chain.seeds[k - 1]) // hashing k only yields the PAST
        expect(chain.seeds[k + 1]).not.toBe(keccak256(chain.seeds[k]!)) // can't derive the future
      }
    }
  })

  it('a forged reveal (any value not hashing to the prior link) is rejected', () => {
    expect(verifyReveal(chain.seeds[2]!, s(0xdead))).toBe(false)
  })
})

describe('client seed commit hides the seed and binds it', () => {
  it('the commit is not the seed and is deterministic', () => {
    const clientSeed = s(0x1111)
    expect(commitSeed(clientSeed)).not.toBe(clientSeed)
    expect(commitSeed(clientSeed)).toBe(commitSeed(clientSeed))
  })
  it('different client seeds give different commits (binding)', () => {
    expect(commitSeed(s(0x1111))).not.toBe(commitSeed(s(0x2222)))
  })
})

describe('roundRandom needs BOTH raw seeds — neither party can predict the outcome at bet time', () => {
  const serverSeed = s(0x7777)
  const clientSeed = s(0x8888)
  const nonce = 1n
  const real = roundRandom(serverSeed, clientSeed, nonce)

  it('the house (holding only the client-seed COMMIT) computes a different value', () => {
    const withCommit = roundRandom(serverSeed, commitSeed(clientSeed), nonce)
    expect(withCommit).not.toBe(real) // commit ≠ raw seed ⇒ house cannot derive the real outcome
  })

  it('the player (holding only the server-seed chain COMMIT, not round k seed) computes a different value', () => {
    const chain = buildSeedChain(s(0x9999), 4)
    const realRoundK = roundRandom(chain.seeds[1]!, clientSeed, nonce) // round 1 uses seeds[1]
    const withRngCommit = roundRandom(chain.commit, clientSeed, nonce) // player only has seeds[0]
    expect(withRngCommit).not.toBe(realRoundK)
  })

  it('flipping either seed changes the outcome (both inputs genuinely gate it)', () => {
    expect(roundRandom(s(0x7778), clientSeed, nonce)).not.toBe(real)
    expect(roundRandom(serverSeed, s(0x8889), nonce)).not.toBe(real)
    expect(roundRandom(serverSeed, clientSeed, 2n)).not.toBe(real)
  })
})

describe('mines: the board commit hides the layout and detects tampering', () => {
  const config = { tiles: 9, mines: 2 }
  const board: MinesBoard = { config, mineTiles: [1, 4], salt: s(0x11) }
  const commit = hashBoard(board)

  it('the in-flight state carries only the commit — never the mine positions', () => {
    const state = minesStart(config, commit)
    expect('mineTiles' in state).toBe(false)
    expect(state.commit).toBe(commit)
    expect(state.revealed).toEqual([])
    // the serialized state a counterparty would see does not contain the layout
    const serialized = JSON.stringify(state, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
    expect(serialized).not.toContain('mineTiles')
    expect(serialized).not.toContain(board.salt)
  })

  it('the commit binds the layout: moving a mine, or changing the salt, changes the commit', () => {
    expect(hashBoard(board)).toBe(commit) // deterministic
    expect(hashBoard({ ...board, mineTiles: [2, 4] })).not.toBe(commit) // mine moved
    expect(hashBoard({ ...board, salt: s(0x12) })).not.toBe(commit) // salt changed
  })

  it('verify rejects a settled game whose revealed board does not match the commitment', () => {
    // honest game: reveal a safe tile (0), then cash out.
    let st = minesStart(config, commit)
    const r1 = minesReveal(st, 0, board.mineTiles.includes(0))
    if ('error' in r1) throw new Error(r1.error)
    st = r1.state
    const out = minesCashOut(st)
    if ('error' in out) throw new Error(out.error)
    const claim = {
      config, commit, reveals: out.state.revealed,
      cashedOut: out.state.phase === MinesPhase.CASHED_OUT, claimedMultiplierX100: out.state.multiplierX100,
    }
    expect(minesVerify(claim, board).ok).toBe(true) // honest board passes
    // a tampered board (mine moved off tile so the house could claim more safe reveals) fails:
    expect(minesVerify(claim, { ...board, mineTiles: [2, 4] }).ok).toBe(false)
  })
})

describe('ladder: the layout seed is absent from in-flight state; wrong seed fails verify', () => {
  const config: TowersConfig = { floors: 8, tilesPerFloor: 3, safePerFloor: 2 }
  const seed = 0x123456789n

  it('commitLayout is not the seed and binds it', () => {
    const c = commitLayout(seed)
    expect(c).not.toBe(seed.toString())
    expect(commitLayout(seed)).toBe(c) // deterministic
    expect(commitLayout(seed + 1n)).not.toBe(c) // binding
    // it really is keccak(abi.encode(seed)) — verifiable, but not invertible
    expect(c).toBe(keccak256(encodeAbiParameters([{ type: 'uint256' }], [seed])))
  })

  it('the in-flight state carries only the commit + choices — never the seed or the safe-tile layout', () => {
    const { state, commit } = startTowers(config, seed)
    expect('seed' in state).toBe(false)
    expect('layout' in state).toBe(false)
    expect('safeTiles' in state).toBe(false)
    expect(state.commit).toBe(commit)
    // advance a couple floors; the running state still never embeds the seed-derived layout
    let st = state
    const resolve = towersResolveStep(seed, config)
    for (let floor = 0; floor < 2 && st.phase === LadderPhase.PLAYING; floor++) {
      const safe = [...safeTilesOnFloor(seed, config, floor)][0]!
      const res = towersAdvance(st, safe, resolve(floor, safe))
      if ('error' in res) throw new Error(res.error)
      st = res.state
    }
    const serialized = JSON.stringify(st, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
    expect(serialized).not.toContain(seed.toString())
  })

  it('a dispute with the WRONG layout seed is rejected (seed must match the commitment)', () => {
    const { state } = startTowers(config, seed)
    const resolve = towersResolveStep(seed, config)
    const safe = [...safeTilesOnFloor(seed, config, 0)][0]!
    const res = towersAdvance(state, safe, resolve(0, safe))
    if ('error' in res) throw new Error(res.error)
    const claim = {
      commit: commitLayout(seed), maxSteps: config.floors, choices: res.state.choices,
      cashedOut: false, claimedMultiplierX100: res.state.multiplierX100,
    }
    // honest seed (replay matches) — but the claim is mid-game (not terminal), so make it a cash-out:
    const honest = verifyTowers({ ...claim, cashedOut: true }, seed, config)
    expect(honest.ok).toBe(true)
    // wrong seed: commitLayout(seed+1) ≠ commit ⇒ rejected before any replay
    expect(verifyTowers({ ...claim, cashedOut: true }, seed + 1n, config).ok).toBe(false)
  })
})
