/**
 * Pure functions for HouseChannel settlement indexing.
 *
 * Extracted from the Ponder handlers so they can be unit-tested without a live DB or RPC. The
 * handlers in src/index.ts are thin wrappers that call these and forward the result to context.db.
 */

/** Map on-chain gameId (uint8) to a human-readable string. */
export function gameIdToName(gameId: number): string {
  switch (gameId) {
    case 1:  return 'dice'
    case 2:  return 'limbo'
    default: return String(gameId)
  }
}

/** Shape of a row returned by openedRow (matches the `settlement` onchainTable columns). */
export interface OpenedRow {
  id:             `0x${string}`
  tableId:        `0x${string}`
  game:           string
  player:         `0x${string}`
  escrowPlayer:   bigint
  payoutPlayer:   bigint | null
  net:            bigint | null
  blockNumber:    bigint
  blockTimestamp: bigint
  txHash:         `0x${string}`
}

/** Shape of the partial update applied by settledUpdate. */
export interface SettledUpdate {
  payoutPlayer: bigint
  net:          bigint
}

/**
 * Build the initial settlement row from a decoded HouseChannel:Opened event.
 * `payoutPlayer` and `net` are null until the matching Settled fires.
 */
export function openedRow(event: {
  args: {
    tableId:      `0x${string}`
    player:       `0x${string}`
    playerKey:    `0x${string}`
    gameId:       number
    escrowPlayer: bigint
    escrowHouse:  bigint
  }
  block: { number: bigint; timestamp: bigint }
  transaction: { hash: `0x${string}` }
}): OpenedRow {
  const { tableId, player, gameId, escrowPlayer } = event.args
  return {
    id:             tableId,
    tableId,
    game:           gameIdToName(gameId),
    player,
    escrowPlayer,
    payoutPlayer:   null,
    net:            null,
    blockNumber:    event.block.number,
    blockTimestamp: event.block.timestamp,
    txHash:         event.transaction.hash,
  }
}

/**
 * Compute the update fields from a HouseChannel:Settled event given the existing row's escrowPlayer.
 * net = payoutPlayer − escrowPlayer (positive → player profit, negative → player loss).
 */
export function settledUpdate(
  existingRow: { escrowPlayer: bigint },
  event: {
    args: {
      tableId:      `0x${string}`
      payoutPlayer: bigint
      payoutHouse:  bigint
    }
  },
): SettledUpdate {
  const { payoutPlayer } = event.args
  return {
    payoutPlayer,
    net: payoutPlayer - existingRow.escrowPlayer,
  }
}
