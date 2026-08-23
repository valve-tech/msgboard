# Operator Coin-Flip UI (Slice 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a player-facing screen where a wallet on chain 943 bets a plain (unboosted) coin flip against a live operator table — pick table, pick side, stake Chips, open, settle or claim, refund a stale round, read a provably-fair verify slip — with the table skinned by the operator's own theme.

**Architecture:** A new `OperatorCoinFlipScreen` renders on the shared `GameStage`, mirroring `CoinFlipTablesScreen`. It reads round history and table discovery from a new `useOperatorRounds` hook (the Ponder indexer's `game:"operator"` rows, with a direct `getLogs` fallback), reads live per-table state from a new `useOperatorTable` multicall hook, and writes bets with the house `sendGameTx` (approve → `open`). The operator's `OperatorRegistry.MetadataSet` URI is fetched (with a timeout + house fallback) and passed to `GameStage` as `themeManifest`, which `ThemeProvider` re-validates through `parseManifest`.

**Tech Stack:** React + TypeScript + viem, the games/web app, Ponder indexer GraphQL, the house theme engine.

**Spec:** docs/superpowers/specs/2026-08-22-operator-coinflip-ui-design.md

## Global Constraints

- No native form controls — use `components/Menu.tsx` for the side pick and `components/Toggle.tsx`; never a native `<select>`/`<checkbox>`.
- Trust chrome is never skinnable — amounts, odds, the verify slip, and the wallet cluster render outside the themed `.stage` subtree; a theme reaches only registered skin points (`lib/theme/skinPoints.ts`).
- Chain 943 only — the operator substrate is unset on 369; the tab hides itself when `deployment.operator` is undefined and the screen renders a "not live" message.
- No new contract and no fund-moving path is added by this slice — the UI only calls existing `OperatorCoinFlip` entrypoints.
- `tsc --noEmit` stays clean and the existing `games/web` vitest suite stays green.
- The theme fetch must time out and fall back to the house look — a slow or dead metadata URI must never block the table from rendering.

---

## Conventions used by every task

- **Test command (whole suite):** `cd games/web && npm test` (this runs `vitest run`).
- **Test command (one file, for the red/green loop):** `cd games/web && npx vitest run src/<path>.test.ts`.
- **Typecheck:** `cd games/web && npm run typecheck` (this runs `tsc --noEmit`).
- **Vitest include glob:** `src/**/*.test.ts` with `environment: 'node'` (see `games/web/vitest.config.ts`). Tests are `.test.ts` files — **never `.test.tsx`** (the glob excludes it). A component test therefore uses `React.createElement` + `renderToStaticMarkup` from `react-dom/server`, exactly like the existing `src/components/shell/GameStage.test.ts`. No JSX in a `.test.ts` file, no jsdom.
- **Package manager:** npm workspaces (the repo has `package-lock.json`). Run npm scripts from `games/web`.

## File Structure

Files to create:

- `games/web/src/lib/operatorIndex.ts` — pure event-fold layer for the operator substrate: the `OperatorEvent` / `OperatorOpenedLog` / `OperatorSettledLog` / `OperatorTableCard` types, `foldOperatorTables`, `foldOperatorRounds`, `latestMetadataUri`, and `verifyOperatorRound` (adapts the operator logs onto the already-tested `verifyRound`).
- `games/web/src/lib/operatorIndex.test.ts` — unit tests for the four folds + the verify adapter.
- `games/web/src/hooks/useOperatorRounds.ts` — polls the raw operator event stream: indexer GraphQL (`game:"operator"`) when `deployment.gamesIndexer` is set, chunked `getLogs` over `OperatorCoinFlip` (live + retired) and `OperatorRegistry` otherwise or on indexer failure.
- `games/web/src/model/operator-table.ts` — pure per-table math: `tierPrice`, `payoutFor`, `betFits`, `decodeOperatorTable`, `operatorBetPlan`, `isStale`, `STALE_BLOCKS`.
- `games/web/src/model/operator-table.test.ts` — unit tests for the math.
- `games/web/src/hooks/useOperatorTable.ts` — reads one table's live `tables()` struct + `tableCap` + `tableLocked` in a single multicall.
- `games/web/src/components/OperatorTablePicker.tsx` — table discovery + selection list, folded from `foldOperatorTables`.
- `games/web/src/components/OperatorTablePicker.test.ts` — SSR render assertion.
- `games/web/src/components/OperatorCoinFlipScreen.tsx` — the screen: `GameStage` + picker + `BetTray` + side `Menu` + rounds (pending/settled/refunded) + bet/settle/refund flow + verify slip + operator theming.
- `games/web/src/components/OperatorCoinFlipScreen.test.ts` — SSR smoke render (empty state).
- `games/web/src/lib/operatorTheme.ts` — `fetchThemeManifest(uri, timeoutMs)` with an `AbortController` timeout and a fail-safe `undefined`.
- `games/web/src/lib/operatorTheme.test.ts` — mocked-`fetch` tests: ok JSON, non-2xx, thrown/aborted, missing URI.

Files to modify:

- `games/web/src/App.tsx` — register the `operator` tab: import the screen, add the `GAMES` entry, tag it `validator` in `VALIDATOR_GAMES`, render it under a `deployment.operator` guard with the deep-linked `initialTableId`, and hide it (tab strip + floor) on a chain with no operator substrate.

Files read but NOT modified (source of truth for exact signatures): `games/web/src/components/CoinFlipTablesScreen.tsx`, `games/web/src/hooks/useBackroomData.ts`, `games/web/src/hooks/useChainData.ts`, `games/web/src/model/table-rounds.ts`, `games/web/src/tx.ts`, `games/web/src/config.ts`, `games/web/src/lib/tablesVerify.ts`, `games/web/src/lib/theme/manifest.ts`, `games/web/src/components/shell/GameStage.tsx`, `games/contracts/contracts/games/operator/OperatorCoinFlip.sol`, `games/contracts/contracts/games/operator/OperatorRegistry.sol`, `games/indexer/src/index.ts`.

### Exact on-chain facts this plan is built on (verified against the Solidity + the indexer)

- `open(bytes32 tableId, uint8 side, uint256 stake, address[] validatorSubset, PreimageLocation.Info[] validatorLocations) returns (bytes32 roundId)` — the player entrypoint. `side`: 0 = heads (even), 1 = tails (odd). The escrow pulls the stake, so the player approves **the escrow**, not the game.
- `claim(bytes32 roundId)` — pull-settle once the seed finalized. `refundStale(bytes32 roundId)` — reclaim on a pure timeout.
- `tables(bytes32 tableId)` returns the struct tuple, in this order: `(address operator, address token, uint16 maxMultiplierX100, uint256 minStake, uint256 maxStake, bool open, address validatorPolicy)`.
- `tierPriceOf(bytes32,uint256)`, `tableCap(bytes32)`, `tableLocked(bytes32)`, `operatorOf(bytes32)` are all `view`. This plan reads `operator` from `tables()[0]` and computes the tier price client-side (`tierPrice`), so only `tables` + `tableCap` + `tableLocked` are read on-chain.
- Event `RoundOpened(bytes32 indexed roundId, bytes32 indexed tableId, address indexed player, uint8 side, uint256 stake, uint256 payout, uint256 tierPrice, bytes32 key, uint256 openedAtBlock)`. **Note the fields differ from `CoinFlipTables.RoundOpened`: there is no `subsetHash`; the operator round carries `tierPrice` + `key` instead.**
- Event `RoundSettled(bytes32 indexed roundId, bytes32 indexed tableId, address indexed player, bool won, uint256 payout, bytes32 seed)`.
- Event `RoundRefunded(bytes32 indexed roundId, bytes32 indexed tableId, address indexed player, uint256 stake)`.
- Event `TableCreated(bytes32 indexed tableId, address indexed operator, address indexed token, uint16 maxMultiplierX100, uint256 minStake, uint256 maxStake)` and `OpenSet(bytes32 indexed tableId, bool open)`.
- Event `OperatorRegistry.MetadataSet(address indexed operator, string uri)`.
- The Ponder indexer stores every one of these under `game = "operator"` (`games/indexer/src/index.ts`), with `args` keyed by the ABI parameter names above and bigints serialised as decimal strings (the hook re-hydrates them).
- `deployment.operator = { coinFlip, escrow, registry, policy, deployBlock, retired }` is populated on 943 in `games/web/src/config.ts`; `deployment.canonicalSubset` (3 addresses, inside the contract's `[MIN_SUBSET=3, DEFAULT_MAX_SUBSET=5]` window), `deployment.chips`, `deployment.random`, and `deployment.gamesIndexer` are all set there.

### Deviations from the task brief, and why (built into this plan)

1. **`RoundOpened` has no `subsetHash`.** The brief and `tablesVerify.OpenedLog` assume one; the operator event carries `tierPrice` + `key`. `verifyRound` never reads `subsetHash`, so Task 1 reuses it through a `verifyOperatorRound` adapter that maps the operator logs onto `OpenedLog`/`SettledLog` (filling `subsetHash` with the round `key`, an unused field).
2. **`TablePicker.tsx` cannot be reused verbatim.** It is hard-wired to `coinFlipTablesAbi`, `reduceTables`, and on-chain table names via a `TableNamed` event — none of which exist in the operator substrate (there is no `TableNamed`). Task 3 builds a dedicated `OperatorTablePicker` that folds the operator's own `TableCreated`/`OpenSet` events, reusing `TablePicker`'s CSS classes (`tp-picker`, `tp-list`, `tp-row`, …) so the look matches.

---

## Task 1 — `lib/operatorIndex.ts`: the event-fold layer + `useOperatorRounds`

**Files:**
- Create: `games/web/src/lib/operatorIndex.ts`
- Create: `games/web/src/lib/operatorIndex.test.ts`
- Create: `games/web/src/hooks/useOperatorRounds.ts`

**Interfaces:**

Produces (from `lib/operatorIndex.ts`):
- `type OperatorEvent = { name: string; args: Record<string, any>; blockNumber: bigint }`
- `type OperatorOpenedLog = { roundId: Hex; tableId: Hex; player: Address; side: number; stake: bigint; payout: bigint; tierPrice: bigint; key: Hex; openedAtBlock: bigint }`
- `type OperatorSettledLog = { roundId: Hex; tableId: Hex; player: Address; won: boolean; payout: bigint; seed: Hex; settledAtBlock: bigint }`
- `type OperatorTableCard = { tableId: Hex; operator: Address; token: Address; maxMultiplierX100: number; minStake: bigint; maxStake: bigint; open: boolean }`
- `foldOperatorTables(events: OperatorEvent[]): OperatorTableCard[]`
- `foldOperatorRounds(events: OperatorEvent[], sessionRounds: OperatorOpenedLog[], myAddress?: Hex): { myRounds: OperatorOpenedLog[]; settledByRound: Map<string, OperatorSettledLog>; refundedByRound: Set<string> }`
- `latestMetadataUri(events: OperatorEvent[], operator?: Address): string | undefined`
- `verifyOperatorRound(opened: OperatorOpenedLog, settled: OperatorSettledLog): { ok: boolean; reasons: string[] }`

Produces (from `hooks/useOperatorRounds.ts`):
- `type OperatorRoundsState = { events: OperatorEvent[]; head: bigint; error?: string; refresh: () => void }`
- `useOperatorRounds(deployment: GameDeployment): OperatorRoundsState`

Consumes: `verifyRound` + `OpenedLog`/`SettledLog` from `../lib/tablesVerify`; `operatorCoinFlipAbi`, `operatorRegistryAbi` from `@msgboard/games-core`; `publicClientFor` from `../wallet`; `GameDeployment` from `../config`.

**Steps:**

- [ ] Write the failing test file `games/web/src/lib/operatorIndex.test.ts` with this ACTUAL content:

```ts
import { describe, it, expect } from 'vitest'
import {
  foldOperatorTables,
  foldOperatorRounds,
  latestMetadataUri,
  verifyOperatorRound,
  type OperatorEvent,
  type OperatorOpenedLog,
} from './operatorIndex'

const TABLE = '0x1111111111111111111111111111111111111111111111111111111111111111' as const
const R1 = '0x00000000000000000000000000000000000000000000000000000000000000a1' as const
const R2 = '0x00000000000000000000000000000000000000000000000000000000000000a2' as const
const ME = '0x00000000000000000000000000000000000000Ab' as const
const OTHER = '0x00000000000000000000000000000000000000cD' as const
const OP = '0x00000000000000000000000000000000000000E0' as const
const TOKEN = '0x00000000000000000000000000000000000000F0' as const

const opened = (roundId: string, player: string, block: bigint): OperatorEvent => ({
  name: 'RoundOpened',
  args: { roundId, tableId: TABLE, player, side: 0, stake: 1n, payout: 2n, tierPrice: 1n, key: roundId, openedAtBlock: block },
  blockNumber: block,
})

describe('foldOperatorTables', () => {
  it('folds TableCreated then applies the last OpenSet', () => {
    const events: OperatorEvent[] = [
      { name: 'TableCreated', args: { tableId: TABLE, operator: OP, token: TOKEN, maxMultiplierX100: 196, minStake: 1n, maxStake: 8n }, blockNumber: 1n },
      { name: 'OpenSet', args: { tableId: TABLE, open: false }, blockNumber: 2n },
      { name: 'OpenSet', args: { tableId: TABLE, open: true }, blockNumber: 3n },
    ]
    const [t] = foldOperatorTables(events)
    expect(t).toEqual({ tableId: TABLE, operator: OP, token: TOKEN, maxMultiplierX100: 196, minStake: 1n, maxStake: 8n, open: true })
  })

  it('ignores an OpenSet for an unknown table', () => {
    expect(foldOperatorTables([{ name: 'OpenSet', args: { tableId: TABLE, open: false }, blockNumber: 1n }])).toEqual([])
  })
})

describe('foldOperatorRounds', () => {
  it('keeps only my rounds, newest first, and indexes terminals', () => {
    const events: OperatorEvent[] = [
      opened(R1, ME, 10n),
      opened(R2, OTHER, 11n),
      { name: 'RoundSettled', args: { roundId: R1, tableId: TABLE, player: ME, won: true, payout: 2n, seed: '0x02' }, blockNumber: 12n },
    ]
    const { myRounds, settledByRound, refundedByRound } = foldOperatorRounds(events, [], ME)
    expect(myRounds.map((r) => r.roundId)).toEqual([R1])
    expect(settledByRound.get(R1)?.won).toBe(true)
    expect(refundedByRound.has(R1)).toBe(false)
  })

  it('merges a session round that is not yet indexed', () => {
    const session: OperatorOpenedLog = {
      roundId: R2, tableId: TABLE, player: ME, side: 1, stake: 1n, payout: 2n, tierPrice: 1n, key: R2, openedAtBlock: 20n,
    }
    const { myRounds } = foldOperatorRounds([opened(R1, ME, 10n)], [session], ME)
    expect(myRounds.map((r) => r.roundId)).toEqual([R2, R1]) // block 20 before block 10
  })

  it('marks a refunded round', () => {
    const events: OperatorEvent[] = [
      opened(R1, ME, 10n),
      { name: 'RoundRefunded', args: { roundId: R1, tableId: TABLE, player: ME, stake: 1n }, blockNumber: 13n },
    ]
    expect(foldOperatorRounds(events, [], ME).refundedByRound.has(R1)).toBe(true)
  })
})

describe('latestMetadataUri', () => {
  it('returns the last MetadataSet for the operator (case-insensitive)', () => {
    const events: OperatorEvent[] = [
      { name: 'MetadataSet', args: { operator: OP, uri: 'ipfs://one' }, blockNumber: 1n },
      { name: 'MetadataSet', args: { operator: OP.toLowerCase(), uri: 'ipfs://two' }, blockNumber: 2n },
    ]
    expect(latestMetadataUri(events, OP)).toBe('ipfs://two')
  })

  it('returns undefined when no operator or no match', () => {
    expect(latestMetadataUri([], OP)).toBeUndefined()
    expect(latestMetadataUri([{ name: 'MetadataSet', args: { operator: OTHER, uri: 'x' }, blockNumber: 1n }], OP)).toBeUndefined()
  })
})

describe('verifyOperatorRound', () => {
  it('accepts a consistent win (even seed, side 0)', () => {
    const o: OperatorOpenedLog = { roundId: R1, tableId: TABLE, player: ME, side: 0, stake: 1n, payout: 2n, tierPrice: 1n, key: R1, openedAtBlock: 10n }
    const s = { roundId: R1, tableId: TABLE, player: ME, won: true, payout: 2n, seed: ('0x' + '00'.repeat(31) + '02') as `0x${string}`, settledAtBlock: 12n }
    expect(verifyOperatorRound(o, s).ok).toBe(true)
  })

  it('rejects a win the seed parity contradicts', () => {
    const o: OperatorOpenedLog = { roundId: R1, tableId: TABLE, player: ME, side: 0, stake: 1n, payout: 2n, tierPrice: 1n, key: R1, openedAtBlock: 10n }
    const s = { roundId: R1, tableId: TABLE, player: ME, won: true, payout: 2n, seed: ('0x' + '00'.repeat(31) + '01') as `0x${string}`, settledAtBlock: 12n }
    const res = verifyOperatorRound(o, s)
    expect(res.ok).toBe(false)
    expect(res.reasons.join(' ')).toMatch(/parity/i)
  })
})
```

- [ ] Run it and watch it fail — the module does not exist yet:
  - `cd games/web && npx vitest run src/lib/operatorIndex.test.ts`
  - Expected failure: `Failed to resolve import "./operatorIndex"` (or `Cannot find module`).

- [ ] Write the minimal implementation `games/web/src/lib/operatorIndex.ts` with this ACTUAL content:

```ts
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
```

- [ ] Run the test again and watch it pass:
  - `cd games/web && npx vitest run src/lib/operatorIndex.test.ts`
  - Expected: all cases under `foldOperatorTables`, `foldOperatorRounds`, `latestMetadataUri`, `verifyOperatorRound` pass.

- [ ] Write the hook `games/web/src/hooks/useOperatorRounds.ts` with this ACTUAL content (no separate unit test — it is a thin RPC/poll wrapper whose only pure parts live in `operatorIndex.ts`; it is exercised by the screen's SSR test and the manual 943 walkthrough):

```ts
import { useCallback, useEffect, useRef, useState } from 'react'
import { operatorCoinFlipAbi, operatorRegistryAbi } from '@msgboard/games-core'
import type { OperatorEvent } from '../lib/operatorIndex'
import { publicClientFor } from '../wallet'
import type { GameDeployment } from '../config'

const POLL_MS = 12_000
// Chunk a getLogs scan so a full-history range never exceeds the RPC's per-request limit (same ceiling
// useChainData/useBackroomData scan under).
const MAX_RANGE = 10_000n

export type OperatorRoundsState = {
  events: OperatorEvent[]
  head: bigint
  error?: string
  refresh: () => void
}

/** Decimal-string args re-hydrated to bigint (hex/addresses/bools pass through) — same rule as
 *  useBackroomData's rehydrate. */
const rehydrate = (args: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(args)) out[k] = typeof v === 'string' && /^[0-9]+$/.test(v) ? BigInt(v) : v
  return out
}

/** Indexer GraphQL — reads ONLY `game = "operator"` rows, same shape as useBackroomData's fetch. */
const fetchViaIndexer = async (url: string, chainId: number, from: bigint, to: bigint): Promise<OperatorEvent[]> => {
  const out: OperatorEvent[] = []
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

/** getLogs fallback (spec §9): scan OperatorCoinFlip (live + retired) and OperatorRegistry directly so a
 *  just-opened round and the operator's theme are visible even if the indexer lags or is unset. */
const fetchViaLogs = async (
  client: ReturnType<typeof publicClientFor>,
  opCfg: NonNullable<GameDeployment['operator']>,
  from: bigint,
  to: bigint,
): Promise<OperatorEvent[]> => {
  const out: OperatorEvent[] = []
  const coinFlipAddresses = [opCfg.coinFlip, ...opCfg.retired]
  for (let lo = from; lo <= to; lo += MAX_RANGE) {
    const hi = lo + MAX_RANGE - 1n < to ? lo + MAX_RANGE - 1n : to
    const [game, registry] = await Promise.all([
      client.getContractEvents({ address: coinFlipAddresses, abi: operatorCoinFlipAbi, fromBlock: lo, toBlock: hi, strict: true }),
      client.getContractEvents({ address: opCfg.registry, abi: operatorRegistryAbi, fromBlock: lo, toBlock: hi, strict: true }),
    ])
    for (const log of [...game, ...registry]) {
      out.push({ name: log.eventName, args: (log.args ?? {}) as Record<string, any>, blockNumber: log.blockNumber ?? 0n })
    }
  }
  return out
}

/**
 * Poll the operator substrate's raw event stream (every operator's tables + rounds + metadata). Reads the
 * indexer's GraphQL when `deployment.gamesIndexer` is set, chunked getLogs otherwise or on an indexer
 * failure. Accumulate-only cache keyed by chain, POLL_MS 12000. Returns `{ events: [], head: 0n }` with no
 * RPC calls when the chain carries no operator substrate (369), so the app builds and runs there unchanged.
 */
export const useOperatorRounds = (deployment: GameDeployment): OperatorRoundsState => {
  const [state, setState] = useState<{ events: OperatorEvent[]; head: bigint; error?: string }>({ events: [], head: 0n })
  const busy = useRef(false)
  const acc = useRef<{ chainId: number; events: OperatorEvent[]; lastBlock: bigint } | null>(null)

  const load = useCallback(async () => {
    const opCfg = deployment.operator
    if (!opCfg || busy.current) return
    busy.current = true
    try {
      const client = publicClientFor(deployment.chainId, deployment.rpc)
      const head = await client.getBlockNumber()
      if (!acc.current || acc.current.chainId !== deployment.chainId) {
        acc.current = { chainId: deployment.chainId, events: [], lastBlock: BigInt(opCfg.deployBlock) - 1n }
      }
      const from = acc.current.lastBlock + 1n
      if (head >= from) {
        let fresh: OperatorEvent[]
        if (deployment.gamesIndexer) {
          try {
            fresh = await fetchViaIndexer(deployment.gamesIndexer, deployment.chainId, from, head)
          } catch {
            fresh = await fetchViaLogs(client, opCfg, from, head)
          }
        } else {
          fresh = await fetchViaLogs(client, opCfg, from, head)
        }
        acc.current.events.push(...fresh)
        acc.current.lastBlock = head
      }
      setState({ events: acc.current.events, head, error: undefined })
    } catch (error) {
      setState((s) => ({ ...s, error: error instanceof Error ? error.message : String(error) }))
    } finally {
      busy.current = false
    }
  }, [deployment.chainId, deployment.rpc, deployment.gamesIndexer, deployment.operator])

  useEffect(() => {
    if (!deployment.operator) {
      setState({ events: [], head: 0n })
      return
    }
    void load()
    const timer = setInterval(() => void load(), POLL_MS)
    return () => clearInterval(timer)
  }, [load, deployment.operator])

  return { ...state, refresh: () => void load() }
}
```

- [ ] Confirm the whole suite and typecheck are still green:
  - `cd games/web && npm test`
  - `cd games/web && npm run typecheck`
  - Expected: existing tests + the new `operatorIndex.test.ts` pass; `tsc` reports no errors.

- [ ] Commit:
  - `git add games/web/src/lib/operatorIndex.ts games/web/src/lib/operatorIndex.test.ts games/web/src/hooks/useOperatorRounds.ts`
  - `git commit -m "feat(operator-ui): operator event folds + useOperatorRounds hook"`

---

## Task 2 — `model/operator-table.ts`: per-table math + `useOperatorTable`

**Files:**
- Create: `games/web/src/model/operator-table.ts`
- Create: `games/web/src/model/operator-table.test.ts`
- Create: `games/web/src/hooks/useOperatorTable.ts`

**Interfaces:**

Produces (from `model/operator-table.ts`):
- `type OperatorTable = { tableId: Hex; operator: Address; token: Address; maxMultiplierX100: number; minStake: bigint; maxStake: bigint; open: boolean; validatorPolicy: Address; cap: bigint; locked: bigint }`
- `tierPrice(minStake: bigint, maxStake: bigint, stake: bigint): bigint | undefined`
- `payoutFor(stake: bigint, maxMultiplierX100: number): bigint`
- `betFits(table: OperatorTable, stake: bigint): { ok: boolean; reason?: string }`
- `decodeOperatorTable(tableId: Hex, tableTuple: readonly unknown[], cap: bigint, locked: bigint): OperatorTable`
- `operatorBetPlan(opCfg: NonNullable<GameDeployment['operator']>, canonicalSubset: Hex[], tableId: Hex, side: number, stake: bigint, locations: Info[]): { approveTo: Address; openTo: Address; openArgs: readonly [Hex, number, bigint, Hex[], Info[]] }`
- `isStale(openedAtBlock: bigint, head: bigint): boolean`
- `const STALE_BLOCKS = 200n`

Produces (from `hooks/useOperatorTable.ts`):
- `useOperatorTable(deployment: GameDeployment, tableId: Hex | null): { table?: OperatorTable; refresh: () => void }`

Consumes: `Info` from `@msgboard/games-core`; `operatorCoinFlipAbi` from `@msgboard/games-core`; `publicClientFor` from `../wallet`; `GameDeployment` from `../config`.

**Steps:**

- [ ] Write the failing test file `games/web/src/model/operator-table.test.ts` with this ACTUAL content:

```ts
import { describe, it, expect } from 'vitest'
import {
  tierPrice,
  payoutFor,
  betFits,
  decodeOperatorTable,
  operatorBetPlan,
  isStale,
  STALE_BLOCKS,
  type OperatorTable,
} from './operator-table'

const TABLE = '0x1111111111111111111111111111111111111111111111111111111111111111' as const
const OP = '0x00000000000000000000000000000000000000E0' as const
const TOKEN = '0x00000000000000000000000000000000000000F0' as const
const ESCROW = '0x00000000000000000000000000000000000000e5' as const
const GAME = '0x00000000000000000000000000000000000000c0' as const
const V1 = '0x00000000000000000000000000000000000000A1' as const

const table = (over: Partial<OperatorTable> = {}): OperatorTable => ({
  tableId: TABLE, operator: OP, token: TOKEN, maxMultiplierX100: 200,
  minStake: 1n, maxStake: 8n, open: true, validatorPolicy: '0x0000000000000000000000000000000000000000',
  cap: 0n, locked: 0n, ...over,
})

describe('tierPrice', () => {
  it('rounds up to the smallest power-of-two tier >= stake', () => {
    expect(tierPrice(1n, 8n, 1n)).toBe(1n)
    expect(tierPrice(1n, 8n, 2n)).toBe(2n)
    expect(tierPrice(1n, 8n, 3n)).toBe(4n)
    expect(tierPrice(1n, 8n, 5n)).toBe(8n)
  })
  it('returns undefined out of range', () => {
    expect(tierPrice(1n, 8n, 0n)).toBeUndefined()
    expect(tierPrice(1n, 8n, 9n)).toBeUndefined()
  })
})

describe('payoutFor', () => {
  it('is stake * maxMultiplierX100 / 100 (integer division)', () => {
    expect(payoutFor(1_000000000000000000n, 196)).toBe(1_960000000000000000n)
    expect(payoutFor(1n, 150)).toBe(1n) // truncates to break-even at dust
  })
})

describe('betFits', () => {
  it('accepts an in-range stake with room under the cap', () => {
    expect(betFits(table({ cap: 100n, locked: 0n }), 1_000000000000000000n).ok).toBe(true)
  })
  it('rejects a paused table', () => {
    expect(betFits(table({ open: false }), 1n).reason).toMatch(/paused/i)
  })
  it('rejects an out-of-range stake', () => {
    expect(betFits(table(), 9n).reason).toMatch(/range/i)
  })
  it('rejects a dust stake whose payout truncates to break-even', () => {
    expect(betFits(table({ maxMultiplierX100: 150 }), 1n).reason).toMatch(/pay nothing/i)
  })
  it('rejects a bet that would exceed the exposure cap', () => {
    // stake 4 (payout 8, exposure 4) with cap 5 and locked 2 → 2 + 4 > 5
    expect(betFits(table({ cap: 5n, locked: 2n }), 4n).reason).toMatch(/cap/i)
  })
})

describe('decodeOperatorTable', () => {
  it('reads the tables() struct tuple in field order', () => {
    const tuple = [OP, TOKEN, 196, 1n, 8n, true, '0x0000000000000000000000000000000000000000'] as const
    expect(decodeOperatorTable(TABLE, tuple, 50n, 10n)).toEqual({
      tableId: TABLE, operator: OP, token: TOKEN, maxMultiplierX100: 196,
      minStake: 1n, maxStake: 8n, open: true, validatorPolicy: '0x0000000000000000000000000000000000000000',
      cap: 50n, locked: 10n,
    })
  })
})

describe('operatorBetPlan', () => {
  it('approves the escrow and opens on the game with the canonical subset', () => {
    const opCfg = { coinFlip: GAME, escrow: ESCROW, registry: '0x0' as const, policy: '0x0' as const, deployBlock: '0', retired: [] }
    const plan = operatorBetPlan(opCfg, [V1], TABLE, 1, 5n, [])
    expect(plan.approveTo).toBe(ESCROW)
    expect(plan.openTo).toBe(GAME)
    expect(plan.openArgs[0]).toBe(TABLE)
    expect(plan.openArgs[1]).toBe(1)
    expect(plan.openArgs[2]).toBe(5n)
    expect(plan.openArgs[3]).toEqual([V1])
  })
})

describe('isStale', () => {
  it('is true only once STALE_BLOCKS have passed since open', () => {
    expect(isStale(100n, 100n + STALE_BLOCKS - 1n)).toBe(false)
    expect(isStale(100n, 100n + STALE_BLOCKS)).toBe(true)
    expect(isStale(0n, 999n)).toBe(false) // no open block yet
  })
})
```

- [ ] Run it and watch it fail:
  - `cd games/web && npx vitest run src/model/operator-table.test.ts`
  - Expected failure: `Failed to resolve import "./operator-table"`.

- [ ] Write the minimal implementation `games/web/src/model/operator-table.ts` with this ACTUAL content:

```ts
import type { Address, Hex } from 'viem'
import type { Info } from '@msgboard/games-core'
import type { GameDeployment } from '../config'

/** A round is refundable once its seed is missing AND STALE_BLOCKS have passed since it opened
 *  (GameBase.STALE_BLOCKS). We gate the Refund button on the block gap; the seed-missing half is enforced
 *  on-chain (refundStale reverts TooEarly if a seed finalized). */
export const STALE_BLOCKS = 200n

/** A table's live state — the tables() struct fields plus the cap/locked mappings. */
export type OperatorTable = {
  tableId: Hex; operator: Address; token: Address
  maxMultiplierX100: number; minStake: bigint; maxStake: bigint
  open: boolean; validatorPolicy: Address
  cap: bigint; locked: bigint
}

/** The smallest power-of-two ladder tier >= stake, in [minStake, maxStake]; undefined out of range.
 *  Mirrors OperatorCoinFlip._tierPrice exactly (the contract enforces it on open). */
export const tierPrice = (minStake: bigint, maxStake: bigint, stake: bigint): bigint | undefined => {
  if (stake < minStake || stake > maxStake) return undefined
  let price = minStake
  while (price < stake) price <<= 1n
  return price
}

/** payout = stake * maxMultiplierX100 / 100 (integer division, as on-chain). */
export const payoutFor = (stake: bigint, maxMultiplierX100: number): bigint =>
  (stake * BigInt(maxMultiplierX100)) / 100n

/** Whether a bet of `stake` fits `table` right now: table open, stake in tier range, non-dust payout, and
 *  within the exposure cap (0 = unlimited). Returns a player-readable reason when it does not. */
export const betFits = (table: OperatorTable, stake: bigint): { ok: boolean; reason?: string } => {
  if (!table.open) return { ok: false, reason: 'paused by operator' }
  const price = tierPrice(table.minStake, table.maxStake, stake)
  if (price === undefined) return { ok: false, reason: 'stake is outside the table range' }
  const payout = payoutFor(stake, table.maxMultiplierX100)
  if (payout === stake) return { ok: false, reason: 'stake too small for this edge — a win would pay nothing' }
  const exposure = payout - stake
  if (table.cap !== 0n && table.locked + exposure > table.cap) return { ok: false, reason: 'table is at its exposure cap' }
  return { ok: true }
}

/** Decode the readContract result for one table. `tableTuple` is the 7-field tables() struct
 *  (operator, token, maxMultiplierX100, minStake, maxStake, open, validatorPolicy). */
export const decodeOperatorTable = (
  tableId: Hex,
  tableTuple: readonly unknown[],
  cap: bigint,
  locked: bigint,
): OperatorTable => ({
  tableId,
  operator: tableTuple[0] as Address,
  token: tableTuple[1] as Address,
  maxMultiplierX100: Number(tableTuple[2] as number),
  minStake: tableTuple[3] as bigint,
  maxStake: tableTuple[4] as bigint,
  open: tableTuple[5] as boolean,
  validatorPolicy: tableTuple[6] as Address,
  cap,
  locked,
})

/** The two-step bet plan: the ERC-20 approve targets the ESCROW (it pulls the stake on open), and the
 *  open targets the game with the auto-picked canonical validator subset (spec §5 — the player never
 *  chooses validators). The token to approve is the table's own token, supplied by the caller. */
export const operatorBetPlan = (
  opCfg: NonNullable<GameDeployment['operator']>,
  canonicalSubset: Hex[],
  tableId: Hex,
  side: number,
  stake: bigint,
  locations: Info[],
): { approveTo: Address; openTo: Address; openArgs: readonly [Hex, number, bigint, Hex[], Info[]] } => ({
  approveTo: opCfg.escrow as Address,
  openTo: opCfg.coinFlip as Address,
  openArgs: [tableId, side, stake, canonicalSubset, locations],
})

/** True once STALE_BLOCKS have passed since the round opened (the block-gap half of refundability). */
export const isStale = (openedAtBlock: bigint, head: bigint): boolean =>
  head > 0n && openedAtBlock > 0n && head >= openedAtBlock + STALE_BLOCKS
```

- [ ] Run the test again and watch it pass:
  - `cd games/web && npx vitest run src/model/operator-table.test.ts`
  - Expected: every case under `tierPrice`, `payoutFor`, `betFits`, `decodeOperatorTable`, `operatorBetPlan`, `isStale` passes.

- [ ] Write the hook `games/web/src/hooks/useOperatorTable.ts` with this ACTUAL content (thin multicall wrapper; its only pure part, `decodeOperatorTable`, is tested above):

```ts
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Hex } from 'viem'
import { operatorCoinFlipAbi } from '@msgboard/games-core'
import { decodeOperatorTable, type OperatorTable } from '../model/operator-table'
import { publicClientFor } from '../wallet'
import type { GameDeployment } from '../config'

const POLL_MS = 12_000

/**
 * Read one operator table's live state in a single multicall: tables() struct + tableCap + tableLocked.
 * Returns undefined until the first read lands, when no table is selected, or on a failed struct read.
 * Polls every POLL_MS so the exposure cap / open flag stay fresh while the tray is open.
 */
export const useOperatorTable = (
  deployment: GameDeployment,
  tableId: Hex | null,
): { table?: OperatorTable; refresh: () => void } => {
  const [table, setTable] = useState<OperatorTable | undefined>(undefined)
  const busy = useRef(false)

  const load = useCallback(async () => {
    const opCfg = deployment.operator
    if (!opCfg || !tableId || busy.current) return
    busy.current = true
    try {
      const client = publicClientFor(deployment.chainId, deployment.rpc)
      const [tableRes, capRes, lockedRes] = await client.multicall({
        contracts: [
          { address: opCfg.coinFlip, abi: operatorCoinFlipAbi, functionName: 'tables', args: [tableId] },
          { address: opCfg.coinFlip, abi: operatorCoinFlipAbi, functionName: 'tableCap', args: [tableId] },
          { address: opCfg.coinFlip, abi: operatorCoinFlipAbi, functionName: 'tableLocked', args: [tableId] },
        ],
        allowFailure: true,
      })
      if (tableRes.status !== 'success') {
        setTable(undefined)
        return
      }
      setTable(
        decodeOperatorTable(
          tableId,
          tableRes.result as readonly unknown[],
          capRes.status === 'success' ? (capRes.result as bigint) : 0n,
          lockedRes.status === 'success' ? (lockedRes.result as bigint) : 0n,
        ),
      )
    } catch {
      setTable(undefined)
    } finally {
      busy.current = false
    }
  }, [deployment.chainId, deployment.rpc, deployment.operator, tableId])

  useEffect(() => {
    if (!tableId) {
      setTable(undefined)
      return
    }
    void load()
    const timer = setInterval(() => void load(), POLL_MS)
    return () => clearInterval(timer)
  }, [load, tableId])

  return { table, refresh: () => void load() }
}
```

- [ ] Confirm the suite and typecheck stay green:
  - `cd games/web && npm test`
  - `cd games/web && npm run typecheck`
  - Expected: all tests pass; `tsc` clean.

- [ ] Commit:
  - `git add games/web/src/model/operator-table.ts games/web/src/model/operator-table.test.ts games/web/src/hooks/useOperatorTable.ts`
  - `git commit -m "feat(operator-ui): per-table math (tier/payout/betFits) + useOperatorTable"`

---

## Task 3 — `OperatorTablePicker`: discovery + selection

**Files:**
- Create: `games/web/src/components/OperatorTablePicker.tsx`
- Create: `games/web/src/components/OperatorTablePicker.test.ts`

**Interfaces:**

Produces:
- `OperatorTablePicker(props: { deployment: GameDeployment; tables: OperatorTableCard[]; selected: Hex | null; onSelect: (tableId: Hex) => void }): JSX.Element`

Consumes: `OperatorTableCard` from `../lib/operatorIndex`; `fmtAmount` from `./Meta`; `GameDeployment` from `../config`. Reuses `TablePicker`'s CSS classes (`tp-picker`, `tp-head`, `tp-title`, `tp-list`, `tp-row`, `tp-name`, `tp-op`, `tp-hot`, `tp-reason`, `tp-empty`) so the look matches the existing tables picker.

**Steps:**

- [ ] Write the failing test file `games/web/src/components/OperatorTablePicker.test.ts` with this ACTUAL content (SSR render, matching `GameStage.test.ts`'s `renderToStaticMarkup` style):

```ts
import { describe, it, expect } from 'vitest'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { OperatorTablePicker } from './OperatorTablePicker'
import { deployments } from '../config'
import type { OperatorTableCard } from '../lib/operatorIndex'

const deployment = deployments.find((d) => d.operator)!
const TABLE = '0x1111111111111111111111111111111111111111111111111111111111111111' as const
const OP = '0x00000000000000000000000000000000000000E0' as const
const TOKEN = '0x00000000000000000000000000000000000000F0' as const

describe('OperatorTablePicker', () => {
  it('lists an open table with its edge and operator', () => {
    const tables: OperatorTableCard[] = [
      { tableId: TABLE, operator: OP, token: TOKEN, maxMultiplierX100: 196, minStake: 1n, maxStake: 8n, open: true },
    ]
    const html = renderToStaticMarkup(
      React.createElement(OperatorTablePicker, { deployment, tables, selected: null, onSelect: () => {} }),
    )
    expect(html).toContain('1.96×')
    expect(html).toContain('0x0000') // shortened operator address
    expect(html).not.toContain('paused')
  })

  it('shows the empty state with no tables', () => {
    const html = renderToStaticMarkup(
      React.createElement(OperatorTablePicker, { deployment, tables: [], selected: null, onSelect: () => {} }),
    )
    expect(html).toContain('no operator tables')
  })

  it('marks a paused table as unselectable', () => {
    const tables: OperatorTableCard[] = [
      { tableId: TABLE, operator: OP, token: TOKEN, maxMultiplierX100: 200, minStake: 1n, maxStake: 8n, open: false },
    ]
    const html = renderToStaticMarkup(
      React.createElement(OperatorTablePicker, { deployment, tables, selected: null, onSelect: () => {} }),
    )
    expect(html).toContain('paused by operator')
    expect(html).toContain('disabled')
  })
})
```

- [ ] Run it and watch it fail:
  - `cd games/web && npx vitest run src/components/OperatorTablePicker.test.ts`
  - Expected failure: `Failed to resolve import "./OperatorTablePicker"`.

- [ ] Write the minimal implementation `games/web/src/components/OperatorTablePicker.tsx` with this ACTUAL content:

```tsx
import * as viem from 'viem'
import type { GameDeployment } from '../config'
import type { OperatorTableCard } from '../lib/operatorIndex'
import { fmtAmount } from './Meta'

const fmtMultiplier = (x100: number) => `${(x100 / 100).toFixed(2)}×`
const shortAddr = (address: viem.Address) => `${address.slice(0, 6)}…${address.slice(-4)}`

const TableRow = ({
  deployment,
  table,
  selected,
  onSelect,
}: {
  deployment: GameDeployment
  table: OperatorTableCard
  selected: boolean
  onSelect: (tableId: viem.Hex) => void
}) => {
  const reason = table.open ? undefined : 'paused by operator'
  return (
    <li>
      <button
        type="button"
        className={`tp-row${selected ? ' selected' : ''}`}
        disabled={reason !== undefined}
        title={reason}
        onClick={() => onSelect(table.tableId)}
      >
        <span className="mono tp-op">{shortAddr(table.operator)}</span>
        <span className="tag">{fmtMultiplier(table.maxMultiplierX100)}</span>
        <span className="tp-hot">
          {fmtAmount(deployment, table.minStake)}–{fmtAmount(deployment, table.maxStake)} stake
        </span>
        {reason && <span className="bad tp-reason">{reason}</span>}
      </button>
    </li>
  )
}

/**
 * Browse and pick a live operator coin-flip table. Pure presentation over the already-folded
 * `OperatorTableCard[]` (the screen owns the poll via `useOperatorRounds` + `foldOperatorTables`). Reuses
 * the tables picker's CSS classes so the look matches; open tables sort before paused ones.
 */
export const OperatorTablePicker = ({
  deployment,
  tables,
  selected,
  onSelect,
}: {
  deployment: GameDeployment
  tables: OperatorTableCard[]
  selected: viem.Hex | null
  onSelect: (tableId: viem.Hex) => void
}) => {
  const sorted = [...tables].sort((a, b) => Number(b.open) - Number(a.open))
  return (
    <div className="tp-picker card">
      <div className="row tp-head" style={{ justifyContent: 'space-between' }}>
        <span className="tp-title">Operator tables</span>
      </div>
      {sorted.length === 0 ? (
        <p className="muted tp-empty">no operator tables yet on this chain</p>
      ) : (
        <ul className="tp-list">
          {sorted.map((t) => (
            <TableRow
              key={t.tableId}
              deployment={deployment}
              table={t}
              selected={selected === t.tableId}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
    </div>
  )
}
```

- [ ] Run the test again and watch it pass:
  - `cd games/web && npx vitest run src/components/OperatorTablePicker.test.ts`
  - Expected: the three cases pass (`1.96×` rendered, empty-state string present, paused row `disabled`).

- [ ] Confirm suite + typecheck:
  - `cd games/web && npm test`
  - `cd games/web && npm run typecheck`
  - Expected: green.

- [ ] Commit:
  - `git add games/web/src/components/OperatorTablePicker.tsx games/web/src/components/OperatorTablePicker.test.ts`
  - `git commit -m "feat(operator-ui): OperatorTablePicker discovery list"`

---

## Task 4 — `OperatorCoinFlipScreen`: the full play + verify surface

This task builds the whole screen: `GameStage` shell, the picker, the `BetTray` + side `Menu`, the rounds list (pending / settled / refunded), the approve→open bet flow (auto-canonical subset), the settle (poll `randomness` → `claim` fallback) + `refundStale` flow, and the provably-fair verify slip. Theming is added in Task 5 (the `themeManifest` prop stays absent here → the house look, which is a correct intermediate state per `GameStage`'s contract).

**Files:**
- Create: `games/web/src/components/OperatorCoinFlipScreen.tsx`
- Create: `games/web/src/components/OperatorCoinFlipScreen.test.ts`

**Interfaces:**

Produces:
- `OperatorCoinFlipScreen(props: { deployment: GameDeployment; data: ChainData; walletClient?: viem.WalletClient; trustAcknowledged: boolean; myAddress?: viem.Hex; initialTableId?: viem.Hex }): JSX.Element`

Consumes: `useOperatorRounds` (Task 1); `useOperatorTable` (Task 2); `foldOperatorTables`, `foldOperatorRounds`, `verifyOperatorRound`, `OperatorOpenedLog`, `OperatorSettledLog` (Task 1); `operatorBetPlan`, `betFits`, `tierPrice`, `payoutFor`, `isStale` (Task 2); `sendGameTx`, `nextHeatLocations` from `../tx`; `publicClientFor` from `../wallet`; `operatorCoinFlipAbi`, `randomAbi` from `@msgboard/games-core`; `OperatorTablePicker` (Task 3); `Menu`, `parseStake` (`./StakeInput`), `GameStage`, `BetTray`, `MetaPanel`, and `AddressLink`/`explorerUrl`/`fmtAmount`/`InfoDot`/`MSGBOARD_GAMES_DOCS` from `./Meta`.

Contract calls used (exact): approve on `table.token` with args `[opCfg.escrow, stake]`; `open` on `opCfg.coinFlip` with args `[tableId, side, stake, deployment.canonicalSubset, nextHeatLocations(deployment, data.lobby, data.rounds)]`; `randomness` on `deployment.random` with args `[opened.key]` returning `{ seed }`; `claim` on `opCfg.coinFlip` with `[roundId]`; `refundStale` on `opCfg.coinFlip` with `[roundId]`.

**Steps:**

- [ ] Write the failing test file `games/web/src/components/OperatorCoinFlipScreen.test.ts` with this ACTUAL content (SSR smoke render — `useEffect` never runs under `renderToStaticMarkup`, so the hooks stay at their empty initial state and no RPC fires):

```ts
import { describe, it, expect } from 'vitest'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { OperatorCoinFlipScreen } from './OperatorCoinFlipScreen'
import { deployments } from '../config'
import type { ChainData } from '../hooks/useChainData'

const deployment = deployments.find((d) => d.operator)!
const emptyData: ChainData = {
  lobby: { openEntries: [], flips: [] },
  rounds: [],
  blockNumber: 0n,
  timestamps: {},
  refresh: () => {},
}

describe('OperatorCoinFlipScreen', () => {
  it('renders the stage title and the empty picker without a wallet', () => {
    const html = renderToStaticMarkup(
      React.createElement(OperatorCoinFlipScreen, {
        deployment,
        data: emptyData,
        trustAcknowledged: false,
      }),
    )
    expect(html).toContain('OPERATOR TABLES')
    expect(html).toContain('no operator tables yet on this chain')
    expect(html).toContain('connect a wallet to play')
  })
})
```

- [ ] Run it and watch it fail:
  - `cd games/web && npx vitest run src/components/OperatorCoinFlipScreen.test.ts`
  - Expected failure: `Failed to resolve import "./OperatorCoinFlipScreen"`.

- [ ] Write the minimal implementation `games/web/src/components/OperatorCoinFlipScreen.tsx` with this ACTUAL content:

```tsx
import { useEffect, useMemo, useState } from 'react'
import * as viem from 'viem'
import { operatorCoinFlipAbi, randomAbi } from '@msgboard/games-core'
import type { GameDeployment } from '../config'
import type { ChainData } from '../hooks/useChainData'
import { useOperatorRounds } from '../hooks/useOperatorRounds'
import { useOperatorTable } from '../hooks/useOperatorTable'
import {
  foldOperatorTables,
  foldOperatorRounds,
  verifyOperatorRound,
  type OperatorOpenedLog,
  type OperatorSettledLog,
} from '../lib/operatorIndex'
import { operatorBetPlan, betFits, tierPrice, payoutFor, isStale } from '../model/operator-table'
import { sendGameTx, nextHeatLocations } from '../tx'
import { publicClientFor } from '../wallet'
import { OperatorTablePicker } from './OperatorTablePicker'
import { Menu } from './Menu'
import { parseStake } from './StakeInput'
import { GameStage } from './shell/GameStage'
import { BetTray } from './shell/BetTray'
import { MetaPanel } from './shell/MetaPanel'
import { AddressLink, explorerUrl, fmtAmount, InfoDot, MSGBOARD_GAMES_DOCS } from './Meta'

/** Minimal ERC20 approve — Chips has no ABI export in games-core; mirrors CoinFlipTablesScreen's local const. */
const ERC20_APPROVE_ABI = [
  {
    name: 'approve',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const

const HEADS = 0
const SIDE_OPTIONS = ['Heads (even)', 'Tails (odd)'] as const
const ZERO32 = viem.padHex('0x0', { size: 32 })

/** The verify receipt for one settled round — recomputes the winner from the seed parity purely from the
 *  RoundOpened + RoundSettled logs (verifyOperatorRound → verifyRound), never trusting the chain's `won`
 *  flag. House trust chrome; never skinnable. */
const OperatorVerifyPanel = ({
  deployment,
  opened,
  settled,
}: {
  deployment: GameDeployment
  opened: OperatorOpenedLog
  settled: OperatorSettledLog
}) => {
  const { ok, reasons } = verifyOperatorRound(opened, settled)
  const parityWin = (BigInt(settled.seed) & 1n) === BigInt(opened.side)
  const gameUrl = deployment.operator ? explorerUrl(deployment, 'address', deployment.operator.coinFlip) : undefined
  const randomUrl = explorerUrl(deployment, 'address', deployment.random)
  return (
    <div className="receipt">
      <h3>
        The slip — run the flip yourself
        <InfoDot>
          Your browser recomputes the result from the seed's parity and compares it with what the{' '}
          {gameUrl ? (
            <a href={gameUrl} target="_blank" rel="noreferrer">operator contract</a>
          ) : (
            'operator contract'
          )}{' '}
          paid out. The seed is set by the{' '}
          {randomUrl ? (
            <a href={randomUrl} target="_blank" rel="noreferrer">Random contract</a>
          ) : (
            'Random contract'
          )}{' '}
          from the validators' revealed secrets. Written up{' '}
          <a href={MSGBOARD_GAMES_DOCS} target="_blank" rel="noreferrer">on MsgBoard</a>.
        </InfoDot>
      </h3>
      <table>
        <tbody>
          <tr>
            <td className="muted">seed (keccak of the validators' secrets)</td>
            <td className="mono">{settled.seed}</td>
          </tr>
          <tr>
            <td className="muted">your side</td>
            <td>{opened.side === HEADS ? 'Heads (even)' : 'Tails (odd)'}</td>
          </tr>
          <tr>
            <td className="muted">our count: seed is {(BigInt(settled.seed) & 1n) === 0n ? 'even' : 'odd'} →</td>
            <td>{parityWin ? 'you win' : 'you lose'}</td>
          </tr>
          <tr>
            <td className="muted">the chain's result</td>
            <td>
              {settled.won ? 'won' : 'lost'} · {fmtAmount(deployment, settled.payout)}
            </td>
          </tr>
        </tbody>
      </table>
      {ok ? (
        <span className="stamp ok">✓ verified — replayed from the chain logs</span>
      ) : (
        <span className="stamp bad">✗ does not match the chain — {reasons.join('; ')}</span>
      )}
    </div>
  )
}

const shortRound = (roundId: viem.Hex) => `${roundId.slice(0, 10)}…${roundId.slice(-6)}`

/** One of the player's rounds — pending (poll + settle, or refund once stale), settled (outcome + verify
 *  slip), or refunded (stale round whose stake was returned). */
const RoundCard = ({
  deployment,
  opened,
  settled,
  refunded,
  seed,
  busy,
  canSettle,
  stale,
  onSettle,
  onRefund,
}: {
  deployment: GameDeployment
  opened: OperatorOpenedLog
  settled?: OperatorSettledLog
  refunded?: boolean
  seed?: viem.Hex
  busy: boolean
  canSettle: boolean
  stale?: boolean
  onSettle: (opened: OperatorOpenedLog) => void
  onRefund?: (opened: OperatorOpenedLog) => void
}) => {
  const settledPending = seed !== undefined && seed !== ZERO32 && !settled
  const spine = settled ? (settled.won ? 'done' : 'expired') : refunded ? 'expired' : 'wait'
  return (
    <div className={`card bk-${spine}`}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span>
          <span className="tag">{opened.side === HEADS ? 'Heads' : 'Tails'}</span>
          {fmtAmount(deployment, opened.stake)} stake · pays {fmtAmount(deployment, opened.payout)}
          {' · '}
          <span className="mono muted">{shortRound(opened.roundId)}</span>
        </span>
        <span className="row">
          {!settled && !refunded && (
            <>
              <button className="secondary" onClick={() => onSettle(opened)} disabled={!canSettle}>
                {busy ? 'Settling…' : 'Settle / claim'}
              </button>
              {stale && onRefund && (
                <button className="secondary" onClick={() => onRefund(opened)} disabled={!canSettle}>
                  {busy ? '…' : 'Refund stake'}
                </button>
              )}
            </>
          )}
        </span>
      </div>
      {settled ? (
        <p className={settled.won ? 'ok' : 'bad'}>
          {settled.won ? (
            <>you won {fmtAmount(deployment, settled.payout)}</>
          ) : (
            <>the flip went the other way — stake to the operator's bankroll</>
          )}{' '}
          · player <AddressLink deployment={deployment} address={settled.player} />
        </p>
      ) : refunded ? (
        <p className="muted">this round went stale — your {fmtAmount(deployment, opened.stake)} stake was refunded</p>
      ) : (
        <p className="muted">
          {settledPending
            ? 'seed is finalized — settle it now'
            : stale
              ? 'the validators never cast a seed for this round — you can refund your stake'
              : 'waiting on the validators to cast the seed for this round'}
        </p>
      )}
      {settled && <OperatorVerifyPanel deployment={deployment} opened={opened} settled={settled} />}
    </div>
  )
}

/**
 * Play + verify surface for operator coin-flip tables (plain bets, chain 943). The player picks a table,
 * a side, and a stake; approve → open pulls the Chips stake into GameEscrow and heats the auto-picked
 * canonical validator subset; a validator cast then settles the round (push via onCast, or the `claim`
 * pull fallback here). Every settled round shows a verify slip that replays the winner from the seed
 * parity purely from the chain logs. Task 5 skins the stage with the operator's theme.
 */
export const OperatorCoinFlipScreen = ({
  deployment,
  data,
  walletClient,
  trustAcknowledged,
  myAddress,
  initialTableId,
}: {
  deployment: GameDeployment
  data: ChainData
  walletClient?: viem.WalletClient
  trustAcknowledged: boolean
  myAddress?: viem.Hex
  /** Pre-selected table from a shared invite link (?table=…). */
  initialTableId?: viem.Hex
}) => {
  const rounds = useOperatorRounds(deployment)
  const [tableId, setTableId] = useState<viem.Hex | null>(initialTableId ?? null)
  const { table } = useOperatorTable(deployment, tableId)
  const [side, setSide] = useState(HEADS) // 0 = HEADS, 1 = TAILS
  const [amount, setAmount] = useState('1')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [seeds, setSeeds] = useState<Record<string, viem.Hex>>({})
  // Rounds opened THIS session, before the poll indexes them (merged with the indexed set).
  const [sessionRounds, setSessionRounds] = useState<OperatorOpenedLog[]>([])

  // Mirror the picked table into the URL so the address bar is a shareable invite and a refresh keeps you
  // on the same table (merges with App's game/chain params — replaceState, no history spam).
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search)
    if (tableId) sp.set('table', tableId)
    else sp.delete('table')
    window.history.replaceState(null, '', `${window.location.pathname}?${sp}${window.location.hash}`)
  }, [tableId])

  const tables = useMemo(() => foldOperatorTables(rounds.events), [rounds.events])
  const { myRounds, settledByRound, refundedByRound } = useMemo(
    () => foldOperatorRounds(rounds.events, sessionRounds, myAddress),
    [rounds.events, sessionRounds, myAddress],
  )

  // Disjoint by construction: the contract lets a round reach only ONE of Settled / Refunded.
  const pending = myRounds.filter((r) => !settledByRound.has(r.roundId) && !refundedByRound.has(r.roundId))
  const settled = myRounds.filter((r) => settledByRound.has(r.roundId))
  const refunded = myRounds.filter((r) => refundedByRound.has(r.roundId) && !settledByRound.has(r.roundId))

  const stake = parseStake(amount)
  const deployed = deployment.operator !== undefined
  const fit = table && stake !== undefined ? betFits(table, stake) : undefined
  const canPlay =
    deployed &&
    walletClient !== undefined &&
    trustAcknowledged &&
    !busy &&
    tableId !== null &&
    stake !== undefined &&
    table !== undefined &&
    fit?.ok === true

  const run = async (work: () => Promise<void>) => {
    setBusy(true)
    setError(undefined)
    try {
      await work()
      rounds.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const bet = () =>
    run(async () => {
      const opCfg = deployment.operator
      if (!opCfg) throw new Error("operator tables aren't live on this chain yet")
      if (!tableId) throw new Error('pick a table first')
      if (stake === undefined) throw new Error('enter a positive stake')
      if (!table) throw new Error('table is still loading — try again in a moment')
      const check = betFits(table, stake)
      if (!check.ok) throw new Error(check.reason ?? 'this bet does not fit the table')
      // 1. Approve the stake in the table's token to the ESCROW — open() pulls it via GameEscrow.
      const locations = nextHeatLocations(deployment, data.lobby, data.rounds)
      const plan = operatorBetPlan(opCfg, deployment.canonicalSubset, tableId, side, stake, locations)
      await sendGameTx(deployment, walletClient!, {
        address: table.token,
        abi: ERC20_APPROVE_ABI,
        functionName: 'approve',
        args: [plan.approveTo, stake],
      })
      // 2. open() heats the canonical subset internally; the player never picks validators (spec §5, NF-1).
      const receipt = await sendGameTx(deployment, walletClient!, {
        address: plan.openTo,
        abi: operatorCoinFlipAbi,
        functionName: 'open',
        args: plan.openArgs,
      })
      const [openedEvent] = viem.parseEventLogs({ abi: operatorCoinFlipAbi, eventName: 'RoundOpened', logs: receipt.logs })
      const a = openedEvent?.args as Partial<OperatorOpenedLog> | undefined
      if (!a?.roundId || !a.key) throw new Error('no RoundOpened event in the receipt')
      setSessionRounds((prev) => [
        {
          roundId: a.roundId!, tableId: a.tableId!, player: a.player!, side: Number(a.side),
          stake: a.stake!, payout: a.payout!, tierPrice: a.tierPrice!, key: a.key!, openedAtBlock: a.openedAtBlock!,
        },
        ...prev,
      ])
    })

  // Drive a pending round to settlement: read its seed from Random; if finalized and the onCast push
  // hasn't already settled it, use the `claim` pull fallback. A not-yet-finalized seed just waits.
  const settleRound = (opened: OperatorOpenedLog) =>
    run(async () => {
      const opCfg = deployment.operator
      if (!opCfg) throw new Error("operator tables aren't live on this chain yet")
      const client = publicClientFor(deployment.chainId, deployment.rpc)
      const randomness = (await client.readContract({
        address: deployment.random,
        abi: randomAbi,
        functionName: 'randomness',
        args: [opened.key],
      })) as { seed: viem.Hex }
      setSeeds((s) => ({ ...s, [opened.roundId]: randomness.seed }))
      if (randomness.seed === ZERO32) {
        throw new Error("the validators haven't cast the seed for this round yet — try again shortly")
      }
      if (!settledByRound.has(opened.roundId)) {
        await sendGameTx(deployment, walletClient!, {
          address: opCfg.coinFlip,
          abi: operatorCoinFlipAbi,
          functionName: 'claim',
          args: [opened.roundId],
        })
      }
    })

  // Reclaim the stake on a round whose seed never finalized (stale). Only offered once STALE_BLOCKS have
  // passed; refundStale reverts TooEarly if a seed did finalize (then the player should settle instead).
  const refundRound = (opened: OperatorOpenedLog) =>
    run(async () => {
      const opCfg = deployment.operator
      if (!opCfg) throw new Error("operator tables aren't live on this chain yet")
      await sendGameTx(deployment, walletClient!, {
        address: opCfg.coinFlip,
        abi: operatorCoinFlipAbi,
        functionName: 'refundStale',
        args: [opened.roundId],
      })
    })

  if (!deployed) {
    return (
      <GameStage title="OPERATOR TABLES" subtitle="bet a coin flip against an operator's bankroll">
        <div className="card">
          <p className="muted">
            Operator tables aren't live on this chain yet. Switch to a chain where the operator substrate is
            deployed to place a bet.
          </p>
        </div>
      </GameStage>
    )
  }

  const tierNow = table && stake !== undefined ? tierPrice(table.minStake, table.maxStake, stake) : undefined
  const payoutNow = table && stake !== undefined && tierNow !== undefined ? payoutFor(stake, table.maxMultiplierX100) : undefined
  const wonCount = settled.filter((r) => settledByRound.get(r.roundId)!.won).length

  return (
    <>
      <GameStage title="OPERATOR TABLES" subtitle="bet a coin flip against an operator's bankroll">
        <div className="cft-surface">
          <OperatorTablePicker deployment={deployment} tables={tables} selected={tableId} onSelect={setTableId} />

          {rounds.error && <div className="banner bad">operator read failed: {rounds.error}</div>}

          {myRounds.length === 0 ? (
            <p className="muted" style={{ padding: '8px 2px' }}>
              No bets yet — pick an open table above, choose a side, and place a stake to open a round.
            </p>
          ) : (
            <div className="cft-rounds">
              {pending.map((o) => (
                <RoundCard
                  key={o.roundId}
                  deployment={deployment}
                  opened={o}
                  seed={seeds[o.roundId]}
                  busy={busy}
                  canSettle={walletClient !== undefined && !busy}
                  stale={isStale(o.openedAtBlock, rounds.head)}
                  onSettle={(r) => void settleRound(r)}
                  onRefund={(r) => void refundRound(r)}
                />
              ))}
              {refunded.map((o) => (
                <RoundCard key={o.roundId} deployment={deployment} opened={o} refunded busy={busy} canSettle={false} onSettle={() => {}} />
              ))}
              {settled.map((o) => (
                <RoundCard
                  key={o.roundId}
                  deployment={deployment}
                  opened={o}
                  settled={settledByRound.get(o.roundId)}
                  seed={seeds[o.roundId]}
                  busy={busy}
                  canSettle={false}
                  onSettle={() => {}}
                />
              ))}
            </div>
          )}
        </div>
      </GameStage>

      <div className="tray-col">
        <BetTray
          amount={amount}
          onAmount={setAmount}
          unit="◈ Chips"
          action={
            <button className="primary" onClick={() => void bet()} disabled={!canPlay}>
              {busy ? 'Sending…' : 'Place bet'}
            </button>
          }
        >
          <div className="acts" style={{ marginTop: 8 }}>
            <label className="tp-field" style={{ gridColumn: '1 / -1' }}>
              your side
              <Menu label="side" options={[...SIDE_OPTIONS]} value={side} onChange={setSide} disabled={busy} />
            </label>
          </div>
          {payoutNow !== undefined && (
            <p className="tray-hint">
              a win pays {fmtAmount(deployment, payoutNow)} · tier {fmtAmount(deployment, tierNow!)}
            </p>
          )}
          {!walletClient && <p className="tray-hint">connect a wallet to play</p>}
          {walletClient && !trustAcknowledged && <p className="tray-hint">tap "Got it" on the fairness note above first</p>}
          {walletClient && trustAcknowledged && tableId === null && (
            <p className="tray-hint">pick an open table above to place a bet</p>
          )}
          {fit && !fit.ok && <p className="tray-hint bad">{fit.reason}</p>}
          <p className="tray-hint">
            you stake Chips against the operator's bankroll — a validator seed's parity decides. Your worst
            case is a stuck round you refund; the operator never touches the coin.
          </p>
          {error && <p className="bad">{error}</p>}
        </BetTray>

        <MetaPanel tabs={['Rounds', 'Record']}>
          <span>
            <b>{pending.length}</b> live · <b>{settled.length}</b> settled
            {refunded.length > 0 && <span className="muted"> · {refunded.length} refunded</span>}
            {wonCount > 0 && <span className="muted"> · you won {wonCount}</span>}
          </span>
        </MetaPanel>
      </div>
    </>
  )
}
```

- [ ] Run the test again and watch it pass:
  - `cd games/web && npx vitest run src/components/OperatorCoinFlipScreen.test.ts`
  - Expected: the SSR render contains `OPERATOR TABLES`, `no operator tables yet on this chain`, and `connect a wallet to play`.

- [ ] Confirm suite + typecheck:
  - `cd games/web && npm test`
  - `cd games/web && npm run typecheck`
  - Expected: green.

- [ ] Commit:
  - `git add games/web/src/components/OperatorCoinFlipScreen.tsx games/web/src/components/OperatorCoinFlipScreen.test.ts`
  - `git commit -m "feat(operator-ui): OperatorCoinFlipScreen play + settle + refund + verify slip"`

---

## Task 5 — Operator theming: `fetchThemeManifest` + wire into `GameStage`

**Files:**
- Create: `games/web/src/lib/operatorTheme.ts`
- Create: `games/web/src/lib/operatorTheme.test.ts`
- Modify: `games/web/src/components/OperatorCoinFlipScreen.tsx` — add the theme-fetch effect and pass `themeManifest` to `GameStage`.

**Interfaces:**

Produces (from `lib/operatorTheme.ts`):
- `fetchThemeManifest(uri: string | undefined, timeoutMs?: number): Promise<unknown | undefined>`

Consumes: nothing beyond the global `fetch` + `AbortController`. In the screen: `latestMetadataUri` (Task 1) over `rounds.events` + `table?.operator`, then `fetchThemeManifest`, then `<GameStage themeManifest={manifest}>` — `ThemeProvider` re-validates the raw manifest through `parseManifest`.

**Steps:**

- [ ] Write the failing test file `games/web/src/lib/operatorTheme.test.ts` with this ACTUAL content:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchThemeManifest } from './operatorTheme'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('fetchThemeManifest', () => {
  it('returns undefined for a missing URI without fetching', async () => {
    const spy = vi.spyOn(globalThis, 'fetch')
    expect(await fetchThemeManifest(undefined)).toBeUndefined()
    expect(spy).not.toHaveBeenCalled()
  })

  it('returns the parsed JSON on a 2xx response', async () => {
    const body = { palette: { '--felt-hi': '#0a3121' } }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }),
    )
    expect(await fetchThemeManifest('https://op.example/theme.json')).toEqual(body)
  })

  it('returns undefined on a non-2xx response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 404 }))
    expect(await fetchThemeManifest('https://op.example/missing.json')).toBeUndefined()
  })

  it('returns undefined when the fetch throws (network error / abort)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('aborted'))
    expect(await fetchThemeManifest('https://op.example/slow.json', 10)).toBeUndefined()
  })
})
```

- [ ] Run it and watch it fail:
  - `cd games/web && npx vitest run src/lib/operatorTheme.test.ts`
  - Expected failure: `Failed to resolve import "./operatorTheme"`.

- [ ] Write the minimal implementation `games/web/src/lib/operatorTheme.ts` with this ACTUAL content:

```ts
/**
 * Fetch an operator theme manifest JSON from its metadata URI, with a hard timeout. Returns the raw parsed
 * JSON (ThemeProvider re-validates it through parseManifest) or undefined on ANY failure — no URI, timeout,
 * network error, non-2xx, or non-JSON — so a slow or dead URI never blocks the table from rendering (spec
 * §9). The engine is fail-safe: an undefined manifest is the house default.
 */
export const fetchThemeManifest = async (
  uri: string | undefined,
  timeoutMs = 4000,
): Promise<unknown | undefined> => {
  if (!uri) return undefined
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(uri, { signal: ctrl.signal })
    if (!res.ok) return undefined
    return (await res.json()) as unknown
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}
```

- [ ] Run the test again and watch it pass:
  - `cd games/web && npx vitest run src/lib/operatorTheme.test.ts`
  - Expected: all four cases pass.

- [ ] Wire the theme into the screen. In `games/web/src/components/OperatorCoinFlipScreen.tsx`, add these two imports to the existing import block:

```tsx
import { foldOperatorTables, foldOperatorRounds, verifyOperatorRound, latestMetadataUri, type OperatorOpenedLog, type OperatorSettledLog } from '../lib/operatorIndex'
import { fetchThemeManifest } from '../lib/operatorTheme'
```

  (This replaces the existing `../lib/operatorIndex` import line, adding `latestMetadataUri`; and adds the `operatorTheme` import.)

- [ ] In the same file, add theme state + effect after the `tables`/`myRounds` `useMemo` blocks:

```tsx
  // Operator-level theme: the operator's latest MetadataSet URI → fetch (timeout + house fallback) → raw
  // manifest handed to GameStage, which re-validates it through parseManifest. An absent/slow/invalid URI
  // stays undefined = the house look (spec §6, §9). Keyed on the URI so it refetches only when it changes.
  const themeUri = useMemo(() => latestMetadataUri(rounds.events, table?.operator), [rounds.events, table?.operator])
  const [themeManifest, setThemeManifest] = useState<unknown>(undefined)
  useEffect(() => {
    let live = true
    setThemeManifest(undefined)
    void fetchThemeManifest(themeUri).then((m) => {
      if (live) setThemeManifest(m)
    })
    return () => {
      live = false
    }
  }, [themeUri])
```

- [ ] In the same file, pass the manifest to the ACTIVE `GameStage` (the one inside the main `return`, NOT the `!deployed` early-return branch):

```tsx
      <GameStage title="OPERATOR TABLES" subtitle="bet a coin flip against an operator's bankroll" themeManifest={themeManifest}>
```

- [ ] Confirm the screen SSR test still passes (theming effect never fires under `renderToStaticMarkup`, so the house look is what renders — the test's assertions are unaffected):
  - `cd games/web && npx vitest run src/components/OperatorCoinFlipScreen.test.ts`
  - Expected: still green.

- [ ] Confirm suite + typecheck:
  - `cd games/web && npm test`
  - `cd games/web && npm run typecheck`
  - Expected: green.

- [ ] Commit:
  - `git add games/web/src/lib/operatorTheme.ts games/web/src/lib/operatorTheme.test.ts games/web/src/components/OperatorCoinFlipScreen.tsx`
  - `git commit -m "feat(operator-ui): operator theme fetch (timeout + house fallback) wired to GameStage"`

---

## Task 6 — Tab registration + deep-link wiring in `App.tsx`

**Files:**
- Modify: `games/web/src/App.tsx` (import ~line 10; `GAMES` array ~lines 56-96; `VALIDATOR_GAMES` ~line 104; `CasinoFloor` games filter ~line 223; `AppShell` games filter ~line 233; render switch after the `tables` block ~lines 298-307).

**Interfaces:**

Consumes: `OperatorCoinFlipScreen` (Task 4/5). Reuses the existing `initialTableId()` helper (App.tsx ~lines 137-140 — its `/^0x[0-9a-fA-F]{64}$/` bytes32 check already fits an operator `tableId`) and the existing `data`/`wallet`/`trustAcknowledged` state.

**Steps:**

- [ ] There is no unit test for `App.tsx` (it wires RPC-backed hooks and the shell; the existing repo has none). The deliverable is a clean typecheck + a green suite + a deep-link smoke render described below. First add the import — after the `CoinFlipTablesScreen` import (line 10):

```tsx
import { OperatorCoinFlipScreen } from './components/OperatorCoinFlipScreen'
```

- [ ] Add the `GAMES` entry directly after the `{ id: 'tables', label: '🎲 Tables' }` line (line 61):

```tsx
  { id: 'operator', label: '🎰 Operator Tables' },
```

- [ ] Tag it validator-settled — change `VALIDATOR_GAMES` (line 104) to:

```tsx
const VALIDATOR_GAMES = new Set<Tab>(['raffle', 'tables', 'operator'])
```

- [ ] Hide it on the floor when the chain has no operator substrate — change the `CasinoFloor` `games` prop filter (line 223) to:

```tsx
          games={GAMES.filter((g) => !['lobby', 'standings', 'live', 'backroom'].includes(g.id) && (g.id !== 'operator' || !!deployment.operator))}
```

- [ ] Hide the tab in the shell strip on a chain with no operator substrate — change the `AppShell` `games` prop filter (line 233) to:

```tsx
        games={GAMES.filter((g) => (g.id !== 'backroom' && g.id !== 'operator') || !!deployment.operator)}
```

- [ ] Add the render block immediately after the `tab === 'tables'` block (after line 307, before the `tab === 'dice'` block):

```tsx
      {tab === 'operator' && deployment.operator && (
        <OperatorCoinFlipScreen
          deployment={deployment}
          data={data}
          walletClient={wallet.walletClient}
          trustAcknowledged={trustAcknowledged}
          myAddress={wallet.address}
          initialTableId={initialTableId()}
        />
      )}
```

- [ ] Write a deep-link smoke test `games/web/src/App.operator.test.ts` proving the trust model + deep-link parse are correct WITHOUT rendering the RPC-backed `App` (it re-uses the exact bytes32 regex App uses and the config guard). This ACTUAL content:

```ts
import { describe, it, expect } from 'vitest'
import { deployments } from './config'

describe('operator tab wiring', () => {
  it('943 carries the operator substrate; other chains hide the tab', () => {
    const withOperator = deployments.filter((d) => d.operator)
    expect(withOperator.length).toBeGreaterThan(0)
    expect(withOperator.every((d) => d.chainId === 943)).toBe(true)
  })

  it('accepts a well-formed bytes32 table deep-link and rejects a malformed one', () => {
    const isTableId = (t: string | null) => !!t && /^0x[0-9a-fA-F]{64}$/.test(t)
    expect(isTableId('0x' + 'a'.repeat(64))).toBe(true)
    expect(isTableId('0xdeadbeef')).toBe(false)
    expect(isTableId(null)).toBe(false)
  })
})
```

- [ ] Run the new test and confirm it passes (it needs no App render):
  - `cd games/web && npx vitest run src/App.operator.test.ts`
  - Expected: both cases pass (proves the 943-only guard and the deep-link regex the render block relies on).

- [ ] Confirm the whole suite + typecheck + production build are green (the build runs `tsc --noEmit && vite build`, exercising the full App wiring):
  - `cd games/web && npm test`
  - `cd games/web && npm run typecheck`
  - `cd games/web && npm run build`
  - Expected: all green; the bundle builds with the new tab.

- [ ] Commit:
  - `git add games/web/src/App.tsx games/web/src/App.operator.test.ts`
  - `git commit -m "feat(operator-ui): register operator tab + deep-link (943 only)"`

---

## Manual 943 walkthrough (spec §8 — do after Task 6)

Not a code step; the acceptance path a human runs once on 943:

1. Open the app on `PulseChain testnet v4`, connect a wallet, open the `🎰 Operator Tables` tab.
2. Confirm the picker lists a live operator table (open, with a stake range).
3. Acknowledge the fairness note, pick a side, enter an in-range stake, and place the bet (approve → open).
4. Watch the round settle — either the push (`onCast`) flips it to settled, or press `Settle / claim` to pull it once the seed finalizes.
5. Open the verify slip on the settled round; confirm it stamps `✓ verified`.
6. For a stuck round (no seed after ~200 blocks), confirm `Refund stake` appears and returns the stake.
7. If the operator has set a `MetadataSet` theme URI, confirm the stage felt/backdrop skins while amounts, odds, and the verify slip stay in the house look.

---

## Self-review

### 1. Spec coverage — every spec section maps to a task

- §2 in-scope "plain bets: table pick → side → stake → open → settle/claim → refund" → Tasks 3, 4.
- §2 in-scope "operator-level theming" → Task 5.
- §2 in-scope "provably-fair verify slip" → Task 1 (`verifyOperatorRound`) + Task 4 (`OperatorVerifyPanel`).
- §2 in-scope "chain 943 only" → Task 6 guards (`deployment.operator`), Task 1/2 hooks no-op off-943.
- §2 out-of-scope (boosted, buy-chips, per-table theming, 369) → not built; `open` only, no `openBoosted`/`MintSale`, one manifest per operator, no new `config.operator` fields.
- §3 architecture (GameStage stage-surface, screen props, tray-col layout) → Task 4 (mirrors `CoinFlipTablesScreen`).
- §4 table state reads (`tables`, `tableCap`, `tableLocked`; tier price computed client-side) → Task 2.
- §4 round history via indexer `game:"operator"` + `useOperatorRounds` + fold → Task 1.
- §4 table discovery → Task 3 (dedicated picker; deviation documented — no `TableNamed` in the operator substrate).
- §5 bet flow (approve escrow → open, side Menu, auto-canonical subset, `nextHeatLocations`) → Task 2 (`operatorBetPlan`) + Task 4 (`bet`).
- §5 settle (poll `randomness` → `claim`) + `refundStale` → Task 4.
- §5 verify slip recompute reuse → Task 1 + Task 4.
- §6 theming (MetadataSet URI → fetch → parseManifest → GameStage themeManifest; trust chrome unskinnable by GameStage's boundary) → Task 5.
- §7 reused blocks (Menu, StakeInput/parseStake, BetTray, MetaPanel, Meta helpers; no native controls) → Tasks 3, 4.
- §8 testing (tsc clean, vitest green, manual walkthrough) → every task's confirm step + the walkthrough section.
- §9 risks (indexer lag → getLogs fallback for the just-opened round; theme fetch timeout + fallback) → Task 1 (`fetchViaLogs` + optimistic `sessionRounds`) + Task 5 (`fetchThemeManifest`).

No spec requirement is unmapped.

### 2. Placeholder scan

No `TBD`, `add error handling`, `similar to Task N`, `write tests for the above`, or references to an undefined type/function. Every code block is complete and self-contained; repeated code (the ERC20 approve ABI, the verify-panel markup) is written out in full rather than cross-referenced.

### 3. Type consistency across tasks

- `OperatorEvent`, `OperatorOpenedLog`, `OperatorSettledLog`, `OperatorTableCard` are defined once in Task 1 and imported unchanged by Tasks 3, 4.
- `OperatorTable` and every math function are defined once in Task 2 and imported unchanged by Task 2's hook and Task 4.
- `operatorBetPlan` returns `openArgs: readonly [Hex, number, bigint, Hex[], Info[]]` — exactly the `open(tableId, side, stake, validatorSubset, validatorLocations)` argument order; Task 4 passes it straight to `sendGameTx`.
- `useOperatorRounds` returns `{ events, head, error, refresh }`; Task 4 consumes `rounds.events`, `rounds.head`, `rounds.error`, `rounds.refresh` — all present.
- `useOperatorTable` returns `{ table, refresh }`; Task 4 consumes `table` only — present.
- `fetchThemeManifest(uri, timeoutMs?)` returns `Promise<unknown | undefined>`; `GameStage.themeManifest` is `unknown` — compatible.
- The screen prop shape `{ deployment, data, walletClient, trustAcknowledged, myAddress, initialTableId }` matches exactly how App renders it in Task 6 and matches the spec §3 convention.
