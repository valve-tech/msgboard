# Provably-fair landing coin flip vs. a house bot (0 tokens at stake)

**Date:** 2026-07-25
**Status:** approved (direction), implementation pending
**Supersedes:** the current `packages/ui` Arcade flip, which is NOT provably fair and must not be defended (see checkpoint memory `checkpoint-2026-07-25-coinflip-fairness-flaw`).

## Problem

The msgboard.xyz landing "Arcade" tab presents a coin flip as "provably fair": `outcome = keccak256(blockHash ‖ clientSeed)`, parity = heads/tails. This claim is **false and a category error**:

- It is a **solo, no-stakes, no-house demo** — there is no counterparty, so "neither side can bias it" is meaningless.
- The block hash is **public at flip time** and the client seed is **player-chosen and editable in the UI**. A player reads the current head, grinds client seeds until parity matches their pick, pastes it in, and wins every time. The *player* biases it.
- Prior sessions made it worse by polishing the unsound scheme (a praising tooltip, a per-flip nonce "fix"). Do not repeat that.

## Decision

Rebuild the landing flip as the **real, board-mediated, commit-reveal house game the full arcade already uses — run at zero stakes.** Both parties (player + a house bot) communicate **entirely via msgboard**; every step is a real, PoW-stamped, publicly verifiable board message. Publishing is **mandatory**, not an opt-in toggle — we are on msgboard.xyz.

"Zero stakes" is what makes this tractable: provable fairness lives in the commit-reveal + EIP-712 co-signing, which does **not** depend on tokens being at risk. Removing stakes removes the on-chain settlement layer entirely:

- No HouseChannel escrow, no `settleWithSeeds`, no on-chain settle.
- **No funded HouseChannel redeploy** (the blocker in memory — missing the `0xaf2ce018` Chips-minter key — simply does not apply; no Chips, no minting, no escrow contract).
- The house bot key only ever **signs**; it never needs funds.

The session runs in **optimistic mode**, tracks a **play-money** balance (fun-chips that move through the real 2× multiplier mechanics), and **never touches chain** — so 0 real tokens are ever at risk while the full audited protocol runs end-to-end.

### Why this over a lean purpose-built flip

A bespoke minimal flip was considered. Rejected because reusing the whole audited protocol is maximally honest (the taste *is* the real thing at zero stakes), avoids a parallel protocol implementation to audit, and the bot/wiring advances the real arcade too. The only real cost — engine bundle weight on the landing SPA — is mitigated by lazy-loading the Arcade tab.

## Fairness mechanism (unchanged from the production protocol)

Per-round entropy is `raw = roundRandom(serverSeed, clientSeed, nonce)` = `uint256(keccak256(abi.encode(bytes32 serverSeed, bytes32 clientSeed, uint64 nonce)))` (`games/msgboard-games/src/rng.ts:35`). The ordering that prevents either side grinding:

1. **House commits blind.** House builds a seed hash-chain and publishes only `rngCommit = seed[0] = keccak256(serverSeed)` in the co-signed OPEN state (nonce 0) — never the seed. (`buildSeedChain`, `rng.ts:13`.)
2. **Player reveals only after OPEN is co-signed.** `clientSeed` is revealed at ROUND time (nonce 1), never at open time (`boardSession.ts` security note; `boardProtocol.ts:16`). Player has seen only the *hash* of the house seed → cannot grind.
3. **House reveals `serverSeed`.** Player verifies `keccak256(serverSeed) === rngCommit` (`verifyReveal`, `rng.ts:22`) and, critically, that `proof.clientSeed === own clientSeed` (`coSignTransport.ts:266`, anti-house-bias linchpin) before EIP-712-signing the ROUND state.
4. **Outcome** = parity of `raw` (even → heads, odd → tails — same convention as the current UI and `coinFlipOutcome`, `games/core/src/secrets.ts:23`). Both halves co-signed → a signed transcript anyone can re-audit (`verifyFinishedSession`).

House committed its seed before the player's seed existed; player fixed its seed seeing only the commit. Neither can bias the 50/50. The signed transcript on the board makes it non-repudiable.

## Components & changes

### 1. New game: `coinflip` in `@msgboard/games` (`games/msgboard-games`)

- `src/games/coinflip.ts` — `Game<CoinFlipParams>`, `gameId: 5` (confirmed free).
  - `CoinFlipParams = { pick: 'heads' | 'tails' }`.
  - Fair 50/50 paying **2× (no house edge)** — this is a free showcase of a *fair coin*; a sub-2× "fair" coin would be dishonest. `maxMultiplierX100 = 200n`.
  - `settleRound(stake, params, raw)`: `side = (raw & 1n) === 0n ? 'heads' : 'tails'`; `win = side === params.pick`; win → `{ win, playerDelta: stake, multiplierX100: 200n }`, lose → `{ win: false, playerDelta: -stake, multiplierX100: 0n }`.
  - `encodeRound`: `abi.encode(uint8 gameId, uint256 stake, uint8 pick, uint256 raw)` (model on `limbo.ts:46`). Not settled on-chain, but keep canonical encoding for transcript hashing consistency.
- Register in the games barrel/registry export so `@msgboard/games` re-exports `coinflip` (mirror how `limbo` is exported/consumed in `runHouse.ts`).
- **Tests first (TDD):** parity → side mapping (both parities), pick-match win/lose, `maxMultiplierX100 === 200n`, `encodeRound` round-trips, and an exhaustive escrow-ceiling check (`multiplierX100 <= maxMultiplierX100` for all `raw` parities) mirroring `test/escrowCeiling.test.ts`.

### 2. Category override for landing isolation (protocol layer)

Thread an optional `category?: Hex` through so the landing demo runs on its **own** board category, isolated from the real arcade's house category:

- `makeBoardPlayerSession` (`games/msgboard-settle/src/boardSession.ts:88`): accept `opts.category`, default `houseCategory(chainId)`.
- The house deps (`games/house-service/src/boardDeps.ts` `makeBoardHouseDeps`) + `startHouse` config path: accept an optional category override, default `houseCategory(chainId)`.
- Add a landing category constant, e.g. `landingCoinflipCategory(chainId) = channelToCategory('coinflip-arcade')` or a dedicated `games.msgboard.xyz:landing:<chainId>` — pick one and use it on both sides.
- **Tests:** existing board-session/house tests still pass with the default; add one asserting a custom category is used on both send and poll.

*(This is done as part of the foundational subagent so the two integration subagents don't both edit `msgboard-settle`.)*

### 3. Landing house bot (`games/house-service`)

- A run config / entrypoint (extend `main.ts` or add `src/runLandingHouse.ts` + a script) that calls `runBoardHouse` with:
  - `games: [coinflip]` (only), `settlementMode: 0` (optimistic), the landing category, and limits with a zero/nominal escrow cap (nothing settles on-chain).
  - `houseSigner`: a dedicated signing key (no funds needed). Reuse the existing mnemonic-index-1 house signer pattern (`liveConfig.ts:72`); the EIP-712 domain `verifyingContract` can be the already-deployed HouseChannel `0xd0fe186f…` (never called) via `makeDomain`.
- Deployable as a long-running process (same shape as `main.ts`); deploy via the ansible runbook per project convention (do NOT ad-hoc ssh) — actual deploy is a follow-up, out of code scope.
- **Tests:** an E2E mirroring `scripts/live-round.ts` but fully off-chain: player (`makeBoardPlayerSession`) ↔ landing house over an in-memory board, one coinflip round, assert the transcript verifies and the outcome recomputes.

### 4. Landing Arcade rewrite (`packages/ui`)

- Add `@msgboard/games` + `@msgboard/settle` as deps; **lazy-load** the engine inside the Arcade (dynamic `import()`), so the landing bundle only pulls it when the Arcade tab opens.
- Replace the solo flip with the production player path, mirroring `games/web/src/hooks/useSession.ts` (`requestOpen → runPlayerSide + startServing → houseDriver`), adapted for the landing:
  - **Ephemeral player key** in `localStorage` purely for co-signing (no wallet, no on-chain, no funds). `clientSeed` via CSPRNG (`generatePrivateKey`), never `Math.random`.
  - One session per flip (fresh `tableId` + `clientSeed`): each flip is OPEN (nonce 0) + ROUND (nonce 1) → a co-signed transcript.
  - Post through the existing `makeWorkerBoard` off-thread PoW seam (`packages/ui/src/seams/worker-board.ts`) — never grind on the main thread.
  - **Mandatory publishing:** every flip *is* the on-board round; remove the "Publish my flips" checkbox entirely. The feed reads the co-signed round records back from the board (`useChainStore` content poll).
  - **Progress UI:** surface the real handshake steps (commit → grant → reveal → transcript) as the showcase — this is the point of the venue.
  - **Verify panel:** show `rngCommit`, revealed `serverSeed` (with the `keccak256(serverSeed)===rngCommit` check), `clientSeed`, `raw`, and parity → face. Player recomputes from the transcript.
- **Copy purge:** delete every false "provably fair — a block hash you didn't choose, neither party can bias it" claim (the tooltip `Arcade.tsx:218`, the "Verify it yourself" paragraph `~319`, the pitch). Replace with an accurate description of the commit-reveal-vs-house-bot mechanism. `coinflip.ts`'s block-hash math (`flipOutcome`) is removed/replaced.
- **Tests:** the parity/recompute lib tests move to the new mechanism; a component test drives a flip against an in-memory/faked house driver (mirror `useSession`'s `makeInMemoryHouseDriver` demo seam) and asserts the co-signed outcome + mandatory board post. Reuse the `FakeWorker` pattern (`test/worker-board.test.ts`).

## Non-goals / YAGNI

- No on-chain settlement, escrow, HouseChannel calls, Chips, or funded redeploy.
- No wallet connection on the landing page.
- Not touching the separate P2P `games/coinflip` (FlipBook) product or `games/web`'s own `useSession` TODO — the landing wires straight to `makeBoardPlayerSession`.
- Real bot deployment (ansible) is a follow-up, out of this code scope.

## Risks

- **Latency:** OPEN + ROUND co-sign over the board = ~4 PoW-stamped posts per flip (several seconds). Accepted — "both parties communicate via msgboard" was an explicit requirement; the handshake *is* the showcase. Mitigate UX with a clear step-by-step progress indicator.
- **Bundle weight:** mitigated by lazy-loading the Arcade tab.
- **Bot liveness:** a withheld house reveal stalls a flip (no funds lost, publicly visible on the board). Add a client timeout → "house didn't respond, round void" and let the player retry.
- **Fairness-critical code:** every change goes through code review + full test runs before completion.

## Build sequence

1. **Foundational (blocks the rest):** `coinflip` Game (TDD) + category override in `msgboard-settle`/`house-service` deps. One subagent.
2. **Parallel after (1) lands + review:**
   - Landing house bot in `games/house-service` + off-chain E2E.
   - `packages/ui` Arcade rewrite + copy purge + tests.
3. Code review (fairness-critical) → full monorepo test/build → done. Bot deploy via ansible is a follow-up.
