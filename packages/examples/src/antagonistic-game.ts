/**
 * antagonistic-game — a commit-reveal game (rock-paper-scissors) played over the board.
 *
 * Games that need impartial inputs can use msgboard as a neutral channel that pits players'
 * incentives against each other. The classic mechanism is commit-reveal:
 *
 *   1. commit — each player posts keccak256(move, salt). The move is hidden, but the player is
 *      now bound to it: they cannot change it after seeing the opponent's.
 *   2. reveal — once both commits are on the board, each player posts (move, salt). Anyone can
 *      check the reveal hashes to the earlier commit and adjudicate the winner impartially.
 *
 * Two msgboard properties make this work without a referee server: proof of work makes spamming
 * fake commits costly, and the ~120-block ephemerality gives a natural reveal deadline — fail to
 * reveal in time and your message ages out, so stalling forfeits the round.
 *
 * Two modes:
 *   • No MSGBOARD_RPC (default): plays one round in-process — commits (opaque), reveals,
 *     adjudication — and shows that a player who reveals a different move than they committed is
 *     caught and disqualified.
 *   • MSGBOARD_RPC set: runs a relayer-engine referee over the `rps` category that pairs commits
 *     with reveals per round and announces winners.
 *
 * Usage:
 *   npm run antagonistic-game --workspace=packages/examples
 *   MSGBOARD_RPC=https://one.valve.city/rpc/vk_demo/evm/943 npm run antagonistic-game --workspace=packages/examples
 */
import { concatHex, hexToString, keccak256, numberToHex, http, type Hex } from 'viem'
import { generatePrivateKey } from 'viem/accounts'
import { fileURLToPath } from 'node:url'
import { Relayer, msgboardContentSource, defaultLogger } from '@msgboard/relayer'
import type { RelayerSource } from '@msgboard/relayer'
import type { RPCMessage } from '@msgboard/sdk'

export const CATEGORY = 'rps'
export const MOVES = ['rock', 'paper', 'scissors'] as const

/** keccak256 of the move byte concatenated with a 32-byte salt — the hidden commitment. */
export const commitOf = (move: number, salt: Hex): Hex => keccak256(concatHex([numberToHex(move, { size: 1 }), salt]))

/** Rock-paper-scissors result: 0 = tie, 1 = player a wins, 2 = player b wins. */
export const judge = (a: number, b: number): 0 | 1 | 2 => ((a - b + 3) % 3) as 0 | 1 | 2

export type Commit = { kind: 'commit'; round: string; player: string; commit: Hex }
export type Reveal = { kind: 'reveal'; round: string; player: string; move: number; salt: Hex }
export type Move = Commit | Reveal

export const decode = (data: Hex): Move | null => {
  try {
    const parsed = JSON.parse(hexToString(data)) as Move
    if (parsed.kind !== 'commit' && parsed.kind !== 'reveal') return null
    return parsed
  } catch {
    return null
  }
}

/**
 * Pairs commits with reveals per round and adjudicates once both players have revealed.
 * A reveal that does not hash to the player's commit is rejected as a cheat.
 */
export const makeReferee = () => {
  const rounds = new Map<string, { commits: Map<string, Hex>; reveals: Map<string, { move: number; salt: Hex }> }>()
  const decided = new Set<string>()

  const round = (id: string) => {
    const existing = rounds.get(id)
    if (existing) return existing
    const fresh = { commits: new Map<string, Hex>(), reveals: new Map<string, { move: number; salt: Hex }>() }
    rounds.set(id, fresh)
    return fresh
  }

  /** Returns a human-readable adjudication when a round completes, else null. */
  const observe = (move: Move): string | null => {
    const state = round(move.round)
    if (move.kind === 'commit') {
      state.commits.set(move.player, move.commit)
      return null
    }

    const commit = state.commits.get(move.player)
    if (!commit) return `${move.player} revealed before committing — ignored`
    if (commitOf(move.move, move.salt) !== commit) return `${move.player} revealed a move that does not match their commit — DISQUALIFIED`
    state.reveals.set(move.player, { move: move.move, salt: move.salt })

    const players = [...state.reveals.keys()]
    if (players.length < 2 || decided.has(move.round)) return null
    decided.add(move.round)

    const [pa, pb] = players
    const a = state.reveals.get(pa)!.move
    const b = state.reveals.get(pb)!.move
    const result = judge(a, b)
    const outcome = result === 0 ? 'tie' : `${result === 1 ? pa : pb} wins`
    return `round ${move.round}: ${pa}=${MOVES[a]} vs ${pb}=${MOVES[b]} → ${outcome}`
  }

  return { observe }
}

async function main() {
  const rpcUrl = process.env.MSGBOARD_RPC

  console.log('\nmsgboard antagonistic-game (rock-paper-scissors)')
  console.log('─────────────────────────────────────────')

  if (!rpcUrl) {
    const referee = makeReferee()
    const round = 'r1'
    // Alice plays paper, Bob plays rock — paper covers rock, Alice should win.
    const alice = { player: 'alice', move: 1, salt: generatePrivateKey() }
    const bob = { player: 'bob', move: 0, salt: generatePrivateKey() }

    console.log('\ncommit phase (moves are hidden behind a hash):')
    for (const p of [alice, bob]) {
      const commit = commitOf(p.move, p.salt)
      referee.observe({ kind: 'commit', round, player: p.player, commit })
      console.log(`  ${p.player} committed ${commit.slice(0, 18)}…`)
    }

    console.log('\nreveal phase:')
    console.log(`  alice reveals ${MOVES[alice.move]}`)
    const aliceResult = referee.observe({ kind: 'reveal', round, player: alice.player, move: alice.move, salt: alice.salt })
    if (aliceResult) console.log(`  → ${aliceResult}`)
    console.log(`  bob reveals ${MOVES[bob.move]}`)
    const bobResult = referee.observe({ kind: 'reveal', round, player: bob.player, move: bob.move, salt: bob.salt })
    if (bobResult) console.log(`  → ${bobResult}`)

    // Cheat attempt: Bob tries to reveal a winning move he never committed to.
    console.log('\ncheat attempt — bob tries to change his move at reveal time:')
    const cheatReferee = makeReferee()
    cheatReferee.observe({ kind: 'commit', round: 'r2', player: 'bob', commit: commitOf(0, bob.salt) }) // committed rock
    const caught = cheatReferee.observe({ kind: 'reveal', round: 'r2', player: 'bob', move: 1, salt: bob.salt }) // reveals paper
    console.log(`  → ${caught}`)

    console.log(`\nSet MSGBOARD_RPC to run a live referee over the "${CATEGORY}" category.\n`)
    process.exit(0)
  }

  // Live: a referee watcher that adjudicates rounds it observes on the board.
  const logger = defaultLogger('antagonistic-game')
  const referee = makeReferee()

  const moveSource: RelayerSource<Move> = {
    poll: async (context) => {
      const messages = (await msgboardContentSource({ category: CATEGORY }).poll(context)) as RPCMessage[]
      return messages.map((message) => decode(message.data)).filter((move): move is Move => move !== null)
    },
  }

  const relayer = new Relayer<Move>({
    node: { transport: http(rpcUrl) },
    mode: 'observe',
    source: moveSource,
    key: (move) => `${move.round}:${move.player}:${move.kind}`,
    action: {
      describe: (move) => `${move.kind} from ${move.player} in round ${move.round}`,
      execute: async (move) => {
        const adjudication = referee.observe(move)
        if (adjudication) console.log(adjudication)
        return { ok: true, ref: `${move.round}:${move.player}` }
      },
    },
    logger,
  })

  relayer.start()
  console.log(`refereeing the "${CATEGORY}" category — rpc: ${rpcUrl}`)
  console.log('post toHex(JSON.stringify({ kind:"commit"|"reveal", round, player, ... })) as message data to play.')

  process.on('SIGINT', async () => {
    console.log('\nstopping…')
    await relayer.stop()
    process.exit(0)
  })
}

// Run the demo only when executed directly (not when imported by tests).
if (process.argv[1] === fileURLToPath(import.meta.url)) void main()
