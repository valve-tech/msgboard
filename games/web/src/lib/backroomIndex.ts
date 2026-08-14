import type { Address, Hex } from 'viem'

/**
 * A round in flight, projected for the security room.
 *
 * THIS TYPE IS THE LEAK BOUNDARY (spec §5). It carries positions only — every
 * field here is already published by `RoundOpened` and none is a function of any
 * validator secret. It declares NO outcome material: no `seed`, `won`,
 * `validators`, `validatorSubset`, `reveal`/`reveals`/`revealCount`, `outcome`,
 * `result`, or `winner`. It also drops the round `key`, so a validator secret in
 * the Random state cannot be tied to the round through the pit. A regression that
 * tries to surface outcome material in the pit is a compile error, not a runtime
 * leak. Do not add a field to this type without re-reading spec §5.
 */
export type PitRound = {
  roundId: Hex
  tableId: Hex
  player: Address
  side: number
  stake: bigint
  payout: bigint
  tierPrice: bigint
  openedAtBlock: bigint
}

/** A terminal event. POST-ONLY — outcome material is safe here (spec §5 rule 4). */
export type TapeEntry = {
  kind: 'settled' | 'refunded' | 'forfeit'
  roundId: Hex
  tableId: Hex
  blockNumber: bigint
  won?: boolean
  payout?: bigint
  seed?: Hex
  forfeit?: bigint
  /** The round's original stake, carried from `RoundOpened`/`RoundRefunded`. Safe post-terminal (spec
   *  §5 rule 4) — populated for 'settled' and 'refunded' kinds so the Tape/P&L panels can show the
   *  full picture (win/loss volume, refund amount) without re-deriving it. */
  stake?: bigint
}

export type OperatorTableView = {
  tableId: Hex
  operator: Address
  token: Address
  open: boolean
  cap: bigint
  locked: bigint
  inFlight: number
  lastActiveBlock: bigint
  validatorPolicy?: Address
  /** Stake ladder + payout multiplier from `TableCreated` — SAFE-PRE, published at table creation. */
  minStake: bigint
  maxStake: bigint
  maxMultiplierX100: number
}

/**
 * Spot-truth treasury figures. `bankroll`/`locked`/`rake`/`fees` are filled by the
 * hook's view reads (not the reducer); the reducer supplies only the history lanes.
 */
export type Treasury = {
  token: Address
  bankroll: bigint
  locked: bigint
  rake: bigint
  fees: bigint
}

/** One deposit/withdraw/rake-withdraw line from `GameEscrow`. POST-hoc financial-ops history — never
 *  round-outcome material, so no leak-boundary concern; kept separate from `Treasury` because it's a
 *  log (many rows per token) rather than a spot balance. */
export type TreasuryEvent = {
  kind: 'deposit' | 'withdraw' | 'rake'
  operator: Address
  token: Address
  amount: bigint
  blockNumber: bigint
}

export type BackroomEvent = {
  name: string
  args: Record<string, any>
  blockNumber: bigint
}

export type ReduceOpts = {
  /** True once `randomness(key).seed != 0` for the round — the irreversibility point. */
  seedFinalized: (roundId: Hex) => boolean
}

const ZERO = '0x' as Address

const emptyTable = (tableId: Hex, blockNumber: bigint): OperatorTableView => ({
  tableId,
  operator: ZERO,
  token: ZERO,
  open: true,
  cap: 0n,
  locked: 0n,
  inFlight: 0,
  lastActiveBlock: blockNumber,
  minStake: 0n,
  maxStake: 0n,
  maxMultiplierX100: 0,
})

/**
 * Fold the operator event history into the security-room projection.
 *
 * PURE: no fetches, no view reads, no Date/random. It takes events plus a
 * `seedFinalized(roundId)` predicate and returns `{ tables, pit, tape, treasuryHistory }`.
 *
 * A round leaves `pit` when it has a terminal event (`RoundSettled` /
 * `RoundRefunded`) OR when `seedFinalized(roundId)` is true — at seed finality the
 * outcome is irreversible, so the round is no longer "in flight".
 */
export const reduceBackroom = (
  events: BackroomEvent[],
  opts: ReduceOpts,
): { tables: OperatorTableView[]; pit: PitRound[]; tape: TapeEntry[]; treasuryHistory: TreasuryEvent[] } => {
  const byTable = new Map<Hex, OperatorTableView>()
  const pit = new Map<Hex, PitRound>()
  const roundTable = new Map<Hex, Hex>() // roundId -> tableId, kept after a round leaves the pit
  // roundId -> stake, kept after a round leaves the pit (post-terminal stake is safe, spec §5 rule 4)
  // so the tape can show the real settled/refunded amount instead of re-deriving it.
  const roundStake = new Map<Hex, bigint>()
  const tape: TapeEntry[] = []
  const treasuryHistory: TreasuryEvent[] = []

  const table = (tableId: Hex, blockNumber: bigint) => {
    let v = byTable.get(tableId)
    if (!v) { v = emptyTable(tableId, blockNumber); byTable.set(tableId, v) }
    return v
  }
  const touch = (tableId: Hex | undefined, blockNumber: bigint) => {
    if (!tableId) return
    const v = table(tableId, blockNumber)
    if (blockNumber > v.lastActiveBlock) v.lastActiveBlock = blockNumber
  }

  for (const e of events) {
    const a = e.args
    switch (e.name) {
      case 'TableCreated': {
        const v = table(a.tableId as Hex, e.blockNumber)
        v.operator = (a.operator as Address) ?? ZERO
        v.token = (a.token as Address) ?? ZERO
        v.open = true
        v.minStake = (a.minStake as bigint) ?? 0n
        v.maxStake = (a.maxStake as bigint) ?? 0n
        v.maxMultiplierX100 = Number(a.maxMultiplierX100 ?? 0)
        touch(a.tableId as Hex, e.blockNumber)
        break
      }
      case 'OpenSet': {
        const v = table(a.tableId as Hex, e.blockNumber)
        v.open = Boolean(a.open)
        touch(a.tableId as Hex, e.blockNumber)
        break
      }
      case 'TableCapSet': {
        const v = table(a.tableId as Hex, e.blockNumber)
        v.cap = a.cap as bigint
        touch(a.tableId as Hex, e.blockNumber)
        break
      }
      case 'ValidatorPolicySet': {
        const v = table(a.tableId as Hex, e.blockNumber)
        v.validatorPolicy = a.policy as Address
        touch(a.tableId as Hex, e.blockNumber)
        break
      }
      case 'RoundOpened': {
        const roundId = a.roundId as Hex
        const tableId = a.tableId as Hex
        roundTable.set(roundId, tableId)
        roundStake.set(roundId, (a.stake as bigint) ?? 0n)
        // Positions only — the leak boundary. No key, no outcome material.
        pit.set(roundId, {
          roundId,
          tableId,
          player: a.player as Address,
          side: Number(a.side),
          stake: a.stake as bigint,
          payout: a.payout as bigint,
          tierPrice: a.tierPrice as bigint,
          openedAtBlock: (a.openedAtBlock as bigint) ?? e.blockNumber,
        })
        touch(tableId, e.blockNumber)
        break
      }
      case 'ExposureLocked': {
        // betId == roundId. Resolve the table through the round; event-derived lane only.
        const tableId = roundTable.get(a.betId as Hex)
        if (tableId) {
          const v = table(tableId, e.blockNumber)
          v.locked += a.payout as bigint
          touch(tableId, e.blockNumber)
        }
        break
      }
      case 'RoundSettled': {
        const roundId = a.roundId as Hex
        const tableId = (a.tableId as Hex) ?? roundTable.get(roundId) ?? (ZERO as Hex)
        pit.delete(roundId)
        const v = byTable.get(tableId)
        if (v) v.locked -= (a.payout as bigint) ?? 0n
        tape.push({
          kind: 'settled',
          roundId,
          tableId,
          blockNumber: e.blockNumber,
          won: Boolean(a.won),
          payout: a.payout as bigint,
          seed: a.seed as Hex,
          stake: roundStake.get(roundId),
        })
        touch(tableId, e.blockNumber)
        break
      }
      case 'RoundRefunded': {
        const roundId = a.roundId as Hex
        const tableId = (a.tableId as Hex) ?? roundTable.get(roundId) ?? (ZERO as Hex)
        pit.delete(roundId)
        // `RoundRefunded(roundId, tableId, player, stake)` carries `stake`, not `payout` — a refund
        // returns the player's original stake, there is no payout to speak of.
        tape.push({
          kind: 'refunded',
          roundId,
          tableId,
          blockNumber: e.blockNumber,
          stake: (a.stake as bigint) ?? roundStake.get(roundId),
        })
        touch(tableId, e.blockNumber)
        break
      }
      case 'ForfeitRouted': {
        const roundId = a.roundId as Hex
        const tableId = roundTable.get(roundId) ?? (ZERO as Hex)
        tape.push({
          kind: 'forfeit',
          roundId,
          tableId,
          blockNumber: e.blockNumber,
          forfeit: a.forfeit as bigint,
        })
        touch(tableId, e.blockNumber)
        break
      }
      // GameEscrow financial-ops history (spec §4.2 "deposit/withdraw/rake history lane"). Never
      // outcome material — a bankroll movement, not a round result.
      case 'BankrollDeposited':
        treasuryHistory.push({
          kind: 'deposit',
          operator: a.operator as Address,
          token: a.token as Address,
          amount: (a.credited as bigint) ?? 0n,
          blockNumber: e.blockNumber,
        })
        break
      case 'BankrollWithdrawn':
        treasuryHistory.push({
          kind: 'withdraw',
          operator: a.operator as Address,
          token: a.token as Address,
          amount: (a.amount as bigint) ?? 0n,
          blockNumber: e.blockNumber,
        })
        break
      case 'RakeWithdrawn':
        treasuryHistory.push({
          kind: 'rake',
          operator: a.operator as Address,
          token: a.token as Address,
          amount: (a.amount as bigint) ?? 0n,
          blockNumber: e.blockNumber,
        })
        break
    }
  }

  // Seed-finalized rounds are decided — settling; they leave the pit (spec §5 rule 3).
  for (const roundId of [...pit.keys()]) if (opts.seedFinalized(roundId)) pit.delete(roundId)

  // in-flight = pit rounds still open per table.
  for (const v of byTable.values()) v.inFlight = 0
  for (const r of pit.values()) {
    const v = byTable.get(r.tableId)
    if (v) v.inFlight += 1
  }

  const rank = (v: OperatorTableView) => (v.open ? 1 : 0)
  const tables = [...byTable.values()].sort((x, y) =>
    rank(y) - rank(x) ||
    y.inFlight - x.inFlight ||
    (y.lastActiveBlock > x.lastActiveBlock ? 1 : y.lastActiveBlock < x.lastActiveBlock ? -1 : 0),
  )

  return { tables, pit: [...pit.values()], tape, treasuryHistory }
}
