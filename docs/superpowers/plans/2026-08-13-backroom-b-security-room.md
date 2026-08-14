# Backroom-B Security-Room Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the operator's read-only "security room" — one live view of every table, in-flight round (positions only), bankroll, exposure vs cap, and the settle/forfeit tape.

**Architecture:** Extend the existing Ponder indexer with the operator contracts (943 only), add a pure `backroomIndex` reducer and a `useBackroomData` hook that mirror the proven `tablesIndex`/`useChainData` patterns, and render a new full-page `backroom` tab in games/web. Views are truth, events are history; the two are reconciled on screen. The information-leak boundary — no outcome material before seed finality — is enforced at the type level, the reducer level, and the indexer level.

**Tech Stack:** Ponder (indexer, TypeScript), viem, React + Vite (games/web), vitest (unit), Playwright (browser).

**Spec:** `docs/superpowers/specs/2026-08-13-backroom-b-security-room-design.md`

## Global Constraints

- Read-only only. Backroom-B never sends a transaction. No wallet write path, no write ABI entries wired to buttons.
- Leak boundary (spec §5): pre-seed (`randomness(key).seed == 0`) the dashboard may show only fields already published by `RoundOpened` (tableId, player, side, stake, payout, tierPrice, key, openedAtBlock) plus derived age/exposure. It must NEVER show, store, or derive per-round validator identity/subset, reveal progress, revealed preimages, or a computed outcome before the seed finalizes. Outcome render point = seed-finalized "decided — settling" (D2).
- Headroom formula (spec §2.2): `available = tableCap == 0 ? bankrollOf : min(tableCap − tableLocked, bankrollOf)`. `bankrollOf` is already net of locked — never subtract `locked` again.
- 943 only. 369 has no operator substrate; the tab is hidden when the chain's config has no operator address. Chain-config-driven, addresses from `943-operator-substrate.json` / `config.ts`.
- Indexer must include the 5 retired OperatorCoinFlip addresses (spec G7) at their own start blocks, or history silently begins at the latest redeploy.
- House UI rules: `Menu`/`Toggle` only (no native select/checkbox); table.css brass / Fraunces / Spline-mono design; heavy work off the main thread; text wraps, never clips.
- Live addresses (943): OperatorCoinFlip `0x0c80607ec07999cdab97d4374d6b7a3b5a6f1833`, GameEscrow `0xb572481635904fe2e3957bc45d81be07337e0838`, OperatorRegistry `0xb202144ed8f2ae1c8a6262c241714c171b039cbc`, DefaultValidatorPolicy `0xe821380fee740210a51503ec086c4ba3074cb63e`, Random `0x775AF72d62c85d2F7f0Bcc05BAa4Be0830087217`. deployBlock 25121394. Retired: `0x360f22c4…`, `0xbb9bc6851998bc979889a6d31c1994160a219d04`, `0xb22ad173ee0ca5f9a3d36dc647d67bafa0e49e87`, `0x30b855799990fa9c2d0dff461bfb905a269efe8e`, `0xc3a4edb9601b55df3e25893a4e28971883a4b475`.

---

## File Structure

- `games/indexer/ponder.config.ts` (modify) — add OperatorCoinFlip (+ retired), GameEscrow, OperatorRegistry, DefaultValidatorPolicy on `pulsechainV4` only.
- `games/indexer/ponder.schema.ts` (modify) — extend the `game` column comment; no new table (reuse `gameEvent`).
- `games/indexer/src/index.ts` (modify) — extend the `store` game union with `'operator'`; register the operator/escrow/registry/policy handlers.
- `games/indexer/src/contracts/abis.ts` (create) — import the 4 operator ABIs from the compiled artifacts (matches the existing FlipBook/Sudoku artifact-import pattern).
- `games/web/src/lib/backroomIndex.ts` (create) — pure reducer: events → `{ tables, pit, tape, treasury, incidents }`. The leak boundary lives in the `PitRound` type.
- `games/web/src/lib/backroomIndex.test.ts` (create) — reducer unit tests + the leak-boundary red-team test.
- `games/web/src/hooks/useBackroomData.ts` (create) — indexer GraphQL + getLogs fallback + multicall spot-reads, mirroring `useChainData`.
- `games/web/src/components/BackroomScreen.tsx` (create) — the page shell + panel composition.
- `games/web/src/components/backroom/*.tsx` (create) — one file per panel group (Floor, Treasury, Pit, Tape, Meters, Reconciliation, Alerts).
- `games/web/src/App.tsx` (modify) — register the `backroom` tab (full-page set) and render it; hide when unconfigured.
- `games/web/src/config.ts` (modify) — add operator addresses + operator deployBlock + retired list to the 943 entry.

---

## Task 1: Indexer — index the operator contracts (943)

**Files:**
- Create: `games/indexer/src/contracts/abis.ts`
- Modify: `games/indexer/ponder.config.ts`, `games/indexer/ponder.schema.ts`, `games/indexer/src/index.ts`

**Interfaces:**
- Produces: `gameEvent` rows with `game: 'operator'` and `name` ∈ {`TableCreated`, `OpenSet`, `ValidatorPolicySet`, `TableCapSet`, `FeesDeposited`, `FeesWithdrawn`, `RoundOpened`, `RoundSettled`, `RoundRefunded`, `ForfeitRouted`, `BankrollDeposited`, `BankrollWithdrawn`, `ExposureLocked`, `Settled`, `Refunded`, `RakeWithdrawn`, `Registered`, `RakeSet`, `RakeRecipientSet`, `MetadataSet`, `ConfigSet`}. Args are JSON with bigints as decimal strings (existing `store` behaviour).

- [ ] **Step 1: Create the ABI import module**

`games/indexer/src/contracts/abis.ts` — mirror the existing artifact-import pattern (`ponder.config.ts` already imports `SudokuLog`/`FlipBook` artifacts directly):

```typescript
import type { Abi } from 'viem'
import OperatorCoinFlip from '../../contracts/artifacts/contracts/games/operator/OperatorCoinFlip.sol/OperatorCoinFlip.json'
import GameEscrow from '../../contracts/artifacts/contracts/games/operator/GameEscrow.sol/GameEscrow.json'
import OperatorRegistry from '../../contracts/artifacts/contracts/games/operator/OperatorRegistry.sol/OperatorRegistry.json'
import DefaultValidatorPolicy from '../../contracts/artifacts/contracts/games/operator/DefaultValidatorPolicy.sol/DefaultValidatorPolicy.json'

export const operatorCoinFlipAbi = OperatorCoinFlip.abi as Abi
export const gameEscrowAbi = GameEscrow.abi as Abi
export const operatorRegistryAbi = OperatorRegistry.abi as Abi
export const defaultValidatorPolicyAbi = DefaultValidatorPolicy.abi as Abi
```

Verify the artifact paths exist first: `ls games/indexer/contracts/artifacts/contracts/games/operator/`. If the indexer's `contracts/artifacts` symlink does not carry the operator artifacts, add the import from `@msgboard/games-core` operator exports instead (games-core re-exports `./operator`); confirm the exported ABI names with `grep -rn "export" games/core/src/operator`.

- [ ] **Step 2: Add the contracts to `ponder.config.ts` (943 only)**

Add constants near the other address blocks and four entries to `contracts`. 369 is intentionally absent (no operator substrate there). Retired games share the ABI; give each its own start block (all ≤ 25121394 — find each with `cast code --rpc-url $RPC <addr>` binary search, or use 25000000 as a safe floor and document it). Use `startBlock: 25_121_394` for the live game and the earliest retired block for the retired ones.

```typescript
import { operatorCoinFlipAbi, gameEscrowAbi, operatorRegistryAbi, defaultValidatorPolicyAbi } from './src/contracts/abis'

const OP_COINFLIP_943 = '0x0c80607ec07999cdab97d4374d6b7a3b5a6f1833'
const OP_ESCROW_943 = '0xb572481635904fe2e3957bc45d81be07337e0838'
const OP_REGISTRY_943 = '0xb202144ed8f2ae1c8a6262c241714c171b039cbc'
const OP_POLICY_943 = '0xe821380fee740210a51503ec086c4ba3074cb63e'
const OP_START_943 = 25_121_394
// Retired game addresses hold real history (spec G7). One address list; earliest deploy block floor.
const OP_COINFLIP_RETIRED_943 = [
  '0x360f22c4b6b0a31cbff91226f20f557dbd0a6353',
  '0xbb9bc6851998bc979889a6d31c1994160a219d04',
  '0xb22ad173ee0ca5f9a3d36dc647d67bafa0e49e87',
  '0x30b855799990fa9c2d0dff461bfb905a269efe8e',
  '0xc3a4edb9601b55df3e25893a4e28971883a4b475',
] as const
const OP_RETIRED_START_943 = 25_000_000 // floor below the first retired deploy; documented, not genesis
```

Ponder allows an array of addresses for one contract with a single startBlock. Register the live game and the retired games as two contract entries (`OperatorCoinFlip`, `OperatorCoinFlipRetired`) so the live one can start at its exact block and the retired ones at the floor:

```typescript
    OperatorCoinFlip: {
      abi: operatorCoinFlipAbi,
      network: { pulsechainV4: { address: OP_COINFLIP_943, startBlock: OP_START_943 } },
    },
    OperatorCoinFlipRetired: {
      abi: operatorCoinFlipAbi,
      network: { pulsechainV4: { address: [...OP_COINFLIP_RETIRED_943], startBlock: OP_RETIRED_START_943 } },
    },
    GameEscrow: {
      abi: gameEscrowAbi,
      network: { pulsechainV4: { address: OP_ESCROW_943, startBlock: OP_START_943 } },
    },
    OperatorRegistry: {
      abi: operatorRegistryAbi,
      network: { pulsechainV4: { address: OP_REGISTRY_943, startBlock: OP_START_943 } },
    },
    DefaultValidatorPolicy: {
      abi: defaultValidatorPolicyAbi,
      network: { pulsechainV4: { address: OP_POLICY_943, startBlock: OP_START_943 } },
    },
```

- [ ] **Step 3: Extend the `store` game union and the schema comment**

In `ponder.schema.ts`, update the `game` column comment to include `'operator'`. In `src/index.ts`, change the `store` signature:

```typescript
const store =
  (game: 'coinflip' | 'raffle' | 'flipbook' | 'operator', name: string) =>
```

- [ ] **Step 4: Register the operator handlers**

Append to `src/index.ts` (contract names must match `ponder.config.ts`; the frontend filters by the `game` column, so the `Settled`/`Refunded`/`RoundOpened`/`Revealed` name overlaps with other games are safe):

```typescript
// Operator substrate (943 only): the game, the shared escrow, the registry, the validator policy.
for (const c of ['OperatorCoinFlip', 'OperatorCoinFlipRetired']) {
  on(`${c}:TableCreated`, store('operator', 'TableCreated'))
  on(`${c}:OpenSet`, store('operator', 'OpenSet'))
  on(`${c}:ValidatorPolicySet`, store('operator', 'ValidatorPolicySet'))
  on(`${c}:TableCapSet`, store('operator', 'TableCapSet'))
  on(`${c}:FeesDeposited`, store('operator', 'FeesDeposited'))
  on(`${c}:FeesWithdrawn`, store('operator', 'FeesWithdrawn'))
  on(`${c}:RoundOpened`, store('operator', 'RoundOpened'))
  on(`${c}:RoundSettled`, store('operator', 'RoundSettled'))
  on(`${c}:RoundRefunded`, store('operator', 'RoundRefunded'))
  on(`${c}:ForfeitRouted`, store('operator', 'ForfeitRouted'))
}
on('GameEscrow:BankrollDeposited', store('operator', 'BankrollDeposited'))
on('GameEscrow:BankrollWithdrawn', store('operator', 'BankrollWithdrawn'))
on('GameEscrow:ExposureLocked', store('operator', 'ExposureLocked'))
on('GameEscrow:Settled', store('operator', 'Settled'))
on('GameEscrow:Refunded', store('operator', 'Refunded'))
on('GameEscrow:RakeWithdrawn', store('operator', 'RakeWithdrawn'))
on('OperatorRegistry:Registered', store('operator', 'Registered'))
on('OperatorRegistry:RakeSet', store('operator', 'RakeSet'))
on('OperatorRegistry:RakeRecipientSet', store('operator', 'RakeRecipientSet'))
on('OperatorRegistry:MetadataSet', store('operator', 'MetadataSet'))
on('DefaultValidatorPolicy:ConfigSet', store('operator', 'ConfigSet'))
```

IMPORTANT leak-boundary check: do NOT register any Random reveal/cast handler and do NOT add a table that stores per-round reveal progress (spec §5 rule 2). This step indexes only the game/escrow/registry/policy events above.

- [ ] **Step 5: Codegen + typecheck**

Run: `cd games/indexer && npx ponder codegen && npx tsc --noEmit`
Expected: PASS (types generated for the new contracts, no errors).

- [ ] **Step 6: Commit**

```bash
git add games/indexer/
git commit -m "feat(backroom-b): index operator substrate contracts on 943 (game/escrow/registry/policy + retired)"
```

---

## Task 2: Web — the `backroomIndex` reducer (pure logic, TDD)

**Files:**
- Create: `games/web/src/lib/backroomIndex.ts`, `games/web/src/lib/backroomIndex.test.ts`

**Interfaces:**
- Consumes: raw event rows `{ name: string; args: Record<string, any>; blockNumber: bigint }` (bigints re-hydrated from the indexer's decimal strings by the hook in Task 4).
- Produces:
  - `type PitRound` — SAFE-PRE ONLY. Fields: `roundId: Hex; tableId: Hex; player: Address; side: number; stake: bigint; payout: bigint; tierPrice: bigint; openedAtBlock: bigint`. NO `seed`, NO `won`, NO `validators`, NO `reveal*`. This type IS the leak boundary.
  - `type TapeEntry` — POST-ONLY. `{ kind: 'settled' | 'refunded' | 'forfeit'; roundId: Hex; tableId: Hex; blockNumber: bigint; won?: boolean; payout?: bigint; seed?: Hex; forfeit?: bigint }`.
  - `type OperatorTableView` — `{ tableId: Hex; operator: Address; token: Address; open: boolean; cap: bigint; locked: bigint; inFlight: number; lastActiveBlock: bigint; validatorPolicy?: Address }`.
  - `type Treasury` — `{ token: Address; bankroll: bigint; locked: bigint; rake: bigint; fees: bigint }` (bankroll/locked/rake/fees filled by the hook's view reads, not the reducer; the reducer supplies the history lanes).
  - `reduceBackroom(events, opts: { seedFinalized: (roundId: Hex) => boolean }): { tables: OperatorTableView[]; pit: PitRound[]; tape: TapeEntry[] }` — the `pit` contains only rounds with no terminal event AND `!seedFinalized(roundId)`; a round whose seed has finalized moves out of `pit` (the hook supplies `seedFinalized` from its per-round seed spot-read).

- [ ] **Step 1: Write the failing tests**

`games/web/src/lib/backroomIndex.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { reduceBackroom, type PitRound } from './backroomIndex'

const R = '0xround1' as const
const T = '0xtable1' as const
const P = '0xplayer1' as const

const opened = { name: 'RoundOpened', blockNumber: 100n, args: {
  roundId: R, tableId: T, player: P, side: 1, stake: 10n, payout: 18n, tierPrice: 10n, key: '0xkey', openedAtBlock: 100n } }
const created = { name: 'TableCreated', blockNumber: 90n, args: {
  tableId: T, operator: '0xop', token: '0xtok', maxMultiplierX100: 180, minStake: 1n, maxStake: 100n } }
const capSet = { name: 'TableCapSet', blockNumber: 91n, args: { tableId: T, cap: 1000n } }
const exposed = { name: 'ExposureLocked', blockNumber: 100n, args: { betId: R, operator: '0xop', token: '0xtok', player: P, stake: 10n, payout: 18n } }
const settled = { name: 'RoundSettled', blockNumber: 112n, args: { roundId: R, tableId: T, player: P, won: true, payout: 18n, seed: '0xseed' } }
const forfeit = { name: 'ForfeitRouted', blockNumber: 112n, args: { roundId: R, operator: '0xop', token: '0xtok', forfeit: 10n } }
const refunded = { name: 'RoundRefunded', blockNumber: 112n, args: { roundId: R, tableId: T, player: P, stake: 10n } }

const noSeed = () => false
const seeded = () => true

describe('reduceBackroom', () => {
  it('surfaces an open round in the pit with positions only', () => {
    const { pit } = reduceBackroom([created, capSet, opened, exposed], { seedFinalized: noSeed })
    expect(pit).toHaveLength(1)
    const r = pit[0]
    expect(r.roundId).toBe(R)
    expect(r.stake).toBe(10n)
    expect(r.payout).toBe(18n)
  })

  it('LEAK BOUNDARY: a pit round carries no outcome, seed, or validator field', () => {
    const { pit } = reduceBackroom([created, opened, exposed], { seedFinalized: noSeed })
    const keys = Object.keys(pit[0] as Record<string, unknown>)
    for (const forbidden of ['seed', 'won', 'validators', 'validatorSubset', 'reveal', 'reveals', 'revealCount', 'outcome', 'result'])
      expect(keys).not.toContain(forbidden)
  })

  it('removes a round from the pit once its seed finalizes', () => {
    const { pit } = reduceBackroom([created, opened, exposed], { seedFinalized: seeded })
    expect(pit).toHaveLength(0)
  })

  it('moves a settled round to the tape and drops it from the pit', () => {
    const { pit, tape } = reduceBackroom([created, opened, exposed, settled], { seedFinalized: seeded })
    expect(pit).toHaveLength(0)
    expect(tape.some((e) => e.kind === 'settled' && e.roundId === R && e.won === true)).toBe(true)
  })

  it('tracks a forfeit on the tape', () => {
    const { tape } = reduceBackroom([created, opened, exposed, refunded, forfeit], { seedFinalized: seeded })
    expect(tape.some((e) => e.kind === 'forfeit' && e.forfeit === 10n)).toBe(true)
  })

  it('counts in-flight rounds per table and clears on terminal', () => {
    const before = reduceBackroom([created, capSet, opened, exposed], { seedFinalized: noSeed })
    expect(before.tables[0].inFlight).toBe(1)
    const after = reduceBackroom([created, capSet, opened, exposed, settled], { seedFinalized: seeded })
    expect(after.tables[0].inFlight).toBe(0)
  })

  it('carries table cap and open flag', () => {
    const { tables } = reduceBackroom([created, capSet], { seedFinalized: noSeed })
    expect(tables[0].cap).toBe(1000n)
    expect(tables[0].open).toBe(true)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd games/web && npx vitest run src/lib/backroomIndex.test.ts`
Expected: FAIL (module not found / reduceBackroom undefined).

- [ ] **Step 3: Implement `backroomIndex.ts`**

Mirror `tablesIndex.ts` structure. The `PitRound` type must not declare any outcome field. Build `tables` (Map by tableId), `pit` (Map by roundId, deleted on terminal or when `seedFinalized(roundId)`), `tape` (append terminal events). `inFlight` = count of pit rounds per table. Terminal events: `RoundSettled`, `RoundRefunded` (and `ForfeitRouted` annotates the matching refund/round). Sort tables by open+inFlight+lastActiveBlock. Keep it pure — no fetches, no view reads.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd games/web && npx vitest run src/lib/backroomIndex.test.ts`
Expected: PASS (all 7).

- [ ] **Step 5: Commit**

```bash
git add games/web/src/lib/backroomIndex.ts games/web/src/lib/backroomIndex.test.ts
git commit -m "feat(backroom-b): pure backroomIndex reducer with leak boundary in the PitRound type"
```

---

## Task 3: Web — the leak-boundary red-team test

**Files:**
- Modify: `games/web/src/lib/backroomIndex.test.ts`

**Interfaces:**
- Consumes: `reduceBackroom`, `PitRound` from Task 2.

- [ ] **Step 1: Write the red-team test**

Add a test that serializes the ENTIRE pit projection (deep) and asserts absence of every forbidden substring, defending against a nested field a shallow key check would miss:

```typescript
it('RED TEAM: the full serialized pit projection leaks no outcome material', () => {
  const events = [
    { name: 'TableCreated', blockNumber: 90n, args: { tableId: T, operator: '0xop', token: '0xtok', maxMultiplierX100: 180, minStake: 1n, maxStake: 100n } },
    { name: 'RoundOpened', blockNumber: 100n, args: { roundId: R, tableId: T, player: P, side: 1, stake: 10n, payout: 18n, tierPrice: 10n, key: '0xkey', openedAtBlock: 100n } },
    { name: 'ExposureLocked', blockNumber: 100n, args: { betId: R, operator: '0xop', token: '0xtok', player: P, stake: 10n, payout: 18n } },
  ]
  const { pit } = reduceBackroom(events, { seedFinalized: () => false })
  const blob = JSON.stringify(pit, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)).toLowerCase()
  for (const forbidden of ['seed', 'won', 'validator', 'reveal', 'preimage', 'outcome', 'result', 'winner'])
    expect(blob.includes(forbidden)).toBe(false)
})
```

- [ ] **Step 2: Run + verify pass** — `cd games/web && npx vitest run src/lib/backroomIndex.test.ts` → PASS. (If `key` or any field trips a substring, the reducer must rename/drop it; the pit must not carry the round `key` if a validator secret can be tied to it — drop `key` from `PitRound`.)

- [ ] **Step 3: Commit** — `git commit -am "test(backroom-b): red-team leak-boundary assertion over the full pit projection"`

---

## Task 4: Web — the `useBackroomData` hook

**Files:**
- Create: `games/web/src/hooks/useBackroomData.ts`

**Interfaces:**
- Consumes: `reduceBackroom` (Task 2); chain config (Task 8 adds operator addresses).
- Produces: `useBackroomData(operator: Address): { tables, pit, tape, treasury, reconciliation, status: 'live'|'degraded'|'loading', lastBlock: bigint }`.

- [ ] **Step 1: Implement the hook** mirroring `useChainData.ts` (read it first): indexer GraphQL query for `gameEvent where game = 'operator'` when `cfg.gamesIndexer` is set, else chunked `getLogs` from operator `deployBlock` (POLL_MS 12000, MAX_RANGE 10000n, accumulate-only cache keyed by chain). Re-hydrate bigint args. Each poll also multicalls the spot-truth views: `bankrollOf`/`lockedOf`/`rakeOf`/`feeBalance` (escrow+game), per-table `tableCap`/`tableLocked`/`tables`, per-pit-round `randomness(key).seed != 0` (to drive `seedFinalized`), and `Random.balanceOf(game, token)`. Pass `seedFinalized` into `reduceBackroom`. Compute the reconciliation deltas (event-derived vs view). Set `status: 'degraded'` on indexer failure with getLogs fallback, `'loading'` before first paint.

- [ ] **Step 2: Typecheck** — `cd games/web && npx tsc --noEmit` → PASS.

- [ ] **Step 3: Commit** — `git add games/web/src/hooks/useBackroomData.ts && git commit -m "feat(backroom-b): useBackroomData hook (indexer + getLogs fallback + spot-truth views)"`

---

## Task 5: Web — config + tab wiring

**Files:**
- Modify: `games/web/src/config.ts`, `games/web/src/App.tsx`

**Interfaces:**
- Produces: `cfg.operator?: { coinFlip: Address; escrow: Address; registry: Address; policy: Address; deployBlock: string; retired: Address[] }` on the 943 entry only; a `backroom` tab.

- [ ] **Step 1: Add operator config to the 943 entry** in `config.ts` (369 entry omits it → tab hidden). Populate from the Global Constraints addresses.

- [ ] **Step 2: Register the tab** in `App.tsx`: add `{ id: 'backroom', label: '🎥 Backroom' }` to `GAMES`; add `'backroom'` to the full-page set (line ~105: `tab === 'live' || tab === 'standings' || tab === 'lobby' || tab === 'backroom'`); exclude it from the games grid (line ~220 filter); render `{tab === 'backroom' && cfg.operator && <BackroomScreen deployment={deployment} operator={wallet.address} />}`. Hide the tab entirely when `!cfg.operator` (guard the `GAMES` entry or filter the tab list by config).

- [ ] **Step 3: Typecheck + commit** — `npx tsc --noEmit` → PASS; `git commit -am "feat(backroom-b): backroom tab + operator config (943 only, hidden when unconfigured)"`

---

## Task 6: Web — BackroomScreen shell + Floor overview + Treasury + Meters (SAFE-PRE panels)

**Files:**
- Create: `games/web/src/components/BackroomScreen.tsx`, `games/web/src/components/backroom/FloorOverview.tsx`, `.../Treasury.tsx`, `.../ExposureMeters.tsx`

**Interfaces:**
- Consumes: `useBackroomData` (Task 4); house `Menu`/`Toggle` components; table.css classes.

- [ ] **Step 1: Build the shell** — full-page, non-immersive layout (page scroll, not the immersive HUD). Operator selector via house `Menu` (default connected wallet). Loading → skeleton tiles, never blank. Compose the panels.
- [ ] **Step 2: FloorOverview** — grid of table tiles: token, open/closed, stake ladder, multiplier, cap, `locked`, headroom (`available` formula), in-flight count, policy summary, last-activity age. All SAFE-PRE.
- [ ] **Step 3: Treasury** — per (operator, token): bankroll ("idle / withdrawable"), locked ("escrowed payouts — includes player stakes"), rake, feeBalance, deposit/withdraw/rake history lane, "rounds of fee runway" = `feeBalance ÷ (3 × top tierPrice)`.
- [ ] **Step 4: ExposureMeters** — per table `tableLocked / tableCap` bar (uncapped = "∞"), plus shared-pool bar Σ exposure vs bankroll. Uses the corrected `available` formula.
- [ ] **Step 5: Playwright acceptance** — screenshot the populated + empty + loading states; assert the headroom number equals `available` for a seeded fixture. Commit: `git add games/web/src/components && git commit -m "feat(backroom-b): floor/treasury/meters panels (SAFE-PRE)"`

---

## Task 7: Web — The Pit + Alerts lane (SAFE-PRE, positions only)

**Files:**
- Create: `games/web/src/components/backroom/Pit.tsx`, `.../AlertsLane.tsx`

- [ ] **Step 1: Pit** — one row per `PitRound`: table, player, side, stake, payout, exposure, tierPrice, age in blocks with a countdown to `STALE_BLOCKS=200`, status lamp `pending → decided — settling → (off board)`. Render STRICTLY from `PitRound` — the type carries no outcome field, so a leak is a compile error. No reveal progress, no cohort, no predicted result, no per-round Random drill-down.
- [ ] **Step 2: AlertsLane** (pinned) — round age ≥ STALE_BLOCKS with no seed; seed finalized but unsettled beyond N blocks; cap ≥ 90%; fee runway < K; idle bankroll below one max-tier exposure; reconciliation drift; indexer stale. Each fires on liveness/capacity facts only.
- [ ] **Step 3: Playwright + a component test** asserting the rendered Pit DOM for a Pending fixture contains no outcome text. Commit: `git commit -am "feat(backroom-b): the pit + alerts lane (positions only)"`

---

## Task 8: Web — Settlement tape + Incident panel + P&L (POST-ONLY)

**Files:**
- Create: `games/web/src/components/backroom/Tape.tsx`, `.../Incidents.tsx`, `.../PnL.tsx`

- [ ] **Step 1: Tape** — live feed of `TapeEntry` (settled/refunded/forfeit), newest first, cursor-paged, full detail (seed OK here — POST-ONLY).
- [ ] **Step 2: Incidents** — per table/window: forfeit count + volume, plain-timeout vs chop-routed refunds, rounds past stale with no seed, policy-change history. Validator attribution deferred (spec C5).
- [ ] **Step 3: PnL** — win/loss volume, rake accrued, forfeit income, net P&L per token over selectable windows (house `Menu` for the window).
- [ ] **Step 4: Playwright + commit** — `git commit -am "feat(backroom-b): settlement tape + incidents + P&L (POST-ONLY)"`

---

## Task 9: Web — Reconciliation strip + degraded/empty states

**Files:**
- Create: `games/web/src/components/backroom/Reconciliation.tsx`

- [ ] **Step 1: Reconciliation strip** — event-derived `tableLocked` vs view; event-derived escrow ledger vs `bankrollOf + lockedOf + rakeOf`; `Random.balanceOf(game, token)` vs Σ `feeBalance`; indexer head vs RPC head. Green ticks or a loud amber drift badge. Never silently correct.
- [ ] **Step 2: Degraded/empty states** — "degraded — reading chain directly" badge on indexer fallback; stale-data badge with last-good block on RPC hiccups; unregistered-operator onboarding; zero-tables and zero-fee-pool states.
- [ ] **Step 3: Reconciliation unit test** — feed a fixture with injected drift; assert amber, never silent correction. Commit: `git commit -am "feat(backroom-b): reconciliation strip + degraded/empty states"`

---

## Task 10: Browser verification (house rule)

- [ ] **Step 1: Playwright screenshots** of every state — loading, degraded, empty, populated, drift — wallet-gated states DOM-injected (games-ui QA pattern). Assert no native form controls (Menu/Toggle only), no horizontal body scroll, text wraps.
- [ ] **Step 2: Commit** any snapshot fixtures — `git commit -am "test(backroom-b): playwright screenshots of every dashboard state"`

---

## Task 11: Live-943 proof

- [ ] **Step 1: Deploy the indexer** via the ansible runbook (never ad-hoc) so `games.msgboard.xyz/games-indexer/graphql` serves the operator rows. Confirm op session first (`timeout 15 op read op://valve/valve_deployer/pk >/dev/null && echo OK || echo HUNG`).
- [ ] **Step 2: Source-log parity** — assert the indexer's operator event count matches a direct `eth_getLogs` sweep from block 25121394 (including retired addresses).
- [ ] **Step 3: Live proof against the QA harness** — run `cd games/e2e && MODE=all … npx tsx scripts/qa-operator-coinflip.ts` while the dashboard watches. Assert: the pit shows the QA rounds in flight with NO outcome; after settlement the tape shows the settle and the `ForfeitRouted`; the meters match `operator-ops.ts status` (now that C3 is fixed). Use the valve RPC (`op item get 'valve city unlimited key' …`), not the public RPC (bogus gas price).
- [ ] **Step 4: Commit the proof log + any config** — `git commit -m "chore(backroom-b): live-943 proof — pit shows positions-only, tape shows settle+forfeit, meters match CLI"`

---

## Self-Review

- **Spec coverage:** §2 data sources → Task 1 (indexer) + Task 4 (views). §3 architecture → Tasks 1,4,5. §4 panels → Tasks 6,7,8,9. §5 leak boundary → Tasks 1 (no reveal storage), 2 (PitRound type), 3 (red team), 7 (compile-safe render). §6 error/empty/scale → Task 9. §7 testing → Tasks 2,3,9,10,11. All covered.
- **Placeholder scan:** logic tasks (1–4) carry real code; UI tasks (6–9) carry precise data contracts + Playwright acceptance rather than inlined JSX, following the codebase's own component patterns (build reads table.css + existing screens). No "TBD"/"handle edge cases".
- **Type consistency:** `PitRound`/`TapeEntry`/`OperatorTableView`/`Treasury`/`reduceBackroom` defined in Task 2 and consumed by 4,6,7,8 with matching names. `available` formula identical across Global Constraints, Task 6, spec §2.2.
- **Leak boundary is enforced three ways** (indexer never stores reveal progress; the type has no outcome field; the red-team test), so a regression fails at build or test, not in production.
