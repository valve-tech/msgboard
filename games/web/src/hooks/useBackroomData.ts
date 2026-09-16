import { useCallback, useEffect, useRef, useState } from 'react'
import * as viem from 'viem'
import type { Address, Hex } from 'viem'
import { operatorCoinFlipAbi, gameEscrowAbi, operatorRegistryAbi, defaultValidatorPolicyAbi, randomAbi } from '@msgboard/games-core'
import {
  reduceBackroom,
  type BackroomEvent,
  type OperatorTableView,
  type PitRound,
  type TapeEntry,
  type Treasury,
  type TreasuryEvent,
} from '../lib/backroomIndex'
import { publicClientFor } from '../wallet'
import { deployments, type GameDeployment } from '../config'

const POLL_MS = 12_000
// Same reasoning as useChainData: a full-history getLogs scan must stay under the RPC's per-request
// range/response limit.
const MAX_RANGE = 10_000n

/** Ponder's network name per chain (ponder.config.ts `networks` keys) — used to read the indexer's
 *  synced head for the reconciliation strip's "indexer head vs RPC head" line. Only 943 carries the
 *  operator substrate today; 369 is listed so the lookup degrades cleanly if it ever does. */
const PONDER_NETWORK: Record<number, string> = { 943: 'pulsechainV4', 369: 'pulsechain' }

/** The one chain (Global Constraints: 943 only) whose config carries the operator substrate. Backroom
 *  is single-chain by design (spec §3 "Scope"), so the hook picks it itself rather than taking a
 *  `deployment` argument — this also lets the exported signature stay exactly `(operator: Address)`.
 *  `undefined` until Task 5 adds `operator` to a deployment; every read below degrades gracefully. */
const OPERATOR_CHAIN = deployments.find((d) => d.operator)

// ── Reconciliation types (spec §4.8) — the security room watching itself. Every figure here is a
// disagreement to DISPLAY, never to silently correct toward either source. ─────────────────────────

/** One table's event-derived exposure vs the spot-truth view. */
export type TableReconciliation = {
  tableId: Hex
  eventLocked: bigint
  viewLocked: bigint
  delta: bigint
}

/** One token's ledger + fee-custody reconciliation for THIS operator only (spec D3: the strip stays
 *  single-operator in v1). `randomBalance` is the WHOLE game contract's custody in the shared Random
 *  contract, not just this operator's slice — a nonzero `feeDelta` is expected once other operators
 *  share the token; it is a scope note, not necessarily drift. */
export type TokenReconciliation = {
  token: Address
  /** EscrowLib ledger replay: deposits − withdrawals + incoming stakes − payouts − rake withdrawals. */
  eventLedger: bigint
  /** bankrollOf + lockedOf + rakeOf, read live this poll. */
  viewLedger: bigint
  ledgerDelta: bigint
  /** Random.balanceOf(game, token) — the whole game's fee custody. */
  randomBalance: bigint
  /** feeBalance(operator, token) — this operator's slice of that custody. */
  feeBalance: bigint
  feeDelta: bigint
}

export type Reconciliation = {
  tables: TableReconciliation[]
  tokens: TokenReconciliation[]
  /** Ponder's synced head for the operator substrate's network, or null when unavailable. */
  indexerHead: bigint | null
  rpcHead: bigint
  headDelta: bigint | null
}

export type BackroomData = {
  tables: OperatorTableView[]
  pit: PitRound[]
  tape: TapeEntry[]
  treasury: Treasury[]
  /** Deposit/withdraw/rake-withdraw lines (spec §4.2's history lane), newest first. */
  treasuryHistory: TreasuryEvent[]
  reconciliation: Reconciliation
  status: 'live' | 'degraded' | 'loading'
  lastBlock: bigint
  /** Rounds whose seed has finalized (irreversible, spec §5 rule 3 — "decided — settling") but that
   *  have not yet posted a terminal event. A COUNT only, not round detail: the pit board still shows
   *  positions only pre-terminal, and a per-round breakdown of this set isn't worth the extra plumbing
   *  for an alert whose whole job is "is anything stuck between decided and settled". */
  decidedUnsettled: number
  refresh: () => void
}

const emptyReconciliation: Reconciliation = { tables: [], tokens: [], indexerHead: null, rpcHead: 0n, headDelta: null }
const emptyState: Omit<BackroomData, 'refresh'> = {
  tables: [],
  pit: [],
  tape: [],
  treasury: [],
  treasuryHistory: [],
  reconciliation: emptyReconciliation,
  status: 'loading',
  lastBlock: 0n,
  decidedUnsettled: 0,
}

/** Decimal-string args re-hydrated to bigint — same rule as useChainData's `rehydrate` (hex strings,
 *  addresses and bools pass through untouched). */
const rehydrate = (args: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(args)) out[k] = typeof v === 'string' && /^[0-9]+$/.test(v) ? BigInt(v) : v
  return out
}

// ── indexer source (GraphQL) — used when `chain.gamesIndexer` is set ────────────────────────────
/** Reads ONLY `game = "operator"` rows (leak-boundary rule 1, spec §5). Cursor-paginated, same shape
 *  as useChainData's fetchViaIndexer. */
const fetchViaIndexer = async (url: string, chainId: number, from: bigint, to: bigint): Promise<BackroomEvent[]> => {
  const out: BackroomEvent[] = []
  let after: string | null = null
  do {
    const query = `query($chainId: Int!, $from: BigInt!, $to: BigInt!, $after: String) {
      gameEvents(where: { chainId: $chainId, game: "operator", blockNumber_gte: $from, blockNumber_lte: $to }, orderBy: "blockNumber", orderDirection: "asc", limit: 1000, after: $after) {
        items { name args blockNumber }
        pageInfo { hasNextPage endCursor }
      }
    }`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables: { chainId, from: from.toString(), to: to.toString(), after } }),
    })
    if (!res.ok) throw new Error(`indexer HTTP ${res.status}`)
    const json = (await res.json()) as {
      errors?: { message: string }[]
      data?: { gameEvents: { items: { name: string; args: Record<string, unknown>; blockNumber: string }[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }
    }
    if (json.errors?.length) throw new Error(json.errors[0]!.message)
    const page = json.data?.gameEvents
    if (!page) break
    for (const e of page.items) out.push({ name: e.name, args: rehydrate(e.args ?? {}), blockNumber: BigInt(e.blockNumber) })
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null
  } while (after)
  return out
}

/** Ponder's `_meta` sync status — a separate, tiny query so the indexer head stays fresh every poll
 *  even on a poll with no new blocks to scan. Failure just leaves the reconciliation's `indexerHead`
 *  null; it does not by itself flip the dashboard to 'degraded' (the event fetch already governs that). */
const fetchIndexerHead = async (url: string, chainId: number): Promise<bigint | null> => {
  const network = PONDER_NETWORK[chainId]
  if (!network) return null
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ _meta { status } }' }),
    })
    if (!res.ok) return null
    const json = (await res.json()) as { data?: { _meta?: { status?: Record<string, { block?: { number?: number } }> } } }
    const n = json.data?._meta?.status?.[network]?.block?.number
    return n === undefined ? null : BigInt(n)
  } catch {
    return null
  }
}

// ── getLogs source (fallback / when no indexer is configured) ───────────────────────────────────
/** Scans all four operator-substrate contracts directly, including the retired OperatorCoinFlip
 *  addresses (spec G7) so the fallback's coverage matches the indexer's (Task 1) rather than being a
 *  subset. Known limitation: the retired addresses' OWN earlier history needs the indexer's per-address
 *  start blocks (Task 1); this fallback scans them from the same `deployBlock` as the live game. That
 *  is an accepted degrade — this path only ever runs while the dashboard is already flagged 'degraded'. */
const fetchViaLogs = async (
  client: ReturnType<typeof publicClientFor>,
  opCfg: NonNullable<GameDeployment['operator']>,
  from: bigint,
  to: bigint,
): Promise<BackroomEvent[]> => {
  const out: BackroomEvent[] = []
  const coinFlipAddresses = [opCfg.coinFlip, ...opCfg.retired]
  for (let lo = from; lo <= to; lo += MAX_RANGE) {
    const hi = lo + MAX_RANGE - 1n < to ? lo + MAX_RANGE - 1n : to
    const [game, escrow, registry, policy] = await Promise.all([
      client.getContractEvents({ address: coinFlipAddresses, abi: operatorCoinFlipAbi, fromBlock: lo, toBlock: hi, strict: true }),
      client.getContractEvents({ address: opCfg.escrow, abi: gameEscrowAbi, fromBlock: lo, toBlock: hi, strict: true }),
      client.getContractEvents({ address: opCfg.registry, abi: operatorRegistryAbi, fromBlock: lo, toBlock: hi, strict: true }),
      client.getContractEvents({ address: opCfg.policy, abi: defaultValidatorPolicyAbi, fromBlock: lo, toBlock: hi, strict: true }),
    ])
    for (const log of [...game, ...escrow, ...registry, ...policy]) {
      out.push({ name: log.eventName, args: (log.args ?? {}) as Record<string, unknown>, blockNumber: log.blockNumber ?? 0n })
    }
  }
  return out
}

/**
 * EscrowLib ledger replay for one (operator, token) — see EscrowLib.sol: `lockExposure` pulls the
 * player's stake fresh (total +stake, exposure only moves bankroll→locked internally); `settleWin`
 * pays `paidToPlayer` out; `settleLoss` keeps everything inside escrow (no adjustment); `refund` pays
 * the player's `stake` back out; `withdrawRake` and `withdrawBankroll` leave the same way. The result
 * should equal the live `bankrollOf + lockedOf + rakeOf` — any gap is the ledger reconciliation delta.
 */
const replayLedger = (events: BackroomEvent[], operator: Address, token: Address): bigint => {
  const op = operator.toLowerCase()
  const tok = token.toLowerCase()
  const mine = (a: Record<string, any>) => (a.operator as string | undefined)?.toLowerCase() === op && (a.token as string | undefined)?.toLowerCase() === tok
  let total = 0n
  for (const e of events) {
    const a = e.args
    switch (e.name) {
      case 'BankrollDeposited':
        if (mine(a)) total += (a.credited as bigint) ?? 0n
        break
      case 'BankrollWithdrawn':
        if (mine(a)) total -= (a.amount as bigint) ?? 0n
        break
      case 'ExposureLocked':
        if (mine(a)) total += (a.stake as bigint) ?? 0n
        break
      case 'Settled':
        if (mine(a)) total -= (a.paidToPlayer as bigint) ?? 0n
        break
      case 'Refunded':
        if (mine(a)) total -= (a.stake as bigint) ?? 0n
        break
      case 'RakeWithdrawn':
        if (mine(a)) total -= (a.amount as bigint) ?? 0n
        break
    }
  }
  return total
}

/** One spot-truth multicall entry, tagged with what it's for so the results can be filed back by index. */
type CallMeta =
  | { kind: 'bankroll' | 'locked' | 'rake' | 'feeBalance' | 'randomBalance'; token: Address }
  | { kind: 'tableCap' | 'tableLocked' | 'tableView'; tableId: Hex }
  | { kind: 'seed'; roundId: Hex }

type MulticallCall = { address: Address; abi: viem.Abi; functionName: string; args: readonly unknown[] }

/**
 * Polls the operator substrate into the security-room projection. Mirrors useChainData's structure:
 * indexer GraphQL when `chain.gamesIndexer` is set, chunked getLogs fallback otherwise (POLL_MS 12000,
 * MAX_RANGE 10000, accumulate-only cache keyed by chain). Each poll also multicalls the spot-truth
 * views (escrow ledgers, per-table cap/locked, per-open-round seed finality, Random fee custody) and
 * feeds `seedFinalized` into the pure `reduceBackroom` reducer — views are truth, events are history,
 * and the reconciliation strip (returned, not auto-corrected) is where the two are compared on screen.
 *
 * Leak boundary (spec §5): the per-round `key` needed for the seed-finality view call is read from the
 * raw event stream and kept ONLY in a local map inside this hook — it is never attached to a `PitRound`
 * and never returned. The `randomness(key)` read itself is reduced to a single boolean
 * (`seed !== zeroHash`) before it leaves this function; the seed value is never stored or returned.
 */
export const useBackroomData = (operator: Address): BackroomData => {
  const [data, setData] = useState<Omit<BackroomData, 'refresh'>>(emptyState)
  const busy = useRef(false)
  const acc = useRef<{ chainId: number; events: BackroomEvent[]; lastBlock: bigint } | null>(null)

  const load = useCallback(async () => {
    const chain = OPERATOR_CHAIN
    const opCfg = chain?.operator
    // No chain currently carries `operator` config (pre-Task-5) → stay at the initial empty/loading
    // state forever rather than throwing. Once Task 5 populates the 943 entry, polling starts.
    if (!chain || !opCfg || busy.current) return
    busy.current = true
    try {
      const client = publicClientFor(chain.chainId, chain.rpc)
      const head = await client.getBlockNumber()
      if (!acc.current || acc.current.chainId !== chain.chainId) {
        acc.current = { chainId: chain.chainId, events: [], lastBlock: BigInt(opCfg.deployBlock) - 1n }
      }
      const from = acc.current.lastBlock + 1n
      let degraded = !chain.gamesIndexer
      if (head >= from) {
        let fresh: BackroomEvent[]
        if (chain.gamesIndexer) {
          try {
            fresh = await fetchViaIndexer(chain.gamesIndexer, chain.chainId, from, head)
          } catch {
            degraded = true
            fresh = await fetchViaLogs(client, opCfg, from, head)
          }
        } else {
          fresh = await fetchViaLogs(client, opCfg, from, head)
        }
        acc.current.events.push(...fresh)
        acc.current.lastBlock = head
      }
      const events = acc.current.events

      const indexerHead = chain.gamesIndexer ? await fetchIndexerHead(chain.gamesIndexer, chain.chainId) : null

      // Single pass over the accumulated events: which tables/tokens exist, and which rounds are still
      // open (candidates for the seed-finality view call). `openRounds` (roundId -> key) is local
      // bookkeeping ONLY — the leak boundary: the key never leaves this function.
      const tableIds = new Set<Hex>()
      const tokens = new Set<Address>()
      const openRounds = new Map<Hex, Hex>()
      // roundId -> tableId for every currently-open round, so `decidedUnsettled` below can be scoped to
      // this operator's tables the same way `tables`/`pit`/`tape` are (see the scoping note further down).
      const openRoundTable = new Map<Hex, Hex>()
      for (const e of events) {
        const a = e.args as Record<string, any>
        switch (e.name) {
          case 'TableCreated':
            tableIds.add(a.tableId as Hex)
            if (a.token) tokens.add(a.token as Address)
            break
          case 'TableCapSet':
          case 'OpenSet':
          case 'ValidatorPolicySet':
            tableIds.add(a.tableId as Hex)
            break
          case 'RoundOpened':
            openRounds.set(a.roundId as Hex, a.key as Hex)
            openRoundTable.set(a.roundId as Hex, a.tableId as Hex)
            break
          case 'RoundSettled':
          case 'RoundRefunded':
            openRounds.delete(a.roundId as Hex)
            break
        }
      }
      if (chain.chips) tokens.add(chain.chips)

      // Build the one multicall for this poll (spec §6 scale: one batched call, not N round trips).
      const calls: MulticallCall[] = []
      const meta: CallMeta[] = []
      for (const token of tokens) {
        calls.push({ address: opCfg.escrow, abi: gameEscrowAbi, functionName: 'bankrollOf', args: [operator, token] })
        meta.push({ kind: 'bankroll', token })
        calls.push({ address: opCfg.escrow, abi: gameEscrowAbi, functionName: 'lockedOf', args: [operator, token] })
        meta.push({ kind: 'locked', token })
        calls.push({ address: opCfg.escrow, abi: gameEscrowAbi, functionName: 'rakeOf', args: [operator, token] })
        meta.push({ kind: 'rake', token })
        calls.push({ address: opCfg.coinFlip, abi: operatorCoinFlipAbi, functionName: 'feeBalance', args: [operator, token] })
        meta.push({ kind: 'feeBalance', token })
        calls.push({ address: chain.random, abi: randomAbi, functionName: 'balanceOf', args: [opCfg.coinFlip, token] })
        meta.push({ kind: 'randomBalance', token })
      }
      for (const tableId of tableIds) {
        calls.push({ address: opCfg.coinFlip, abi: operatorCoinFlipAbi, functionName: 'tableCap', args: [tableId] })
        meta.push({ kind: 'tableCap', tableId })
        calls.push({ address: opCfg.coinFlip, abi: operatorCoinFlipAbi, functionName: 'tableLocked', args: [tableId] })
        meta.push({ kind: 'tableLocked', tableId })
        calls.push({ address: opCfg.coinFlip, abi: operatorCoinFlipAbi, functionName: 'tables', args: [tableId] })
        meta.push({ kind: 'tableView', tableId })
      }
      for (const [roundId, key] of openRounds) {
        // The ONLY per-round Random read this hook performs — its result is reduced to a boolean below.
        calls.push({ address: chain.random, abi: randomAbi, functionName: 'randomness', args: [key] })
        meta.push({ kind: 'seed', roundId })
      }

      const results = calls.length ? await client.multicall({ contracts: calls, allowFailure: true }) : []

      const bankrollOf = new Map<Address, bigint>()
      const lockedOf = new Map<Address, bigint>()
      const rakeOf = new Map<Address, bigint>()
      const feeBalanceOf = new Map<Address, bigint>()
      const randomBalanceOf = new Map<Address, bigint>()
      const viewTableCap = new Map<Hex, bigint>()
      const viewTableLocked = new Map<Hex, bigint>()
      const viewTableMeta = new Map<
        Hex,
        { operator: Address; token: Address; open: boolean; validatorPolicy: Address; minStake: bigint; maxStake: bigint; maxMultiplierX100: number }
      >()
      // A round's seed-finality reduces to a boolean the instant it's read — never store the seed itself.
      const seedFinalized = new Set<Hex>()

      results.forEach((r, i) => {
        const m = meta[i]
        if (!m || r.status !== 'success') return
        switch (m.kind) {
          case 'bankroll':
            bankrollOf.set(m.token, r.result as bigint)
            break
          case 'locked':
            lockedOf.set(m.token, r.result as bigint)
            break
          case 'rake':
            rakeOf.set(m.token, r.result as bigint)
            break
          case 'feeBalance':
            feeBalanceOf.set(m.token, r.result as bigint)
            break
          case 'randomBalance':
            randomBalanceOf.set(m.token, r.result as bigint)
            break
          case 'tableCap':
            viewTableCap.set(m.tableId, r.result as bigint)
            break
          case 'tableLocked':
            viewTableLocked.set(m.tableId, r.result as bigint)
            break
          case 'tableView': {
            // Table struct order (OperatorCoinFlip.sol): operator, token, maxMultiplierX100, minStake,
            // maxStake, open, validatorPolicy.
            const t = r.result as readonly unknown[]
            viewTableMeta.set(m.tableId, {
              operator: t[0] as Address,
              token: t[1] as Address,
              maxMultiplierX100: Number(t[2] as number),
              minStake: t[3] as bigint,
              maxStake: t[4] as bigint,
              open: t[5] as boolean,
              validatorPolicy: t[6] as Address,
            })
            break
          }
          case 'seed': {
            const seed = (r.result as { seed: Hex }).seed
            if (seed !== viem.zeroHash) seedFinalized.add(m.roundId)
            break
          }
        }
      })

      const reduced = reduceBackroom(events, { seedFinalized: (roundId) => seedFinalized.has(roundId) })

      // The operator substrate is shared: `events` (and therefore `reduced.tables`/`pit`/`tape`) carries
      // EVERY operator's tables and rounds, not just this one's — GameEscrow/OperatorCoinFlip emit no
      // per-operator-scoped log topic the fetch layer could filter on upstream. Backroom-B is single-
      // operator by design (spec §3 "Scope"), so scope down here, once, rather than in every panel: a
      // table's `operator` field is set the instant its `TableCreated` event folds (reduceBackroom), so
      // this filter is reliable even before the per-poll view read below confirms it.
      const myTableIds = new Set(
        reduced.tables.filter((t) => t.operator.toLowerCase() === operator.toLowerCase()).map((t) => t.tableId),
      )

      // A round leaves `reduced.pit` the instant its seed finalizes (spec §5 rule 3), even before it
      // posts a terminal event — that gap is exactly what the "seed finalized but unsettled" alert
      // watches for. `openRounds` is this poll's set of not-yet-terminal rounds (per the event stream);
      // intersect with `seedFinalized`, scoped to this operator's tables via `openRoundTable`, for the
      // count. A count only — no round detail leaves this hook for this set (see `decidedUnsettled` on
      // `BackroomData`).
      let decidedUnsettled = 0
      for (const roundId of openRounds.keys()) {
        const tableId = openRoundTable.get(roundId)
        if (seedFinalized.has(roundId) && tableId && myTableIds.has(tableId)) decidedUnsettled += 1
      }

      // Views are truth: overwrite the reducer's event-derived cap/locked/open/validatorPolicy with the
      // live reads, and record the pre-overwrite event-derived figure as the reconciliation baseline.
      const tableReconciliation: TableReconciliation[] = []
      for (const t of reduced.tables) {
        const eventLocked = t.locked
        const vCap = viewTableCap.get(t.tableId)
        const vLocked = viewTableLocked.get(t.tableId)
        const vMeta = viewTableMeta.get(t.tableId)
        if (vCap !== undefined) t.cap = vCap
        if (vLocked !== undefined) t.locked = vLocked
        if (vMeta) {
          t.open = vMeta.open
          t.validatorPolicy = vMeta.validatorPolicy
          t.minStake = vMeta.minStake
          t.maxStake = vMeta.maxStake
          t.maxMultiplierX100 = vMeta.maxMultiplierX100
          if (vMeta.operator !== viem.zeroAddress) t.operator = vMeta.operator
          if (vMeta.token !== viem.zeroAddress) t.token = vMeta.token
        }
        tableReconciliation.push({
          tableId: t.tableId,
          eventLocked,
          viewLocked: vLocked ?? eventLocked,
          delta: eventLocked - (vLocked ?? eventLocked),
        })
      }

      const treasury: Treasury[] = [...tokens].map((token) => ({
        token,
        bankroll: bankrollOf.get(token) ?? 0n,
        locked: lockedOf.get(token) ?? 0n,
        rake: rakeOf.get(token) ?? 0n,
        fees: feeBalanceOf.get(token) ?? 0n,
      }))

      const tokenReconciliation: TokenReconciliation[] = [...tokens].map((token) => {
        const eventLedger = replayLedger(events, operator, token)
        const viewLedger = (bankrollOf.get(token) ?? 0n) + (lockedOf.get(token) ?? 0n) + (rakeOf.get(token) ?? 0n)
        const randomBalance = randomBalanceOf.get(token) ?? 0n
        const feeBalance = feeBalanceOf.get(token) ?? 0n
        return { token, eventLedger, viewLedger, ledgerDelta: eventLedger - viewLedger, randomBalance, feeBalance, feeDelta: randomBalance - feeBalance }
      })

      // Scope the reduced projection down to this operator's tables (see the scoping note above).
      const tables = reduced.tables.filter((t) => myTableIds.has(t.tableId))
      const pit = reduced.pit.filter((r) => myTableIds.has(r.tableId))
      const tape = reduced.tape.filter((e) => myTableIds.has(e.tableId))
      const treasuryHistory = reduced.treasuryHistory
        .filter((h) => h.operator.toLowerCase() === operator.toLowerCase())
        .sort((a, b) => (a.blockNumber > b.blockNumber ? -1 : a.blockNumber < b.blockNumber ? 1 : 0))
      const scopedTableReconciliation = tableReconciliation.filter((r) => myTableIds.has(r.tableId))

      setData({
        tables,
        pit,
        tape,
        treasury,
        treasuryHistory,
        reconciliation: {
          tables: scopedTableReconciliation,
          tokens: tokenReconciliation,
          indexerHead,
          rpcHead: head,
          headDelta: indexerHead === null ? null : head - indexerHead,
        },
        status: degraded ? 'degraded' : 'live',
        lastBlock: head,
        decidedUnsettled,
      })
    } catch {
      // RPC hiccup or total indexer+getLogs failure: keep the last-good cache on screen (spec §6) and
      // flag it rather than fail closed to a blank dashboard.
      setData((d) => ({ ...d, status: 'degraded' }))
    } finally {
      busy.current = false
    }
  }, [operator])

  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), POLL_MS)
    return () => clearInterval(timer)
  }, [load])

  return { ...data, refresh: () => void load() }
}
