# Fund-stack security re-audit — operator/bonus economy (pre-369 gate)

Date: 2026-08-17. Scope: the casino fund custody + accounting stack as one system.
Method: source + test read only. No build, no deploy, no file edits.
Chain state: the operator substrate is 943-testnet only; it is NOT on 369.

Files audited (all under `games/contracts/contracts/`):
`games/operator/GameEscrow.sol`, `EscrowLib.sol`, `GameBase.sol`,
`games/operator/OperatorCoinFlip.sol`, `BackingPool.sol`, `BonusChips1155.sol`,
`MintSale.sol`, `Marketplace.sol`, `BurnFeePolicy.sol`, `OperatorRegistry.sol`,
`OperatorBond.sol`, `OperatorVault.sol`, `OperatorVaultFactory.sol`,
`DefaultValidatorPolicy.sol`, `ReentrancyGuard.sol`, `Chips.sol`, and the interfaces.
Tests read for regression confirmation: `test/foundry/BackingPool.t.sol`,
`MintSale.t.sol`, `OperatorCoinFlip.t.sol`, `OperatorAssetsE2E.t.sol`,
`OperatorCoinFlipBoosted.t.sol`. Off-chain read: `games/e2e/scripts/operator-ops.ts`.

---

## 1. Verdict on each prior finding

### CRITICAL — expireCharges "P2 break" — CLOSED
`BackingPool.expireCharges` now carries two independent guards that stop a
permissionless double-release of backing:
- `if (holder == game) revert HolderIsGame;` — `BackingPool.sol:312`.
- `if (n > circ[seriesId]) revert CircShort;` — `BackingPool.sol:315`. The
  game-held (in-flight) charge is excluded from `circ` (`consume` does
  `circ -= 1`, `BackingPool.sol:214`), so a keeper can never de-earmark more than
  the circulating supply.
- Post-state P2 is enforced on-chain, not just in tests: `_assertBacked(seriesId)`
  reverts the whole tx if `earmark != circ*w` (`BackingPool.sol:145-147`, called at
  `327`).
Regression test: `BackingPool.t.sol:375` (`test_expireCharges_cannotBurnGameHeldCharge`)
exercises both guards and re-asserts the invariant.

### operator-run-validator forfeit reopening (validator-abort free-roll) — CLOSED (at the contract level)
The forfeit no longer routes to the operator. `_routeForfeit` hands the withheld
stakes off from Random custody and routes them to the owner-set neutral sink
`forfeitPolicy` (`OperatorCoinFlip.sol:595-602`, `_routeForfeitToSink` at `612-625`,
`_deliverAndRoute` at `631-635`). The sink is menu-restricted and defaults to
`BurnFeePolicy` (constructor `174-182`, `setForfeitPolicy` `186-190`); an operator can
never set it. Economic proof holds for boosted rounds too: on a chop the operator only
recovers its own capital (fee restored, bet-A exposure returned, `credit += w` is its
own deposited backing), while the withholder's forfeit (`>= tierPrice >= stake >=` the
avoided base exposure `x`) is burned — a selective abort is strictly negative-EV.
Regression: `OperatorCoinFlip.t.sol:275, 467`; `OperatorCoinFlipBoosted.t.sol:524`.
Residual is a pure governance decision (task #42: are operator-run validators allowed
on real-money tables) — not a code defect. See go/no-go item G1.

### chop-harvest — CLOSED
The chop terminal burns the charge with the round's player as the price beneficiary:
`bonusChips.burnWithBeneficiary(address(this), sid, 1, r.player)`
(`OperatorCoinFlip.sol:606`). In `MintSale.onBurn` the `game`-plus-`beneficiary` branch
routes the full price to `refundable[beneficiary]` and vests NOTHING to the operator
(`MintSale.sol:227-230`). So an operator that forces a chop cannot harvest `P`.
Regression: `MintSale.t.sol:288` (`test_chopHarvest_operatorGetsNothing`),
`OperatorAssetsE2E.t.sol:345`.

### C3 — operator-ops status headroom double-count — CLOSED
`games/e2e/scripts/operator-ops.ts:184` sets `const idle = bankroll` and the comment at
`181-183` explains that subtracting `locked` would double-count (exposure already leaves
`bankroll` at lock time — see `EscrowLib.lock`, `EscrowLib.sol:32-36`). The `withdraw`
command uses the same corrected basis (`operator-ops.ts:118-120`).

### C1 — purchase-price credit risk — CLOSED (at the contract level)
The purchase price never enters `GameEscrow` or `BackingPool`. `MintSale.buy` pulls the
gross price into the MintSale's OWN balance and books it to `escrowed[s]`
(`MintSale.sol:188-192`); backing is a separate pull inside `pool.fundEarmark`
(`MintSale.sol:197`, `BackingPool.sol:181-190`). The operator can reach only
`vested[op][τ]` (`withdrawVested`, `MintSale.sol:251-257`); no function moves `escrowed`
or `refundable` toward the operator (V3). Fee-at-vest, refunds fee-inclusive
(`onBurn`, `MintSale.sol:207-245`).

### C6 — charge-holder liveness — CLOSED as designed (partial fix, documented)
Expiry gives every holder a floor. `expireCharges` is permissionless
(`BackingPool.sol:311`) and its burn fires `onBurn` with `burner == pool`, refunding the
holder the full fee-inclusive price to `refundable[holder]`
(`MintSale.sol:223-226`). So a fee-starved or unwilling operator that stops running
boosted rounds collects nothing and the holder recovers `P` after expiry. This is the O5
floor; the full "force the operator to serve" fix is deferred by design (accounting
spec O5) and is not a fund-loss path.

### S2c LOW-1/2 — on-chain wiring must be asserted — PARTIALLY OPEN (tooling gap; pre-369 blocker)
`setBonusInfra` asserts only two of the wiring facts: `pool.game() == this` and
`pool.chips() == chips` (`OperatorCoinFlip.sol:204-205`). The remaining
governance-critical links are NOT asserted anywhere on-chain, and no deploy/wiring
script in the repo checks them:
`chips.creator == MintSale`, `chips.minter == pool`, `pool.minter == MintSale`,
`chips.priceLedger == MintSale`, and the chips burner allowlist `== {game, pool}`.
`deploy-operator-substrate.ts` still deploys the pre-bonus 3-arg game
(`deploy-operator-substrate.ts:130`) and never touches the bonus economy; no bonus
deploy script exists yet. See finding NF-2. This must be an asserted read-back gate
before 369, or O4 (holder protection) can silently void.

---

## 2. New findings (ranked by severity)

### NF-1 (MEDIUM) — the player controls the operator's per-round randomness-fee spend; no maximum by default
Evidence: `open` and `openBoosted` charge the operator's fee pool
`validatorSubset.length * tierPrice` and the CALLER (player/proposer) supplies the
subset — `OperatorCoinFlip.sol:361-362` and `454-455`, metered by `_chargeFee`
(`319-324`). The only bound is the `MIN_SUBSET = 3` floor (`GameBase.sol:42, 119`);
there is no maximum. `DefaultValidatorPolicy` offers `minCount`, `requireOperator`, and
an optional `useWhitelist`, but NO `maxCount` (`DefaultValidatorPolicy.sol:18-23, 67`).
A table's `validatorPolicy` defaults to `address(0)` = floor-only
(`OperatorCoinFlip.sol:243`), so the default posture accepts any distinct allowlisted
subset up to `validatorCount`.

Failure scenario (inputs → wrong outcome): an operator funds a fee pool and opens a
table with the default policy. A player opens rounds naming the largest allowlisted
subset it can assemble (each named validator must have inked a pool at `(token,
tierPrice)`, `GameBase.sol:162-167`). Every round meters `subset.length * tierPrice`
out of the operator's pool with zero operator consent per round. The player only has to
put its own stake at risk on a fair 50/50 flip; the fee spend is deterministic. Two
sub-cases:
- If the round finalizes normally, the fee is spent to the randomness providers — a pure
  cost shifted onto the operator (griefing / fee-pool exhaustion → `InsufficientFees`
  reverts stop the operator's own play until it re-funds).
- If any of those providers are player-affiliated allowlisted validators, the operator's
  fee flows to the attacker's validators — an economic extraction, not just griefing.
The exact fee destination lives in the external Random contract, so I rate this MEDIUM
(extraction if the fee is capturable by the subset, griefing at minimum).

Suggested fix: add an operator-set per-table maximum subset size (a `maxCount` in
`DefaultValidatorPolicy` and/or a `tableMaxSubset` gate in the game before `_chargeFee`),
and default new tables to a bounded whitelist policy. At minimum, make the deploy/QA
runbook require operators to set a whitelist policy before funding a fee pool on a
real-money (369) table, and document that the default floor-only policy leaves per-round
fee spend player-controlled.

### NF-2 (LOW, but a hard pre-369 gate) — bonus-economy governance wiring is not asserted on-chain or by any script
Evidence: as in S2c LOW-1/2 above. `setBonusInfra` checks two links
(`OperatorCoinFlip.sol:204-205`); the price-side and role links
(`chips.creator/minter/priceLedger`, `pool.minter`, burner allowlist) are set by
independent owner-only setters with no cross-assertion (`BonusChips1155.sol:88-108`,
`BackingPool.sol:122-125`, `MintSale.sol:118-131`) and no deploy script wires or
read-back-verifies them.

Failure scenario: a deploy leaves `chips.priceLedger` unset or pointed at a stale
MintSale. Burns then fire no price release (`_fireOnBurn` no-ops when unset,
`BonusChips1155.sol:209-214`), so purchase prices are collected on `buy` but never
refunded on expiry/chop — O4 holder protection voids silently while the sale still runs.
A wrong `chips.minter` (not the pool) breaks the mint↔backing lockstep and lets
under-backed supply exist.

Suggested fix: ship a bonus deploy + read-back-assertion script mirroring
`deploy-operator-substrate.ts:151-156`, asserting all five links and the burner set, and
run it as the 369 gate. Optionally have `setBonusInfra` also read and assert
`chips.priceLedger`, `chips.minter`, and `pool.minter` at set time.

### NF-3 (INFO) — round isolation depends on the external Random enforcing single-use preimages
Evidence: `instanceByKey[key] = roundId` (`OperatorCoinFlip.sol:379, 464`) assumes the
Random request `key` is unique per round. `_heatBoundStaked` passes the validator
preimage locations to `IRandom.heat` (`GameBase.sol:154-179`); the test double derives
`key = keccak256(abi.encode(info))` (`MockRandomStaking.sol:77`), which would COLLIDE if
two rounds reused the same preimages. In production, uniqueness rests on Random's
consumed-preimage tracking (each inked secret is single-use). This is an external
dependency, not a defect here, but it is load-bearing: if the caster/pool-ink fleet ever
lets two live rounds share a preimage, one round's `onCast` overwrites the other's
`instanceByKey` and strands funds until `refundStale`. Keep the pool-ink drift
monitoring (memory: cast-watcher pool-ink) operational through 369.

### NF-4 (INFO) — rebasing / mid-life balance-drift tokens remain out of the supported set
Evidence: `GameEscrow._pullVerified` measures only the deposit-time delta
(`GameEscrow.sol:103-113`); a token whose balance drifts between lock and settle
desyncs a bucket. This is documented (`GameEscrow.sol:15-20, 103-108`) and the isolation
model confines any damage to that token's own bucket. No action beyond the existing O6
disclosure and the `createSeries` zero-value-transfer probe
(`BonusChips1155.sol:127-157`). Not new; noted for completeness.

### Areas checked and found sound (no finding)
- EscrowLib arithmetic: `settleLoss` credits `payout - rakeAmt` with `rakeAmt <= stake <=
  payout` (`EscrowLib.sol:46-50`; rake capped at `MAX_RAKE_BPS = 500`,
  `OperatorRegistry.sol:12, 37`) — no underflow, no over-credit.
- Paired-bet conservation (P1–P4) traced by hand across T1–T8; every terminal in
  `BackingPool` re-asserts `earmark == circ*w` (`_assertBacked`), and escrow
  `bankroll(pool)` tracks `Σearmark + Σhold + Σcredit` on every path.
- Reentrancy: every token-moving entrypoint is `nonReentrant` with a shared per-contract
  mutex (`ReentrancyGuard.sol`); `_settle` uses status-first CEI so the push path
  (`onCast`, unguarded by design) bounces off `AlreadyResolved`; `claim` is guarded
  (`OperatorCoinFlip.sol:529`). `onBurn` is SSTORE-only with no external call and no
  reachable revert (`MintSale.sol:207-245`).
- Access control: pool hooks are `onlyGame`; `fundEarmark` is minter-only; `expireCharges`
  is permissionless but self-limiting; `withdrawCredit`/`withdrawVested`/`withdrawRefund`
  are `msg.sender`-scoped and CEI. `onReverse` is `onlyRandom` (`GameBase.sol:204-206`),
  so a chop credit cannot be forged.
- Marketplace never takes charge custody (approval-fill, `Marketplace.sol:186`); fees are
  capped and parked on a reverting policy; the buyer is safe on a stale listing.
- `OperatorBond`, `OperatorVault(Factory)`: measured-delta credit, front-run-safe atomic
  clone+init, impl locked. No issue.

---

## 3. Go / no-go for 369

CONDITIONAL GO — the fund custody and accounting core is sound. All seven prior findings
are closed in the current source, with on-chain invariant enforcement and regression
tests behind the critical ones. I found no new HIGH or CRITICAL fund-loss path:
conservation holds, reentrancy is guarded, and access control is tight.

Two gates must clear before real money touches this on 369:
- G1 (governance, task #42): decide whether operator-run validators are permitted on
  real-money tables. The contract closes the free-roll (forfeit → burn), so this is a
  policy call, not a code fix — but it must be an explicit decision on the record.
- G2 (NF-2, LOW but blocking): a bonus-economy deploy script that wires AND
  read-back-asserts all five governance links + the burner allowlist. Do not enable the
  bonus economy on 369 without it.

One item to fix or consciously accept:
- NF-1 (MEDIUM): bound the player-controlled per-round fee spend, or require a bounded
  whitelist validator policy on every real-money table and document it in the operator
  runbook.

Keep NF-3's pool-ink / cast-watcher monitoring live through the 369 cutover.
