# CoinFlip — Player Commit-Reveal Randomness (Design Spec)

Status: draft for review · 2026-06-18
Context: the cheaper-steps win identified in `2026-06-18-zk-game-randomness-feasibility.md` §4. Moves CoinFlip off the validator apparatus onto a 2-party commit-reveal — no ZK, no validators. Raffle is explicitly **out of scope** here (its N-party draw is grindable without an independent entropy source; see §8).

## 1. Summary

Today's CoinFlip (`0x8d3a…`, `CoinFlip.sol`) decides the winner from **validator-only entropy**: players declare a validator subset, the contract heats the validators, `onCast` delivers a validator-produced 256-bit seed, and the winner is its **parity**. Two opposed players therefore spin up the whole validator coordination (subset declaration, heat, cast, reveal) to extract one bit — several on-chain steps and a third-party liveness dependency, for a game that has exactly two mutually-distrusting participants.

This spec replaces that with the textbook fair coin flip: **each of the two players commits a secret, both reveal, the seed is the hash of the two secrets, parity decides.** Fair as long as **either** player is honest (same guarantee as "one honest validator", sourced from the players). It retires the validator subset, heat, and cast entirely. Ships as a **new contract** (`CoinFlipCR`); the existing validator CoinFlip stays deployed and is deprecated in the UI.

## 2. Current vs proposed

| | Current (validator entropy) | Proposed (commit-reveal) |
|---|---|---|
| Entropy source | validator subset, inked secrets | the two players' committed secrets |
| Trust | ≥1 honest validator | ≥1 honest player |
| On-chain coordination | enter → heat → cast (validator) → claim | enter+commit → reveal ×2 → settle |
| Third-party liveness | yes (validators must cast) | no (only the two players) |
| Player liveness | passive (no reveal) | must reveal (forfeit timeout) |
| Outcome | `seed % 2`, seed from validators | `keccak(secretHeads, secretTails) % 2` |

The trade is: drop validator dependency + heat/cast, in exchange for a reveal step per player (with a forfeit clock). For a 2-party game where both already transact, this is strictly fewer moving parts.

## 3. Protocol

1. **Enter + commit.** `enter(uint8 side, bytes32 commitment)` payable. `commitment = keccak256(abi.encode(secret, salt, msg.sender))`. Player escrows `msg.value` on `side` (heads/tails) and binds a secret. No validator subset.
2. **Pair.** An opposite-side entrant at the **equal stake** is matched FIFO (reuse the existing queue: `_queue[stake][side]`), producing a `flipId` binding the two entries. `Paired(flipId, heads, tails, stake)`.
3. **Reveal.** Each player calls `reveal(bytes32 flipId, bytes32 secret, bytes32 salt)`; the contract checks `keccak256(abi.encode(secret, salt, player)) == commitment` and stores the secret. `Revealed(flipId, player)`.
4. **Settle.** Once **both** secrets are revealed: `seed = keccak256(abi.encode(secretHeads, secretTails))`, `winningSide = uint8(uint256(seed) & 1)`, winner takes the pot (`2 * stake`). `Settled(flipId, winner, winningSide, payout, seed)`.
5. **Forfeit (liveness).** After `REVEAL_BLOCKS` from pairing, if exactly one side revealed, that revealer claims the pot via `claimForfeit(flipId)`; `Forfeited(flipId, winner)`. If neither revealed, either may `refundStale(flipId)` to reclaim their own stake (no game happened).

## 4. Fairness argument

- **Binding:** a player commits before pairing; `commitment` fixes `secret` (collision-resistant keccak), so neither can change their secret after seeing the opponent's entry.
- **Hiding:** `salt` (32 random bytes) hides `secret` until reveal; the opponent's commitment leaks nothing about the secret.
- **Unbiasable:** `seed = keccak(secretHeads, secretTails)` depends on **both** secrets; a single honest, uniformly-random secret makes the parity uniform regardless of the other's choice — so a dishonest player cannot bias the bit. This is the "≥1 honest participant" guarantee.
- **No second-mover advantage:** whoever reveals second learns the outcome before revealing, but their only alternative to revealing is **forfeiting** (§3.5). They would withhold only when they would lose — in which case forfeiting yields the same result (the counterparty wins). So withholding never improves a player's outcome; revealing is dominant. The first revealer is already committed and cannot be disadvantaged because the second mover gains nothing by withholding.
- **Salt custody:** the salt lives in the player's browser (as in Raffle); losing it before reveal forfeits the stake. The UI must back salts up (reuse Raffle's `salts.ts` + backup-string pattern).

## 5. Contract (`packages/contracts/contracts/CoinFlipCR.sol`, new)

- Drop: `IRandom`/`GameBase` validator wiring, `validatorSubset`, `_validateSubset`, `_pairAndHeat`/`onCast`/heat machinery, `MIN_SUBSET`, `STALE_BLOCKS` (validator-specific).
- Keep: the FIFO queue by `(stake, side)`, the entry/flip structs (minus subset fields), owner/admin only if still needed (likely none — no validators to manage).
- Add: `commitment` on entries; `secret`/`revealed` per side on the flip; `REVEAL_BLOCKS` constant; `reveal`, `claimForfeit`, and settle-on-second-reveal.
- Events: `Entered(id, player, side, stake, commitment)`, `Paired(flipId, heads, tails, stake)`, `Revealed(flipId, player)`, `Settled(flipId, winner, winningSide, payout, seed)`, `Forfeited(flipId, winner)`, `Cancelled(id)`.
- Tests (Foundry): commit/pair/reveal/settle happy path; parity correctness against known secrets; non-reveal forfeit after `REVEAL_BLOCKS`; double-reveal rejected; wrong secret/salt rejected; both-no-reveal refund; the second-mover-withhold scenario yields no gain.

## 6. Web + SDK changes (`examples/games/web`, `@gibs/coinflip`)

- `CoinFlipScreen`: enter now generates `{secret, salt}`, stores via `salts.ts` (keyed by chain+contract+entryId), submits `commitment`; surfaces a **Reveal** action when paired (mirrors Raffle's reveal flow + the salt-backup banner already in `RaffleScreen`). The InfoDot copy from the recent UI pass describes the commit-reveal in one line.
- `useChainData`/indexer: index the new events (`Entered/Paired/Revealed/Settled/Forfeited`) for the new address; the lobby/flip derivation drops subset/validator fields. The games-indexer (`deploy/games-indexer`) adds `CoinFlipCR` alongside the existing CoinFlip (keep the old one indexed for history).
- `config.ts`: add `coinFlipCR` address per deployment; the UI points the Coin Flip tab at it once deployed.
- The trust strip (`TrustBanner`) copy generalizes: "safe as long as one of the **participants**/validators is honest" — for CoinFlipCR the participant set is the two players.

## 7. Deployment / migration

- Deploy `CoinFlipCR` on 943 (then 369). The existing validator CoinFlip stays deployed; its history remains indexed and viewable. The Coin Flip tab switches to the new contract; no migration of in-flight flips (let them settle out on the old contract).

## 8. Non-goals / deferred

- **Raffle.** Its N-party draw is grindable from players' own secrets (the last committer can grind), which is exactly what the validator entropy defends against. A validator-light Raffle (draw from all *revealed* salts, commits frozen first, non-revealers forfeited, reveal-order leakage handled) is a separate, harder design — deferred.
- **ZK / proof-settled.** Out of scope; this is the no-ZK path. A future proof-settled CoinFlip (batch + privacy) attaches to the settlement rails per the feasibility study §5 — not needed for the step-count win.
- **Escrowed-channel CoinFlip.** Could later be reframed as a session-style game over `HouseChannel`; this spec keeps CoinFlip a direct on-chain PvP game, just with player entropy.

## 9. Open questions

- `REVEAL_BLOCKS` value on 943/369 (a few minutes of blocks).
- Whether to fold `secret` into the existing salt backup string or keep a separate store key.
- Whether the old validator CoinFlip is hidden from the UI immediately or kept as a selectable "validator-entropy (legacy)" mode during a transition.
