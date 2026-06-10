# Games Platform — Coin Flip + Closest-Guess Raffle (Design Spec)

Date: 2026-06-09
Status: Draft for review

Supersedes (where they conflict):
- `2026-06-09-coinflip-core-design.md` (Slice 1) — its `@gibs/coinflip-core` naming becomes
  `@gibs/games-core` + `@gibs/coinflip`, and its player-secret entropy (fresh-per-flip player
  secrets + the publicly-known walk-away secret) is removed in favour of validator-only entropy.
- `2026-06-08-coin-flip-design.md` — superseded by the validator-only entropy model below.

## Summary

A small games platform that runs provably-fair games on top of the gibsfinance/random protocol.
Two games ship together so the shared abstraction is validated against more than one shape:

- **Coin flip** — two players escrow an equal stake on opposite sides; the parity of a validator-
  produced random seed decides who takes the pot.
- **Closest-guess raffle** — many players each commit a hidden guess in the range one to two
  hundred fifty-six and an equal per-guess stake; a validator-produced draw in the same range is
  cast, and the player whose revealed guess is closest in absolute distance takes the pot.

Both games are the same idea: *join an open instance keyed by your parameters; when a fill
condition is met, consume validator entropy; settle by a scoring rule.* Coin flip matches into a
pair by side and stake and scores by seed parity. The raffle matches into a shared round by its
parameter tuple and scores by closest distance to the draw.

On-chain, a thin `GameBase` contract holds everything the two games share; `CoinFlip` and `Raffle`
each add only their own matching and scoring. Off-chain, a chain-agnostic `@gibs/games-core`
substrate holds lifecycle, escrow reading, validator selection, and a small `Game` interface;
`@gibs/coinflip` and `@gibs/raffle` are thin consumers; every front end (scripts, web, terminal)
is a thin shell over the same core.

## Goals

- One on-chain base and one off-chain core shared by both games; no duplicated plumbing or
  duplicated audit surface.
- Provable fairness that does not depend on trusting any single party, stated honestly with its
  one irreducible trust assumption disclosed to players.
- A single scoring rule per game, expressed once off-chain and matched exactly on-chain, with a
  test that fails the moment the two drift apart.
- Liveness: no player can stall, abort, or re-roll a game; a dead validator set always resolves to
  a refund.
- Run identically on local Anvil (chain 31337) and PulseChain testnet version four (chain 943),
  selected by one flag, for both player and operator roles.

## Non-goals (this design)

- A standing always-on validator daemon (the operator runs inline here, as the existing duel
  script does). The core exposes the operator functions a daemon will later wrap.
- Production wallet-connect experience, ERC-20 stakes (native token only in version one), and a
  governance multisig (the fee/allowlist owner is a plain owner address in version one, behind a
  swappable interface).
- A stake-bonded slashable validator registry (analysed and deferred — see Security model).

## Security model

This section is load-bearing; the rest of the design follows from it.

### The entropy comes only from validators, and it is pinned

The random seed for every game is produced exclusively by the gibsfinance/random lifecycle:
validators `ink` a secret behind a write-once pointer, the game `heat`s a selected set of those
pointers, a validator `cast`s the revealed secrets, and core Random sets the seed to the hash of
the revealed secrets. The game contract inks nothing and contributes nothing to the seed. Players
never feed the seed.

Every inked secret is immutable from ink time (core Random verifies a revealed secret against the
write-once pointer in `_flick`). No actor can dial a chosen value into a seed; injecting a chosen
value would mean reversing keccak256. Each actor's only freedom is binary: reveal the pinned
secret, or withhold it.

### Why players hold no entropy: the small-output proof

Both games have a tiny output space (coin flip: one bit; raffle: two hundred fifty-six values).
Any player-held contribution to a small-output seed is exploitable:

- A **pinned** player contribution lets the last revealer compute the result before revealing and
  withhold to abort a loss (the last-revealer-abort).
- An **underminable** player contribution (the Consumer overlay) lets a griefer forward-hash chosen
  replacements after the other inputs are known and dictate the outcome in a few hundred tries for
  the raffle, or roughly two for coin flip.

There is no third option for a player-held input over a two- or two-hundred-fifty-six-value output.
Therefore the only safe design is that no player, and nothing replaceable, feeds the small-output
seed. "Entropy out of the user's reach" is a security requirement here, not a user-experience
nicety. (The Consumer/undermine machinery remains valid for large-output consumers, where grinding
a specific 256-bit seed is infeasible; it is simply wrong for these games.)

### The real attack surface is selection, not values

Core Random's `heat` selection is caller-controlled: the caller passes candidate pointer locations
and `heat` takes the first required ones that ignite. There is no protocol-enforced provider
diversity and no selection randomisation. Whoever controls the selection *and* knows the secrets
behind it knows the draw at heat time. An operator who inks a pool, knows its secrets, and controls
the selection can search subsets of its known preimages offline for one whose hash reduces to a
confederate's target, submit that selection, and win every round. This is cheap, offline, and
undetectable. Player commit-reveal does nothing against it; undermine does nothing against it.

The defence must remove either selection-control or secret-knowledge. We remove secret-knowledge of
the *whole* set by requiring the selected validators to be independent, so that the attacker cannot
know every secret.

### Two-layer validator model

Core Random has no validator registry of any kind — `provider` in a pointer is just a caller-set
address, so "N distinct providers" alone is defeated by one operator inking N self-controlled pools.
Independence must be vouched for somewhere. The chosen model has two layers:

1. **Universe (owner-controlled, on-chain).** `GameBase` holds a small owner-managed allowlist of
   eligible validators (on the order of five). The owner — a plain owner address in version one,
   read through a swappable `IValidatorRegistry` interface so it can later become a multisig or a
   bonded registry without touching the games — adds and removes members. The contract vouches for
   the universe.
2. **Per-instance subset (declared at creation).** Each game instance declares which validators it
   uses, as part of the first entrant's parameters, fixed before anyone stakes. The front end nudges
   everyone toward a small set of canonical subsets so liquidity concentrates rather than fragments.

`GameBase`'s heat helper, `_heatBound`, enforces two things at heat time:

- **Binding:** the heated providers equal the instance's declared subset, and `required` equals the
  number of supplied locations (no slack, so the contributing set equals the named set). This stops
  an operator bait-and-switch — declare a good set, heat a sybil set.
- **Membership:** the declared subset is a subset of the owner allowlist. This protects even a
  caller who never touches the front end: a raw-contract caller still cannot introduce a validator
  the owner has not vouched for.

Provider-level binding is sufficient; the contract need not pin exact preimages. A subset that
contains at least one honest provider defeats grinding regardless of which of that provider's
preimages is chosen, because the attacker never learns the honest secret.

### The irreducible trust assumption, disclosed

Small-output games inherently trust the validator selection: safety reduces to *at least one of the
chosen subset is honest*. You cannot buy trustless-against-all-validators by handing the player
entropy — that entropy is exactly the stall/grind lever the proof above eliminates. The front end
must disclose the "at least one of N validators honest" assumption.

### What stays off-chain, and why a stake-bonded registry was rejected

The grinding attack is offline and unprovable on-chain (the operator hashes its known secrets before
submitting heat; nothing on-chain witnesses it), so slashing cannot fire against the actual attack.
A bonded registry's honesty assumption is identical to the owner allowlist's ("at least one of N
independent"); bonds only raise the cost of sybils and buy liveness deterrence that core Random's
`chop` already covers (a withholding validator forfeits its Random stake). For this attack, curated
honesty is a stronger and far cheaper guarantee than an unslashable bond. The bonded registry is
deferred as a decentralisation upgrade, reachable later behind `IValidatorRegistry`.

The front end's remaining job is small: nudge players toward sane canonical subsets for liquidity.
It is not a trust boundary — a permissionless contract cannot rely on the attacker running the
honest client — which is exactly why binding and membership live on-chain.

## Architecture

### On-chain

`GameBase is ConsumerReceiver` holds exactly five shared pieces and nothing game-specific:

1. The core Random reference and constructor.
2. Native-token escrow helpers (`_take` / `_pay` / `_refund`).
3. The owner-managed validator allowlist (behind `IValidatorRegistry`) and `_heatBound` (binding +
   membership, as above), heating with this contract as the request owner and the change callback
   enabled.
4. The `onCast` dispatch skeleton: a reverse index from a Random request key to the game instance,
   the `OnlyRandom` guard, the `AlreadyResolved` status guard, and a route to an abstract
   `_settle(instanceId, seed)` the game implements.
5. The timeout recovery surface: `refundStale` and the `onChop` hook.

`CoinFlip is GameBase` and `Raffle is GameBase` add only their own matching, their own entry
structs, and their own `_settle` body. The converged design deletes from the current `CoinFlip.sol`
all player-preimage machinery (see Coin flip below): the game contracts ink nothing and only heat
validator pools and read the resulting seed.

`CoinFlip.sol`, `GameBase.sol`, and `Raffle.sol` live in `packages/contracts` of the
gibsfinance/random repository, beside the protocol they consume.

### Off-chain

A chain-agnostic substrate plus two thin consumers, all viem-based, in a new `examples/games` area
of the gibsfinance/random repository, using pnpm to match the surrounding packages:

```
examples/games/
  core/                      @gibs/games-core
    src/
      chains.ts              chain registry: anvil (31337) + pulsechainV4 (943), addresses, accounts
      contracts.ts           Random + GameBase/CoinFlip/Raffle application binary interfaces + resolution
      secrets.ts             validator secret/preimage helpers + the shared seed reduction (keccak, uniform)
      lifecycle.ts           the shared state machine + RoundState reader
      operator.ts            ink pool, arm (diversity-checked + bound heat), cast, recovery
      game.ts                the Game interface (parseParams, decodeEntry, canArm, settle) + presets
      index.ts               public surface
  coinflip/                  @gibs/coinflip — the Game implementation for coin flip
  raffle/                    @gibs/raffle  — the Game implementation for the raffle
  scripts/                   thin front ends (the multichain duel + a raffle run) over the core
```

The off-chain validator-selection helper mirrors the on-chain binding/membership check so a client
can build a valid heat selection and predict what the contract will accept. The seed-reduction
helper (the shared keccak and uniform-in-range functions) is cross-checked against the contract.

## Shared lifecycle and the Game interface

One state machine serves both games:

```
OPEN -> FILLING -> ARMED -> DRAWING -> SETTLED -> PAID
                     |          |
        (under threshold by      (validator secrets unrevealed at expiry)
         deadline) ROLLED_OVER          CHOPPED -> refund
```

- **Coin flip** maps as: OPEN (an entry is queued) -> ARMED (an opposite-side equal-stake entry
  pairs it) -> DRAWING (the pair's validators are heated) -> SETTLED (the seed parity is read) ->
  PAID. There is no FILLING/ROLLED_OVER phase — a pair fills in one step.
- **Raffle** maps as: FILLING (commits accumulate) -> rolls over at each period checkpoint until the
  threshold is met -> ARMED (frozen at a checkpoint with enough commits) -> DRAWING (validators
  heated) -> SETTLED (draw recorded, claim window open) -> PAID (winner finalised).

The `Game<TParams, TEntry, TOutcome>` interface is four pure methods plus the canonical presets:
`parseParams`, `decodeEntry`, `canArm`, and `settle`. The fairness-as-types point: `settle(params,
entries, seed)` takes the seed as an input only, so a game physically cannot route player data back
into the seed.

- `coinflip.settle` = the parity bit, `seed & 1` (even is heads, odd is tails).
- `raffle.settle` = the draw `1 + (seed mod 256)` in the range one to two hundred fifty-six, then
  the entry with the smallest absolute distance to the draw, ties broken by earliest commit, scoring
  only entries with a valid revealed guess, salt, and player.

The core provides the reader (turns events into a `RoundState`, calling `game.decodeEntry`), the
operator (ink, arm with a diversity-checked and bound heat, cast), and the shared secret/seed
helpers. The seam: the core owns lifecycle, escrow, and validator selection; the game owns only the
four pure methods.

## Coin flip — matching and settlement

The current `CoinFlip.sol` is already correct in its matching and recovery; the converged design
keeps that and removes the player-secret machinery validator-only entropy makes dead.

**Removed** (validator-only entropy): the `ink` call and its interface, the running player-ink
offset and player-pointer helpers, the player-section view, the walk-away secret and preimage
constants, the per-entry and per-flip preimage fields, and the zero-preimage guard. The entry
shrinks to `(player, side, stake, enteredAtBlock, active)`; the flip drops its two preimage fields.
The game now inks nothing.

**Kept unchanged** (already right): first-in-first-out matching by `(stake, side)` with the bounded
queue scan that caps how many cancelled tombstones a matcher walks; the waiting-entrant `cancel`
refund; `refundStale` for a paired flip whose seed never finalised; the parity `_settle`; the
`onCast` optimistic push with a `claim` pull fallback; and the status-guarded-before-transfer rule
that makes a double payout impossible.

**Heat stays at match time.** The earlier notes assumed heat would move to a separate operator step.
Under binding plus the owner-bounded universe, it does not need to for coin flip: the matching player
can heat inside the entry-and-match call in one atomic transaction, supplying validator locations,
because `_heatBound` pins those locations to the declared, frontend-vetted subset (which contains at
least one honest validator). Even an adversarial matcher cannot grind the parity bit — it never
learns the honest validator's secret. This keeps coin flip to one transaction with no liveness gap.
The raffle is genuinely different (its draw fires at a commit-threshold checkpoint with no second
entrant to complete it), so the raffle keeps an operator arm step; the asymmetry is natural.

**Where the validator set lives:** per-instance. The coin-flip match key becomes
`(stake, validatorSubsetHash)`; the first entrant of a table declares the subset and the front end
nudges everyone to one canonical subset so the added key dimension does not fragment liquidity. This
unifies coin flip with the raffle: one `GameBase` mechanism (declared parameters plus `_heatBound`)
serves both.

## Raffle — round, commit-reveal, claim, settlement

`Raffle is GameBase`, inheriting escrow, the owner-bounded allowlist, `_heatBound`, the `onCast`
dispatch, and the recovery surface. It adds the round model, the player commit-reveal, and the
claim/overwrite scoring.

- **Instance (a round, keyed by its parameter tuple).** The first entrant declares
  `(stake, threshold M, validatorSubset ⊆ allowlist, period)`; the range is fixed at one to two
  hundred fifty-six. The front end nudges to canonical tuples; the same tuple is the same round.
- **Commit (entry).** `commit(round, commitment)` is payable with the stake;
  `commitment = keccak256(abi.encode(guess, salt, msg.sender))`. Each commit is one ticket at the
  equal stake; a player may hold many. The guess is hidden and frozen here, before the draw.
  `cancel(ticketId)` refunds a still-waiting ticket (a tombstone) — the per-ticket escape hatch.
- **Fill and rollover.** A round accumulates commits. At each period checkpoint the operator
  evaluates: at or above the threshold, freeze the round and arm; below it, roll forward to the next
  checkpoint with funds still escrowed and nobody kicked. The period is the draw cadence and the
  commit cutoff; the threshold is the viability floor — the draw cannot fire before it.
- **Arm and draw (operator).** `arm(round, validatorLocations)` runs `_heatBound` (heated providers
  equal the declared subset; subset within the allowlist) to a request key, moving the round to
  DRAWING. A validator `cast` sets the seed; `onCast` records the draw `1 + (seed mod 256)` and opens
  a bounded claim window. It does not pay yet — the key difference from coin flip's settle-on-cast.
- **Claim, reveal, overwrite (during the window).** `reveal(ticketId, guess, salt)` verifies the
  commitment hash and that the ticket belongs to the caller, computes the absolute distance to the
  draw, and overwrites the provisional winner if it is closer (ties to the earliest commit). Losers
  will not spend gas to reveal, so they self-forfeit. Address-binding in the commitment stops a
  front-runner from copying a revealed guess and salt out of the mempool and claiming it.
- **Finalise.** After the window, `finalise(round)` pays the provisional winner the pot less the fee
  (non-revealers' stakes are part of the pot — that is their forfeit) and marks the round paid.

**Two load-bearing boundaries, both enforced by the one hash equality at reveal:** the salt feeds
only the commitment, never the draw seed (the draw is validator-only and already cast before any
reveal; the salt exists only to hide a guess in a two-hundred-fifty-six-value space, where a bare
hash of the guess would be unhidden by enumerating two hundred fifty-six hashes); and the commitment
freezes the guess before the draw, so overwrite only changes which already-committed, address-bound
guess holds the pot and can never inject a new or edited guess after the draw is known.

## Error handling and recovery

The recovery design leans on one principle proven in coin flip: never let a push be the only way
out. Every value-moving path has a permissionless pull fallback, and every one guards status before
transferring, so the state machine itself is the reentrancy guard and the contracts hold none.

- **Validator liveness (draw never produced).** Validators heated but no cast by expiry: core
  Random's `chop` refunds the unrevealed validator preimages (firing `onChop`); the game's
  `refundStale` after the stale timeout returns escrowed stakes. Coin flip pushes to both players
  (only two). The raffle refunds pull, per-ticket — each committer reclaims their own ticket — so a
  large round needs no giant push. Whether `onCast` fired (the seed finalised) is the real driver: no
  `onCast` ever means `refundStale` is the only exit.
- **Settlement push failure (coin flip).** Core Random swallows a reverting `onCast`, leaving the
  flip pending; `claim` is the pull retry, and the status-before-transfer guard makes a double payout
  impossible. No reentrancy guard, which would block the retry. The raffle is barely affected: its
  `onCast` only records the draw and opens the window, and its payout is already a pull.
- **Zero player reveal (raffle no-contest).** After the window with no provisional winner,
  `finalise` routes the pot to the round's contributing validators — the declared subset minus any
  chopped (non-revealing) validators, which `GameBase` records from `onChop`. A chopped validator
  already forfeited its Random stake, so it is excluded here too. If every validator was chopped the
  seed never finalised, so this is the liveness case (refund), not the no-contest case.
- **Round never fills (raffle below threshold).** `cancel(ticketId)` is the per-ticket escape, with
  no deadline; funds are reclaimable while the round is still filling.
- **Claim-window edges (raffle).** A reveal after the window closes is rejected; a wrong guess or
  salt fails the hash check; a double reveal of one ticket is rejected (the running best already has
  it); equidistant guesses break to the earliest commit block, then the ticket id for same-block
  determinism.
- **Arm griefing (raffle).** `arm` is permissionless but `_heatBound` permits only locations bound to
  the declared subset, so there is no sybil substitution; it requires the threshold met at a
  checkpoint and a filling status (one-shot to drawing), so there is no premature or double arm.

## Fees and validator economics

Two separate concerns that an earlier draft wrongly conflated:

- **Validator entropy compensation is already handled by core Random** through its price and stake
  mechanism, which pays validators when their inked preimages are heated and consumed. The platform
  does not re-implement it.
- **The game fee** is a separate rake the game contract takes, owner-adjustable, default zero,
  applied to both games. It is a **percentage of the pot** (basis points), chosen as a percentage
  specifically so that a nonzero value also mitigates blanket flooding in the raffle: the percentage
  taxes a flooder's own large stake pile proportionally, so past a coverage point the fee they pay
  exceeds the marginal other-player stakes they would capture, and flooding taxes itself. The fee
  goes to a **configurable fee-recipient address** the owner sets — distinct from the validator
  payment Random already makes and from the no-contest pot. Coin flip has no flooding shape, so a
  nonzero coin-flip fee is pure revenue and makes the flip slightly negative expected value; its
  default stays zero, and the owner can raise it.
- **Anti-spam posture.** At the default fee of zero, the only anti-spam force is commit-reveal
  hiding — a spammer cannot see which of the two hundred fifty-six values are uncovered, so flooding
  is blind with diminishing returns. Raising the percentage adds the self-taxing deterrent against
  blanket flooding. A per-address cap remains an available later lever if abuse appears.
- **The no-contest pot** (zero reveals) goes to the round's contributing validators, as above — a
  pot distribution separate from the fee.

## Testing

> Toolchain note (2026-06-09): the contract repository (`gibsfinance/random/packages/contracts`)
> uses Hardhat with viem and Mocha/Chai, not Foundry. The tests below are written against that
> existing toolchain; the intent (cross-layer parity, security invariants, value conservation) is
> tool-independent. Native Foundry property/invariant fuzzing is deferred to a follow-up.

- **Contract tests (Hardhat + viem + Mocha/Chai).** `GameBase`: escrow; `_heatBound` binding and membership and the
  no-slack `required` check, rejecting substituted or non-allowlisted providers; `onCast` dispatch
  with its guards; owner-only allowlist changes; `refundStale`; `onChop` recording the chop set.
  `CoinFlip`: matching and the tombstone-scan cap, `cancel`, heat-at-match bound to the subset,
  parity settle, push-plus-pull payout, no double pay, and a deletion proof that the contract inks
  nothing. `Raffle`: address-bound commit, per-ticket stake, rollover and threshold arming, the draw
  reduction and claim window, reveal verification and overwrite, the earliest-commit tiebreak,
  finalise paying the pot less fee, non-revealer forfeit, the no-contest distribution, and per-ticket
  `refundStale`.
- **Security-invariant tests.** A selection-grind fuzz that varies which honest-validator preimages
  are heated and asserts the draw stays unpredictable; an assertion that the seed is a function of
  validator secrets only and is independent of commits and salts; a guess-freeze test where a reveal
  with an altered guess reverts; an address-binding test where replaying another sender's guess and
  salt reverts; and a no-last-revealer-abort test that no player action can prevent settlement.
- **Invariant and conservation tests (Hardhat now; native Foundry fuzz deferred).** Value
  conservation (the sum of stakes equals the sum of payouts, fees, and refunds, with nothing stuck);
  draw uniformity over the range; the winner is always the closest revealer; and status
  monotonicity. Expressed as Hardhat assertions plus targeted randomized loops in version one;
  ported to native Foundry invariant/fuzz testing in a later follow-up once both games are stable.
- **Off-chain tests (vitest).** The `Game` pure methods against known seeds (`coinflip.settle`
  parity; `raffle.settle` closest and earliest); parameter and entry round-trips; and the reader
  reconstructing state from events.
- **Cross-layer parity (the highest-value test).** For fuzzed parameters, entries, and seed, the
  off-chain `settle` must name the exact same winner the on-chain claim and overwrite pays. This
  guards against drift between the contract and `@gibs/games-core`, where a tiebreak tweak or a
  reduction difference would otherwise surface only as a user told they won while the contract paid
  someone else.
- **End-to-end on a local chain.** Extend the existing coin-flip duel harness to the full lifecycle
  for both games — match or commit, arm, validator cast, settle or finalise, winner paid with fee
  and forfeits — plus the recovery paths (stall to refund; zero reveal to validators). PulseChain
  version four (943) is exercised by a manual run, not in continuous integration.

## Build order

1. Extract `GameBase` from the current `CoinFlip` internals (escrow, the allowlist behind
   `IValidatorRegistry`, `_heatBound`, the `onCast` dispatch, `refundStale`/`onChop`); rework
   `CoinFlip` to extend it and delete the player-secret machinery. Contract tests for both.
2. Implement `Raffle` (round model, commit-reveal, claim/overwrite, finalise, no-contest, fee).
   Contract tests and the security-invariant and parity tests.
3. Scaffold `@gibs/games-core` (chains, contracts, secrets/seed, lifecycle, operator, the `Game`
   interface) and the two consumers `@gibs/coinflip` and `@gibs/raffle`. Off-chain unit and parity
   tests.
4. The front-end scripts (the multichain duel and a raffle run) over the core; verify on Anvil in a
   continuous-integration-style run, then a live 943 run.

## Open items carried into the plan

- The exact subset size N a default instance uses (for example three of five) — a configuration
  constant.
- Canonical-parameter enforcement is a user-interface nudge plus an optional on-chain
  recommended-presets list, not a hard whitelist (binding already constrains the validators;
  fragmentation is a liquidity and experience concern, not a safety one).
- The default fee value (basis points) per game; both default to zero.
