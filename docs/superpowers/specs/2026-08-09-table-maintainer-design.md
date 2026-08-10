# Table-Maintainer Substrate — Slice A Design

**Status:** draft for review · **Date:** 2026-08-09 · **Scope:** Slice A only (the bonded operator role + standardized escrow/accounting). Slices B (attestor/reputation), C (discovery), D (N-party attribution) are out of scope here.

## 1. Goal & framing

Turn msgboard's game contracts into a neutral **substrate** over which independent **casino operators ("table maintainers")** run business. msgboard sells casinos a *provably-fair backstop that costs ~nothing but compute*: the operator **cannot** freeze or steal player funds — it's enforced in code. Operator = our customer; player = the operator's customer; msgboard = the rails, never a counterparty.

**Three roles** (msgboard is the substrate, not a party):
- **Player** — brings a stake; the substrate guarantees safety.
- **Operator / table-maintainer** — brings bankroll + liveness + validator curation; earns rake; is identified, accountable, and bonded.
- **Validator** — randomness/settlement; curated per-operator (reputation is slice B).

Slice A delivers: a permissionless operator registry, per-`(operator, token)` isolated accounting with full pre-collateralization, protocol-custodied bond, BYO funding sources (with a default vault), and per-operator rake routing — wired onto **one reference game**, proven on 943 with bots, before anything touches 369.

## 2. Invariant spine (the non-negotiable contract)

1. **Honest player never frozen or stolen from** — always wins per the revealed outcome or is made whole from *pre-locked* capital.
2. **Cheater/withholder never profits — including never escaping a loss.** No refund/void/split as a reward for misbehavior. (Withholding at showdown = a *loss* via answer-aware adjudication, never a split.)
3. **Opaque-unit, per-`(operator, token)` closed-ledger accounting.** Conservation is enforced *within* each bucket; token-agnostic (any ERC-20, no whitelist, no oracle — the substrate never names which token has value); single-token per ledger; each bucket **sandboxed** so a hostile/rebasing token harms only its own bucket. Enforced via balance-delta credited amounts + reentrancy isolation + SafeTransferLib.
4. **Operator bankruptcy is contained & graceful** — never cascades to another operator or the protocol.
5. **Protocol carries ZERO solvency risk** — never a counterparty, no pooled/insurance fund. Guaranteed by **full pre-collateralization at the moment of risk**: no bet/hand is accepted unless its worst-case payout is already locked from the responsible party's isolated capital.

## 3. Components

### 3.1 OperatorRegistry (permissionless, thin — custodies no idle funds)
```
register() -> operatorId                      // anyone; no admin gate
setRakeRecipient(token, address)              // per-operator, per-token payout address
setRakeBps(gameInstance, bps)                 // operator's own rake, bounded by a protocol max
setFundingSource(token, address)              // where bet-exposure is pulled from (BYO; defaults to the OperatorVault)
setMetadataURI(uri)                           // name/branding for discovery (slice C reads this)
// reputation pointer is a slice-B concern; registry only stores the ref
```
The registry maps `operatorId -> {owner, rakeRecipients, fundingSources, bondRef, metadataURI}`. It holds **no player funds and no bankroll**. Curation/"verified" status lives entirely off-chain in discovery (slice C) — the on-chain registry gatekeeps nothing.

### 3.2 GameEscrow (the standardized settlement seam — the safety-critical core)
The one thing that is **never BYO**, because player safety physically lives here. Per `(operator, gameInstance, token)` closed ledger.

- **Fund-and-verify (pre-collateralization):** at bet-accept the game calls `lockExposure(op, token, betId, maxPayout, playerStake)`. The escrow pulls `maxPayout - playerStake` from the operator's funding source and `playerStake` from the player, and **verifies via balance-delta** that the tokens actually arrived (`balanceAfter - balanceBefore >= expected`). If either transfer under-delivers → **revert** (player never exposed). Fee-on-transfer/rebasing tokens can't desync the books because we credit the *measured* delta.
- **Settle:** `settle(betId, outcome)` pays the winner from the already-escrowed amount and returns any remainder to the operator's bankroll ledger. Deterministic; independent of the operator or the funding vault after the lock.
- **Rake:** taken from the operator's side at settle, accrued to the operator's rake ledger, `withdrawRake(token)` sends it to the registry's rake recipient. A protocol fee (if any) is a separate, explicitly-bounded cut — default 0 for launch.
- **Isolation:** funds are keyed by `(operator, token)`; no cross-operator or cross-token pooling. Reentrancy-guarded; SafeTransferLib everywhere.

### 3.3 Bond custody (protocol-held, backstops the claim path)
A per-`(operator, token)` **bond** posted once into protocol-controlled escrow (not the BYO vault, so a harmed player can always claim regardless of operator behavior). It backstops the **residual/dispute** cases where escrow-level adjudication can't make an honest player whole (e.g. the N-party unattributable garbage-deck residual, or operator-vanish mid-dispute). Claimable **only** by an on-chain-adjudicated honest party, capped at their at-risk stake (recovery, never a windfall) — no griefing surface. Operator can top-up / withdraw-when-idle (subject to open-dispute locks).

### 3.4 Capital model (reconciles bankroll + bond + pre-collateralization)
- **House-banked games:** operator funds a **bankroll** ledger (per token). `lockExposure` pre-collateralizes each bet from it; bankroll empty → bet rejected (graceful bankruptcy). Bankroll *is* the solvency collateral.
- **P2P games (card tables):** the pot is self-funded by players' escrowed stakes; the operator posts only the **residual bond** and earns rake.
- Both bankroll and bond live in protocol escrow; idle bankroll can live in a BYO source and be pulled per-bet.

### 3.5 BYO funding + default vault
The operator's funding source is **any address that can deliver the token** — Safe, EOA, custom contract, or an EIP-3009 signed authorization (the x402 rail the card tables already use, see [[zk-x402-escrow-conversion]]). The substrate never trusts it; it only verifies funds *arrived* (§3.2). We ship a **default canonical `OperatorVault`** (minimal, EIP-1167-cloneable) for easy onboarding, but BYO stays first-class.

## 4. Wiring onto the reference game

**OPEN DECISION (confirm):** first reference game to prove slice A on 943.
- **Recommended: `CoinFlipTables` (house-banked).** It exercises the fullest path (bankroll + pre-collateralization + rake routing + graceful bankruptcy) and the operator-bears-risk model *also resolves the CoinFlip validator-abort gate* (the operator's bankroll absorbs an abort; the player is always refunded; the attestor de-lists a bad validator in slice B). Two birds.
- Alternative: a card table (`ZkTable`) — but P2P exercises less of the capital machinery, and those contracts were just hardened (don't reopen yet).

Wiring (for the reference game): add an `operatorId` + `token` dimension to a table/instance; replace its ad-hoc house bankroll with `GameEscrow.lockExposure` / `settle`; route rake through the registry. Fund-safety logic (adjudication, answer-aware timeouts) is unchanged — we only change *where custody lives* and *who the accountable party is*.

## 5. Error handling & edge cases
- Funding under-delivers (fee-on-transfer / malicious token) → `lockExposure` reverts; bet never opens; damage impossible.
- Bankroll insufficient → bet rejected (not a failure state; the table just stops taking action).
- Hostile/rebasing token → contained to its own `(operator, token)` bucket; other buckets untouched.
- Operator vanishes mid-dispute → honest player made whole from escrow, then the bond; faulter forfeits.
- Reentrancy via token callbacks → guards + checks-effects-interactions across every external transfer.

## 6. Testing & rollout
- **Foundry:** conservation invariants per `(operator, token)` bucket (fuzz: units-in == units-out); pre-collateralization (no accepted bet can be under-collateralized); isolation (a malicious ERC-20 mock can't drain another bucket); bond claim only by an adjudicated honest party; rake routing.
- **Opcode/EVM gate:** MCOPY opcode-scan every new deployed artifact (943/369 are pre-Cancun — see [[checkpoint-2026-08-08-card-tables-hardening]]); shanghai overrides.
- **943 live:** deploy the reference game under a test operator; bots play many rounds incl. pathological/antagonistic play; verify no freeze/steal, graceful bankruptcy, correct rake.
- **369:** only after 943 proves out; first real-money deploy is operator-aware (treasury = per-operator).

## 7. Out of scope (later slices)
- **B:** attestor → EAS schema → provex indexer → operator/validator reputation + de-listing (the sound disincentive for CoinFlip; on-ramp: `games/web/src/lib/easAttest.ts`, `SolveResolver`).
- **C:** discovery / player trust surface / operator onboarding.
- **D:** N-party (secp256k1) attribution + unbiasable subset assignment (cryptographic; the bond makes it non-blocking).
