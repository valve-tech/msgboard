import { ponder } from 'ponder:registry'
import { sudokuPuzzle, sudokuSolve } from 'ponder:schema'

// SudokuLog's ABI is sourced as a generic `viem.Abi` (like coinFlipAbi/raffleAbi), so Ponder can't
// derive the event-name literal union or arg types at the type level — the events are still valid at
// RUNTIME. Cast `on` to a loose signature so the `SudokuLog:*` literals typecheck, mirroring index.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const on = ponder.on as unknown as (name: string, handler: (arg: any) => unknown) => void

// PuzzleOpened(uint256 indexed puzzleId, uint256 openedAt): one puzzle per chain. Keyed by
// `${chainId}-${puzzleId}` so re-indexing (and the same puzzleId on both chains) stays idempotent.
on('SudokuLog:PuzzleOpened', async ({ event, context }: any) => {
  const chainId = context.network.chainId
  await context.db
    .insert(sudokuPuzzle)
    .values({
      id: `${chainId}-${event.args.puzzleId.toString()}`,
      chainId,
      puzzleId: event.args.puzzleId,
      openedAt: event.args.openedAt,
      blockNumber: event.block.number,
      txHash: event.transaction.hash,
    })
    .onConflictDoNothing()
})

// Solved(uint256 indexed puzzleId, uint256 indexed player, uint256 nullifier, uint256 solvedAt,
// uint256 elapsed): the leaderboard row. `player`/`nullifier` are uint256 ZK commitments stored as
// decimal strings (JSON/GraphQL has no bigint). Keyed by `${chainId}-${txHash}-${logIndex}`.
on('SudokuLog:Solved', async ({ event, context }: any) => {
  const chainId = context.network.chainId
  await context.db
    .insert(sudokuSolve)
    .values({
      id: `${chainId}-${event.transaction.hash}-${event.log.logIndex}`,
      chainId,
      puzzleId: event.args.puzzleId,
      player: event.args.player.toString(),
      nullifier: event.args.nullifier.toString(),
      solvedAt: event.args.solvedAt,
      elapsed: event.args.elapsed,
      blockNumber: event.block.number,
      txHash: event.transaction.hash,
    })
    .onConflictDoNothing()
})
