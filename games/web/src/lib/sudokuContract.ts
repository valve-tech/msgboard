import * as viem from 'viem'

/**
 * Minimal SudokuLog ABI — the ZK skill-game leaderboard. `puzzles()`/`spentNullifier()` are reads,
 * `logSolve()` is the permissionless proof submission, and `Solved` is the leaderboard event scanned
 * when no indexer is configured. Matches packages/contracts/.../games/SudokuLog.sol.
 */
export const sudokuLogAbi = [
  {
    type: 'function',
    name: 'puzzles',
    stateMutability: 'view',
    inputs: [{ name: 'puzzleId', type: 'uint256' }],
    outputs: [
      { name: 'puzzleHash', type: 'bytes32' },
      { name: 'openedAt', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'spentNullifier',
    stateMutability: 'view',
    inputs: [{ name: 'nullifier', type: 'uint256' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'logSolve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'puzzleId', type: 'uint256' },
      { name: 'proof', type: 'uint256[24]' },
      { name: 'puzzle', type: 'uint256[81]' },
      { name: 'player', type: 'uint256' },
      { name: 'nullifier', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'event',
    name: 'Solved',
    inputs: [
      { name: 'puzzleId', type: 'uint256', indexed: true },
      { name: 'player', type: 'uint256', indexed: true },
      { name: 'nullifier', type: 'uint256', indexed: false },
      { name: 'solvedAt', type: 'uint256', indexed: false },
      { name: 'elapsed', type: 'uint256', indexed: false },
    ],
  },
] as const

/**
 * Known puzzle grids by id, keyed under the SudokuLog contract address (lowercase) they're published
 * on. Only the puzzleHash lives on-chain, so the 81-cell board must come from a trusted source and be
 * verified against that hash before play (verifyPuzzleGrid). Puzzle #1 is the canonical Wikipedia
 * sudoku, published on 369 mainnet + 943 testnet.
 */
export const CANONICAL_PUZZLE_1: number[] = [
  5, 3, 0, 0, 7, 0, 0, 0, 0,
  6, 0, 0, 1, 9, 5, 0, 0, 0,
  0, 9, 8, 0, 0, 0, 0, 6, 0,
  8, 0, 0, 0, 6, 0, 0, 0, 3,
  4, 0, 0, 8, 0, 3, 0, 0, 1,
  7, 0, 0, 0, 2, 0, 0, 0, 6,
  0, 6, 0, 0, 0, 0, 2, 8, 0,
  0, 0, 0, 4, 1, 9, 0, 0, 5,
  0, 0, 0, 0, 8, 0, 0, 7, 9,
]

/** Look up a known published grid for a puzzle id. Extend as more puzzles are opened. */
export const knownPuzzleGrid = (puzzleId: bigint): number[] | undefined =>
  puzzleId === 1n ? CANONICAL_PUZZLE_1 : undefined

/**
 * keccak256(abi.encode(uint256[81] puzzle)) — the exact preimage SudokuLog.openPuzzle stores as
 * `puzzleHash`. Lets the client confirm it holds the SAME board the contract pinned before play.
 */
export const puzzleGridHash = (puzzle: number[]): viem.Hex => {
  if (puzzle.length !== 81) throw new Error(`puzzleGridHash: expected 81 cells, got ${puzzle.length}`)
  // encodeAbiParameters types uint256[81] as a fixed 81-tuple; we've just checked the length.
  const cells = puzzle.map((c) => BigInt(c)) as unknown as readonly bigint[]
  return viem.keccak256(viem.encodeAbiParameters([{ type: 'uint256[81]' }], [cells] as never))
}

/** True iff `puzzle` hashes to the on-chain `puzzleHash` — the "I have the right board" check. */
export const verifyPuzzleGrid = (puzzle: number[], onChainHash: viem.Hex): boolean =>
  puzzleGridHash(puzzle).toLowerCase() === onChainHash.toLowerCase()
