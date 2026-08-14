# Operator assets program — design

Status: DESIGN, decisions locked (2026-08-13). Designed with two fable passes;
contradictions hunted adversarially. No code written yet. This is a PROGRAM spec —
it decomposes into slices, each of which gets its own implementation plan and its own
943 proof.

## 1. What this builds

Two related systems, delivered together (the owner chose "both together"), on
testnet 943 first, then mainnet 369 after the gates below hold.

- **System 1 — operator theming (cosmetic).** An operator sets the visual theme of
  the games it runs. Pure cosmetics; it never changes a number in the money path.
- **System 2 — tradeable bonus assets (functional).** A consumable ERC1155 "edge
  chip": one unit buys one boosted round, where the holder gets a better payout
  multiplier (the house edge narrows, clamped at the zero-edge point). Charges trade
  like any token.

The two systems share exactly one thing — the asset-representation abstraction
(§6). Otherwise they are isolated: a theme can never change a number, and a bonus can
never change a pixel of trust chrome.

## 2. Locked decisions

1. **Scope:** both systems in v1; the fairness/solvency gates are resolved inline,
   not deferred.
2. **Forfeit routing → neutral sink.** The validator forfeit no longer routes to the
   operator's own bankroll. It routes through a pluggable fee policy to a neutral
   sink (burn or buyback) that can never be a round participant. This closes the
   operator-run-validator win-denial hole and resolves the standing 369 gate (task
   #42).
3. **Charges are collateralized.** An outstanding charge is always fully backed by
   escrowed worst-case boost exposure; an operator cannot sell charges and then
   withdraw the capital that honors them. Charges expire so backing can release.
4. **Fees are pluggable.** Fee handling is a seam, not a hardcoded cut. Any
   fee-producing contract points at an `IFeePolicy` that decides whether there is a
   fee, how much, and where it goes (burn / buyback / recipient / nothing). The
   operator is the house and already earns rake + the house edge from play, so there
   is no bolted-on "operator royalty" knob. The buyback is one policy implementation.

## 3. Program invariants (must hold at every slice)

- **I1 — settlement seam untouched.** `GameEscrow` is not modified by the bonus
  mechanism. The boost only makes `payout` a larger argument to the existing
  `lockExposure`; the ledger math is already payout-agnostic.
- **I2 — provably fair, commit-at-open.** Every result stays recomputable from the
  sealed round. The boost (effective multiplier and charge consumption) is committed
  inside the same `open` transaction that creates the randomness request — there is
  no block in which the outcome is knowable and the bonus is still mutable.
- **I3 — bounded odds.** Effective multiplier is clamped to `MULT_MAX = 200` (a fair
  coin's zero-house-edge point). No boosted table can become a guaranteed-drain
  faucet. No `MULT_MAX` change in v1.
- **I4 — the boost exposure of every outstanding charge is always backed.** The
  backing pool holds, at all times, at least the worst-case boost exposure of all
  outstanding charges (§5.3). This does NOT cover the price a buyer paid for the
  charge — see the purchase-price posture in §5.3 (F5). So the honest claim is
  narrower than "the operator cannot rug players": in-flight rounds cannot be rugged,
  and a sold charge's *boost payout* is always funded, but the *purchase price* is
  operator credit whose rug posture §5.3 states explicitly.
- **I5 — the forfeit sink is never a round participant, given an honest game owner.**
  This is a trust assumption, not an on-chain-enforceable absolute: participants are
  per-round and dynamic, while the policy is a static owner-set contract whose
  internal forwarding the game cannot inspect. It is enforced the same way the
  validator allowlist is (owner curation, `GameBase.addValidator` is owner-gated),
  narrowed by an immutable policy menu: the game accepts only fee-policy addresses
  from an owner-deployed, immutable allowlist, and policy-parameter changes are
  timelocked (§4.1). An operator can never set the forfeit sink.
- **I6 — trust chrome is unskinnable.** Themes apply only through an allowlist of
  named skin points. The ◈ seal, fairness strip, all amounts/odds/multipliers, and
  alert lanes are outside the allowlist and cannot be themed.
- **I7 — pre-Cancun deployability.** Every new contract compiles solc 0.8.25 /
  `evmVersion: shanghai`, emits no MCOPY/TSTORE (verified on stripped bytecode — the
  CBOR-metadata trailer gives false MCOPY hits), and fits EIP-170.

## 4. Foundation slice (Slice 0) — pluggable fees + neutral-sink forfeit

This slice is built first: it is the smallest, it is a standalone fairness win, and
it resolves the 369 gate (task #42) independent of the rest of the program.

### 4.1 `IFeePolicy` seam

```solidity
interface IFeePolicy {
    /// @return bps the fee in basis points for this context (0 = no fee)
    function feeBps(bytes32 kind, address token, address payer) external view returns (uint16 bps);
    /// @notice Take `amount` already delivered to this policy and route it (burn / buyback / recipient).
    ///         MUST NOT send to any address named in `context` as a round participant.
    function route(bytes32 kind, address token, uint256 amount, bytes calldata context) external;
}
```

- View-first: fee-producing contracts read `feeBps` to compute the cut, transfer the
  cut to the policy, then call `route`. Mirrors the `IValidatorPolicy` staticcall
  hook pattern already in the substrate.
- `kind` distinguishes call sites (`"forfeit"`, `"mint-sale"`, `"marketplace"`) so
  one policy can price each differently.
- Default implementations: `BurnFeePolicy` (send to `0xdead` / call `burn`),
  `BuybackFeePolicy` (accumulate per token; a keeper runs `swap(minOut, deadline)`
  batched, never inline — inline swaps are sandwich bait; buyback token is config,
  differs 943 vs 369), `RecipientFeePolicy` (forward to a set address).
- **Governance (C7, and I5's menu).** A `FeeRouter`/policy that accumulates fees
  pre-buyback is the first protocol-held pot. It holds no player money (invariant
  preserved) but its owner is a target. v1: the game/marketplace/mint-sale accept
  only fee-policy addresses from an owner-deployed, **immutable allowlist (the policy
  menu)**; policy-parameter changes are timelocked; the owner key is documented per
  the deployer-key hygiene rule. Not on the money path of any round.
- **Safety of the seam (F11).** Call sites clamp `feeBps` to a platform max
  (`bps ≤ 1000`, i.e. ≤10%) before applying it — a `uint16` policy could otherwise
  return 65535. Every call site defines its behaviour when no policy is set at deploy
  (the forfeit site defaults to straight burn, never "brick"; see §4.2). Burn
  transport is per-token, not a global `0xdead` transfer — some tokens block dead-
  address transfers or lack `burn`.

### 4.2 Neutral-sink forfeit re-route

Change `OperatorCoinFlip._routeForfeit` (currently deposits the forfeit into the
operator bankroll): the fee-restore to the operator stays; the punitive forfeit
(`chopCredit − fee`) goes to a neutral sink via the forfeit `IFeePolicy`
(`kind = "forfeit"`). `refundStale`'s chopped branch follows the same path (it
already delegates to `_routeForfeit`).

**The policy must NOT sit on the player-refund critical path (F3).** `_routeForfeit`
also refunds the player, and both abort paths funnel through it, so a reverting or
gas-guzzling policy would freeze every chopped round's stake, for all operators.
Required ordering and safety:
- refund the player's stake and release exposure FIRST; route the forfeit LAST;
- wrap the `route` call in `try/catch` — on failure, park the forfeit in a local
  `unrouted[token]` ledger and emit an event; a separate permissionless
  `sweepForfeit(token)` retries the route. The refund never depends on the sink;
- the forfeit-policy pointer is owner-mutable (recovery from a bad policy), drawn
  only from the immutable policy menu (§4.1, I5);
- **unset default = straight burn**, never "brick" — the new game version is never
  refund-frozen in the gap between deploy and `setFeePolicy`.

**Selective-abort EV — the honest statement (F4).** Deny-value of an aborted round =
the operator's exposure = `stake × (eff−100)/100 ≤ stake` for `eff ≤ 200`; validator
stake `tierPrice ≥ stake` by ladder construction, so an operator-run validator that
aborts loses `tierPrice ≥ stake ≥ deny-value` to the sink — at-least-break-even at
every boost level ≤ 2.0× (another reason not to raise `MULT_MAX`). BUT the pair's
margin is **zero, not strictly negative, at tier boundaries** (`tierPrice == stake`
when the stake sits on a tier, incl. `minStake`). And on a boosted round, returning
the charge on a chopped refund (§5.1) would tip that boundary case to *profitable*
(pair keeps stake + the charge a settled loss would have burned). Therefore:
- **On a chopped refund, BURN the charge** (do not return it); return the charge only
  on a plain timeout where no validator withheld. This removes the boundary-case
  profit.
- The forfeit only bites if a chop actually lands in the window, and third parties
  have no incentive to call chop (credits go to the sink, not the caller). So an
  operator/keeper **chop-bot that lands the chop within `STALE_BLOCKS` is a HARD
  rollout gate** for real-money bonus tables — promoted from an open item.

- **Trade-off (accepted by the owner).** The honest operator loses its former
  consolation for a third-party validator abort. The owner chose closing the denial
  button over that compensation.
- Custody invariant is preserved: the fee restore stays internal to `feeBalance`; the
  forfeit still leaves Random custody by exact `handoff`; only the post-handoff
  destination changes. The QA assertion "forfeit credited to operator bankroll"
  inverts (§8.3).
- Ships on the same new OperatorCoinFlip version as System 2; applies to all operator
  tables, so the 369 fairness fix is general.

## 5. System 2 — the bonus economy

### 5.1 Mechanism: consumable payout-boost charge

- Bonus = a payout-multiplier boost (fable mechanism A — the only one where
  `GameEscrow` is byte-identical, satisfying I1). Result derivation stays `seed & 1`;
  only the pre-committed `payout` grows. `eff = min(base + bonusPoints, MULT_MAX)`.
- The asset is a **consumable ERC1155** (Solady base, vendored, TSTORE-free). `id` =
  a series with fixed `(bonusPoints, maxStake, expiry)`. Balances are fungible
  charges; one unit = one boosted round.
- Lifecycle: `openBoosted` pulls **1 unit into game escrow** (escrow-then-burn, so
  the refund path needs no mint authority). On `_settle` (win or lose) the unit is
  **burned**. On a **plain-timeout** refund (no validator withheld) the unit is
  **returned** to the player (they paid for a boosted round and did not get one). On a
  **chopped** refund (a validator withheld) the unit is **burned**, not returned — see
  F4 in §4.2: returning it there would make selective abort profitable at tier
  boundaries. The charge return/burn mirrors `_releaseTableExposure`'s exactly-once
  discipline (three terminal paths; `refundStale` delegates to `_routeForfeit` when a
  chop credit exists), and the return is the LAST interaction in its path so the
  player's `onERC1155Received` cannot reenter mid-refund (F10).

### 5.2 Why consumable (anti-abuse, I2/I4)

- **Flash-loan: dead.** The unit leaves the borrower at open and returns/burns only
  at a later block's terminal transition — unrepayable within the open tx.
- **Stacking / sybil: irrelevant.** The charge is spent per round; buying more is the
  intended behavior. One series ref per open; `min(…, MULT_MAX)` clamps regardless.
- **Liability is bounded.** A series of N charges has a finite ceiling
  `N × maxStake × bonusPoints / 100` — the number that makes collateralization
  (I4) computable.
- **No trade-mining, ever.** The bps fee is a pure cost; adding any reward would
  create a wash-farm.

### 5.3 Collateralization (decision 3, I4)

**The backing pool is a separate token-holding contract (pins the F2 mechanism).**
`GameEscrow` stays byte-identical (I1), which has exactly ONE compatible way to fund
the boost: an external backing pool holds the operator's earmarked tokens, and
`openBoosted` injects the boost delta into escrow atomically at open —
`pool.consume(series, boostDelta)` → `GameEscrow.depositBankroll(operator, token,
boostDelta)` → `lockExposure(...)`, all in one transaction. The base exposure flows
from the operator's own bankroll as today. This makes a boosted WIN liquid: the full
payout sits in `locked` at open, so `settleWin` pays from it. A "virtual earmark"
that never moves tokens into escrow would leave `settleWin` short — forbidden.

**Earmark lifecycle (F1 + F8, exact):**
- **Mint = earmark.** The house `BonusChips1155` mints ONLY via the earmarking
  mint-sale (F6). Minting N units of a series locks `N × maxStake × bonusPoints/100`
  into the backing pool. No other mint path exists, so an unbacked charge cannot
  circulate.
- **Debit at open, not at burn.** `openBoosted` debits that charge's earmark unit at
  open (when the boost delta is injected). Debiting later would let a time-based
  expiry release free backing an in-flight round already spent (a double-free).
- **Re-earmark on refund (F1 — the CRITICAL fix).** On any refund of a boosted round,
  `EscrowLib.refundExposure` returns the FULL exposure (base + boost delta) to the
  operator's bankroll. The boost delta must NOT stay in withdrawable bankroll — the
  game re-injects it into the backing pool as a fresh earmark for the (returned or
  burned) charge, symmetric with open. Without this, an ordinary stale round leaks
  backing into `bankrollOf`, the ops CLI sweeps it, and I4 self-violates with no
  attacker. (On a chopped refund the charge is burned per §5.1, so the re-earmark is
  released immediately; on a plain timeout the charge is returned, so the re-earmark
  persists.)
- **Residual release on burn.** Earmark per charge is the worst case
  `maxStake × bonusPoints/100`; the actual draw at open is
  `stake × bonusPoints/100 ≤` that. Release the residual to the operator when the
  charge burns, or backing over-accumulates and strands operator capital.
- **Exactly-once.** Earmark debit/credit mirrors `_releaseTableExposure`'s
  exactly-once discipline across the three terminal paths.
- **Live-earmark check (F6).** `openBoosted` requires a live earmark for
  `(collection, id)` in the platform backing pool — which structurally restricts the
  `series.collection` an operator may set to the house contract, and closes the
  "vanity 1155 with zero earmark" hole.

**Invariant (I4):** `Σ backing-pool balance ≥ Σ worst-case boost exposure of all
outstanding charges`, at rest and after every path. An operator that goes idle or
withdraws bankroll cannot strand a sold charge's boost payout.

**Expiry + the purchase-price posture (F5).** A series carries an expiry timestamp;
`openBoosted` reverts on an expired charge, and its earmark releases on expiry so
capital can free up. But the earmark covers only boost EXPOSURE, never the PRICE the
buyer paid — an operator can close the table / zero the series / starve the fee pool,
make charges unspendable, and recover the earmark at expiry while keeping the sale
proceeds. That is a real purchase-price rug I4 does NOT cover. v1 posture (owner may
change, §9): mint-sale proceeds **vest against burns** (the operator receives sale
proceeds as charges are actually consumed, not up front), so an operator that never
lets charges be spent never collects. Backing released at expiry for a series that
was made unspendable routes to holders pro-rata rather than to the operator.
Disclosure-grade UI states the credit risk regardless. Default expiry 90 days (§9).

### 5.4 Contract shape (new OperatorCoinFlip version)

- `struct BonusSeries { address collection; uint256 id; uint16 bonusPoints; uint256 maxStake; uint64 expiry; }`
  set per table via `setBonusSeries(tableId, …)` gated `onlyOperator(tableId)`
  (mirrors `setTableCap`/`setValidatorPolicy`). Opt-in is mandatory and already
  structurally forced — only the operator's bankroll funds exposure and only the
  operator authorizes the game at the escrow.
- `openBoosted(tableId, side, stake, seriesRef, minEffMult, subset, locations)` =
  `open()` plus: `require stake ≤ series.maxStake`; `require now < series.expiry`;
  `eff = min(base + bonusPoints, MULT_MAX)`; **`require eff ≥ minEffMult`** — the
  player's commit against an operator front-running `setBonusSeries` to shrink the
  bonus (F7, the `minOut` idiom); **`require eff > base`** so a charge is never burned
  for zero boost at a 2.0× table (F11); pull 1 charge (CEI: after the round struct
  write, before the pool-inject + `lockExposure`); append `(collection, id, effMult)`
  to the Round struct **at the end** (the appended-index rule keeps the caster/QA
  tuple layout stable). Plain `open()` stays byte-for-byte for non-boosted rounds.
- `BoostApplied(roundId, collection, id, effMult)` for the indexer; `RoundOpened`
  already carries `payout`, so `eff` is recomputable as `payout×100/stake`.
- The game implements `onERC1155Received`; `openBoosted` gets the house SSTORE-mutex
  `ReentrancyGuard` (the 1155 receiver is a new reentry surface; Solady's TSTORE
  guard is undeployable pre-Cancun).
- **EIP-170 (F11 — not tight).** OperatorCoinFlip is currently 10,330 of 24,576
  deployed bytes (~14KB headroom; the "squeezed" contract was HoldemTableN, not this
  one). Boost + 1155-receiver + `setTheme` fit comfortably. Keep the size test in the
  build, but do NOT let size fear drive the design. A `BonusConfig` side-contract read
  by staticcall stays available as an optional factoring; if used, the read is atomic
  with commit, so it introduces no post-outcome race.

### 5.5 Sale + marketplace

- **Primary sale (load-bearing fee).** A mint-sale contract sells charges; most
  volume is primary (charges are consumables, like chips at a cage). The mint-sale
  earmarks backing (§5.3) and takes the fee via `IFeePolicy` (`kind = "mint-sale"`).
- **Secondary (house marketplace).** A minimal fixed-price list/buy/cancel escrow;
  fee via `IFeePolicy` (`kind = "marketplace"`). ERC-2981 royalty is advisory only;
  do not build transfer-hook enforcement (it breaks composability and fights the
  game's escrow-then-return transfers). Off-venue secondary leakage is accepted.

## 6. System 1 — operator theming + the `AssetRef` abstraction

### 6.1 Equip mechanism (reuse existing seams)

- **Operator-level theme** (all of an operator's tables): reuse
  `OperatorRegistry.setMetadataURI` — event-only (`MetadataSet`), `onlyRegistered`,
  zero on-chain consumers today. The metadata JSON grows a `theme` key. **Zero new
  Solidity.** Ships first, against the existing games UI.
- **Per-table theme override:** mirror the `setName`/`TableNamed` precedent —
  operator-gated, event-only, length-capped (≤256 bytes for a theme URI vs 64 for a
  name), last-event-wins. Add `setTheme(tableId, uri, contentHash)` + `TableThemed`
  to the new OperatorCoinFlip version (folded into the same redeploy). `contentHash`
  binds the off-chain manifest so a CDN swap can't change a live table's art.

### 6.2 `AssetRef` — one type, four representations (shared by theming + bonus art)

```
AssetRef { kind: declarative | media | erc1155 | generative; pointer; contentHash }
```

| kind | storage | integrity | execution risk | allowed on |
|---|---|---|---|---|
| declarative | inline (data:, ≤~1KB) | inherent | none | everything, incl. trust-adjacent tier palettes |
| media | IPFS/CDN | CID / contentHash | none (`<img>` only) | all skin points except trust chrome |
| erc1155 | token metadata → media | contentHash of resolved | none (rendered as media) | as media |
| generative (on-chain js/html/svg) | contract `render()` | hash of returned bytes | HIGH | player's own bonus art + ambient/backdrop layers; NEVER trust chrome, NEVER autoplaying table-global |

### 6.3 Skin points, trust chrome, sandboxing

- Skin points (enumerated in the plan): felt color/texture, backdrop, card-back art,
  chip/coin faces, table plaque, accent palette, wheel-wedge / drop-board tints
  (declarative-only — color encodes payout tier; keep the tier→hue mapping and the
  legend), lobby tile art, ambient layer.
- **Trust chrome is unskinnable (I6):** the ◈ seal (renders above any themed art),
  the fairness strip / trust badges / how-it-works, all amounts/odds/multipliers/
  receipts/seed proofs, alert lanes, wallet + network chrome. Enforced by allowlist,
  not blocklist. Declarative palettes are contrast-validated client-side; a failing
  palette falls back to the house theme entirely.
- **Sandboxing:** declarative → CSS custom properties (no execution). media / erc1155
  → `<img>` only (SVG via `data:` img neuters scripts). generative → sandboxed
  `<iframe sandbox="allow-scripts">` (no `allow-same-origin` → opaque origin, no
  storage), CSP `default-src 'none'`, no network, `postMessage` carries only
  `{w,h,theme}` — never wallet/round data. On table-global surfaces generative
  content renders as a static poster until the viewer clicks to activate;
  `prefers-reduced-motion` keeps it static. Hash verification and heavy decode run in
  a worker, never the main thread.

## 7. Player UI dependency (important scope note)

OperatorCoinFlip has NO player-facing web UI today — only QA scripts drive it. System
2's buy-charges / open-boosted flow and per-table theming both need that UI to exist.
So the program includes building the OperatorCoinFlip player screen (on the shipped
stage-surface architecture), or that screen is a prerequisite slice. Operator-level
theming (§6.1) is the exception — it applies to the existing games UI and can ship
without the operator-game screen.

## 8. Rollout and reprove (943 first)

1. **943 build order:** Slice 0 (IFeePolicy + neutral-sink forfeit) → `BonusChips1155`
   + backing pool + mint-sale + marketplace (no Random interaction) → new
   OperatorCoinFlip version (openBoosted + setTheme + neutral-sink forfeit) → operator
   game player UI + theming renderer → QA extension.
2. **Redeploy discipline** (from the substrate/forfeit memories — these bite
   otherwise): new game address → retire the old into `operatorCoinFlipRetired`; keep
   `heatsSince` counting so the shared pool doesn't desync; players re-run
   `setPlayerGame(newGame,true)`, operators re-`authorizeGame` + `setBonusSeries`;
   shanghai per-file override on every new contract; stripped-bytecode MCOPY check;
   deploy via the ansible runbook; use the valve RPC (the public 943 RPC quotes a
   bogus 10000-gwei gas price); check the `op` session first (an expired session
   hangs deploys silently).
3. **Reprove on 943 (extends `qa-operator-coinflip.ts`):** buy charges → openBoosted
   → settle win and loss (assert boosted payout, charge burned) → refund path returns
   the charge → forfeit routes to the neutral sink (assert operator bankroll is NOT
   credited, sink is) → solvency invariant holds with boosted exposure → backing pool
   fully backs outstanding charges → collateralization blocks an over-withdraw. Then
   a bot soak.
4. **369 gates:** the operator substrate's own 369 gate (fleet operationalization)
   plus decision 2 (neutral-sink forfeit, now built) and decision 3
   (collateralization, now built). Real money touches System 2 only after the 943
   reprove is green and slice-B reputation exists for disclosure-grade surfaces.

## 9. Remaining open defaults (owner may override; otherwise these ship)

- **Bonus magnitude cap:** platform-wide `bonusPoints ≤ 25` (max +0.25× toward the
  2.0× ceiling). Prevents a single charge from erasing most of the edge at once.
- **Which games:** coin flip only in v1 (the only escrow-backed operator game).
  Standing rule for future games: bonus mechanisms must be payout-side only,
  escrow-untouched.
- **Charge expiry:** 90 days default.
- **Fee bps defaults:** primary-sale 100–250 bps; house-marketplace secondary
  50–100 bps; forfeit sink 100% burn (or buyback). All read through `IFeePolicy`, so
  changeable without a game redeploy.
- **Buyback token:** deferred to the fee-policy config (943 vs 369 differ). The
  earlier PLSX/PLS/PRVX choice becomes a policy parameter, not a hardcoded default;
  PRVX liquidity on 943 is unverified and may need a stub pool to rehearse.

## 10. Contradictions — resolved vs residual

Resolved by the locked decisions: C2 win-denial (→ neutral sink), C1 rug-vs-charges
(→ collateralization), C8 fee model (→ pluggable `IFeePolicy`). Structural: I1 keeps
the settlement seam untouched; I3 keeps odds bounded; I6 keeps trust chrome
unskinnable.

Residual, tracked into the plans and the 369 gate:
- **Charge-holder liveness (C6):** an operator can stop funding the fee pool and
  block boosted opens even with backing present. The backing/mint-sale design must
  also front the per-open fee, or `openBoosted` must degrade gracefully. Resolve in
  the bonus-economy plan.
- **Non-uniform payouts (C3):** two players at one table get different payouts for
  the same bet. The UI must show the holder's effective multiplier pre-bet and the
  discovery card must show base + boosted range. A UI/disclosure requirement, not a
  fund-safety one.
- **Buyback MEV / keeper trust (C9):** batched keeper swaps with `minOut` are
  sandwich-resistant but keeper-trusted. A fee-policy implementation detail.
- **Generative-asset moderation (C4):** the substrate stays neutral; de-listing lives
  in the discovery layer (slice-B), the viewer's kill-switch in the client. Default:
  media/declarative only on table-global surfaces at launch; generative in a
  fast-follow once the sandbox ships.

## 11. Plan-level carry-overs (from the fable red-team, 2026-08-13)

These are settled at the design level above; the implementation plans must pin them
verbatim, with tests:

- **1155 reentry (F10).** `claim()` currently has no `nonReentrant`; returning a
  charge to a contract player fires its `onERC1155Received`. Rule: the charge
  return/burn is the LAST interaction in every terminal path (after
  `GameEscrow.refund`/settle), and `openBoosted`/`claim` carry the house SSTORE
  `ReentrancyGuard`. Decide guard coverage for `claim` explicitly in the plan.
- **No 1155 balance-delta accounting (F10).** Anyone can push charges at the game's
  receiver. Track escrowed units per round by EXACT pull only — never infer from a
  balance delta (unlike the ERC-20 `_pullVerified` idiom).
- **Caster / QA assumptions (F11).** Boosted rounds break any off-chain assertion of
  `payout == stake × table.maxMultiplierX100 / 100`; `eff` from `RoundOpened.payout`
  now exceeds the table multiplier on boosted rounds. Audit `qa-operator-coinflip.ts`
  and the cast-watcher for that assumption before the redeploy.
- **feeBps clamp + burn transport + unset default (F11).** Enforced at every
  `IFeePolicy` call site (see §4.1/§4.2): clamp `bps ≤ 1000`; per-token burn
  transport; forfeit-site unset default = burn, never brick.
- **`_tierPrice` boundary (F4).** The plan's forfeit/charge tests must include a
  `stake == minStake` (tier-boundary) case, where `tierPrice == stake`, to prove the
  chopped-refund charge burn removes the boundary-case profit.
