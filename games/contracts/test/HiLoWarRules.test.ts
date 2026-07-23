import * as viem from 'viem'
import { expect } from 'chai'
import hre from 'hardhat'
import * as helpers from '@nomicfoundation/hardhat-toolbox-viem/network-helpers'
import * as expectations from './expectations'
import {
  GAME_STATE_ABI,
  encodeGameState,
  hashGameStateAbi,
  encodeMove,
  hashBetCommit,
  initialFlipState,
  applyMove,
  Phase,
  type HiLoState,
  type Move,
} from '@msgboard/hilo-war'

// Two arbitrary non-zero placeholder addresses for the (revealVerifier, shuffleVerifier)
// constructor args — the pure logic never calls them.
const REVEAL = '0x0000000000000000000000000000000000000111' as viem.Hex
const SHUFFLE = '0x0000000000000000000000000000000000000222' as viem.Hex

const ANTE = viem.parseEther('1')
const SALT_A = ('0x' + 'a1'.repeat(32)) as viem.Hex
const SALT_B = ('0x' + 'b2'.repeat(32)) as viem.Hex

const deploy = async () => {
  const rules = await hre.viem.deployContract('HiLoWarRules', [REVEAL, SHUFFLE])
  return { rules, hre }
}

// Decode the bytes the contract returns into the same 16-tuple TS encodes.
const decodeState = (data: viem.Hex) => viem.decodeAbiParameters(GAME_STATE_ABI as any, data)

// Run the TS reference engine; throws if it errors (so tests assert on the happy state).
const applyTs = (s: HiLoState, m: Move): HiLoState => {
  const r = applyMove(s, m)
  if ('error' in r) throw new Error(r.error)
  return r.state
}

// Assert the contract's returned encoding is byte-identical to the TS engine's.
const expectParity = async (
  rules: Awaited<ReturnType<typeof deploy>>['rules'],
  s: HiLoState,
  m: Move,
) => {
  const got = (await rules.read.applyMove([encodeGameState(s), encodeMove(m)])) as viem.Hex
  const want = encodeGameState(applyTs(s, m))
  expect(got).to.equal(want)
  return decodeState(got)
}

const freshDealState = () => initialFlipState({ ante: ANTE, deckIndex: 0, warPot: 0n })

// Drive the TS engine through a sequence, returning every intermediate state so the
// Solidity can be checked against each one.
const drive = (start: HiLoState, moves: Move[]) => {
  let s = start
  const states: HiLoState[] = [start]
  for (const m of moves) {
    s = applyTs(s, m)
    states.push(s)
  }
  return states
}

describe('HiLoWarRules', () => {
  describe('hashGameState', () => {
    it('matches hashGameStateAbi for a fresh flip state', async () => {
      const { rules } = await helpers.loadFixture(deploy)
      const s = freshDealState()
      const got = await rules.read.hashGameState([encodeGameState(s)])
      expect(got).to.equal(hashGameStateAbi(s))
    })
  })

  describe('happy path', () => {
    it('DEAL_DONE -> both commits -> both opens (hold/hold) -> decisive SHOWDOWN matches TS', async () => {
      const { rules } = await helpers.loadFixture(deploy)
      const commitA = hashBetCommit('HOLD', SALT_A)
      const commitB = hashBetCommit('HOLD', SALT_B)
      const moves: Move[] = [
        { kind: 'DEAL_DONE' },
        { kind: 'BET_COMMIT', by: 'A', commitment: commitA },
        { kind: 'BET_COMMIT', by: 'B', commitment: commitB },
        { kind: 'BET_OPEN', by: 'A', bet: 'HOLD', salt: SALT_A },
        { kind: 'BET_OPEN', by: 'B', bet: 'HOLD', salt: SALT_B },
        // ranks: cardA index 40 -> rank 10, cardB index 0 -> rank 0; A wins decisively
        { kind: 'SHOWDOWN', cardA: 40, cardB: 0 },
      ]
      const states = drive(freshDealState(), moves)
      // Cross-check the Solidity against the TS engine at EVERY step in the path.
      for (let i = 0; i < moves.length; i++) {
        await expectParity(rules, states[i]!, moves[i]!)
      }
      // And assert the terminal state's decoded result explicitly.
      const final = states[states.length - 1]!
      const decoded = decodeState(encodeGameState(final))
      expect(decoded[0]).to.equal(Phase.FLIP_DONE) // phase
      expect(decoded[12]).to.equal(1) // resultWinner == A
      expect(decoded[13]).to.equal(2n * ANTE) // resultAmount == pot (both antes)
      expect(decoded[14]).to.equal(true) // resultSet
      expect(decoded[3]).to.equal(0n) // pot drained
    })

    it('RAISE/HOLD seats the raiser ante on the open (per-seat increment, CALL_OR_FOLD)', async () => {
      const { rules } = await helpers.loadFixture(deploy)
      const commitA = hashBetCommit('RAISE', SALT_A)
      const commitB = hashBetCommit('HOLD', SALT_B)
      let s = freshDealState()
      s = applyTs(s, { kind: 'DEAL_DONE' })
      s = applyTs(s, { kind: 'BET_COMMIT', by: 'A', commitment: commitA })
      s = applyTs(s, { kind: 'BET_COMMIT', by: 'B', commitment: commitB })
      // A opens RAISE first — ante should already be in the pot AFTER this single open,
      // before B has opened. This is the divergence from the plan sketch.
      const afterA = await expectParity(rules, s, { kind: 'BET_OPEN', by: 'A', bet: 'RAISE', salt: SALT_A })
      expect(afterA[0]).to.equal(Phase.BET_OPEN) // still waiting on B
      expect(afterA[3]).to.equal(3n * ANTE) // 2 antes from deal + A's raise ante
      expect(afterA[5]).to.equal(2n * ANTE) // contributedA = deal ante + raise ante
      // B opens HOLD -> resolve to CALL_OR_FOLD, raiser A, no further pot change
      const sAfterA = applyTs(s, { kind: 'BET_OPEN', by: 'A', bet: 'RAISE', salt: SALT_A })
      const afterB = await expectParity(rules, sAfterA, { kind: 'BET_OPEN', by: 'B', bet: 'HOLD', salt: SALT_B })
      expect(afterB[0]).to.equal(Phase.CALL_OR_FOLD)
      expect(afterB[11]).to.equal(1) // raiser == A
      expect(afterB[3]).to.equal(3n * ANTE)
    })

    it('RAISE/RAISE seats both antes across the two opens, then SHOWDOWN', async () => {
      const { rules } = await helpers.loadFixture(deploy)
      const commitA = hashBetCommit('RAISE', SALT_A)
      const commitB = hashBetCommit('RAISE', SALT_B)
      const moves: Move[] = [
        { kind: 'DEAL_DONE' },
        { kind: 'BET_COMMIT', by: 'A', commitment: commitA },
        { kind: 'BET_COMMIT', by: 'B', commitment: commitB },
        { kind: 'BET_OPEN', by: 'A', bet: 'RAISE', salt: SALT_A },
        { kind: 'BET_OPEN', by: 'B', bet: 'RAISE', salt: SALT_B },
      ]
      const states = drive(freshDealState(), moves)
      for (let i = 0; i < moves.length; i++) {
        await expectParity(rules, states[i]!, moves[i]!)
      }
      const final = states[states.length - 1]!
      const decoded = decodeState(encodeGameState(final))
      expect(decoded[0]).to.equal(Phase.SHOWDOWN)
      expect(decoded[11]).to.equal(0) // raiser cleared on equal bets
      expect(decoded[3]).to.equal(4n * ANTE) // 2 deal antes + 2 raise antes
    })
  })

  describe('CALL / FOLD', () => {
    // Reach CALL_OR_FOLD with A as the raiser.
    const reachCallOrFold = (): HiLoState => {
      let s = freshDealState()
      s = applyTs(s, { kind: 'DEAL_DONE' })
      s = applyTs(s, { kind: 'BET_COMMIT', by: 'A', commitment: hashBetCommit('RAISE', SALT_A) })
      s = applyTs(s, { kind: 'BET_COMMIT', by: 'B', commitment: hashBetCommit('HOLD', SALT_B) })
      s = applyTs(s, { kind: 'BET_OPEN', by: 'A', bet: 'RAISE', salt: SALT_A })
      s = applyTs(s, { kind: 'BET_OPEN', by: 'B', bet: 'HOLD', salt: SALT_B })
      return s
    }

    it('CALL by the non-raiser adds an ante and advances to SHOWDOWN', async () => {
      const { rules } = await helpers.loadFixture(deploy)
      const s = reachCallOrFold()
      const decoded = await expectParity(rules, s, { kind: 'CALL', by: 'B' })
      expect(decoded[0]).to.equal(Phase.SHOWDOWN)
      expect(decoded[3]).to.equal(4n * ANTE) // 2 deal + A raise + B call
      expect(decoded[6]).to.equal(2n * ANTE) // contributedB = deal ante + call ante
    })

    it('CALL by the raiser reverts IllegalMove', async () => {
      const { rules } = await helpers.loadFixture(deploy)
      const s = reachCallOrFold()
      await expectations.revertedWithCustomError(
        rules,
        rules.read.applyMove([encodeGameState(s), encodeMove({ kind: 'CALL', by: 'A' })]),
        'IllegalMove',
      )
    })

    it('FOLD pays the raiser pot+warPot and sets foldedCardHidden', async () => {
      const { rules } = await helpers.loadFixture(deploy)
      const s = { ...reachCallOrFold(), warPot: 5n * ANTE }
      const decoded = await expectParity(rules, s, { kind: 'FOLD', by: 'B' })
      expect(decoded[0]).to.equal(Phase.FLIP_DONE)
      expect(decoded[12]).to.equal(1) // resultWinner == raiser A
      expect(decoded[13]).to.equal(3n * ANTE + 5n * ANTE) // pot (3 antes) + warPot
      expect(decoded[14]).to.equal(true) // resultSet
      expect(decoded[15]).to.equal(true) // foldedCardHidden
      expect(decoded[3]).to.equal(0n) // pot drained
      expect(decoded[4]).to.equal(0n) // warPot drained
    })

    it('FOLD by the raiser reverts IllegalMove', async () => {
      const { rules } = await helpers.loadFixture(deploy)
      const s = reachCallOrFold()
      await expectations.revertedWithCustomError(
        rules,
        rules.read.applyMove([encodeGameState(s), encodeMove({ kind: 'FOLD', by: 'A' })]),
        'IllegalMove',
      )
    })
  })

  describe('BET_OPEN', () => {
    const reachBetOpen = (): HiLoState => {
      let s = freshDealState()
      s = applyTs(s, { kind: 'DEAL_DONE' })
      s = applyTs(s, { kind: 'BET_COMMIT', by: 'A', commitment: hashBetCommit('HOLD', SALT_A) })
      s = applyTs(s, { kind: 'BET_COMMIT', by: 'B', commitment: hashBetCommit('HOLD', SALT_B) })
      return s
    }

    it('open with the wrong salt reverts CommitMismatch', async () => {
      const { rules } = await helpers.loadFixture(deploy)
      const s = reachBetOpen()
      const wrongSalt = ('0x' + 'cc'.repeat(32)) as viem.Hex
      await expectations.revertedWithCustomError(
        rules,
        rules.read.applyMove([
          encodeGameState(s),
          encodeMove({ kind: 'BET_OPEN', by: 'A', bet: 'HOLD', salt: wrongSalt }),
        ]),
        'CommitMismatch',
      )
    })

    it('open with the wrong bet value reverts CommitMismatch', async () => {
      const { rules } = await helpers.loadFixture(deploy)
      const s = reachBetOpen()
      // Committed to HOLD, but opening RAISE with the HOLD salt -> hash mismatch.
      await expectations.revertedWithCustomError(
        rules,
        rules.read.applyMove([
          encodeGameState(s),
          encodeMove({ kind: 'BET_OPEN', by: 'A', bet: 'RAISE', salt: SALT_A }),
        ]),
        'CommitMismatch',
      )
    })
  })

  describe('SHOWDOWN', () => {
    // Reach SHOWDOWN via HOLD/HOLD, with a chosen warPot carried in.
    const reachShowdown = (warPot: bigint): HiLoState => {
      let s = { ...freshDealState(), warPot }
      s = applyTs(s, { kind: 'DEAL_DONE' })
      s = applyTs(s, { kind: 'BET_COMMIT', by: 'A', commitment: hashBetCommit('HOLD', SALT_A) })
      s = applyTs(s, { kind: 'BET_COMMIT', by: 'B', commitment: hashBetCommit('HOLD', SALT_B) })
      s = applyTs(s, { kind: 'BET_OPEN', by: 'A', bet: 'HOLD', salt: SALT_A })
      s = applyTs(s, { kind: 'BET_OPEN', by: 'B', bet: 'HOLD', salt: SALT_B })
      return s
    }

    it('a tie carries the pot into warPot and clears the result', async () => {
      const { rules } = await helpers.loadFixture(deploy)
      const s = reachShowdown(3n * ANTE)
      // cardA 8 -> rank 2, cardB 9 -> rank 2: same rank, different card -> tie
      const decoded = await expectParity(rules, s, { kind: 'SHOWDOWN', cardA: 8, cardB: 9 })
      expect(decoded[0]).to.equal(Phase.FLIP_DONE)
      expect(decoded[3]).to.equal(0n) // pot drained into warPot
      expect(decoded[4]).to.equal(3n * ANTE + 2n * ANTE) // prior warPot + this flip's pot
      expect(decoded[14]).to.equal(false) // resultSet false (result: null)
    })

    it('a decisive showdown carries the warPot into the winner amount', async () => {
      const { rules } = await helpers.loadFixture(deploy)
      const s = reachShowdown(3n * ANTE)
      // cardA 0 -> rank 0, cardB 40 -> rank 10: B wins
      const decoded = await expectParity(rules, s, { kind: 'SHOWDOWN', cardA: 0, cardB: 40 })
      expect(decoded[0]).to.equal(Phase.FLIP_DONE)
      expect(decoded[12]).to.equal(2) // resultWinner == B
      expect(decoded[13]).to.equal(2n * ANTE + 3n * ANTE) // pot + warPot
      expect(decoded[4]).to.equal(0n) // warPot drained
    })

    it('equal card indices revert BadCard', async () => {
      const { rules } = await helpers.loadFixture(deploy)
      const s = reachShowdown(0n)
      await expectations.revertedWithCustomError(
        rules,
        rules.read.applyMove([encodeGameState(s), encodeMove({ kind: 'SHOWDOWN', cardA: 7, cardB: 7 })]),
        'BadCard',
      )
    })

    it('an out-of-range card index reverts BadCard', async () => {
      const { rules } = await helpers.loadFixture(deploy)
      const s = reachShowdown(0n)
      await expectations.revertedWithCustomError(
        rules,
        rules.read.applyMove([encodeGameState(s), encodeMove({ kind: 'SHOWDOWN', cardA: 52, cardB: 0 })]),
        'BadCard',
      )
    })
  })

  describe('terminal states', () => {
    it('any move on a FLIP_DONE state reverts WrongPhase', async () => {
      const { rules } = await helpers.loadFixture(deploy)
      const s: HiLoState = { ...freshDealState(), phase: Phase.FLIP_DONE }
      await expectations.revertedWithCustomError(
        rules,
        rules.read.applyMove([encodeGameState(s), encodeMove({ kind: 'DEAL_DONE' })]),
        'WrongPhase',
      )
    })
  })

  describe('whoseTurn', () => {
    it('fresh BET_COMMIT -> both seats owe (mask 3)', async () => {
      const { rules } = await helpers.loadFixture(deploy)
      let s = freshDealState()
      s = applyTs(s, { kind: 'DEAL_DONE' })
      expect(await rules.read.whoseTurn([encodeGameState(s)])).to.equal(3)
    })

    it('after A commits -> only B owes (mask 2)', async () => {
      const { rules } = await helpers.loadFixture(deploy)
      let s = freshDealState()
      s = applyTs(s, { kind: 'DEAL_DONE' })
      s = applyTs(s, { kind: 'BET_COMMIT', by: 'A', commitment: hashBetCommit('HOLD', SALT_A) })
      expect(await rules.read.whoseTurn([encodeGameState(s)])).to.equal(2)
    })

    it('fresh BET_OPEN (no seat opened) -> both seats owe (mask 3)', async () => {
      const { rules } = await helpers.loadFixture(deploy)
      // Both committed -> phase advances to BET_OPEN, bets still empty.
      let s = freshDealState()
      s = applyTs(s, { kind: 'DEAL_DONE' })
      s = applyTs(s, { kind: 'BET_COMMIT', by: 'A', commitment: hashBetCommit('HOLD', SALT_A) })
      s = applyTs(s, { kind: 'BET_COMMIT', by: 'B', commitment: hashBetCommit('HOLD', SALT_B) })
      expect(s.phase).to.equal(Phase.BET_OPEN)
      expect(s.bets).to.deep.equal({})
      expect(await rules.read.whoseTurn([encodeGameState(s)])).to.equal(3)
    })

    it('BET_OPEN after A opens (betA set, betB unset) -> only B owes (mask 2)', async () => {
      const { rules } = await helpers.loadFixture(deploy)
      // A opens RAISE, B has not opened: still BET_OPEN with betA != 0, betB == 0.
      let s = freshDealState()
      s = applyTs(s, { kind: 'DEAL_DONE' })
      s = applyTs(s, { kind: 'BET_COMMIT', by: 'A', commitment: hashBetCommit('RAISE', SALT_A) })
      s = applyTs(s, { kind: 'BET_COMMIT', by: 'B', commitment: hashBetCommit('HOLD', SALT_B) })
      s = applyTs(s, { kind: 'BET_OPEN', by: 'A', bet: 'RAISE', salt: SALT_A })
      expect(s.phase).to.equal(Phase.BET_OPEN)
      expect(s.bets.A).to.equal('RAISE')
      expect(s.bets.B).to.equal(undefined)
      expect(await rules.read.whoseTurn([encodeGameState(s)])).to.equal(2)
    })

    it('BET_OPEN after B opens (betB set, betA unset) -> only A owes (mask 1)', async () => {
      const { rules } = await helpers.loadFixture(deploy)
      // Mirror of the above: only B has opened.
      let s = freshDealState()
      s = applyTs(s, { kind: 'DEAL_DONE' })
      s = applyTs(s, { kind: 'BET_COMMIT', by: 'A', commitment: hashBetCommit('HOLD', SALT_A) })
      s = applyTs(s, { kind: 'BET_COMMIT', by: 'B', commitment: hashBetCommit('RAISE', SALT_B) })
      s = applyTs(s, { kind: 'BET_OPEN', by: 'B', bet: 'RAISE', salt: SALT_B })
      expect(s.phase).to.equal(Phase.BET_OPEN)
      expect(s.bets.A).to.equal(undefined)
      expect(s.bets.B).to.equal('RAISE')
      expect(await rules.read.whoseTurn([encodeGameState(s)])).to.equal(1)
    })

    it('CALL_OR_FOLD with raiser A -> only B owes (mask 2)', async () => {
      const { rules } = await helpers.loadFixture(deploy)
      let s = freshDealState()
      s = applyTs(s, { kind: 'DEAL_DONE' })
      s = applyTs(s, { kind: 'BET_COMMIT', by: 'A', commitment: hashBetCommit('RAISE', SALT_A) })
      s = applyTs(s, { kind: 'BET_COMMIT', by: 'B', commitment: hashBetCommit('HOLD', SALT_B) })
      s = applyTs(s, { kind: 'BET_OPEN', by: 'A', bet: 'RAISE', salt: SALT_A })
      s = applyTs(s, { kind: 'BET_OPEN', by: 'B', bet: 'HOLD', salt: SALT_B })
      expect(s.phase).to.equal(Phase.CALL_OR_FOLD)
      expect(s.raiser).to.equal('A')
      expect(await rules.read.whoseTurn([encodeGameState(s)])).to.equal(2)
    })

    it('fallthrough SHOWDOWN -> both seats owe protocol progress (mask 3)', async () => {
      const { rules } = await helpers.loadFixture(deploy)
      // Reach SHOWDOWN via HOLD/HOLD; both seats owe the next co-signed (flip) step.
      let s = freshDealState()
      s = applyTs(s, { kind: 'DEAL_DONE' })
      s = applyTs(s, { kind: 'BET_COMMIT', by: 'A', commitment: hashBetCommit('HOLD', SALT_A) })
      s = applyTs(s, { kind: 'BET_COMMIT', by: 'B', commitment: hashBetCommit('HOLD', SALT_B) })
      s = applyTs(s, { kind: 'BET_OPEN', by: 'A', bet: 'HOLD', salt: SALT_A })
      s = applyTs(s, { kind: 'BET_OPEN', by: 'B', bet: 'HOLD', salt: SALT_B })
      expect(s.phase).to.equal(Phase.SHOWDOWN)
      expect(await rules.read.whoseTurn([encodeGameState(s)])).to.equal(3)
    })

    it('fallthrough DEAL -> both seats owe protocol progress (mask 3)', async () => {
      const { rules } = await helpers.loadFixture(deploy)
      // The fresh flip state sits in DEAL before DEAL_DONE; both owe the deal step.
      const s = freshDealState()
      expect(s.phase).to.equal(Phase.DEAL)
      expect(await rules.read.whoseTurn([encodeGameState(s)])).to.equal(3)
    })

    it('SETTLED -> nobody owes (mask 0)', async () => {
      const { rules } = await helpers.loadFixture(deploy)
      const s: HiLoState = { ...freshDealState(), phase: Phase.SETTLED }
      expect(await rules.read.whoseTurn([encodeGameState(s)])).to.equal(0)
    })
  })

  describe('gameId', () => {
    // gap 15: the game-id discriminator is a constant 1 (HiLo War). Asserting it covers the
    // otherwise-untested gameId() function.
    it('returns 1', async () => {
      const { rules } = await helpers.loadFixture(deploy)
      expect(await rules.read.gameId()).to.equal(1)
    })
  })

  describe('unknown move kind', () => {
    // gap 16: applyMove's final `else` — a move whose kind is none of 0..5. The dispatcher decodes
    // the move as abi.encode(uint8 kind, bytes payload); kind = 6 from a valid non-terminal state
    // (fresh DEAL) falls through every branch and reverts IllegalMove.
    it('reverts IllegalMove for an out-of-range move kind', async () => {
      const { rules } = await helpers.loadFixture(deploy)
      const s = freshDealState()
      expect(s.phase).to.equal(Phase.DEAL) // non-terminal, so WrongPhase does not short-circuit
      const unknownMove = viem.encodeAbiParameters(
        [{ type: 'uint8' }, { type: 'bytes' }],
        [6, '0x'],
      )
      await expectations.revertedWithCustomError(
        rules,
        rules.read.applyMove([encodeGameState(s), unknownMove]),
        'IllegalMove',
      )
    })
  })

  describe('isFinal', () => {
    it('is true only for phase SETTLED (7)', async () => {
      const { rules } = await helpers.loadFixture(deploy)
      for (let p = 0; p <= 7; p++) {
        expect(await rules.read.isFinal([p])).to.equal(p === Phase.SETTLED)
      }
    })
  })
})
