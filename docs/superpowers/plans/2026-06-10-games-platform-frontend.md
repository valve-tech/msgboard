# Games Platform — Web Front End Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first real player-facing surface for the games platform: a web application over `@gibs/games-core` where a player can connect a wallet, see the trust disclosure, enter a coin flip or a raffle using canonical presets, watch the round progress live, and — the differentiating feature — verify the draw themselves with the same off-chain `settle` the parity gate proved equals the contract.

**Architecture:** The web app is a thin shell, exactly as the spec demands: every chain read goes through `@gibs/games-core` bindings, every game rule goes through `@gibs/coinflip` / `@gibs/raffle` pure methods, and the app adds only (a) a pure, fully-tested view-model layer that derives screen state from contract events, and (b) dumb React components over that layer. No game arithmetic is reimplemented in the app. The fairness story is surfaced as a product feature: a "verify this draw" panel recomputes the winner client-side from the on-chain seed and entries and shows it beside the on-chain result.

**Tech Stack:** Vite + React 18 + TypeScript (ESM), viem ^2 only for wallet/chain access (injected provider via `viem.custom(window.ethereum)` — no wagmi, no extra wallet kit; the core is viem-first and the app stays that way), vitest + @testing-library/react for the model and hook layers. Chains: anvil/local (31337) and PulseChain testnet v4 (943) through the core registry.

**Prerequisites:** Plan 2 complete (it is): `@gibs/games-core`, `@gibs/coinflip`, `@gibs/raffle`, and the e2e package exist and pass. Contracts compiled. `anvil` installed for local development.

**Repository note:** Code lives in `gibsfinance/random` branch `games-platform`, local path `~/Documents/gibs-finance/random`. The new app lives under `examples/games/web/`. The plan and progress records live in this msgboard repo (`progress.txt` is the single worklog for both repos).

**Spec:** `docs/superpowers/specs/2026-06-09-games-platform-design.md` — sections on the front end's job (canonical-subset nudging, lines ~116, 149, 262–275), the disclosed trust assumption, and the `Game` interface + presets (line ~220).

---

## Pre-flight: read these before starting

- `examples/games/core/src/` — the whole core surface (chains, contracts, secrets, game, lifecycle, operator). The app may not bypass it.
- `examples/games/e2e/src/deploy.ts` and `examples/games/e2e/scripts/parity-gate.ts` — the canonical transaction sequences for both games (enter/commit/arm/cast/reveal/finalise), the event names, and the commitment scheme `keccak256(abi.encode(guess, salt, player))`.
- `examples/games/e2e/test/parity.test.ts` + `coinflip-parity.test.ts` — what "verified" means; the verify panel is these assertions as UI.
- `examples/games/README.md` — the trust-assumption wording the UI must show.
- Contract events (the app's entire read surface):
  - CoinFlip: `Entered(id, player, side, stake, subsetHash)`, `Cancelled(id)`, `Paired(flipId, heads, tails, stake)`, `Heated(flipId, key)`, `Settled(flipId, winner, winningSide, payout, seed)`.
  - Raffle: `RoundOpened(roundId, stake, threshold, period, subsetHash)`, `Committed(ticketId, roundId, player, commitment)`, `TicketCancelled(ticketId)`, `Armed(roundId, key)`, `Drawn(roundId, draw, claimDeadline)`, `Revealed(ticketId, roundId, guess, distance, leading)`, `Finalised(roundId, winner, payout, fee)`, `NoContest(roundId, potPerValidator)`, `TicketRefunded(ticketId)`.

### Three design decisions this plan pins (do not relitigate mid-build)

1. **Presets are factories, not constants.** Canonical stake/threshold tuples belong to the game packages (liquidity concentration is game logic), but validator subsets are deployment-specific — so the open item "populate `presets`" is implemented as `makePresets(subset)` factory functions exported by `@gibs/coinflip` and `@gibs/raffle`, and the app supplies the per-chain canonical subset from its config. `Game.presets` stays `[]` (the interface field is kept for compatibility; the factories are the real surface).
2. **Polling, not websockets.** State refreshes by re-reading events on an interval (default 4 s) via the core's public client. Works identically on anvil and public 943 RPC; no subscription transport assumptions.
3. **The raffle salt lives in localStorage and the player is told so.** Commit stores `{guess, salt}` under a key derived from chain + contract + ticket id, shows a backup string, and the commit confirmation warns in plain language: lose the salt before revealing and the stake is forfeited to the pot.

---

## File structure

```
examples/games/web/                  @gibs/games-web
  package.json
  tsconfig.json
  vite.config.ts                     (vitest config inline via `test` key)
  index.html
  src/
    main.tsx                         React root
    App.tsx                          chain picker + wallet bar + game tabs
    config.ts                        per-chain: game addresses, canonical subset, explorer URL
    wallet.ts                        injected-provider connect, viem wallet/public clients
    model/                           PURE view-model layer (no React, fully unit-tested)
      coinflip-lobby.ts              events -> open entries, my entries, active/settled flips
      raffle-rounds.ts               events -> rounds with phase, tickets, countdowns
      verify.ts                      the verify-the-draw derivation for both games
      salts.ts                       commit-salt storage (localStorage, backup codec)
    hooks/
      useChainData.ts                polling loop -> model state
      useWallet.ts
    components/
      TrustBanner.tsx                the disclosure; acknowledge-to-play
      CoinFlipScreen.tsx             presets, enter, lobby, flip detail + VerifyPanel
      RaffleScreen.tsx               presets, commit, round detail, reveal, finalise + VerifyPanel
      VerifyPanel.tsx                off-chain settle vs on-chain result, side by side
  test/
    coinflip-lobby.test.ts
    raffle-rounds.test.ts
    verify.test.ts
    salts.test.ts
  scripts/
    dev-local.ts                     deploy to anvil + seed demo state + write src/generated/local.json

Modify:
  examples/games/coinflip/src/index.ts   add makePresets(subset)
  examples/games/raffle/src/index.ts     add makePresets(subset)
  examples/games/README.md               web app section
```

---

### Task 1: Preset factories in the game packages (the parked open item)

**Files:**
- Modify: `examples/games/coinflip/src/index.ts`, `examples/games/coinflip/test/coinflip.test.ts`
- Modify: `examples/games/raffle/src/index.ts`, `examples/games/raffle/test/raffle.test.ts`

- [ ] **Step 1: Write the failing tests**

In `coinflip.test.ts`:

```ts
describe('makePresets', () => {
  const subset = params.validatorSubset
  it('produces the canonical stake ladder bound to the given subset', () => {
    const presets = makePresets(subset)
    expect(presets.map((p) => p.params.stake)).to.deep.equal(
      [viem.parseEther('0.1'), viem.parseEther('1'), viem.parseEther('10')],
    )
    for (const p of presets) {
      expect(p.params.validatorSubset).to.deep.equal(subset)
      expect(() => coinflip.parseParams(p.params)).to.not.throw()
      expect(p.label.length).to.be.greaterThan(0)
    }
  })
})
```

In `raffle.test.ts` (canonical tuples: stake ladder × one threshold/period shape, every preset valid under `parseParams`):

```ts
describe('makePresets', () => {
  it('produces canonical tuples that parseParams accepts, bound to the subset', () => {
    const presets = makePresets(params.validatorSubset)
    expect(presets.length).to.be.greaterThan(0)
    for (const p of presets) {
      expect(() => raffle.parseParams(p.params)).to.not.throw()
      expect(p.params.threshold).to.equal(3n)
      expect(p.params.validatorSubset).to.deep.equal(params.validatorSubset)
    }
  })
})
```

- [ ] **Step 2: Run to verify failure** (`pnpm test` in each package)

- [ ] **Step 3: Implement the factories**

`@gibs/coinflip`:

```ts
const STAKE_LADDER = [viem.parseEther('0.1'), viem.parseEther('1'), viem.parseEther('10')] as const

/** The canonical presets for a chain's recommended subset. A recommended list, not a whitelist —
 * binding already constrains the validators; concentration is a liquidity concern (spec). */
export const makePresets = (validatorSubset: viem.Hex[]): Preset<CoinFlipParams>[] =>
  STAKE_LADDER.map((stake) => ({
    label: `${viem.formatEther(stake)} flip`,
    params: { stake, validatorSubset },
  }))
```

`@gibs/raffle`: same shape; tuples `{stake: ladder, threshold: 3n, period: 30n, validatorSubset}` with labels like `"0.1 raffle (3 players)"`. Export `Preset` from `@gibs/games-core` re-export if not already importable.

- [ ] **Step 4: Run to verify pass; typecheck both packages**
- [ ] **Step 5: Commit** — `feat: canonical preset factories for coinflip and raffle`

---

### Task 2: The pure view-model layer, test-first

This is where all front-end correctness lives; components stay dumb. Everything in `model/` takes plain event/log objects and returns plain state — no clients, no React, no time reads (now/`Date` passed in as arguments so tests are deterministic).

**Files:**
- Create: `examples/games/web/` package skeleton (package.json with `@gibs/games-core` + game deps + react + vite + vitest, tsconfig mirroring the sibling packages, `vite.config.ts` with inline vitest `test` config)
- Create: `src/model/coinflip-lobby.ts` + `test/coinflip-lobby.test.ts`
- Create: `src/model/raffle-rounds.ts` + `test/raffle-rounds.test.ts`
- Create: `src/model/salts.ts` + `test/salts.test.ts`
- Create: `src/model/verify.ts` + `test/verify.test.ts`

- [ ] **Step 1: coinflip-lobby — failing tests, then implement**

Input: arrays of decoded `Entered/Cancelled/Paired/Heated/Settled` event args plus `myAddress`. Output:

```ts
type CoinFlipLobby = {
  openEntries: { id: bigint; player: Hex; side: 'heads' | 'tails'; stake: bigint; mine: boolean }[]
  flips: { flipId: Hex; heads: Hex; tails: Hex; stake: bigint; status: 'pending' | 'settled'
          winner?: Hex; winningSide?: 'heads' | 'tails'; seed?: Hex; mine: boolean }[]
}
```

Rules to test: an `Entered` without `Cancelled`/`Paired` is open; cancelled entries disappear; paired entries leave the lobby and appear as a pending flip; `Settled` upgrades the flip with winner/side/seed (side decoded through `coinflip.decodeEntry`, NOT a local ternary); `mine` flags compare case-insensitively.

- [ ] **Step 2: raffle-rounds — failing tests, then implement**

Input: decoded `RoundOpened/Committed/TicketCancelled/Armed/Drawn/Revealed/Finalised/NoContest/TicketRefunded` args, `myAddress`, and `currentBlock`. Output per round: phase (`filling | drawing | claiming | paid | no-contest`), tickets (with `mine`, `revealed`, `leading`), `commitCount` vs `threshold`, `draw`, `claimDeadline` and `blocksUntilDeadline` (derived from the passed-in `currentBlock` — test the boundary: deadline block itself is still open, deadline+1 is closed, matching the contract's `block.number > claimDeadline`).

- [ ] **Step 3: salts — failing tests, then implement**

`saveSalt(store, chainId, raffleAddr, ticketId, {guess, salt})`, `loadSalt(...)`, `exportBackup(...)`/`importBackup(...)` (a single base64 JSON string of all entries for one chain+contract). `store` is an injected `Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>` so tests use a Map-backed fake. Key shape: `gibs-games:<chainId>:<raffleAddr>:ticket:<id>`.

- [ ] **Step 4: verify — failing tests, then implement**

The parity assertions as a pure function, one per game:

```ts
verifyCoinFlip({ seed, heads, tails, onChainWinner }) =>
  { offChainWinner: Hex; winningSide: 'heads'|'tails'; matches: boolean }
verifyRaffle({ seed, entries, onChainBestTicket }) =>
  { draw: bigint; offChainTicket: bigint | null; matches: boolean }
```

Implemented by calling `coinflip.settle` / `raffle.settle` / `raffleDraw` — zero new arithmetic. Tests reuse the known vectors from the package tests (even/odd seed; draw 129 tiebreaks) and assert `matches: false` surfaces when fed a deliberately wrong on-chain value (the panel must be able to say "MISMATCH — do not trust this round").

- [ ] **Step 5: Run the full web test suite; commit** — `feat: games-web pure view-model layer`

---

### Task 3: App shell — config, wallet, polling hook

**Files:**
- Create: `index.html`, `src/main.tsx`, `src/App.tsx`, `src/config.ts`, `src/wallet.ts`, `src/hooks/useWallet.ts`, `src/hooks/useChainData.ts`

- [ ] **Step 1: config.ts**

```ts
export type GameDeployment = {
  chainId: GamesChainId
  coinFlip: viem.Hex
  raffle: viem.Hex
  canonicalSubset: viem.Hex[]   // feeds makePresets; the spec's liquidity nudge
  explorer?: string
}
```

943 values come from the parity-gate run log in `examples/games/README.md` once the live run happens; local values are imported from `src/generated/local.json` (written by the Task 6 dev harness; the file is gitignored and the import is guarded so the 943-only build works without it).

- [ ] **Step 2: wallet.ts + useWallet**

`connect()` requests accounts from `window.ethereum`, builds `viem.createWalletClient({ transport: viem.custom(window.ethereum), chain })`, exposes `switchChain` via `wallet_switchEthereumChain` (adding the chain with `wallet_addEthereumChain` on error 4902 — parameters from the core registry). Public client comes from the core's `makePublicClient(chainId)`. No wallet state libraries; one small React context.

- [ ] **Step 3: useChainData**

A single polling hook: every 4 s (and immediately on tx confirmation), pull both games' full event sets via `getContractEvents` from the deployment block (configurable `fromBlock` in config to keep 943 scans cheap), plus `getBlockNumber`, run them through the model layer, and expose `{ lobby, rounds, blockNumber, refresh }`. All decoding through core ABIs.

- [ ] **Step 4: App.tsx** — chain picker (from config), wallet bar (address, balance, connect/disconnect), `TrustBanner`, and two tabs (Coin Flip / Raffle). Vite dev server runs; commit — `feat: games-web shell, wallet, polling`.

---

### Task 4: Coin flip screen

**Files:** `src/components/TrustBanner.tsx`, `src/components/CoinFlipScreen.tsx`, `src/components/VerifyPanel.tsx`

- [ ] **Step 1: TrustBanner** — the README's disclosure sentence ("a draw is safe as long as at least one of the chosen validators is honest"), the chain's canonical subset listed by address with explorer links, and an "I understand" acknowledgement stored per chain in localStorage. Entering is disabled until acknowledged. This satisfies the spec's open item: the assumption must surface in any real player-facing UI.
- [ ] **Step 2: Enter flow** — preset picker from `makePresets(config.canonicalSubset)`; side picker; on submit, `simulateContract` then `writeContract` `enterAndMatch(side, subset, locations)` where `locations` is `[]` when no opposite entry is open at that stake (queue) and the bound heat locations when one is (pair — reuse `buildHeatLocations` + the per-chain pool offsets from config; on local, the dev harness records them). Show my open entry with a Cancel button (`cancel(id)`).
- [ ] **Step 3: Flip detail + VerifyPanel** — pending flips show "waiting for the validators' cast (12-block window)"; settled flips render the VerifyPanel: on-chain winner beside `verifyCoinFlip(...)` output with an explicit ✓ MATCHES / ✗ MISMATCH state and the seed shown in full. Manual check against the dev harness data; commit — `feat: coin flip screen with self-verification`.

---

### Task 5: Raffle screen

**Files:** `src/components/RaffleScreen.tsx`

- [ ] **Step 1: Commit flow** — preset picker; guess input (1–256); generate a crypto-random salt; `commit(stake, threshold, period, subset, commitmentFor(guess, salt, address))`; on the `Committed` receipt store the salt via `model/salts` keyed by the real ticket id, then show the backup string with copy button and the forfeit warning.
- [ ] **Step 2: Round lifecycle** — filling rounds: commit count vs threshold and period progress; armed/drawing: "waiting for cast"; claiming: the draw, my tickets with Reveal buttons (guess+salt loaded from storage; a ticket with no stored salt shows the import-backup field instead), reveal-window countdown in blocks, current leading ticket (from `Revealed.leading`); after deadline: Finalise button (anyone may call); paid: winner + payout; refundable (chopped/stale, from `choppedInstance`/`STALE_BLOCKS` reads): per-ticket Refund button.
- [ ] **Step 3: VerifyPanel for the raffle** — after the draw: `verifyRaffle` over the revealed entries vs the on-chain `bestTicket`, live-updating as reveals land. Commit — `feat: raffle screen with salt custody and self-verification`.

---

### Task 6: Local dev harness and the end-to-end walkthrough

**Files:** `scripts/dev-local.ts`; gitignore entry for `src/generated/`

- [ ] **Step 1: dev-local.ts** — runs `deployLocal(3)` from the e2e package, inks an extra preimage batch per validator (the UI will trigger heats; one-shot preimages — give each validator a pool of 16), writes `src/generated/local.json` `{chainId: 31337, coinFlip, raffle, random, canonicalSubset, poolOffsets, deployBlock}`, and seeds demo state: one open coin-flip entry and one filling raffle round from throwaway anvil accounts. Wire as `pnpm dev:local` (runs the harness then `vite`).
- [ ] **Step 2: Manual walkthrough (the task's acceptance gate)** — with anvil + `pnpm dev:local` + a browser wallet pointed at 127.0.0.1:8545: acknowledge the banner; enter tails against the seeded heads entry; cast via the harness's `cast` helper (`pnpm dev:cast`, which casts any outstanding keys with the stored secrets); watch the flip settle and the VerifyPanel show ✓; commit into the seeded raffle, arm/cast via the helper, reveal, finalise, VerifyPanel ✓. Record the walkthrough result in progress.txt.
- [ ] **Step 3: Commit** — `feat: local dev harness for the games web app`.

---

### Task 7: Runbook + records

- [ ] **Step 1:** `examples/games/README.md` — a "Web app" section: `pnpm --filter @gibs/games-web dev:local` for the anvil flow; how to point it at 943 (fill `config.ts` from the gate's run log after the live run); the salt-custody warning repeated.
- [ ] **Step 2:** Update msgboard `progress.txt` (single worklog) and push both repos.

---

## Verification (whole plan)

- `pnpm --filter @gibs/games-web test` — the model layer is the contract-facing logic; it must be green and meaningful (lobby derivation, round phases incl. the deadline boundary, salt round-trips incl. backup import, verify-mismatch surfacing).
- `pnpm --filter @gibs/coinflip test && pnpm --filter @gibs/raffle test` — preset factories.
- The Task 6 manual walkthrough on anvil end to end, twice (fresh chain, then again on the same chain to exercise nonzero pool offsets).
- Existing suites stay green: core/coinflip/raffle/e2e vitest + 161 Hardhat tests.

## Out of scope (explicitly)

- A terminal front end (the spec mentions it; it layers on the same model/ functions later).
- Indexer-backed history (the polling event scan is fine at current scale; swap to `packages/indexer` only if 943 scans get slow).
- Mainnet deployment, fee configuration UI, validator-operator tooling.
- Wallet kits (wagmi/rainbowkit) — injected-provider-only for v1.

## Risks / notes

- **One-shot preimages drive UX:** every pairing/arming consumes one preimage per subset validator; the dev harness pre-inks pools of 16 and the UI must surface a clear error when a subset's pools are exhausted (`UnableToService` on heat — decode and translate to "validators need to re-ink").
- **The 12-block cast window:** on 943 a flip that pairs when no caster is running will go stale; the UI's refund surfaces (Task 5 step 2 / coin flip `refundStale`) are the safety net and must be reachable, not buried.
- **943 config depends on the live gate run** (addresses + pool offsets from the run log). The app ships local-first; 943 lights up by filling `config.ts`.
