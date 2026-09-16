# Backroom-B — the operator security-room dashboard

Status: DESIGN, approved to build (2026-08-13). Companion to backroom-A
(`docs/superpowers/specs/2026-08-12-operator-bankroll-management-design.md`, which
names this as the next design). Designed with fable; contradictions hunted
adversarially. No code is written yet.

## 1. Purpose and scope

Backroom-B is the operator's security room. It gives one live, read-only view of
every table the operator runs — every in-flight round, every player position, the
shared bankroll, per-table exposure against its cap, and the settle/forfeit tape as
it happens. It renders the read layer that backroom-A defined (`operator-ops.ts
status` plus the contract events), continuously and visually, in the games-web house
style.

Backroom-B is NOT a write tool. Every state change — deposit, withdraw, caps,
policy — stays in the operator-ops CLI and its operator-only on-chain entrypoints.
Backroom-B is also NOT an oracle. It must never show a round's outcome, or any
material that predicts it, before the outcome is irreversible on-chain. That
boundary (section 5) is the load-bearing property of this design.

## 2. Data sources

### 2.1 On-chain surface (live 943 addresses)

- OperatorCoinFlip `0x0c80607e…` (deployBlock 25121394). Events: `TableCreated`,
  `OpenSet`, `ValidatorPolicySet`, `TableCapSet`, `FeesDeposited`, `FeesWithdrawn`,
  `RoundOpened`, `RoundSettled`, `RoundRefunded`, `ForfeitRouted`. Views: `tables`,
  `rounds`, `feeBalance`, `tableCap`, `tableLocked`, `operatorOf`, `tierPriceOf`.
- GameEscrow `0xb5724816…`. Events: `BankrollDeposited`, `BankrollWithdrawn`,
  `ExposureLocked`, `Settled`, `Refunded`, `RakeWithdrawn`, `GameAuthorized`,
  `PlayerGameSet`. Views: `bankrollOf`, `lockedOf`, `rakeOf`, `betOf`,
  `authorizedGame`, `playerAllowsGame`.
- OperatorRegistry `0xb202144e…`. Events: `Registered`, `RakeSet`,
  `RakeRecipientSet`, `FundingSourceSet`, `MetadataSet` (event-only — no view).
  Views: `registered`, `rakeBps`, `rakeRecipientOf`, `fundingSourceOf`.
- DefaultValidatorPolicy `0xe821380f…`. Event `ConfigSet`; view `configOf` (flags
  only — whitelist members live in the `ConfigSet` calldata).
- GameBase (on the game). Events `ValidatorAdded`, `ValidatorRemoved`. Views
  `isValidator`, `validatorCount`, `MIN_SUBSET=3`, `STALE_BLOCKS=200`,
  `HEAT_DURATION=12`, `instanceByKey`, `choppedInstance`.
- Random `0x775AF72d…`. `balanceOf(account, token)` for the fee-custody invariant.

### 2.2 Ledger semantics that drive display

`EscrowLib.lock` moves only the operator's exposure OUT of bankroll and grows
`locked` by the full payout (operator exposure + the player's own stake). So
`bankrollOf` is ALREADY net of locked. The idle, withdrawable balance IS
`bankrollOf`, not `bankrollOf − lockedOf`. Every headroom number in Backroom-B uses:

```
available = tableCap == 0 ? bankrollOf : min(tableCap − tableLocked, bankrollOf)
```

Note: the shipped `operator-ops.ts status` had this wrong (it subtracted `locked`
twice); the fix landed on 2026-08-13. Backroom-B and the CLI now agree.

### 2.3 Gaps — data no current event or view exposes

- **G1 — open-round enumeration.** No view lists Pending rounds per table. The
  dashboard derives the open set from the event stream (`RoundOpened` minus terminal
  events). The indexer becomes load-bearing for the pit board. No contract change.
- **G2 — withheld-validator identity.** `ForfeitRouted` and `onReverse` carry only
  the total forfeit, not WHICH validator withheld. The security room's most natural
  question — "who aborted my round?" — needs the `open()` calldata (the subset)
  decoded off-chain, diffed against Random-side cast events. Ship v1 without on-chain
  attribution; add the indexer calldata decode as a fast-follow.
- **G3 — per-round validator cohort.** `RoundOpened` omits the subset. Post-terminal
  cohort display needs the same G2 calldata decode.
- **G4 — fee-pool history.** `_chargeFee` and the fee restore emit no event. The
  `feeBalance` sparkline is poll-rate, not block-rate. The dashboard polls the view.
- **G5 — policy whitelist members.** `configOf` returns flags only; members live in
  `ConfigSet` calldata. The indexer decodes `setConfig` inputs.
- **G6 — operator metadata.** `MetadataSet` is event-only; the indexer keeps
  last-write-wins per operator.
- **G7 — retired-game history.** Five retired OperatorCoinFlip addresses hold real
  history (`943-operator-substrate.json` `operatorCoinFlipRetired`). The indexer
  must include them at their own start blocks, or the tape and P&L silently begin at
  the latest redeploy.

## 3. Architecture

Follow the two existing read patterns exactly; invent nothing.

- **Indexer (primary).** Extend the Ponder indexer (`games/indexer/ponder.config.ts`)
  with OperatorCoinFlip (plus the retired addresses at their own start blocks),
  GameEscrow, OperatorRegistry, and DefaultValidatorPolicy on 943, from block
  25121394. Store rows through the existing generic `store()` handler with a new
  `game: 'operator'` tag — the frontend already filters by `chainId + game` because
  event names collide across contracts. Deploy via the ansible runbook, never
  ad-hoc.
- **Frontend (games/web).** A `useBackroomData` hook mirroring `useChainData`:
  indexer GraphQL when configured, chunked `getLogs` fallback otherwise (POLL_MS
  12000, MAX_RANGE 10000, accumulate-only cache keyed by chain). Event state reduces
  through a pure `backroomIndex.ts` reducer in `games/web/src/lib/`, the same shape
  as `reduceTables`, unit-tested like `tablesIndex.test.ts`.
- **Spot-truth reads.** Each poll multicalls the views: `bankrollOf` / `lockedOf` /
  `rakeOf` / `feeBalance`, per-table `tableCap` / `tableLocked` / `tables`, and
  `Random.balanceOf(game, token)`. Views are truth; events are history. The
  reconciliation strip (4.8) renders any disagreement instead of hiding it. The
  reducer never silently "corrects" toward either source.
- **Placement.** A new full-page, non-immersive tab (`backroom`), joining the
  `live | standings | lobby` full-page set. Dense multi-panel data wants page
  scroll, not the immersive HUD. House rules apply: `Menu` / `Toggle` only, never
  native selects/checkboxes; table.css brass / Fraunces / Spline-mono design; heavy
  work off the main thread.
- **Scope.** Keyed to one operator at a time: default the connected wallet, with an
  address override via the house `Menu`. All data is public chain data, so no auth
  is claimed (see decision C7).

## 4. Panels

Safety classes: **SAFE-PRE** = renderable while a round is Pending. **POST-ONLY** =
renderable only after the round is terminal or decided-irreversible (section 5).

- **4.1 Floor overview** (SAFE-PRE) — a grid of table tiles: token, open/closed,
  min/max stake ladder, multiplier, cap, `tableLocked`, headroom, in-flight count,
  policy summary, last-activity age.
- **4.2 Bankroll & treasury** (SAFE-PRE) — per (operator, token): `bankrollOf`
  (labeled "idle / withdrawable"), `lockedOf` (labeled "escrowed payouts — includes
  player stakes"), `rakeOf`, `feeBalance`, a deposit/withdraw/rake history lane, and
  a "rounds of fee runway" estimate (`feeBalance ÷ (3 × top tierPrice)`).
- **4.3 The pit** (SAFE-PRE by construction) — the security-camera wall. One row per
  Pending round: table, player, side, stake, payout, exposure, tierPrice, age in
  blocks with a countdown to `STALE_BLOCKS=200`, and a status lamp: `pending` →
  `decided — settling` → off the board on terminal. Shows POSITIONS, never OUTCOMES:
  no reveal progress, no validator cohort, no predicted result, no Random-state
  drill-down for the round's key. This is the panel section 5 exists for.
- **4.4 Settlement tape** (POST-ONLY) — a live feed of terminal events:
  `RoundSettled` (won/lost, payout, seed), `RoundRefunded`, `ForfeitRouted`, escrow
  `Settled` (rake). Newest first, cursor-paged. Full detail is fine here.
- **4.5 Exposure vs cap meters** (SAFE-PRE) — per table, a bar of
  `tableLocked / tableCap` (uncapped shows "∞"), plus a shared-pool bar: Σ exposure
  vs `bankrollOf`. Uses the corrected `available` formula from 2.2.
- **4.6 Incident panel** (POST-ONLY) — per table and window: forfeit count and
  volume (`ForfeitRouted`), plain-timeout refunds vs chop-routed refunds, rounds past
  stale with no seed, policy-change history. Per-validator abort attribution once
  G2/G3 land.
- **4.7 P&L and rake** (POST-ONLY) — win/loss volume, rake accrued, forfeit income,
  net operator P&L per token over selectable windows.
- **4.8 Reconciliation strip** (SAFE-PRE) — the security room watching itself:
  event-derived `tableLocked` vs the view; event-derived escrow ledger vs
  `bankrollOf + lockedOf + rakeOf`; `Random.balanceOf(game, token)` vs Σ
  `feeBalance`; indexer head vs RPC head. Green ticks or a loud amber drift badge.
- **4.9 Alerts lane** (SAFE-PRE, pinned) — round age ≥ STALE_BLOCKS with no seed;
  seed finalized but unsettled beyond N blocks; cap ≥ 90% used; fee runway < K
  rounds; idle bankroll below one max-tier exposure; reconciliation drift; indexer
  stale. Every alert fires on liveness/capacity facts, never on outcome material.

## 5. The information-leak boundary (the load-bearing property)

**Threat model.** Post-open, the operator has no unilateral abort lever: `setOpen`
gates only new opens, withdraw is bounded to idle bankroll, the full payout is
pre-locked, and settlement is permissionless. The only payout-prevention path is a
colluding validator that withholds its reveal — and withholding pays off exactly
when the coalition already knows the player would win. Reveal transactions are
public, so the last unrevealed validator can always compute the outcome. The
dangerous information is therefore: anything that identifies the live round's
validator cohort, its reveal progress, or revealed preimage material, before the
seed finalizes. A dashboard that showed "round X: 2 of 3 revealed, waiting on
validator V" would be a collusion console.

**The irreversibility point.** A round's outcome becomes unpreventable the moment
`randomness(key).seed != 0`: both abort paths then revert `TooEarly`, and the
pre-locked payout can only flow via `_settle`. Settlement is normally atomic with
seed finalization (`callAtChange = true`), so the decided-but-unsettled window is
rare (only when a `claim` is needed).

**The rule, precisely:**

1. Pre-seed (Pending, `seed == 0`): the dashboard may render the round's existence,
   tableId, player, side, stake, payout, exposure, tierPrice, `openedAtBlock`, age,
   and feeCharged. All of these are already published by `RoundOpened` and none is a
   function of any validator secret.
2. Pre-seed, FORBIDDEN: per-round validator identities or subset (even though
   recoverable from `open()` calldata), reveal counts or progress, revealed
   preimages, any Random-state drill-down keyed by the round's key, any computed or
   projected outcome, any mempool-derived signal. The indexer must not even STORE
   per-round pre-seed reveal-progress rows — what the backend never materializes, a
   UI regression cannot leak.
3. At seed finalization (`seed != 0`), the dashboard MAY compute and show the outcome
   (parity vs side), labeled "decided — settling" until `RoundSettled` confirms.
   Decision D2 sets this render point; the default is seed-finalized, because it is
   provably irreversible at that instant.
4. Post-terminal: everything, including seed, cohort, and forfeit attribution.

**Honesty clause.** Every forbidden item is public chain data; a motivated operator
can run its own watcher. Backroom-B's boundary is therefore not secrecy — it is (a)
refusing to build, host, and normalize the payout-prevention console under the
substrate's own brand, and (b) keeping the claim "the operator cannot rug players"
from being falsified by the operator's own official tooling. The real wall is
economic and structural, and it has a crack the dashboard must not paper over — see
C1.

## 6. Error, empty, loading, and scale

- Loading: skeleton tiles per panel; never a blank page. First indexer query is one
  paged GraphQL call, so first paint is fast.
- Indexer down: fall back to chunked `getLogs` from `deployBlock`, with a visible
  "degraded — reading chain directly" badge. Never fail closed to an empty
  dashboard.
- RPC hiccups: the valve RPC intermittently returns "all upstream attempts failed";
  retry transients, surface a stale-data badge with the last-good block, keep
  rendering the cache.
- Reorgs: the browser cache is accumulate-only (Ponder handles reorgs server-side).
  State this in a tooltip; the reconciliation strip catches residual drift.
- Empty: unregistered operator → onboarding explainer; zero tables → "no tables
  yet"; zero fee pool → an alert (every `open()` will revert `InsufficientFees`).
- Scale: table list from one indexer aggregate; per-table views batched in one
  multicall per poll (2 reads/table, cheap to ~100 tables); pit and tape virtualized
  with cursor pagination; poll cadence stays 12 s regardless of table count.

## 7. Testing

1. **Reducer unit tests (vitest)**, like `tablesIndex.test.ts`: replay
   open/settle/forfeit/refund; assert derived `tableLocked` returns to 0; assert the
   open-set derivation; assert headroom math against EscrowLib semantics.
2. **Leak-boundary tests — the adversarial core.** (a) Type-level: the pre-seed round
   view type has no outcome/reveal/cohort fields, so a rendering regression is a
   compile error. (b) Runtime: feed the reducer a full round history and assert the
   Pending projection deep-contains no seed, no `won`, no validator addresses.
   (c) Indexer: assert no handler stores reveal-progress. (d) A red-team snapshot:
   serialize everything the pit board renders for a Pending round and diff it against
   the `RoundOpened` args whitelist.
3. **Reconciliation tests:** run against a recorded 943 event fixture plus mocked
   view reads; inject drift; assert the amber state, never silent correction.
4. **Browser verification (house rule):** Playwright screenshots of every state —
   loading, degraded, empty, populated, drift — wallet-gated states DOM-injected.
5. **Live-943 proof:** run `qa-operator-coinflip.ts MODE=all` while the dashboard
   watches; assert the pit shows the QA rounds in flight with no outcome, the tape
   shows the settle and the forfeit after, and the meters match `operator-ops.ts
   status`.
6. **Indexer integration:** Ponder against 943 from block 25121394 including retired
   addresses; assert event counts match a direct `eth_getLogs` sweep.

## 8. Contradictions and decisions

**C1 — the forfeit destination undermines the leak boundary (substrate-level, the
big one, flagged for 369).** The forfeit routes into the operator's own bankroll
(`_routeForfeit` line 354), and `requireOperator` is only satisfiable when the
operator is itself an allowlisted validator (`DefaultValidatorPolicy.validate` lines
68–73 require the operator's address in the subset, and the hard floor requires every
member be allowlisted). For an operator that runs its own validator, a selective
abort is coalition-cost-free: the validator's slashed tierPrice returns to the
operator's own bankroll, the player gets only the stake back, and the operator keeps
the exposure it would have paid on a win. This reintroduces the validator-abort
free-roll the session closed. Today's containment is that `addValidator` is
owner-gated, so msgboard curates the validator universe. No dashboard rule fixes
this — the colluding validator computes the outcome itself. **Owner decision before
369 (tracked as task #42):** (i) forfeit destination on real-money tables — operator,
player, split, or burn (routing to the player would make abort weakly worse than
paying, since stake + tierPrice ≥ payout at 1.5–2× multipliers); (ii) whether
`requireOperator` is permitted on real-money tables; (iii) whether operator-run
validators are allowlisted at all. Backroom-B assumes the boundary matters; C1
decides whether it holds.

**C2 — "see what the players are doing" vs "the house must not know."** Resolved:
Backroom-B shows POSITIONS in flight, never OUTCOMES. A real security room watches
the floor but cannot see the next card. The coin flip is not zk, so the outcome is
public the instant the last reveal lands; the zk-results rule as applied here means
"Backroom-B adds zero outcome-relevant computation pre-finality." Making outcomes
cryptographically unknowable pre-settlement needs the deferred threshold-seed Random
change.

**C3 — backroom-A's read layer disagreed with itself (bug, FIXED 2026-08-13).** The
CLI `status` computed `idle = bankroll − locked`, double-counting exposure. Fixed to
`idle = bankroll`. Backroom-B uses the corrected formula (2.2); the two read layers
now agree.

**C4 — spec vs CLI: open-round count.** The backroom-A spec promised an open-round
count in `status`; the CLI omits it (no view exposes it, G1). Backroom-B delivers it
via the indexer. Decision: the CLI may gain an indexer-backed count later, or the
claim is dropped. Non-blocking.

**C5 — missing validator attribution (decision).** "Which validator aborted" needs
G2/G3 data the events do not carry. **Default: ship Backroom-B v1 without on-chain
attribution; add the indexer calldata decode as a fast-follow.** A redeploy that adds
subset/attribution to events is a larger change that touches live-943 continuity and
overlaps the slice-B attestor effort; keep it out of v1.

**C6 — read-only purity (decision).** A live "cap 97% used" meter begs for a "raise
cap" button, which would collapse the A/B separation. **Default: Backroom-B stays
strictly read-only; at most it renders the exact `operator-ops.ts` command to copy.**

**C7 — audience and hosting (owner's product call).** Everything Backroom-B renders
is public chain data. Options: (a) a public tab on games.msgboard.xyz — doubles as a
radical-transparency trust surface ("watch the books live"), but hands every player a
surveillance view of every other player's positions and P&L at real stakes; (b) an
operator-scoped tab (default to the connected wallet, no gating pretense); (c) a
separate operator app. **Default for the build: operator-scoped tab (b), behind a
config flag so a public transparency view (a) can be enabled later without
rearchitecting.** Owner confirms before any public exposure.

**C8 — 369 rollout dependencies.** The operator substrate is not on 369; the
production cast-watcher fleet still runs pre-forfeit code; the indexer currently
indexes zero operator contracts. Backroom-B is chain-config-driven (addresses from
the deployment JSON per chain; absent → tab hidden), and its indexer addition rides
the ansible runbook. Order: indexer first, Backroom-B against 943, then 369 after the
fleet operationalization. Backroom-B is not on the 369 critical path.

**Small decisions:** D1 poll cadence = 12 s (house pattern). D2 outcome render point
= seed-finalized "decided — settling" (provably irreversible). D3 reconciliation
strip stays single-operator in v1.
