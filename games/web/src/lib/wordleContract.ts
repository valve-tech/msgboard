import * as viem from 'viem'

/**
 * Minimal WordleLog ABI — the non-wagered "play with friends" ZK-Wordle record. A setter opens a
 * hidden-word challenge (`openChallenge`) and friends who solve it submit a `wordle_solve` proof
 * (`logSolve`), logged on a per-challenge leaderboard ranked by guesses-used. No Chips / house /
 * escrow. Matches packages/contracts/contracts/games/WordleLog.sol.
 *
 * On-chain is the OPTIONAL canonical anchor; the live game (challenge, guesses, clue proofs) rides
 * msgboard. `logSolve` verifies the proof against the challenge's stored `commit`, so anchoring a win
 * requires the setter to have called `openChallenge(challengeId, commit)` first.
 */
export const wordleLogAbi = [
  {
    type: 'function',
    name: 'openChallenge',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'challengeId', type: 'uint256' },
      { name: 'commit', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'logSolve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'challengeId', type: 'uint256' },
      { name: 'proof', type: 'uint256[24]' },
      { name: 'guessesCommit', type: 'uint256' },
      { name: 'proofDictRoot', type: 'uint256' },
      { name: 'guessesUsed', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'challenges',
    stateMutability: 'view',
    inputs: [{ name: 'challengeId', type: 'uint256' }],
    outputs: [
      { name: 'commit', type: 'uint256' },
      { name: 'setter', type: 'address' },
      { name: 'openedAt', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'dictRoot',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'logged',
    stateMutability: 'view',
    inputs: [
      { name: 'challengeId', type: 'uint256' },
      { name: 'guessesCommit', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'event',
    name: 'ChallengeOpened',
    inputs: [
      { name: 'challengeId', type: 'uint256', indexed: true },
      { name: 'setter', type: 'address', indexed: true },
      { name: 'commit', type: 'uint256', indexed: false },
      { name: 'openedAt', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'Solved',
    inputs: [
      { name: 'challengeId', type: 'uint256', indexed: true },
      { name: 'solver', type: 'address', indexed: true },
      { name: 'guessesUsed', type: 'uint256', indexed: false },
      { name: 'guessesCommit', type: 'uint256', indexed: false },
      { name: 'solvedAt', type: 'uint256', indexed: false },
    ],
  },
] as const

/** Read the on-chain challenge record (commit/setter/openedAt). openedAt === 0n ⇒ never opened. */
export const readChallenge = async (
  client: viem.PublicClient,
  wordleLog: viem.Hex,
  challengeId: bigint,
): Promise<{ commit: bigint; setter: viem.Hex; openedAt: bigint }> => {
  const [commit, setter, openedAt] = (await client.readContract({
    address: wordleLog,
    abi: wordleLogAbi,
    functionName: 'challenges',
    args: [challengeId],
  })) as [bigint, viem.Hex, bigint]
  return { commit, setter, openedAt }
}
