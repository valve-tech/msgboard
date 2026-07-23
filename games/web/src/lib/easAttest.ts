import * as viem from 'viem'
import type { GameDeployment } from '../config'
import { publicClientFor } from '../wallet'
import { sendGameTx } from '../tx'

/**
 * EAS leaderboard layer (SKILL_GAMES_DESIGN.md "leaderboard = EAS attestation"): a solve can be
 * recorded as an EAS attestation gated by the proof-checking resolvers deployed on both chains
 * (contracts/eas/{Sudoku,Wordle}SolveResolver.sol). The resolver replays exactly the checks
 * logSolve performs, so an attestation can only exist if the PLONK proof verifies — the standard,
 * composable twin of the Log entry. Schema field order is load-bearing (it IS the encoding) and
 * must match the registered schema strings byte-for-byte.
 */

const easAbi = [
  {
    type: 'function',
    name: 'attest',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'request',
        type: 'tuple',
        components: [
          { name: 'schema', type: 'bytes32' },
          {
            name: 'data',
            type: 'tuple',
            components: [
              { name: 'recipient', type: 'address' },
              { name: 'expirationTime', type: 'uint64' },
              { name: 'revocable', type: 'bool' },
              { name: 'refUID', type: 'bytes32' },
              { name: 'data', type: 'bytes' },
              { name: 'value', type: 'uint256' },
            ],
          },
        ],
      },
    ],
    outputs: [{ type: 'bytes32' }],
  },
  {
    type: 'event',
    name: 'Attested',
    inputs: [
      { name: 'recipient', type: 'address', indexed: true },
      { name: 'attester', type: 'address', indexed: true },
      { name: 'uid', type: 'bytes32', indexed: false },
      { name: 'schemaUID', type: 'bytes32', indexed: true },
    ],
  },
] as const

const sudokuResolverAbi = [
  {
    type: 'function',
    name: 'attestedNullifier',
    stateMutability: 'view',
    inputs: [{ name: 'nullifier', type: 'uint256' }],
    outputs: [{ type: 'bool' }],
  },
] as const

const wordleResolverAbi = [
  {
    type: 'function',
    name: 'attested',
    stateMutability: 'view',
    inputs: [
      { name: 'challengeId', type: 'uint256' },
      { name: 'guessesCommit', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const

/** True when this deployment carries the full EAS layer for the given game. */
export const sudokuEasReady = (d: GameDeployment): boolean =>
  !!(d.eas && d.sudokuSchemaUid && d.sudokuSolveResolver)
export const wordleEasReady = (d: GameDeployment): boolean =>
  !!(d.eas && d.wordleSchemaUid && d.wordleSolveResolver)

const attest = async (
  deployment: GameDeployment,
  walletClient: viem.WalletClient,
  schema: viem.Hex,
  recipient: viem.Hex,
  data: viem.Hex,
): Promise<{ txHash: viem.Hex; uid?: viem.Hex }> => {
  const receipt = await sendGameTx(deployment, walletClient, {
    address: deployment.eas!,
    abi: easAbi as viem.Abi,
    functionName: 'attest',
    args: [
      {
        schema,
        data: { recipient, expirationTime: 0n, revocable: false, refUID: viem.zeroHash, data, value: 0n },
      },
    ],
  })
  const attested = viem.parseEventLogs({ abi: easAbi, logs: receipt.logs, eventName: 'Attested' })[0]
  return { txHash: receipt.transactionHash, uid: (attested?.args as { uid?: viem.Hex })?.uid }
}

/**
 * Attest a proven sudoku solve. Schema (registered on both chains):
 *   uint256 puzzleId,uint256 player,uint256 nullifier,uint256[24] proof,uint256[81] puzzle
 * No elapsed field on purpose — readers derive it as attestation.time - openedAt.
 */
export const attestSudokuSolve = (
  deployment: GameDeployment,
  walletClient: viem.WalletClient,
  args: { puzzleId: bigint; player: bigint; nullifier: bigint; proof: bigint[]; puzzle: bigint[]; recipient: viem.Hex },
) =>
  attest(
    deployment,
    walletClient,
    deployment.sudokuSchemaUid!,
    args.recipient,
    viem.encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256[24]' }, { type: 'uint256[81]' }],
      [args.puzzleId, args.player, args.nullifier, args.proof as never, args.puzzle as never],
    ),
  )

/**
 * Attest a proven wordle solve. Schema:
 *   uint256 challengeId,uint256 guessesUsed,uint256 guessesCommit,uint256[24] proof
 * The resolver requires recipient == attester (same "whoever submits, claims" as WordleLog).
 */
export const attestWordleSolve = (
  deployment: GameDeployment,
  walletClient: viem.WalletClient,
  args: { challengeId: bigint; guessesUsed: bigint; guessesCommit: bigint; proof: bigint[]; recipient: viem.Hex },
) =>
  attest(
    deployment,
    walletClient,
    deployment.wordleSchemaUid!,
    args.recipient,
    viem.encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256[24]' }],
      [args.challengeId, args.guessesUsed, args.guessesCommit, args.proof as never],
    ),
  )

/** Which of these solve nullifiers are already EAS-attested (the resolver's own spent book). */
export const sudokuAttestedSet = async (
  deployment: GameDeployment,
  nullifiers: bigint[],
): Promise<Set<string>> => {
  if (!sudokuEasReady(deployment) || nullifiers.length === 0) return new Set()
  const client = publicClientFor(deployment.chainId, deployment.rpc)
  const capped = nullifiers.slice(0, 30) // leaderboard head only — one read per row
  const flags = await Promise.all(
    capped.map((n) =>
      client
        .readContract({
          address: deployment.sudokuSolveResolver!,
          abi: sudokuResolverAbi,
          functionName: 'attestedNullifier',
          args: [n],
        })
        .catch(() => false),
    ),
  )
  return new Set(capped.filter((_n, i) => flags[i]).map((n) => n.toString()))
}

/** Has this (challenge, guess sequence) already been attested? */
export const wordleAttested = async (
  deployment: GameDeployment,
  challengeId: bigint,
  guessesCommit: bigint,
): Promise<boolean> => {
  if (!wordleEasReady(deployment)) return false
  const client = publicClientFor(deployment.chainId, deployment.rpc)
  return client
    .readContract({
      address: deployment.wordleSolveResolver!,
      abi: wordleResolverAbi,
      functionName: 'attested',
      args: [challengeId, guessesCommit],
    })
    .catch(() => false) as Promise<boolean>
}
