# On-Chain Session Settlement — Dice Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take one game (Dice) end-to-end through real on-chain escrowed settlement — escrow chips at open, play one co-signed roll off-chain over MsgBoard, settle on-chain, index the result, show one activity row — proving the whole pipeline against the already-deployed `Chips`/`HouseChannel` on PulseChain 943.

**Architecture:** Board-only transport: the house is a key-holding MsgBoard watcher; player and house exchange co-signed `SessionState` halves over a per-table board category. Escrowed backend (`HouseChannel`): house reviews `OpenTerms`, locks `escrowHouse`, settle pays from escrow, `dispute`/forfeit guarantees the player's principal against a dead/malicious house. Reuses `@gibs/msgboard-games` (`HouseSession`, RNG, `Transcript`) and `@gibs/msgboard-settle` (`EscrowedSettlement`, `signOpenTerms`) unchanged; the new work is a split co-signing exchange, a deployed house process, web wiring, and an indexer extension.

**Tech Stack:** TypeScript, viem 2.x, `@gibs/msgboard-games`, `@gibs/msgboard-settle`, Ponder 0.16 (indexer), Vite+React (web), Foundry/Hardhat (contracts, already written), Vitest (tests).

**Spec:** `docs/superpowers/specs/2026-06-18-onchain-session-settlement-dice-slice-design.md`

## Global Constraints

- **Backend is Escrowed `HouseChannel`** (settlementMode `1`); `EscrowedSettlement` throws if mode ≠ 1.
- **One roll per table** for this slice: open → exactly one `playRound` → settle. `chainLength = 1`, final state is nonce `1`.
- **Board-only transport.** Player↔house co-signing rides the board; no HTTP house API. PoW grind stays in a Web Worker on the browser (never the main thread — enforced by `board.ts`'s guard).
- **Deployed addresses (943):** Chips `0xA5276259e544C86438566cB28cc87daCce060910`, HouseBankroll `0xf1781f82745604281227C6CeC26176C2464cb0D1`, HouseChannel `0x57876609E4fEDDEeB83e46A1b3A20140998f0e46`. CoinFlip/Raffle (already indexed) untouched.
- **One testnet house identity** holds the contract owner key (mint/fund/setHouseKey) AND is the co-signer registered via `setHouseKey`. Supplied via env/secret; never posted. Cold/hot split is deferred.
- **Indexer is Ponder `^0.16.6`** (`chains`/`chain`/`id`/`rpc`, `ordering: 'omnichain'`, explicit `src/api/index.ts`). Register handlers with `ponder.on(...)` as a method — never a detached alias (loses `this` → empty registry).
- **Chips are a mintable ERC20** (`Chips.mint` is owner-only); the faucet mints, the house treasury is minted + `fundHouse`'d.
- **EIP-712 `verifyingContract` = HouseChannel address** for `SessionState` and `OpenTerms` (replaces the web's `PLACEHOLDER_VERIFIER`).
- **Web is viem-only** (no ethers); follow the existing `examples/games/web` patterns.

---

## File structure

**`gibsfinance/random` (branch `games-platform`):**
- `examples/games/msgboard-games/src/escrow.ts` (new) — pure Dice escrow sizing.
- `examples/games/msgboard-games/src/coSignTransport.ts` (new) — split co-signing over a `Transport`.
- `examples/games/house-service/` (new package `@gibs/games-house-service`) — `src/openReview.ts`, `src/houseLoop.ts`, `src/faucet.ts`, `src/index.ts`, `package.json`.
- `examples/games/web/src/hooks/useSession.ts` (modify) — board co-sign to the house; real `verifyingContract`.
- `examples/games/web/src/components/DiceScreen.tsx` (modify) — chips/faucet, open, settle, status.
- `examples/games/web/src/hooks/useGamesActivity.ts` (new) — read the indexer.
- `examples/games/web/src/components/ActivityRow.tsx` (new) — minimal Dice settlements list.
- `examples/games/web/src/config.ts` (modify) — `chips`, `houseChannel`, `houseKey` (public addr) per deployment.
- `packages/contracts/scripts/configure-house.ts` (new) — one-time config + faucet helper.

**`valve-tech/msgboard`:**
- `deploy/games-indexer/abis.ts` (modify) — add `houseChannelAbi`.
- `deploy/games-indexer/ponder.config.ts` (modify) — add `HouseChannel` contract.
- `deploy/games-indexer/ponder.schema.ts` (modify) — add `settlement` table.
- `deploy/games-indexer/src/index.ts` (modify) — `HouseChannel` handlers + join.
- `.github/workflows/games-deploy.yml` (modify) — `house-service` deploy mode + `configure-house` mode.

---

### Task 1: Dice escrow sizing (pure helper)

**Files:**
- Create: `examples/games/msgboard-games/src/escrow.ts`
- Test: `examples/games/msgboard-games/test/escrow.test.ts`
- Modify: `examples/games/msgboard-games/src/index.ts` (export `./escrow`)

**Interfaces:**
- Consumes: `EDGE_BPS` (from `./game`), the Dice rules' multiplier via `settleRound` semantics (roll-under target → `multiplierX100`).
- Produces:
  - `diceMaxMultiplierX100(params: { targetX100: bigint }): bigint` — the win multiplier (hundredths) for a roll-under target, with the 1% edge.
  - `escrowFor(stake: bigint, multiplierX100: bigint): { escrowPlayer: bigint; escrowHouse: bigint }` — `escrowPlayer = stake`, `escrowHouse = stake*(multiplierX100-100n)/100n`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { diceMaxMultiplierX100, escrowFor } from '../src/escrow'

describe('dice escrow sizing', () => {
  it('a 50% roll-under target pays ~1.98x after the 1% edge', () => {
    // fair = 100/50 = 2.00x; with EDGE_BPS=100 → 0.99 * 2.00 = 1.98x → 198 (hundredths)
    expect(diceMaxMultiplierX100({ targetX100: 5000n })).toBe(198n)
  })

  it('escrowHouse covers exactly the player win above their own stake', () => {
    const { escrowPlayer, escrowHouse } = escrowFor(1_000n, 198n)
    expect(escrowPlayer).toBe(1_000n)        // player brings their stake
    expect(escrowHouse).toBe(980n)           // 1000 * (198-100)/100 = 980
    // total locked 1980 == stake * 1.98x; on a win the player can take all of it
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @gibs/msgboard-games test escrow`
Expected: FAIL — `Cannot find module '../src/escrow'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// examples/games/msgboard-games/src/escrow.ts
import { EDGE_BPS } from './game'

/** Roll-under win multiplier (hundredths) for target t (in hundredths-of-a-percent, targetX100):
 *  fair = 100% / t%, scaled to hundredths and reduced by the house edge. */
export function diceMaxMultiplierX100(params: { targetX100: bigint }): bigint {
  // targetX100 is hundredths of a percent: 50.00% => 5000. winChance = targetX100 / 10000.
  // fair multiplier = 1/winChance = 10000/targetX100 (in x); in hundredths-of-x: *100.
  // So fairX100 = 100 * 10000 / targetX100. Then apply the edge: * (10000-EDGE_BPS)/10000.
  const fairX100 = (100n * 10_000n) / params.targetX100 // 5000 -> 200 (== 2.00x)
  return (fairX100 * (10_000n - EDGE_BPS)) / 10_000n     // 200 * 9900/10000 = 198 (== 1.98x)
}

export function escrowFor(stake: bigint, multiplierX100: bigint): { escrowPlayer: bigint; escrowHouse: bigint } {
  return { escrowPlayer: stake, escrowHouse: (stake * (multiplierX100 - 100n)) / 100n }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @gibs/msgboard-games test escrow`
Expected: PASS (2 tests). If `diceMaxMultiplierX100(5000)` ≠ `198n`, reconcile against the real Dice rules module (`src/games/dice.ts` `settleRound`) and adjust the formula + the test's expected value together so they match the on-chain/​rules math exactly.

- [ ] **Step 5: Export + commit**

Add `export * from './escrow'` to `examples/games/msgboard-games/src/index.ts`.
```bash
git add examples/games/msgboard-games/src/escrow.ts examples/games/msgboard-games/src/index.ts examples/games/msgboard-games/test/escrow.test.ts
git commit -m "feat(games): dice escrow sizing helper"
```

---

### Task 2: House open-review (build + sign + verify OpenTerms; decline out-of-band)

**Files:**
- Create: `examples/games/house-service/src/openReview.ts`
- Create: `examples/games/house-service/package.json` (deps: `@gibs/msgboard-games`, `@gibs/msgboard-settle`, `viem`, `vitest`)
- Test: `examples/games/house-service/test/openReview.test.ts`

**Interfaces:**
- Consumes: `escrowFor`, `diceMaxMultiplierX100` (Task 1); `signOpenTerms`, `verifyOpenTermsSig`, `OpenTerms` (`@gibs/msgboard-settle`); `makeSettleDomain` (`@gibs/msgboard-settle`); `StateSigner`/`GameDomain` (`@gibs/msgboard-games`).
- Produces:
  - `type OpenRequest = { tableId: Hex; player: Hex; playerKey: Hex; gameId: number; targetX100: bigint; stake: bigint; rngCommit: Hex; clientSeed: Hex }`
  - `type Limits = { maxEscrowHouse: bigint; minTargetX100: bigint; clockBlocks: bigint; expiryBlocks: bigint }`
  - `reviewOpen(req: OpenRequest, ctx: { houseKey: StateSigner; domain: GameDomain; headBlock: bigint; limits: Limits }): Promise<{ ok: true; terms: OpenTerms; houseSig: Hex } | { ok: false; reason: string }>`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { makeSettleDomain, verifyOpenTermsSig } from '@gibs/msgboard-settle'
import { reviewOpen } from '../src/openReview'

const HOUSE = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d')
const houseKey = { signTypedData: (a: any) => HOUSE.signTypedData(a), signMessage: (a: any) => HOUSE.signMessage(a) } as any
const domain = makeSettleDomain(943, '0x57876609E4fEDDEeB83e46A1b3A20140998f0e46')
const limits = { maxEscrowHouse: 10n ** 24n, minTargetX100: 100n, clockBlocks: 120n, expiryBlocks: 300n }
const baseReq = {
  tableId: ('0x' + '11'.repeat(32)) as `0x${string}`,
  player: '0x000000000000000000000000000000000000dEaD' as `0x${string}`,
  playerKey: '0x000000000000000000000000000000000000bEEF' as `0x${string}`,
  gameId: 0, targetX100: 5000n, stake: 1_000n,
  rngCommit: ('0x' + '22'.repeat(32)) as `0x${string}`,
  clientSeed: ('0x' + '33'.repeat(32)) as `0x${string}`,
}

describe('reviewOpen', () => {
  it('grants in-band terms the player can verify against the house key', async () => {
    const r = await reviewOpen(baseReq, { houseKey, domain, headBlock: 1000n, limits })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.terms.escrowPlayer).toBe(1_000n)
    expect(r.terms.escrowHouse).toBe(980n)
    expect(r.terms.gameId).toBe(0)
    expect(await verifyOpenTermsSig(HOUSE.address, domain, r.terms, r.houseSig)).toBe(true)
  })

  it('declines a target below the min (escrow would blow the cap)', async () => {
    const r = await reviewOpen({ ...baseReq, targetX100: 1n, stake: 10n ** 21n }, { houseKey, domain, headBlock: 1000n, limits })
    expect(r.ok).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @gibs/games-house-service test openReview`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// examples/games/house-service/src/openReview.ts
import type { Hex } from 'viem'
import type { GameDomain, StateSigner } from '@gibs/msgboard-games'
import { diceMaxMultiplierX100, escrowFor } from '@gibs/msgboard-games'
import { signOpenTerms, type OpenTerms } from '@gibs/msgboard-settle'

export type OpenRequest = {
  tableId: Hex; player: Hex; playerKey: Hex; gameId: number
  targetX100: bigint; stake: bigint; rngCommit: Hex; clientSeed: Hex
}
export type Limits = { maxEscrowHouse: bigint; minTargetX100: bigint; clockBlocks: bigint; expiryBlocks: bigint }

export async function reviewOpen(
  req: OpenRequest,
  ctx: { houseKey: StateSigner; domain: GameDomain; headBlock: bigint; limits: Limits },
): Promise<{ ok: true; terms: OpenTerms; houseSig: Hex } | { ok: false; reason: string }> {
  if (req.targetX100 < ctx.limits.minTargetX100) return { ok: false, reason: 'target below minimum' }
  if (req.stake <= 0n) return { ok: false, reason: 'non-positive stake' }
  const { escrowPlayer, escrowHouse } = escrowFor(req.stake, diceMaxMultiplierX100({ targetX100: req.targetX100 }))
  if (escrowHouse > ctx.limits.maxEscrowHouse) return { ok: false, reason: 'escrow exceeds house cap' }
  const terms: OpenTerms = {
    tableId: req.tableId, player: req.player, playerKey: req.playerKey,
    escrowPlayer, escrowHouse, gameId: req.gameId, rngCommit: req.rngCommit,
    clockBlocks: ctx.limits.clockBlocks, expiry: ctx.headBlock + ctx.limits.expiryBlocks,
  }
  const houseSig = await signOpenTerms(ctx.houseKey, ctx.domain, terms)
  return { ok: true, terms, houseSig }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @gibs/games-house-service test openReview`
Expected: PASS (2 tests). If `OpenTerms` field names/types differ, copy them verbatim from `@gibs/msgboard-settle/src/openTerms.ts`.

- [ ] **Step 5: Commit**

```bash
git add examples/games/house-service/package.json examples/games/house-service/src/openReview.ts examples/games/house-service/test/openReview.test.ts
git commit -m "feat(house-service): open-review — size escrow, sign or decline OpenTerms"
```

---

### Task 3: Board co-signing exchange (the split-signing foundation)

The existing `HouseSession` co-signs with **both** keys in-process. Split play needs each side to sign only its own half and exchange over a `Transport`. This task adds a thin exchange so the house service and the browser produce a transcript **bit-identical** to the in-process `HouseSession` — the property `@gibs/msgboard-settle`'s `replaySession` depends on.

**Files:**
- Create: `examples/games/msgboard-games/src/coSignTransport.ts`
- Test: `examples/games/msgboard-games/test/coSignTransport.test.ts`
- Modify: `examples/games/msgboard-games/src/index.ts` (export `./coSignTransport`)

**Interfaces:**
- Consumes: `HouseSession`, `SessionState`, `SessionConfig`, `Transport` (`send`/`poll` + a message sink), `Transcript`, `verifyFinishedSession` (`@gibs/msgboard-games`).
- Produces:
  - `runHouseSide<TParams>(cfg: SessionConfig<TParams>, transport: CoSignTransport, play: PlayInput<TParams>): Promise<string>` — drives open + one round as the house, requesting the player's half over the transport; returns the retained transcript JSON.
  - `runPlayerSide<TParams>(cfg: Omit<SessionConfig, 'house'> & { houseRemote: true }, transport: CoSignTransport): Promise<string>` — the browser counterpart: verifies + signs its half on each request.
  - `type CoSignTransport = { request(stateNoSig: SessionState): Promise<Hex>; serve(sign: (s: SessionState) => Promise<Hex>): void }` — abstracts the board round-trip; tests supply an in-memory pair.

- [ ] **Step 1: Write the failing test** (parity with in-process HouseSession)

```ts
import { describe, it, expect } from 'vitest'
import { HouseSession, verifyFinishedSession, runHouseSide, runPlayerSide } from '../src'
import { memoryCoSignPair, fixedDiceConfig } from './helpers' // helper builds two SessionConfigs + a linked transport pair

describe('co-sign over transport', () => {
  it('produces a transcript that verifies like the in-process session', async () => {
    const { houseCfg, playerCfg, houseT, playerT, play, ctx } = fixedDiceConfig()
    const [transcriptJson] = await Promise.all([
      runHouseSide(houseCfg, houseT, play),
      runPlayerSide(playerCfg, playerT),
    ])
    expect(await verifyFinishedSession(transcriptJson, ctx)).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @gibs/msgboard-games test coSignTransport`
Expected: FAIL — `runHouseSide` not exported.

- [ ] **Step 3: Write minimal implementation**

Implement `runHouseSide`/`runPlayerSide` by wrapping `HouseSession` with a **remote player signer**: the house holds its own key locally and, wherever the in-process session would call the player signer, it instead `transport.request(state)`s the player's signature; the player side `serve`s by verifying the proposed state transition (recompute via the same rules + seed reveal, exactly as `HouseSession.playRound` verifies) and returning its EIP-712 half. Build the `Transcript` identically (same OPEN/ROUND envelopes, same `gameStateHash`) so `replaySession` accepts it. Keep the helper (`test/helpers.ts`) in-memory: `request`/`serve` resolve through a shared queue, no board.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @gibs/msgboard-games test coSignTransport`
Expected: PASS. The transcript must satisfy `verifyFinishedSession` (chain links, both EIP-712 co-signatures, seed-reveal chain, recomputed outcome). If it fails on signature mismatch, the proposed-state bytes the player signs must be byte-identical to what the house signs — assert both halves recover to the right addresses before debugging higher.

- [ ] **Step 5: Commit**

```bash
git add examples/games/msgboard-games/src/coSignTransport.ts examples/games/msgboard-games/src/index.ts examples/games/msgboard-games/test/coSignTransport.test.ts examples/games/msgboard-games/test/helpers.ts
git commit -m "feat(games): split co-signing over a transport (transcript-parity with HouseSession)"
```

---

### Task 4: House service process (board watcher + faucet)

**Files:**
- Create: `examples/games/house-service/src/houseLoop.ts`, `src/faucet.ts`, `src/index.ts`
- Test: `examples/games/house-service/test/houseLoop.test.ts`

**Interfaces:**
- Consumes: `reviewOpen` (Task 2); `runHouseSide` + `CoSignTransport` (Task 3); `createBoardClient`, `MsgBoardTransport`, `makeSeedChain` (`@gibs/msgboard-games`); `Chips` mint via viem wallet client.
- Produces:
  - `startHouse(cfg: { boardRpc: string; chainId: number; houseChannel: Hex; houseKey: StateSigner; account: Account; limits: Limits }): { stop(): void }`
  - `faucetMint(opts: { walletClient; chips: Hex; to: Hex; amount: bigint; cap: bigint }): Promise<Hex>` — owner-mints up to `cap`.

- [ ] **Step 1: Write the failing test** (house answers an open-request with a grant, over a mock board)

```ts
import { describe, it, expect } from 'vitest'
import { handleOpenRequest } from '../src/houseLoop'
// handleOpenRequest is the pure unit startHouse calls per board message: (req, ctx) -> grant | decline envelope
it('answers a valid open-request with a signed grant envelope', async () => {
  const env = await handleOpenRequest(/* baseReq from Task 2 */, /* ctx with houseKey/domain/headBlock/limits/seedChain */)
  expect(env.kind).toBe('open-grant')
  expect(env.terms.escrowHouse).toBe(980n)
  expect(env.houseSig).toMatch(/^0x/)
})
```

- [ ] **Step 2: Run test to verify it fails** — module not found. `pnpm --filter @gibs/games-house-service test houseLoop`.

- [ ] **Step 3: Write minimal implementation**

`handleOpenRequest`: make a `makeSeedChain(length=1)` → `rngCommit`, call `reviewOpen`, return an `open-grant {terms, houseSig, rngCommit}` or `open-decline {reason}` envelope. `startHouse`: open a `MsgBoardTransport` on the per-table category pattern `games.msgboard.xyz:table:<chainId>:<tableId>`, poll; on `open-request` → `handleOpenRequest` → post grant; on the player's first round → `runHouseSide` to co-sign + reveal and post the result; post the OPEN anchor to `games.msgboard.xyz:lobby:<chainId>`. `faucetMint`: `writeContract` `Chips.mint(to, min(amount, cap))`.

- [ ] **Step 4: Run test to verify it passes** — `pnpm --filter @gibs/games-house-service test houseLoop`. Expected PASS.

- [ ] **Step 5: Commit**

```bash
git add examples/games/house-service/src/houseLoop.ts examples/games/house-service/src/faucet.ts examples/games/house-service/src/index.ts examples/games/house-service/test/houseLoop.test.ts
git commit -m "feat(house-service): board-watcher loop (open-grant, round co-sign, reveal) + faucet"
```

---

### Task 5: Contract configuration script

**Files:**
- Create: `packages/contracts/scripts/configure-house.ts`
- Test: `packages/contracts/test/configure-house.test.ts` (anvil-fork or simulate-only)

**Interfaces:**
- Consumes: deployed `Chips`/`HouseChannel` ABIs + addresses; an owner wallet client.
- Produces: `configureHouse(opts: { walletClient; chips: Hex; channel: Hex; houseKey: Hex; treasury: bigint; fund: bigint }): Promise<{ setHouseKey: Hex; mint: Hex; fund: Hex }>` (returns tx hashes).

- [ ] **Step 1: Write the failing test** — simulate the three calls succeed against a fork where the signer is owner; assert `HouseChannel.houseKey() == houseKey` and channel Chips balance increased by `fund`.

- [ ] **Step 2: Run** `pnpm --filter @gibs/contracts test configure-house` → FAIL.

- [ ] **Step 3: Implement** `configureHouse`: `simulateContract`+`writeContract` for `setHouseKey(houseKey)`, `Chips.mint(account, treasury)`, `Chips.approve(channel, fund)` (if `fundHouse` pulls), `HouseChannel.fundHouse(fund)`; wait for receipts.

- [ ] **Step 4: Run** → PASS.

- [ ] **Step 5: Commit** `git commit -m "feat(contracts): configure-house script (setHouseKey, mint, fundHouse)"`.

---

### Task 6: Web — split co-sign in `useSession` + real verifyingContract

**Files:**
- Modify: `examples/games/web/src/hooks/useSession.ts`
- Modify: `examples/games/web/src/config.ts` (add `chips`, `houseChannel` per deployment)
- Test: `examples/games/web/test/useSession.coSign.test.ts`

**Interfaces:**
- Consumes: `runPlayerSide` + `CoSignTransport` (Task 3); `MsgBoardTransport` over the Web Worker board client; `config.deployment.houseChannel`.
- Produces: `useSession` opens a board co-sign session against the house (no in-browser house key), `verifyingContract = deployment.houseChannel`, exposes `{ open(), play(), settleReady, transcript }`.

- [ ] **Step 1: Write the failing test** — drive `runPlayerSide` against an in-memory house (Task 3 helper) and assert the player retains a transcript whose `verifyingContract` equals the configured `houseChannel` and that `verifyFinishedSession` passes.
- [ ] **Step 2: Run** `pnpm --filter @gibs/games-web test useSession.coSign` → FAIL.
- [ ] **Step 3: Implement** — replace the ephemeral house signer + `PLACEHOLDER_VERIFIER` with: a board `CoSignTransport` (post to `…:table:<chain>:<tableId>`, poll for the house's halves; grind in the Worker), `verifyingContract = deployment.houseChannel`, and `runPlayerSide`. Keep the existing return shape the screens use.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(games-web): useSession co-signs with the real house over the board"`.

---

### Task 7: Web — Dice open + settle + status (DiceScreen)

**Files:**
- Modify: `examples/games/web/src/components/DiceScreen.tsx`
- Test: `examples/games/web/test/diceSettle.test.ts`

**Interfaces:**
- Consumes: `EscrowedSettlement.buildOpen`/`buildSettle` (`@gibs/msgboard-settle`); `useSession` (Task 6); `sendGameTx`; `faucet` request; `Chips`/`HouseChannel` ABIs.
- Produces: Dice screen flow — faucet → `approve` → `open(terms, houseSig)` → play one roll → `buildSettle(transcript)` → `settle()`; a per-table status indicator (`playing → settle-pending → landed`).

- [ ] **Step 1: Write the failing test** — given a finished transcript fixture, `EscrowedSettlement.buildSettle` yields a `settle` `TxRequest` whose `args[0]` (final state) has nonce `1` and the player's won balance; assert the screen calls `writeContract` with it.
- [ ] **Step 2: Run** `pnpm --filter @gibs/games-web test diceSettle` → FAIL.
- [ ] **Step 3: Implement** the flow + status UI (reuse the existing screen scaffolding; grind/PoW in the Worker; "stamping…" state for the board tail).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(games-web): Dice escrowed open + on-chain settle + status"`.

---

### Task 8: Indexer — HouseChannel events + join (msgboard repo)

**Files:**
- Modify: `deploy/games-indexer/abis.ts` (add `houseChannelAbi as const`), `ponder.config.ts`, `ponder.schema.ts`, `src/index.ts`
- Test: `deploy/games-indexer/test/settlementJoin.test.ts`

**Interfaces:**
- Consumes: live `HouseChannel` `Opened`/`Settled` logs.
- Produces: a `settlement` onchainTable `{ id, tableId, game, player, escrowPlayer, payoutPlayer, net, blockNumber, blockTimestamp, txHash }`; `Opened` inserts the open row (game from `gameId`, player, escrow), `Settled` updates it with payout + net.

- [ ] **Step 1: Write the failing test** — feed an `Opened` then a `Settled` for the same `tableId`; assert one joined row with `game='dice'`, `player`, `payoutPlayer`, `net = payoutPlayer - escrowPlayer`.
- [ ] **Step 2: Run** the indexer test → FAIL.
- [ ] **Step 3: Implement** — add `HouseChannel` to `ponder.config.ts` (`chain: 'pulsechainV4'`, `abi: houseChannelAbi`, address `0x5787…`, `startBlock`); `ponder.on('HouseChannel:Opened', …)` inserts keyed by `tableId` (map `gameId→'dice'`), `ponder.on('HouseChannel:Settled', …)` updates the row. **Register via `ponder.on(...)` as a method.**
- [ ] **Step 4: Run** → PASS. Then `mode=games-indexer` deploy; verify GraphQL `settlements` serves at `games.msgboard.xyz/games-indexer/graphql`.
- [ ] **Step 5: Commit** (msgboard repo) `git commit -m "feat(games-indexer): index HouseChannel Opened/Settled into joined settlement rows"`.

---

### Task 9: Web — activity row + 943 E2E (happy + dispute)

**Files:**
- Create: `examples/games/web/src/hooks/useGamesActivity.ts`, `examples/games/web/src/components/ActivityRow.tsx`
- Modify: `examples/games/web/src/components/DiceScreen.tsx` (mount the row)
- Test: `examples/games/web/test/activity.test.ts`; `examples/games/house-service/test/e2e.943.test.ts` (gated, opt-in)

**Interfaces:**
- Consumes: the indexer `settlements` GraphQL (Task 8); `config.deployment.gamesIndexer`.
- Produces: `useGamesActivity(deployment)` → recent Dice settlements; `ActivityRow` renders `player · stake · payout · net · when · tx`.

- [ ] **Step 1: Write the failing test** — mock the GraphQL response; assert `ActivityRow` renders the player (shortened), `fmtAmount` stake/payout (with `v4PLS`), and the explorer tx link.
- [ ] **Step 2: Run** `pnpm --filter @gibs/games-web test activity` → FAIL.
- [ ] **Step 3: Implement** the hook (GraphQL POST, same shape as `useChainData.fetchViaIndexer`) + the row component; mount under the Dice screen.
- [ ] **Step 4: Run** → PASS. Then the **gated E2E** on 943: configure-house → start house-service → faucet → open → one roll → settle → assert a `settlements` row appears; and a **dispute path** test: house withholds the round result → player `dispute()` → assert `DisputeForfeited` makes the player whole.
- [ ] **Step 5: Commit + deploy** — `git commit -m "feat(games-web): Dice activity row from the indexer + 943 e2e"`; deploy house-service (`mode=house-service`), run `configure-house`, redeploy web + indexer.

---

## Self-review notes (for the executor)
- **Spec coverage:** Task 1 ↔ §7 escrow; Tasks 2–4 ↔ §5.1 house service + §5.3 faucet + §6 flow; Task 5 ↔ §5.2 config; Tasks 6–7 ↔ §5.4 web wiring + §6 settle/dispute; Task 8 ↔ §5.6 indexing; Task 9 ↔ §5.7 activity + §11 E2E (incl. dispute). §5.5 board categories are realized in Tasks 4 & 6.
- **The riskiest task is Task 3** (transcript parity for split co-signing). Do it before any deployed piece; everything downstream depends on `replaySession` accepting the transcript. If `HouseSession` cannot be cleanly wrapped with a remote signer, the fallback is a small protocol module that builds the same OPEN/ROUND envelopes directly — but prove parity with `verifyFinishedSession` either way before moving on.
- **One-roll-per-table** keeps escrow exact (Task 1) and the final state at nonce 1 (Tasks 3, 7). Don't generalize to multi-roll in this slice.
