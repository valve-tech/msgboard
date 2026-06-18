# On-Chain Session Settlement — Dice Thin Vertical Slice (Design Spec)

Status: draft for review · 2026-06-18
Parent design: [`2026-06-13-msgboard-games-design.md`](./2026-06-13-msgboard-games-design.md) (this builds §6.2 escrowed + §7 relayer-as-anyone + §8 frontend, for **one game**)

## 1. Summary

The six "session games" (Dice, Limbo, Plinko, Keno, Mines, Hi-Lo War) currently settle **entirely off-chain**: the browser plays both sides with a fresh in-process house key, `verifyingContract` is a placeholder, and the only artifact is an ephemeral MsgBoard lobby notice. There are **no real chip stakes** — which is why there is nothing real to surface in a cross-game activity table.

The escrow infrastructure to fix this is **already written and deployed** on PulseChain testnet 943: `Chips` (mintable ERC20), `HouseChannel` (per-table escrow, EIP-712 `OpenTerms`, `settle`/`dispute`/forfeit), `HouseBankroll` (optimistic backend), and `@gibs/msgboard-settle` (`buildOpen`/`buildSettle`). None of it is configured or wired into play.

This slice proves the **entire on-chain settlement pipeline end-to-end on one game (Dice)**: stand up a live House counterparty, configure the deployed contracts, escrow real chips, play off-chain, settle on-chain, index the result, and show one activity row. Once proven, the remaining five games and the full filterable activity table fan out almost mechanically in later slices.

**Locked decisions** (from brainstorming):
- **Backend:** Escrowed `HouseChannel` (§6.2). The house reviews `OpenTerms` and either co-signs — locking `escrowHouse` to cover the player's max win ("bets against") — or declines.
- **Game:** Dice (stateless, bounded max payout → clean escrow sizing).
- **Transport:** **Board-only.** The House is a key-holding MsgBoard watcher (same pattern as the bots/relayer); player and house co-sign via the board. A direct HTTP fast-path is deferred. This is viable because measured board posts are ~1–1.8 s (see §10).
- **Settlement landing:** the settle-ready state is public on the board, so the player **or any watcher** can land `settle()` — the "untrusted, anyone-can-run relayer" of §7, with no fee and no special power. We don't run a dedicated relayer in this slice.

## 2. What already exists vs. the gap

**Exists (deployed 943):** `Chips 0xA5276259e544C86438566cB28cc87daCce060910`, `HouseBankroll 0xf1781f82745604281227C6CeC26176C2464cb0D1`, `HouseChannel 0x57876609E4fEDDEeB83e46A1b3A20140998f0e46`. `HouseChannel` emits `Opened(tableId, player, playerKey, escrowPlayer, escrowHouse)`, `Settled(tableId, payoutPlayer, payoutHouse)`, `DisputeOpened`/`DisputeAnsweredWithState`/`DisputeForfeited`. `@gibs/msgboard-settle` exposes `EscrowedSettlement.buildOpen(terms, houseSig)` and `buildSettle(transcriptJson)` (replays + re-verifies the co-signed transcript, then builds `settle(finalState, sigPlayer, sigHouse)`), plus `signOpenTerms`/`verifyOpenTermsSig`. `HouseSession` owns the server-seed chain and publishes `rngCommit` at open.

**The gap:**
1. **No live house.** `useSession` makes a *fresh in-browser ephemeral* house key — "both signers local" — and `verifyingContract` defaults to `PLACEHOLDER_VERIFIER`. There is no deployed counterparty holding the key registered via `setHouseKey`.
2. **Contracts unconfigured.** `setHouseKey`, `Chips.mint`, `HouseChannel.fundHouse` never called.
3. **No chips in play.** Session balances are hardcoded bigints, not escrowed ERC20.
4. **No settlement.** No `open`/`settle` transactions; no indexing of channel events; no activity surface.

## 3. Goals / non-goals

### Goals (this slice)
- A deployed **House service** that holds the house key and co-signs Dice tables over MsgBoard.
- One-time **contract configuration** on 943.
- A testnet **chip faucet**.
- The **Dice screen** plays a real escrowed table: chips locked at open, one roll played + co-signed off-chain, settled on-chain.
- **Funds-safety**: a player can always force-settle the last co-signed state via `dispute`/forfeit, even against a dead or malicious house.
- The games **indexer** picks up `Opened`/`Settled`; one **Dice activity row** renders from it.

### Non-goals (deferred to later slices)
- The direct HTTP fast-path for low-latency rounds.
- The other five session games.
- Multi-roll tables (this slice is **one roll per table**, see §7).
- Deposit/withdraw chip economics beyond the faucet; chip value/peg/tokenomics (out of scope per parent §3).
- A dedicated relayer process (anyone *can* relay; we don't run one).
- The full filterable activity table (this slice ships one minimal row list).
- The optimistic (`HouseBankroll`) and ZK (`ZkTable`) backends.

## 4. Architecture

```
 Player (browser)                 MsgBoard (943 board)               House service (box)
 ─────────────────                ───────────────────                ───────────────────
 useSession + Web Worker  ──open-request──▶  table category  ◀──watch──  HouseSession(houseKey)
 (grind in worker)        ◀──open-grant───   (per-tableId)   ──post────  reviews terms, signs OpenTerms
        │                                                                 owns server-seed chain
   approve + open() ───────────────────────────────────────▶  HouseChannel.open  (escrow locked, Opened)
        │                 ──round (co-signed state)──▶                    co-signs, reveals seed_k
        │                 ◀──round-result + reveal────                    posts back
   verify + retain transcript                                            
   "Cash out": buildSettle(transcript) ────────────────────▶  HouseChannel.settle (payout, Settled)
        │  (or ANY board watcher lands it)
        ▼
 games-indexer  ◀── Opened/Settled ── games-indexer-943 (Ponder)  ──▶  Dice activity row on the web
```

Trust model: the House service is **trusted with the key and the bankroll** (it is the casino). The player's protection is **cryptographic, not operational** — escrow locked at open, both-signatures-required state transitions, and an on-chain dispute/forfeit clock. A vanishing or cheating house cannot take the player's principal or deny a co-signed payout.

## 5. Components

### 5.1 House service (`examples/games/house-service`, new)
A long-running Node process deployed on the msgboard box (alongside `games-indexer-943` and the actors), modeled on the existing board-watcher pattern (bots/relayer). Responsibilities:
- Hold the **house key** `Hk` (registered via `setHouseKey`). Key supplied via env/secret; never leaves the process; never posted.
- **Watch** the open-request board category. For each request: validate params, compute `escrowHouse` (§7), build `OpenTerms`, mint a `HouseSession` (which generates the seed chain → `rngCommit`), `signOpenTerms(Hk, domain, terms)`, and post an **open-grant** — or post a **decline** if the terms exceed risk limits / the funded pool.
- Per round: receive the player's co-signed `SessionState`, compute the outcome via `HouseSession.play` (`settleRound(stake, params, roundRandom(serverSeed_k, clientSeed, nonce))`), co-sign the new state, reveal `serverSeed_k`, post the **round-result**.
- Keep per-`tableId` session state in memory (durable store not required for the slice; a restart abandons in-flight tables to the dispute path, which is safe).
- **Faucet** endpoint (§5.3).

This is essentially extracting the in-browser house half of `useSession` into a deployed process whose transport is the board. The signing/RNG logic (`HouseSession`) is reused unchanged.

### 5.2 Contract configuration (one-time ops)
A scripted, idempotent ops step (a `games-deploy.yml` mode or a `packages/contracts` script):
- `HouseChannel.setHouseKey(addressOf(Hk))`
- `Chips.mint(house, N)` — initial house treasury
- `HouseChannel.fundHouse(N)` — back the channel's escrow pool
Records the house address + amounts; safe to re-run.

**Two keys, one testnet identity.** Mints + `fundHouse` + `setHouseKey` require the contract **owner** key (the deployer, `0xAF2c…`); co-signing `OpenTerms`/`SessionState` and the faucet's `Chips.mint` require a key the **House service** holds. For this slice, the simplest model is one house identity: the House service holds the **owner** key, so the same identity is registered as `Hk`, mints (treasury + faucet), funds the channel, and co-signs. Production would split the cold owner key from a hot co-signing key + a transfer-funded faucet reserve; that separation is a deferred hardening, not slice scope. The key is supplied via env/secret and never posted.

### 5.3 Chip faucet (testnet only)
The House owns `Chips`, so the service exposes a faucet that `Chips.mint(player, amount)` up to a per-address cap. Transport for the slice: the simplest viable path (a board faucet-request the service honors, or a minimal endpoint) — an impl detail, gated to 943.

### 5.4 Web wiring (`useSession` + `DiceScreen`)
- Replace the ephemeral in-browser house with **board round-trips** to the House service; set `verifyingContract` to the real `HouseChannel` address (from config).
- Chip flow surfaced in the Dice screen: balance, "Get test chips" (faucet), then `Chips.approve(HouseChannel, escrowPlayer)` + `HouseChannel.open(terms, houseSig)`.
- Play one roll (off-chain, co-signed, instant render from the locally-recomputed outcome the moment the house's result appears on the board).
- "Cash out": `EscrowedSettlement.buildSettle(transcript)` → `simulate` → `writeContract` (player submits) → `Settled`.
- A per-table **settlement-status** indicator (playing → settle-pending → landed) per parent §8.
- All board grinding stays in the **Web Worker** (enforced guard); a "stamping…" state covers the ~1–6 s tail.

### 5.5 Board transport & categories
- **Open/announce:** the existing lobby category `games.msgboard.xyz:lobby:943` keeps the public OPEN anchor (tableId, gameId, rngCommit, escrow) for discoverability + the activity/Live feed.
- **Per-table session traffic:** a per-table category `games.msgboard.xyz:table:943:<tableId>` carries open-request, open-grant, round, and round-result envelopes, so concurrent tables don't cross-talk and a watcher can follow one table.
- All messages are PoW-stamped (low-frequency: open + one round + settle-ready ≈ a handful per table).

### 5.6 Indexing (extend `games-indexer`)
Add `HouseChannel` to `deploy/games-indexer` (msgboard repo): index `Opened`, `Settled`, and the `Dispute*` events. Because `Settled` carries only `tableId`, the indexer **joins on the `Opened` row** (keyed by `tableId`) to recover `gameId` + `player` + escrow, and writes an enriched settlement row (`game`, `player`, `stake`/escrowPlayer, `payoutPlayer`, net, block, tx). `gameId → 'dice'`. Served via the same GraphQL endpoint already live at `games.msgboard.xyz/games-indexer/graphql`.

### 5.7 Minimal activity row
A small "recent Dice settlements" list in the Dice screen (or a stub Activity panel), reading the indexer: `player · stake · payout · net · when · tx`. This is the seed of the full filterable activity table (later slice) — same data source, minimal UI.

## 6. End-to-end flow

1. **Faucet** — player mints test chips.
2. **Open request** — player picks target % + bet (`escrowPlayer = stake`) and a `clientSeed`; posts an open-request to `…:table:943:<tableId>` with `{gameId: dice, params, escrowPlayer, clientSeed, player, playerKey}`.
3. **Open grant / decline** — house validates, sizes `escrowHouse` (§7), builds `OpenTerms`, signs, posts `{terms, houseSig, rngCommit}` — or a decline.
4. **On-chain open** — player `approve` + `HouseChannel.open(terms, houseSig)`; both escrows lock; `Opened` emitted.
5. **Play (one roll)** — player posts a co-signed `SessionState` (nonce 1, the bet); house computes `roundRandom(serverSeed_1, clientSeed, 1)`, `settleRound`, co-signs the new state, reveals `serverSeed_1`, posts the result. Player verifies the reveal against `rngCommit` and recomputes the outcome; appends to the retained transcript.
6. **Settle** — the final co-signed state is on the board; player (or any watcher) `buildSettle(transcript)` → `HouseChannel.settle(finalState, sigPlayer, sigHouse)`; escrow pays out per final balances; `Settled` emitted.
7. **Index + show** — indexer records `Opened`+`Settled`; the Dice activity row appears.

**Censorship / funds-safety path:** if the house never grants, never posts a result, or never settles, the player holds the last co-signed state and calls `HouseChannel.dispute(...)`. The house must answer on-chain with a newer co-signed state or **forfeit** (`DisputeForfeited` pays the player per the last state). Pre-open censorship costs the player nothing (no escrow locked yet). This is the guarantee that makes a trusted house operationally — but not custodially — trusted.

## 7. Escrow sizing for Dice (one roll per table)

Dice roll-under at target `t%` has fair multiplier `100/t`; with the 1% house edge (`EDGE_BPS = 100`) the paid multiplier `m = settleRound`'s `multiplierX100/100 ≈ 0.99 · 100/t`. For a single roll:
- `escrowPlayer = stake`
- `escrowHouse = stake · (m − 1)` (the most the player can win above their own stake)
- total locked `= stake · m`; on a win the player takes `stake · m`, on a loss the house takes `stake`.

The house **bounds risk at review**: it enforces a max multiplier (equivalently a min target `t`) per table so `escrowHouse` never exceeds its funded pool, and declines requests outside the band. One roll per table makes the escrow exact and the settlement a single final state (nonce 1). Multi-roll tables (escrow bounding the cumulative swing across a seed chain) are a deliberate later extension.

## 8. Data shapes

- **`OpenTerms`** (mirrors `HouseChannel.sol` / `@gibs/msgboard-settle` exactly): `{ tableId, player, playerKey, escrowPlayer, escrowHouse, gameId, rngCommit, clockBlocks, expiry }`.
- **`SessionState`**: `{ nonce, balancePlayer, balanceHouse, gameStateHash, … }`, co-signed EIP-712 by both keys with `verifyingContract = HouseChannel`.
- **Board envelopes** (per-table category): `open-request`, `open-grant {terms, houseSig, rngCommit}`, `round {state, sigPlayer}`, `round-result {state, sigHouse, serverSeedReveal}`. JSON, bigints as decimal strings (rehydrated client-side).
- **Indexer row**: `{ tableId, game, player, escrowPlayer, payoutPlayer, net, blockNumber, blockTimestamp, txHash }`.

## 9. Where the code lives (cross-repo)
- **`gibsfinance/random`** (`games-platform`): `examples/games/house-service` (new); `examples/games/web` (`useSession`, `DiceScreen`, faucet UI, activity row); reuse `@gibs/msgboard-games` (`HouseSession`) + `@gibs/msgboard-settle` (`EscrowedSettlement`) unchanged.
- **`valve-tech/msgboard`**: `deploy/games-indexer` (add `HouseChannel` events + join logic); `.github/workflows/games-deploy.yml` (house-service deploy mode + contract-config mode); the indexer + web deploy modes already exist.
- **Contracts**: already deployed; configuration only.

## 10. Measured constraint: board PoW

Live 943 difficulty (`wm=10000`, `wd=1000000` from `msgboard_status`) → `difficulty = (2²⁴ + size·10000)/100`, ~180–250k expected iters for typical message sizes. Measured (single-thread, Apple Silicon, 25 trials/size): **WASM median ~1.2–1.8 s** (native ~0.9–1.2 s), with a heavy probabilistic tail (p90 ~3–6 s, occasional 5–13 s). Difficulty scales with **message size**, not board growth, and `wm/wd` is read live, so a higher-difficulty board is tolerated by the Worker + a "stamping…" state. This is why board-only transport is acceptable for a handful of posts per table; per-round latency is the reason a direct fast-path stays on the roadmap.

## 11. Testing
- **Contracts**: existing Foundry/Hardhat suites for `HouseChannel`/`Chips` cover open/settle/dispute/forfeit; add a Dice-params escrow-sizing unit test.
- **Settle replay**: `@gibs/msgboard-settle`'s `replaySession` re-verifies the transcript; add a Dice end-to-end fixture (open → 1 roll → settle calldata) asserting payout matches the co-signed final state.
- **House service**: unit-test the open-review (escrow sizing, decline-out-of-band) and the round co-sign/reveal against a scripted player.
- **Indexer**: assert `Opened`+`Settled` join produces the expected Dice row (against a real settled table on 943).
- **E2E (943)**: one full table from faucet to indexed row, plus a dispute-path test (house withholds → player forfeits → player made whole).

## 12. Open questions
- **House-service durability**: in-memory per-table state (restart → tables fall to dispute) is fine for the slice; a persistent store is a hardening follow-up.
- **Faucet transport**: board-request vs minimal endpoint — pick the simplest at implementation time.
- **`clockBlocks`/`expiry` defaults** for the dispute clock on 943 — choose concrete values during implementation (a few minutes of blocks).
- **tableId derivation** — house- or player-chosen; must be unique and bind the open.

## 13. Decomposition (this slice → one implementation plan)
1. Contract config mode + faucet (unblocks chips).
2. House service (open-review + round co-sign + reveal, board transport).
3. Web wiring (`useSession` board round-trips, real `verifyingContract`, Dice open/play/settle UI).
4. Indexer extension (`HouseChannel` events + join) + minimal activity row.
5. E2E on 943 (happy path + dispute path) → deploy.
