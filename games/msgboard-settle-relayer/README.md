# @msgboard/settle-relayer

The **async, untrusted, anyone-can-run settlement worker** of the msgboard-games design
(spec §7; Plan 3 of `2026-06-13-msgboard-games-design.md`). It runs OFF the play critical
path and its only job is to **land settlement** — turn a finished, co-signed session into
an on-chain `settle()` call — without ever being able to change WHAT settles.

## What it does

1. **Detects settle-ready sessions** (`settleReadySource`). A provider (in production: a
   board watcher / a co-signed-final feed / an explicit close-out queue) reports sessions;
   the source keeps only those with at least one co-signed `ROUND` after the `OPEN` (a net
   delta to land) and yields one independent `SettleJob` per session. Parallel sessions never
   serialize.
2. **Builds + submits the settle calldata** (`settleAction`). Per job it calls the Plan 2
   `OptimisticSettlement` / `EscrowedSettlement.buildSettle(transcriptJson)` builder, which
   **replays the retained transcript and re-verifies every chain link, every EIP-712
   co-signature, the server-seed reveal chain, and every recomputed outcome — and THROWS on
   any mismatch**. The resulting `TxRequest{address,abi,functionName,args}` is submitted via
   viem `simulateContract` → `writeContract`.
3. **Replace-by-fee + nonce window** (the engine's `repricingAction` + `PendingTxTracker`).
   Multiple settlements pipeline within a bounded nonce window (no head-of-line blocking),
   and a stuck/underpriced settle tx is replaced-by-fee on the same nonce at a higher fee.
4. **Nudges, never gates** (`detectNudges`). It surfaces "sign the next state" / "top up gas"
   reminders to the UI as pure data. It never signs on a participant's behalf, never withholds
   settlement, never moves funds.

## Why it is untrusted (its only power is *when*)

The worker has **no degrees of freedom over what settles**:

- It **cannot forge.** It only ever submits a transcript it was *given*, and only the states
  the transcript's two co-signatures already authorize. The safety suite verifies both
  parties' EIP-712 signatures on every submitted state.
- It **cannot land a tampered payout.** `buildSettle` → `replaySession` throws on any
  chain/sig/outcome/balance mismatch; the action turns that throw into a non-submitting
  `ok:false`. A flipped balance produces no tx.
- It **cannot censor.** An absent or failing worker only *delays*. A later tick re-offers the
  same session and any worker lands it — two workers offered the same session build
  byte-identical calldata.
- It is **observe-by-default.** With no `mode: 'live'` it describes and does nothing.

So **anyone can run their own** settler (or self-settle by calling `buildSettle` and
submitting the `TxRequest` directly). The worker's only contribution is *when* a valid,
fully-signed settlement lands.

## Where the pieces live (two repos)

By the split-of-concern rule of spec §9:

- **Generic repricing / nonce-window primitive → `@msgboard/relayer`** (the msgboard engine).
  `repricingAction` (a `RelayerAction` wrapper) + `createPendingTxTracker` (per-nonce
  in-flight state) are game-agnostic — they know only viem txs, nonces, and fees — and are the
  literal "nonce-window / repricing Action wrapper for high-throughput live relayers" the
  relayer spec deferred to its §13. They belong to the engine so any relayer (a cross-chain
  mirror, a sponsor, a future settler) can reuse them.
- **Games settlement worker → this package.** A *composition* that wires the games
  `Settlement` builders (`@msgboard/settle`), the retained `Transcript`/`SessionState`
  types (`@msgboard/games`), and the published engine (`@msgboard/relayer`). It cannot
  live in `packages/relayer` because that package must stay a generic, published engine with
  no games dependency.

## Dependency-path decision (Plan 3 Task 1)

This package depends on the **published `@msgboard/relayer ^0.0.32`** — the same mechanism by
which the other games packages already consume published `@msgboard/sdk`.

`Relayer`, `RelayerAction`, `RelayerContext`, `RelayerMode`, and `RelayerNode`, plus the
repricing primitive (`repricingAction` / `createPendingTxTracker` / `PendingTxTracker` /
`TxFees`), are all exported by the published `0.0.32` and imported directly from
`@msgboard/relayer`. The repricing primitive was added to the engine in this same plan
(Tasks 2–3); it shipped in the `0.0.32` release, so the temporary local shim that mirrored it
during development (`src/repricing-local.ts`, used while the engine sat at `0.0.31`) has been
removed and `settleAction.ts` / `worker.ts` import it from `@msgboard/relayer` directly.

## Run / test

```bash
pnpm test       # vitest run — settleReadySource, settleAction, nudges, worker, safety
pnpm typecheck  # tsc --noEmit
```

Unit tests use fakes only (fake provider/submitter/transcripts) driven through
`Relayer.runOnce()` — no anvil, no RPC. The real on-chain land/RBF e2e is deferred to the
web/e2e plan (spec §13 plan 6).
