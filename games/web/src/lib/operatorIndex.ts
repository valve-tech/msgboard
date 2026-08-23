import type { Address, Hex } from 'viem'
import { verifyRound, type OpenedLog, type SettledLog } from './tablesVerify'

/** One decoded operator-substrate event — the ABI event name, its named args, and the block it landed
 *  in. Matches the row shape both sources (indexer GraphQL / getLogs) produce in useOperatorRounds. */
export type OperatorEvent = { name: string; args: Record<string, any>; blockNumber: bigint }

/** A RoundOpened projection for OperatorCoinFlip. NOTE: there is no `subsetHash` (unlike CoinFlipTables);
 *  the operator round carries `tierPrice` + `key` instead. */
export type OperatorOpenedLog = {
  roundId: Hex; tableId: Hex; player: Address; side: number
  stake: bigint; payout: bigint; tierPrice: bigint; key: Hex; openedAtBlock: bigint
}

export type OperatorSettledLog = {
  roundId: Hex; tableId: Hex; player: Address; won: boolean
  payout: bigint; seed: Hex; settledAtBlock: bigint
}

/** A discovered table, folded from TableCreated + OpenSet (last OpenSet wins). */
export type OperatorTableCard = {
  tableId: Hex; operator: Address; token: Address
  maxMultiplierX100: number; minStake: bigint; maxStake: bigint; open: boolean
}

const toOpened = (a: Record<string, any>, blockNumber: bigint): OperatorOpenedLog => ({
  roundId: a.roundId as Hex, tableId: a.tableId as Hex, player: a.player as Address, side: Number(a.side),
  stake: a.stake as bigint, payout: a.payout as bigint, tierPrice: a.tierPrice as bigint,
  key: a.key as Hex, openedAtBlock: (a.openedAtBlock as bigint) ?? blockNumber,
})

const toSettled = (a: Record<string, any>, blockNumber: bigint): OperatorSettledLog => ({
  roundId: a.roundId as Hex, tableId: a.tableId as Hex, player: a.player as Address, won: Boolean(a.won),
  payout: a.payout as bigint, seed: a.seed as Hex, settledAtBlock: blockNumber,
})

/** Fold TableCreated + OpenSet into the current table list (last OpenSet wins; unknown-table OpenSet
 *  is ignored). */
export const foldOperatorTables = (events: OperatorEvent[]): OperatorTableCard[] => {
  const byId = new Map<Hex, OperatorTableCard>()
  for (const e of events) {
    const a = e.args
    if (e.name === 'TableCreated') {
      byId.set(a.tableId as Hex, {
        tableId: a.tableId as Hex, operator: a.operator as Address, token: a.token as Address,
        maxMultiplierX100: Number(a.maxMultiplierX100), minStake: a.minStake as bigint,
        maxStake: a.maxStake as bigint, open: true,
      })
    } else if (e.name === 'OpenSet') {
      const t = byId.get(a.tableId as Hex)
      if (t) t.open = Boolean(a.open)
    }
  }
  return [...byId.values()]
}

/** Fold the player's rounds: merge indexed RoundOpened with this session's optimistic opens, keep only
 *  the connected wallet's rounds (newest first by open block), and index the Settled/Refunded terminals. */
export const foldOperatorRounds = (
  events: OperatorEvent[],
  sessionRounds: OperatorOpenedLog[],
  myAddress?: Hex,
): {
  myRounds: OperatorOpenedLog[]
  settledByRound: Map<string, OperatorSettledLog>
  refundedByRound: Set<string>
} => {
  const openedByRound = new Map<string, OperatorOpenedLog>()
  const settledByRound = new Map<string, OperatorSettledLog>()
  const refundedByRound = new Set<string>()
  for (const e of events) {
    const a = e.args
    if (e.name === 'RoundOpened' && a.roundId) openedByRound.set(a.roundId as string, toOpened(a, e.blockNumber))
    if (e.name === 'RoundSettled' && a.roundId) settledByRound.set(a.roundId as string, toSettled(a, e.blockNumber))
    if (e.name === 'RoundRefunded' && a.roundId) refundedByRound.add(a.roundId as string)
  }
  for (const o of sessionRounds) if (!openedByRound.has(o.roundId)) openedByRound.set(o.roundId, o)
  const mine = myAddress?.toLowerCase()
  const myRounds = [...openedByRound.values()]
    .filter((o) => !mine || o.player.toLowerCase() === mine)
    .sort((x, y) => (y.openedAtBlock > x.openedAtBlock ? 1 : y.openedAtBlock < x.openedAtBlock ? -1 : 0))
  return { myRounds, settledByRound, refundedByRound }
}

/** The operator's latest metadata URI (last MetadataSet wins), or undefined. Case-insensitive match. */
export const latestMetadataUri = (events: OperatorEvent[], operator?: Address): string | undefined => {
  if (!operator) return undefined
  const op = operator.toLowerCase()
  let uri: string | undefined
  for (const e of events) {
    if (e.name === 'MetadataSet' && (e.args.operator as string | undefined)?.toLowerCase() === op) {
      uri = e.args.uri as string
    }
  }
  return uri
}

/** Recompute a settled operator round from the chain logs, reusing the tested `verifyRound`. The operator
 *  round has no `subsetHash`, and `verifyRound` never reads it, so we fill it with the (unused) round key. */
export const verifyOperatorRound = (
  opened: OperatorOpenedLog,
  settled: OperatorSettledLog,
): { ok: boolean; reasons: string[] } => {
  const o: OpenedLog = {
    roundId: opened.roundId, tableId: opened.tableId, player: opened.player, side: opened.side,
    stake: opened.stake, payout: opened.payout, subsetHash: opened.key, key: opened.key, openedAtBlock: opened.openedAtBlock,
  }
  const s: SettledLog = {
    roundId: settled.roundId, tableId: settled.tableId, player: settled.player, won: settled.won,
    payout: settled.payout, seed: settled.seed, settledAtBlock: settled.settledAtBlock,
  }
  return verifyRound(o, s)
}
