# Operator-configurable validator-inclusion policy (pluggable hook) — design

Status: APPROVED shape (2026-08-12). Build on a branch, re-prove on 943 before 369.

## Problem

Today every validator-settled game validates the round's validator subset against ONE global
owner-managed allowlist (`GameBase._validateSubset`: ≥ MIN_SUBSET, all distinct, all allowlisted).
The opener (player) chooses the subset from that global set. Operators want to shape WHICH validators
their tables use — e.g. "≥3 and at least one must be the operator", or "≥3 drawn from this whitelist" —
and different operators will want different rules. We need a per-operator, per-table, extensible
inclusion policy WITHOUT weakening the fund-safety guarantee that protects players.

## Goals

- An operator configures a validator-inclusion policy per table.
- The mechanism is a **pluggable hook** (an operator-supplied policy contract), so rules can evolve
  without changing the game contract.
- The hook can only make a table **stricter**, never weaker: the non-negotiable safety floor is
  enforced by the game itself before the hook runs.
- Ship a **built-in default policy** so operators who write no custom hook get sane behavior.
- **Multiplayer-ready**: the hook interface carries enough round context to serve a future N-party game
  (operator sets the rule; individual players don't each add steps).
- Transparent trust: the policy is on-chain and readable before a player stakes; the player consents by
  choosing the table.

## Non-goals (separate efforts)

- **ZK-settled results** where the house could preempt payout — the operator coin flip already
  neutralizes this (pre-collateralized exposure at open, atomic + permissionless settlement, validator
  forfeit), so ZK settlement is a requirement of the multiplayer / card-game extension, tracked
  separately, not of this single-player policy change.
- The **house "backroom"** (live top-up/withdraw, security-room observability, cross-table bankroll
  balancing, optional per-table bankroll accounts/thresholds) — its own design.
- No change to the forfeit / settle / chop mechanics; the policy only gates `open()`.

## The non-negotiable floor (enforced by the game, not the hook)

Before any hook runs, `open()` still requires, and the hook CANNOT lower:
- `subset.length >= MIN_SUBSET` (3),
- all members distinct,
- every member on the global validator allowlist (`_isAllowlisted`).

This preserves the "one honest validator in the set defeats grinding" guarantee for the player
regardless of what an operator's hook does. A hook can only ADD constraints on top.

## Design

### Interface

```solidity
interface IValidatorPolicy {
    /// @return ok true iff `subset` satisfies this operator's rule for `tableId`.
    /// MUST be view (no state change, cannot move funds). Called AFTER the game's hard floor.
    function validate(
        address operator,
        bytes32 tableId,
        address proposer,   // the party assembling the round (the player in a 1-player game;
                            //  the round-opener / game in a future N-party game)
        address[] calldata subset
    ) external view returns (bool ok);
}
```

- `view` is enforced by the interface, so the hook can read state (its own per-table config, the game's
  tables/allowlist) but cannot mutate or move funds.
- `proposer` + `subset` + `tableId` give a multiplayer game everything it needs; the same interface
  serves the N-party case (the game passes the assembling party as `proposer`).

### Wiring in the game

- `Table` gains `address validatorPolicy` (0 = no extra policy → floor only).
- Set by the operator: `createTable(..., validatorPolicy)` and a `setValidatorPolicy(tableId, policy)`
  guarded by `onlyOperator(tableId)`. Changing it affects only FUTURE opens; in-flight rounds were
  already validated.
- `open()` order (unchanged floor, then hook):
  1. `_validateSubset(subset)` — the hard floor (as today).
  2. if `t.validatorPolicy != address(0)`: `if (!IValidatorPolicy(t.validatorPolicy).validate(operator, tableId, msg.sender, subset)) revert PolicyRejected();`
  3. the rest of `open()` (tier price, fee charge, heat, escrow lock) unchanged.
- A reverting hook makes `open()` revert → only that operator's own table is bricked (the operator's
  problem), never a fund-safety issue. Gas: the player pays for the hook call; an abusive hook only makes
  the operator's table expensive to play — a reputation cost borne by the operator.

### Built-in default policy: `DefaultValidatorPolicy`

A single deployed contract operators can point their tables at without writing code. Per-(game, table)
config, settable only by the table's operator (it reads the operator from the calling game's `tables`):
- `minCount` (defaults to / floored at MIN_SUBSET = 3),
- `requireOperator` (bool — the operator address must be in the subset),
- `whitelist` (optional set — if non-empty, every subset member must be in it; "≥ N from this list"
  falls out of minCount + whitelist).

`validate` returns true iff the subset meets the configured constraints. It never needs to re-check the
floor (the game already did), but it may (harmlessly) restate `minCount >= 3`.

## Trust model

- The policy address and the default policy's config are on-chain and readable before a player stakes.
- The player's protection is (a) the hard floor (always ≥3 allowlisted distinct validators, so including
  one honest validator makes the draw safe for them) and (b) their choice to play a table whose policy
  they can read. Operators compete on policy reputation (diverse, credible validator sets attract play).
- An operator who whitelists only colluding validators still cannot drop below 3 allowlisted validators,
  and the table's policy is visible — players can avoid it. (If we later want the player to always be
  able to inject a validator THEY trust even at a stricter table, that is an additive future option; the
  floor already guarantees safety when the player trusts one of the chosen set.)

## Fund-safety invariants (to hold after the change)

1. The hard floor (≥3, distinct, allowlisted) is enforced by the game before the hook and cannot be
   weakened by any hook. (Test: a hook that returns true for a 2-member subset still reverts on the floor.)
2. The hook is view-only; it cannot move funds or reenter a state-changing path.
3. Only the table's operator can set/point the policy; a player cannot inject a policy at open.
4. The policy gates `open()` only; settle / claim / chopAndRoute / refundStale are untouched, so the
   forfeit airtightness proven on 943 is preserved.
5. A reverting/abusive hook bricks only that operator's table; no other operator, player, or the escrow
   is affected.

## Re-prove-on-943 plan (the airtight bar)

- **Foundry** (extend OperatorCoinFlip.t.sol): default policy accepts a valid subset; rejects when
  requireOperator and the operator is absent; rejects a member not on the whitelist; a permissive hook
  cannot bypass the floor (2-member subset still reverts); a reverting hook reverts open() but leaves the
  table and other tables usable; setValidatorPolicy is operator-only; policy change affects only future
  opens; forfeit/settle unaffected with a policy set.
- **Anvil vs real Random** (operator-forfeit.test.ts): add a table with a policy set; confirm open →
  settle and open → forfeit still pass end to end (policy is pre-heat gating, so the real-Random paths
  are unchanged).
- **Deployability guard**: OperatorCoinFlip + DefaultValidatorPolicy MCOPY/TSTORE-free, under size limit,
  shanghai.
- **Live 943**: redeploy the policy-aware OperatorCoinFlip (+ DefaultValidatorPolicy) via the game-only
  redeploy path; extend qa-operator-coinflip.ts: createTable with a policy, open a valid subset (passes),
  open an invalid subset (reverts PolicyRejected), and the full forfeit proof still 42/42.
- **Reviews**: whole-branch fund-safety review focused on the new hook seam (can any hook path move
  funds, bypass the floor, or brick beyond the operator's own table?), plus a fix review if findings.

## Open sub-decisions (small, non-blocking)

- Policy settable anytime by the operator (recommended) vs. fixed at createTable. Recommend settable.
- Whether to also expose an on-chain view for the UI to render a table's policy (recommended: a getter on
  DefaultValidatorPolicy; custom hooks expose their own).
