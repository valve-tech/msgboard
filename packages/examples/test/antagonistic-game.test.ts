import { describe, it, expect } from 'vitest'
import type { Hex } from 'viem'
import { commitOf, judge, makeReferee, decode, MOVES } from '../src/antagonistic-game.js'

const SALT_A = `0x${'11'.repeat(32)}` as Hex
const SALT_B = `0x${'22'.repeat(32)}` as Hex
const ROCK = 0
const PAPER = 1
const SCISSORS = 2

describe('judge', () => {
  // The whole point of the game is impartial adjudication: the move that beats the
  // other must win, equal moves tie. If this drifts the referee crowns the wrong player.
  it('returns a tie (0) when both players throw the same move', () => {
    expect(judge(ROCK, ROCK)).toBe(0)
    expect(judge(PAPER, PAPER)).toBe(0)
    expect(judge(SCISSORS, SCISSORS)).toBe(0)
  })

  it('awards player a (1) when a beats b', () => {
    expect(judge(PAPER, ROCK)).toBe(1) // paper covers rock
    expect(judge(ROCK, SCISSORS)).toBe(1) // rock blunts scissors
    expect(judge(SCISSORS, PAPER)).toBe(1) // scissors cut paper
  })

  it('awards player b (2) when b beats a', () => {
    expect(judge(ROCK, PAPER)).toBe(2)
    expect(judge(SCISSORS, ROCK)).toBe(2)
    expect(judge(PAPER, SCISSORS)).toBe(2)
  })
})

describe('commitOf', () => {
  // A commitment must be a deterministic, hiding function of (move, salt): the same
  // inputs always reproduce it (so a reveal can be checked) and a different salt hides
  // the same move behind a different value (so opponents cannot correlate moves).
  it('is deterministic for the same move and salt', () => {
    expect(commitOf(ROCK, SALT_A)).toBe(commitOf(ROCK, SALT_A))
  })

  it('changes when the salt changes, even for the same move', () => {
    expect(commitOf(ROCK, SALT_A)).not.toBe(commitOf(ROCK, SALT_B))
  })

  it('changes when the move changes, even for the same salt', () => {
    expect(commitOf(ROCK, SALT_A)).not.toBe(commitOf(PAPER, SALT_A))
  })
})

describe('makeReferee', () => {
  it('holds commits silently until a round can be decided', () => {
    const referee = makeReferee()
    expect(referee.observe({ kind: 'commit', round: 'r1', player: 'alice', commit: commitOf(PAPER, SALT_A) })).toBeNull()
    expect(referee.observe({ kind: 'commit', round: 'r1', player: 'bob', commit: commitOf(ROCK, SALT_B) })).toBeNull()
  })

  it('does not adjudicate until BOTH players have revealed', () => {
    const referee = makeReferee()
    referee.observe({ kind: 'commit', round: 'r1', player: 'alice', commit: commitOf(PAPER, SALT_A) })
    referee.observe({ kind: 'commit', round: 'r1', player: 'bob', commit: commitOf(ROCK, SALT_B) })
    // only one reveal so far — the round is still open
    expect(referee.observe({ kind: 'reveal', round: 'r1', player: 'alice', move: PAPER, salt: SALT_A })).toBeNull()
  })

  it('adjudicates the winner once both reveal matching moves', () => {
    const referee = makeReferee()
    referee.observe({ kind: 'commit', round: 'r1', player: 'alice', commit: commitOf(PAPER, SALT_A) })
    referee.observe({ kind: 'commit', round: 'r1', player: 'bob', commit: commitOf(ROCK, SALT_B) })
    referee.observe({ kind: 'reveal', round: 'r1', player: 'alice', move: PAPER, salt: SALT_A })
    const outcome = referee.observe({ kind: 'reveal', round: 'r1', player: 'bob', move: ROCK, salt: SALT_B })
    // paper beats rock — alice must win
    expect(outcome).toContain('alice wins')
    expect(outcome).toContain(`alice=${MOVES[PAPER]}`)
    expect(outcome).toContain(`bob=${MOVES[ROCK]}`)
  })

  it('reports a tie when both reveal the same move', () => {
    const referee = makeReferee()
    referee.observe({ kind: 'commit', round: 'r1', player: 'alice', commit: commitOf(ROCK, SALT_A) })
    referee.observe({ kind: 'commit', round: 'r1', player: 'bob', commit: commitOf(ROCK, SALT_B) })
    referee.observe({ kind: 'reveal', round: 'r1', player: 'alice', move: ROCK, salt: SALT_A })
    const outcome = referee.observe({ kind: 'reveal', round: 'r1', player: 'bob', move: ROCK, salt: SALT_B })
    expect(outcome).toContain('tie')
  })

  it('rejects a reveal from a player who never committed', () => {
    const referee = makeReferee()
    const outcome = referee.observe({ kind: 'reveal', round: 'r1', player: 'mallory', move: ROCK, salt: SALT_A })
    expect(outcome).toContain('revealed before committing')
  })

  it('DISQUALIFIES a reveal that does not hash to the commitment (the anti-cheat guarantee)', () => {
    const referee = makeReferee()
    // Bob commits to rock, then tries to reveal paper using the same salt.
    referee.observe({ kind: 'commit', round: 'r1', player: 'bob', commit: commitOf(ROCK, SALT_B) })
    const outcome = referee.observe({ kind: 'reveal', round: 'r1', player: 'bob', move: PAPER, salt: SALT_B })
    expect(outcome).toContain('DISQUALIFIED')
  })
})

describe('decode', () => {
  const toHexJson = (value: unknown): Hex =>
    `0x${Buffer.from(JSON.stringify(value), 'utf8').toString('hex')}` as Hex

  it('decodes a well-formed commit message', () => {
    const move = { kind: 'commit', round: 'r1', player: 'alice', commit: commitOf(ROCK, SALT_A) }
    expect(decode(toHexJson(move))).toMatchObject(move)
  })

  it('returns null for data that is not valid JSON', () => {
    expect(decode('0xdeadbeef')).toBeNull()
  })

  it('returns null when the JSON is not a commit or reveal', () => {
    expect(decode(toHexJson({ kind: 'chitchat', round: 'r1' }))).toBeNull()
  })
})
