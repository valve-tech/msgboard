# Operator contracts — code-quality review

Date: 2026-08-17
Scope: the operator substrate and bonus economy under
`games/contracts/contracts/games/operator/`, plus the shared
`GameBase.sol`. Pre-mainnet (chain 369) gate.

This is a code-quality pass only. It is not a security or economic audit;
those run separately. The goal is to cut audit surface before 369: dead
code, duplicated logic, needless state, and stale comments.

## Summary

The contracts are in good shape. They are heavily commented, the invariants
are stated, and the CEI and reentrancy discipline is consistent. The main
cleanups are duplicated token-pull logic, one block of documented dead code
in the registry, an unwired bond field, and a fee-routing pattern that two
contracts share and a third diverges from.

Observations are ranked by value. Audit-surface reduction comes first;
cosmetic items come last.

---

## 1. Duplicated token-pull-with-delta logic (HIGH — audit surface)

The "pull a token and measure the real delta" pattern appears in six places
in two families. Each copy is a hand-written `balanceOf`/`transferFrom`/
`balanceOf` triple. Consolidating them into one shared library removes the
most repeated safety-critical code in the substrate.

Family A — measure and credit the delta (returns received):
- `GameEscrow.sol:109-113` `_pullVerified`
- `OperatorCoinFlip.sol:284-288` `_pullVerified`
- `OperatorBond.sol:46-48` (inline, in `postBond`)

Family B — measure and require the exact amount (revert on mismatch):
- `MintSale.sol:188-190` (`PullMismatch`)
- `Marketplace.sol:178-180` (`PullMismatch`)
- `BackingPool.sol:180-182` (`DepositMismatch`)

Suggested change: add one small library (for example `TokenPull`) with two
functions — `measured(token, from, amount) returns (uint256)` and
`exact(token, from, amount)` that reverts on a short delivery. Replace all
six copies. This gives one audited implementation, one place for the
fee-on-transfer reasoning, and one error type per family. The two `_pullVerified`
copies (`GameEscrow` and `OperatorCoinFlip`) are already byte-identical and
should collapse first.

## 2. OperatorRegistry funding-source is dead code (HIGH — audit surface)

`setFundingSource`, `fundingSourceOf`, and the `_fundingSource` mapping have
NO on-chain reader. The contract itself documents this at
`OperatorRegistry.sol:56-61`: it is "ADVISORY ONLY", a deviation from the
spec's original pull-per-bet model, kept as an off-chain hint. All collateral
now sits in escrow before any bet opens.

- `OperatorRegistry.sol:17` mapping `_fundingSource`
- `OperatorRegistry.sol:62-65` `setFundingSource`
- `OperatorRegistry.sol:67-69` `fundingSourceOf`
- `OperatorRegistry.sol:22` event `FundingSourceSet`

Suggested change: remove the mapping, the setter, the getter, and the event
before mainnet. It is a live write path that no contract reads — pure audit
surface. If off-chain tooling needs the hint, an emitted-only event (like
`setMetadataURI`) keeps the pointer without the storage and the getter.

## 3. OperatorBond dispute-lock is unwired (MED-HIGH — audit surface)

`OperatorBond` carries a `locked` field on every bond, but nothing ever sets
it. The contract states the dispute-LOCK path ships in slice D
(`OperatorBond.sol:10-13`); until then `locked` stays 0 and `free == total`.

- `OperatorBond.sol:25` `struct Bond { uint256 total; uint256 locked; }`
- `OperatorBond.sol:62` and `:72` compute `free = total - locked`

Suggested change: for the 369 gate, either land the slice-D lock path or drop
the `locked` field and the `free` subtraction until it is real. A stored field
that is always zero, read on two withdrawal paths, is surface an auditor must
still reason about (can it ever be non-zero? who sets it?) for no current
behavior.

## 4. Fee-routing park pattern — duplicated and inconsistent (MED)

Three contracts route a fee to an `IFeePolicy`. Two use an identical
"external self-call + try/catch + park" idiom; the third diverges and reverts
instead of parking.

- `OperatorCoinFlip.sol:631-635` `_deliverAndRoute` + `:612-625`
  `_routeForfeitToSink` + `:639-648` `sweepForfeit` — parks on failure.
- `Marketplace.sol:214-219` `_deliverAndRoute` + `:197-208` `sweepFees` —
  parks on failure. The `_deliverAndRoute` body is the same self-only
  transfer-then-route as the coin-flip copy.
- `MintSale.sol:272-280` `sweepFees` — routes directly, NO self-call, and
  REVERTS the whole sweep on a bad policy (the fee stays accrued).

Suggested change: extract the shared self-call-and-park routine into one
place (a small base or library taking `policy`, `token`, `amount`, `kind`,
`ctx`). Then make a deliberate decision on `MintSale`: either it parks like
the other two, or the divergence is intentional and the comment says WHY
mint-sale fees revert while marketplace and forfeit fees park. Right now the
same operation behaves two ways across three contracts, and only two of the
three explain it.

## 5. OperatorCoinFlip `_bonusInfraSet` is redundant state (MED — simplify)

`_bonusInfraSet` tracks exactly the same fact as `backingPool != address(0)`.
Both are written together and never diverge.

- `OperatorCoinFlip.sol:140` `bool internal _bonusInfraSet;`
- set together at `:206-208`
- read at `:203` (`if (_bonusInfraSet)`) and `:218` (`if (!_bonusInfraSet)`)

Suggested change: drop the bool. Use `if (backingPool != address(0)) revert
BonusInfraAlreadySet();` and `if (backingPool == address(0)) revert
BonusInfraUnset();`. One fewer storage slot and one fewer piece of state an
auditor must confirm stays in sync.

## 6. `override` keyword inconsistency (LOW — cosmetic)

Interface implementations are marked inconsistently. `MintSale.onBurn` uses
`override` (`MintSale.sol:209`); `BurnFeePolicy.route` and `feeBps`
(`BurnFeePolicy.sol:17,24`) implement `IFeePolicy` with no `override`.
Solidity 0.8.24 does not require `override` for interface functions, so both
compile — but the style should be one way across the substrate.

Suggested change: add `override` to `BurnFeePolicy.feeBps` and `route` to
match the rest.

## 7. Line-number reference in a comment (LOW — stale-prone)

`BackingPool.sol:106` cites "GameEscrow.sol:135-138" for the self-authorize
call. It happens to be correct today, but any edit to GameEscrow silently
rots it.

Suggested change: reference the function by name
(`GameEscrow.authorizeGame`), not by line number.

## 8. OperatorRegistry getter style is mixed (LOW — consistency)

`registered` is a public mapping with an auto-getter
(`OperatorRegistry.sol:14`), while `_rakeBps`, `_rakeRecipient`, and
`_fundingSource` are internal with hand-written getters. The reader has to
learn two access styles in one small contract.

Suggested change: pick one. Either make the rake mappings public (dropping
the explicit getters that add nothing beyond the default) or make
`registered` internal with a `registeredOf` getter. Note the rake-recipient
and funding-source getters DO add logic (the recipient getter defaults to the
operator), so those stay as functions; only the plain pass-through getters are
candidates.

---

## Notes — things that look like findings but are correct

- The local `ReentrancyGuard` (not Solady's) is deliberate and documented:
  Solady's uses transient storage, which reverts pre-Cancun on 943/369
  (`ReentrancyGuard.sol:1-23`). Keep it.
- `open()` is not `nonReentrant` while `openBoosted()` is. This is justified:
  only the boosted path moves an ERC-1155 charge (an untrusted receiver
  callback). The plain path touches no callback token and relies on CEI. The
  asymmetry is correct, not an oversight.
- `GameBase._take/_pay/_refund` (native-token helpers) are unused by the
  operator game, which is token-only via escrow. They are live for the other
  games that share `GameBase` (CoinFlip, Raffle), so they are not dead code in
  the base.
- The `Round` struct "appended indices" comments in `OperatorCoinFlip.sol:88`
  and `:91-92` match the real field order. They are accurate, not stale.
- `authorizedGame` plus `authorizeGame` appear in both `GameEscrow` and
  `OperatorBond` as the same self-sovereign pattern. Sharing them across two
  otherwise-unrelated contracts would couple them for little gain; leaving the
  small duplication is the reasonable call.
