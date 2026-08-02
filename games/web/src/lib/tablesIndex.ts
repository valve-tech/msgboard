import type { Address, Hex } from 'viem'

export type TableView = {
  tableId: Hex; operator: Address
  hot: bigint; cold: bigint; escrowed: bigint; stake: bigint
  maxMultiplierX100: number; maxStake: bigint; hotTarget: bigint; open: boolean
  roundsRecent: number; lastActiveBlock: bigint
  /** Authenticated on-chain display name (last TableNamed wins); raw — clean before rendering. */
  name?: string
}

export type TableEvent = { type: string; tableId: Hex; blockNumber: bigint } & Record<string, any>

const empty = (tableId: Hex, operator: Address, blockNumber: bigint): TableView => ({
  tableId, operator, hot: 0n, cold: 0n, escrowed: 0n, stake: 0n,
  maxMultiplierX100: 0, maxStake: 0n, hotTarget: 0n, open: true,
  roundsRecent: 0, lastActiveBlock: blockNumber,
})

export const reduceTables = (events: TableEvent[], now: bigint, windowBlocks: bigint): TableView[] => {
  const byId = new Map<Hex, TableView>()
  const recent: { tableId: Hex; blockNumber: bigint }[] = []
  const get = (e: TableEvent) => {
    let v = byId.get(e.tableId)
    if (!v) { v = empty(e.tableId, (e.operator as Address) ?? ('0x' as Address), e.blockNumber); byId.set(e.tableId, v) }
    return v
  }
  for (const e of events) {
    const v = get(e)
    v.lastActiveBlock = e.blockNumber
    switch (e.type) {
      case 'TableCreated': v.operator = e.operator; v.maxMultiplierX100 = e.maxMultiplierX100; v.maxStake = e.maxStake; v.hotTarget = e.hotTarget; v.open = true; break
      case 'ParamsSet': v.maxMultiplierX100 = e.maxMultiplierX100; v.maxStake = e.maxStake; v.hotTarget = e.hotTarget; break
      case 'OpenSet': v.open = e.open; break
      case 'TableNamed': v.name = e.name; break // authenticated on-chain name; last one wins
      case 'HotFunded': v.hot += e.amount; break
      case 'ColdFunded': v.cold += e.amount; break
      case 'HotWithdrawn': v.hot -= e.amount; break
      case 'ColdWithdrawn': v.cold -= e.amount; break
      case 'Promoted': v.cold -= e.amount; v.hot += e.amount; break
      case 'Demoted': v.hot -= e.amount; v.cold += e.amount; break
      case 'Refilled': v.cold -= e.amount; v.hot += e.amount; break
      case 'Staked': v.stake += e.amount; break
      case 'Unstaked': v.stake -= e.amount; break
      case 'RoundOpened': {
        const payout: bigint = e.payout
        const stake: bigint = e.stake ?? e.payout
        v.hot -= payout - stake
        v.escrowed += payout
        recent.push({ tableId: e.tableId, blockNumber: e.blockNumber })
        break
      }
      case 'RoundSettled': v.escrowed -= e.payout; if (!e.won) v.hot += e.payout; break
      // Stale round refunded: escrow released, operator's exposure (payout - stake) returns to hot, the
      // player's stake leaves the contract. Mirrors CoinFlipTables.refundStale exactly.
      case 'Refunded': {
        const payout: bigint = e.payout
        const stake: bigint = e.stake ?? 0n
        v.escrowed -= payout
        v.hot += payout - stake
        break
      }
    }
  }
  for (const r of recent) {
    if (now - r.blockNumber <= windowBlocks) { const v = byId.get(r.tableId); if (v) v.roundsRecent += 1 }
  }
  const armed = (v: TableView) => (v.open && v.hot >= 1n ? 1 : 0)
  return [...byId.values()].sort((a, b) =>
    armed(b) - armed(a) || b.roundsRecent - a.roundsRecent || (b.stake > a.stake ? 1 : b.stake < a.stake ? -1 : 0),
  )
}
