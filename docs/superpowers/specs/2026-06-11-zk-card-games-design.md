# ZK Card Games — Mental-Poker Rails + Hi-Lo War (Design Spec)

Date: 2026-06-11
Status: Draft for review

Relationship to prior specs:
- Complements `2026-06-09-games-platform-design.md`. The existing games (coin flip, raffle) draw
  entropy from gibsfinance/random validators. The games in this spec draw entropy from the players'
  own joint shuffle and need **no validator entropy at all** — a different trust model, so they get
  their own contract family and off-chain core rather than extending `GameBase`.
- The venue branding rules stand: these ship as MsgBoard Games venues, "supercharged by MsgBoard,"
  no authorship credit, plain repo links.

## Summary

A rails-plus-catalog design for card games with cryptographically hidden state, built on the
mental-poker literature (Barnett–Smart masked decks with zero-knowledge shuffle arguments) and on
MsgBoard as the public bulletin board. Two players (or a player and the house bot) jointly encrypt
and shuffle a deck so that neither can see its order; cards are dealt to one player by the other
revealing a decryption share; every shuffle and share carries a zero-knowledge proof, so the whole
hand is verifiable from the transcript alone.

A heads-up table is a **state channel**: stakes are escrowed on-chain when the table opens, every
in-round action is a signed off-chain message at network speed, and the chain is touched again only
to settle or to resolve a dispute. This satisfies the pacing requirement: switching turns within a
round never waits on a block; only table open and final settlement are chain-paced.

The first build is **Hi-Lo War**, the smallest game that exercises every rail (private deal,
betting decision, hidden fold, public showdown, dispute clock). Heads-up hold'em follows on proven
rails, then house-banked blackjack, then ring poker under its own future spec.

## Goals

- Card games where no party — opponent, house, validator, relay, or operator — can see a player's
  hidden cards or influence the deck order, and the full hand is re-verifiable from the MsgBoard
  archive transcript in a browser.
- In-round turns at message speed: no per-turn chain transactions; a session costs three
  transactions on the honest path (create, join, settle) regardless of how many hands are played.
- **Session pipelining:** a new table, rematch, or reshuffle must never wait on a previous settle
  transaction confirming. Tables are independent on-chain objects; clients open table N+1 while
  table N's settle is still in flight. In-session reshuffles are entirely off-chain.
- One rails layer (crypto, channel, transport, verifiability) reused by every game in the catalog;
  each new game adds only a rules module off-chain and a rules contract on-chain.
- No new trusted parties. The fast relay is untrusted by construction; its only power is delay,
  and delay lands in the dispute clock, never in fairness.
- Liveness: a stalled or vanished opponent always resolves — chess-clock forfeit inside a hand,
  cooperative settle or dispute settle at the boundary — and nobody's funds strand.
- Run identically on Anvil, 943, and 369, selected the existing way (chain flag / config), with
  the existing gate, bot, and treasury-hygiene machinery extended rather than duplicated.

## Non-goals (this design)

- Ring tables (3+ independent parties). Catalogued, costed, and deferred to a dedicated spec —
  N-party key shares, per-seat dropout, and redeal machinery are a step change in complexity.
- Writing our own shuffle circuits. The spike picks an existing audited-ish stack; circuit
  authorship is explicitly out of scope for v1.
- Tournament structures, rake/fee design, table discovery/matchmaking UX beyond the existing
  open-table pattern, and ERC-20 stakes (native token only, as today).
- Real-time spectating. The archive mirror is near-real-time but the v1 spectator story is replay,
  not live rail.

## Security model

This section is load-bearing; the rest of the design follows from it.

### Entropy is self-dealt; validators are not involved

The deck order is the composition of both players' secret permutations. It is unpredictable to you
only if the *other* party's permutation is unknown to you — and unpredictable to an outside
observer if *either* permutation is honest-random. Each player therefore guarantees their own
fairness with their own client's randomness: you never need to trust your opponent's RNG, the
house, a validator, or the operator. The gibsfinance/random ink/heat/cast lifecycle is not used.

### What zero-knowledge proofs pin down

- **Shuffle arguments** prove each re-encryption shuffle is a permutation of the same masked deck —
  no card added, dropped, duplicated, or substituted — without revealing the permutation.
- **Decryption-share proofs** (Chaum–Pedersen) prove each revealed share is the correct partial
  decryption under the prover's registered key — a wrong or garbage share is detectable instantly
  and is itself dispute evidence.
- **Proofs of key knowledge** at setup prevent rogue-key tricks against the aggregate ElGamal key.

What proofs cannot pin down, stated honestly in the UI as today: a player leaking their own hole
cards to a friend (information collusion) is outside any protocol — and is moot heads-up, where
the only other party is your adversary; and the soundness of the proof system itself plus the
correctness of the chosen SDK's circuits is the irreducible residue of trust. The spike records
each candidate's audit status and the spec gains an addendum with the findings.

### The channel and the chess clock

Every off-chain step advances a co-signed state `(tableId, nonce, balances, deckCommitment,
phase)`. Money only moves on-chain against a state carrying both signatures (cooperative settle)
or through the dispute machine. Disputes: either party posts their latest co-signed state; the
contract starts a per-response chess clock; the counterparty must answer with a higher-nonce
co-signed state or the specific protocol message the phase requires (signature checked, proof
verified on-chain by the deployed verifiers); clock expiry forfeits the disputed pot to the honest
party and settles remaining balances from the last co-signed state. Replay is dead by nonce
monotonicity; the dispute invariant — no sequence of disputes and responses pays out more than the
table's total escrow — is fuzz/invariant-tested.

### The relay is untrusted; MsgBoard is the record

Protocol messages are signed and proof-carrying, so the fast pipe needs no integrity or ordering
guarantees. A malicious relay can delay or drop — both land in the chess clock. The MsgBoard
mirror (PoW-stamped posts under a per-table category) is the permanent public record from which
anyone can re-verify the entire session; the relay buffer is disposable.

## The rails

### Crypto layer

Barnett–Smart masked deck over the players' aggregate ElGamal key: joint keygen with proofs of key
knowledge → mask the 52-card deck → each party shuffles + re-randomizes with a shuffle argument →
selective deal by decryption shares with Chaum–Pedersen proofs → public reveal when both shares
are published. Hidden folds are free: a card whose shares were never published stays masked
forever.

The stack is chosen by a **time-boxed spike** (budget: two days) comparing Zypher's zk-shuffle SDK
and Manta's zkShuffle on: license; audit status; browser WASM proving time for a 52-card shuffle
(budget: ≤ 5 s on a mid laptop — AMENDED 2026-06-12 with user sign-off to ≤ 12 s on an M1-class
machine, absorbed at hand boundaries; see the spike addendum) and per-share proving
(budget: ≤ 100 ms); Solidity verifier gas;
and a clean deploy on PulseChain (both stacks use BN254 pairing precompiles, which PulseChain
inherits from Ethereum, so no precompile risk is expected — the spike confirms on 943). The spike
lands behind a fixed `MaskedDeck` interface in `@gibs/zk-cards-core` so nothing else waits on the
choice. If both stacks fail the budgets, the fallback is Geometry's arkworks Barnett–Smart
library compiled to WASM with a vendored Bayer–Groth verifier — more work, recorded as the risk.

### Channel layer

A table is a two-party state channel:

- **Create** (tx 1): player A escrows her bankroll, registers her channel key, fixes the rules
  tuple (game id, ante, chess-clock parameters, bankroll bounds).
- **Join** (tx 2): player B escrows and registers likewise. The table is now live; everything
  until settlement is off-chain.
- **Settle** (tx 3): either party submits the final co-signed state; the contract verifies both
  signatures and pays out. Top-up is one optional extra transaction; disputes are the only other
  chain path.

Sessions pipeline: tables are independent structs keyed by id; nothing in create/join reads any
other table, so a rematch opens immediately while the old settle is pending. In-session
reshuffles (deck exhausted) are pure off-chain protocol anchored by the next co-signed state.

### Transport layer

A deliberately dumb fast pipe in msgboard `packages/relayer`: table-scoped POST + SSE with a short
in-memory buffer, deployed beside the existing actors on the msgboard box. Clients treat it as
lossy and untrusted. A mirror worker batches each table's transcript into PoW-stamped MsgBoard
posts under a per-table category — categories posted as 32-byte hex (`stringToHex(name,
{size: 32})`), per the known SDK gotcha, so the archive indexes them.

### Verifiability layer

The venue's verify panel replays a session from the archive transcript alone: every signature,
shuffle argument, and share proof re-checked in the browser, every state transition re-derived —
the GamesLiveProof pattern extended from "re-check one flip" to "replay a whole table."

## The catalog

Rated by parties, fast messages per hand, hidden state, abort surface, effort (S/M/L), and what
sells it. Build order follows.

| # | Game | Parties | Msgs/hand | Hidden state | Effort | The sell |
|---|------|---------|-----------|--------------|--------|----------|
| 1 | **Hi-Lo War** | 2 PvP | ~6–9 | your card until showdown; folds never revealed | S | full rails on the smallest game; ships first |
| 2 | **Heads-up hold'em** | 2 PvP | ~30 | hole cards; community cards public | M+ | the marquee game; betting rounds + community reveals on proven rails |
| 3 | **Blackjack vs house** | 2 (house bot) | ~10 | dealer hole card; draw cards | M | "the house deals but cannot see your cards or stack the deck" |
| 4 | Video poker vs house | 2 (house bot) | ~8 | draw cards | S+ | solo play against a paytable, always-open table |
| 5 | Heads-up 5-card draw | 2 PvP | ~20 | hole cards | M | optional dry run for hold'em's betting machine; build only if hold'em wants a stepping stone |
| 6 | Gin rummy / cribbage | 2 PvP | 40+ | hands throughout | M+ | long-session social play; later |
| 7 | Baccarat vs house | 2 (house bot) | ~6 | almost nothing | S | low priority: barely uses the tech, and the existing raffle covers the few-decisions itch |
| 8 | Ring hold'em (3–6) | N | 30+ scaled by N | hole cards; N-party key shares | L | the endgame; per-seat dropout/redeal machinery; **own future spec** |
| 9 | Hearts / trick-taking | N | high | all hands | L | social tier; after ring rails exist |

Build order: **1 → 2 → 3**, then 4 cheaply on 3's house rails; 8 gets its own spec when its turn
comes. Games 5–7 and 9 are catalogued so the decision not to build them yet is recorded, not
forgotten.

## First build: Hi-Lo War

Deliberately "Kuhn poker in War clothing": the smallest rule set that still exercises private
deal, a simultaneous betting decision, hidden folds, public showdown, the war pot, reshuffles,
and the dispute clock. Hold'em adds betting rounds and community cards but no new cryptographic
moves.

### Rules

- Table opens with both bankrolls escrowed and a fixed **ante** per flip from the rules tuple.
- Setup (off-chain): joint keygen with proofs → mask deck → A shuffles with proof → B shuffles
  with proof → co-sign state 0 carrying the deck commitment.
- **Each flip:**
  1. The next two deck slots are dealt, one to each player, privately (each receives only the
     opponent's share for their own slot). Both antes enter the pot.
  2. Each player commits **raise** (add one ante) or **hold** as a salted commitment; both open
     after both have committed — simultaneous, no reaction advantage.
  3. If exactly one player raised, the other chooses **call** (match the raise) or **fold**. A
     fold ends the flip: the pot goes to the raiser and the folder's card is **never revealed**.
  4. If no fold occurred (both held, both raised, or the raise was called), both publish their
     reveal shares; both cards go public; **higher rank takes the pot** (ace high; suits
     irrelevant). Equal ranks carry the whole pot into the next flip (the
     war pot).
  5. Co-sign the new state (balances, next deck index, war-pot carry).
- Deck exhausted (fewer than 2 cards left): reshuffle in-channel (remask remaining + fresh full
  deck per the rules module; v1 simply remasks a fresh 52), co-sign, continue.
- Either player may stop at any flip boundary: co-sign final state, either submits settle. A
  rematch table opens immediately without waiting for the settle to confirm.
- Any stall — share not sent, commit not opened, state not co-signed — is dispute material; the
  chess clock forfeits the disputed pot and settles from the last co-signed state.

### Edge cases pinned

- Stall before state 0 (setup never completes): dispute machine refunds both escrows in full
  after one clock period — no pot exists yet, no forfeit.
- War-pot carry at session end: a tie on the final flip splits the carried pot evenly (the only
  split in the game; documented in the UI).
- Simultaneity: raise/hold commitments are salted hashes inside signed channel messages; opening
  out of order is harmless (the commitment binds), refusing to open is a stall.
- Top-up: only at a flip boundary, only above the in-channel minimum (one ante + current war
  pot), one transaction, reflected in the next co-signed state by both signatures.

## Contracts

New family in `gibsfinance/random` `packages/contracts`, deliberately separate from `GameBase`
(different trust model: no validator entropy, channel-settled):

- **`ZkTable`** — table structs keyed by id: create/join (escrow, channel keys, rules tuple),
  cooperative settle (two signatures over the final state → payout), top-up, and the dispute
  machine (submit state → chess clock → typed responses: higher-nonce co-signed state, or the
  phase-required protocol message with signature + proof verified → forfeit/resolve on expiry).
  Holds the verifier and rules-contract addresses per game id. No table reads another table.
- **Verifier contracts** — vendored from the spiked SDK: shuffle-argument verifier and
  decryption-share verifier. Reached only from the dispute path; the honest path never pays
  proof-verification gas.
- **`HiLoWarRules`** — pure functions the dispute machine consults: given a contested state and a
  candidate protocol message, is the transition legal? Each later game adds one rules contract,
  not a new table contract.

## Off-chain packages

Following the `examples/games/*` pattern (pnpm workspace, `@gibs/*` names):

- **`@gibs/zk-cards-core`** — the engine: `MaskedDeck` (wraps the spiked SDK's WASM provers and
  verifier bindings), channel state machine, transcript format, dispute-evidence builder,
  transport interface. No network code; fully unit-testable with two in-process clients.
- **`@gibs/hilo-war`** — rules module, flip state machine, view-model mirroring `HiLoWarRules`,
  with a cross-layer parity test in the existing style (the off-chain legality function and the
  contract must never drift).
- **Relay** (msgboard `packages/relayer`) — table-scoped POST + SSE, short buffer, stateless
  beyond it; compose-deployed beside the actors.
- **Mirror worker** — transcript batches → PoW-stamped posts, per-table 32-byte-hex category.
- **Web** (`@gibs/games-web`) — Hi-Lo War venue page in the card-room theme; verify panel = full
  table replay from the archive; key/salt custody follows the existing local-custody pattern.
- **Bots** — player-bots extended to sit at Hi-Lo War tables as ordinary channel clients
  (balance-aware, same ops-wallet hygiene: HD index 11, never the treasury), so tables fill from
  day one. 369 inherits the sparing-cadence rules unchanged.

## Testing

- **Engine:** two in-process clients driving full sessions through `@gibs/zk-cards-core`,
  including adversarial suites — bad shares, tampered proofs, replayed and stale states, refusal
  to open commitments, mid-flip disconnects.
- **Contracts:** Hardhat unit tests plus Foundry fuzz/invariants on the dispute machine; the
  headline invariant: *no interleaving of creates, joins, top-ups, settles, disputes, and
  responses ever pays out more than the table's total escrow, and every table reaches a terminal
  state.*
- **Parity:** the cross-layer test that fails the moment `@gibs/hilo-war` legality and
  `HiLoWarRules` disagree on any generated transition.
- **Acceptance:** a headless two-client walkthrough on Anvil (open → many flips including folds,
  ties, a reshuffle, a top-up → cooperative settle; then a dispute run with a stalling client),
  wired into the existing gate pattern and extended for the 943 live gate.

## Rollout

1. **Spike** (time-boxed, two days): pick the SDK; record license, audit status, proving times,
   verifier gas in a spec addendum.
2. **Anvil**: engine + contracts + walkthrough green.
3. **943**: deploy verifiers + `ZkTable` + `HiLoWarRules`; relay + mirror on the msgboard box via
   the existing workflow (`games-deploy`); bots filling tables; live gate passes; human browser
   click-through.
4. **369**: same contracts via the keyed valve endpoint, Sourcify verification, treasury hygiene
   and pause-when-dry rules as in force; venue page and docs updated under the standing branding
   rules.

## Open items

- Spike outcome (SDK choice + measured budgets) — RESOLVED 2026-06-12, see
  `2026-06-12-zk-cards-sdk-spike-addendum.md`: Zypher zshuffle (uzkge, pinned commit),
  Manta disqualified, Geometry priced as fallback. Both sign-off items APPROVED
  2026-06-12: shuffle budget amended ≤ 5 s → ≤ 12 s (bound above), GPL-3.0 posture
  accepted (non-commercial venue; revisit if monetized). Two pre-mainnet blockers remain
  (SRS provenance regeneration; license clarification with upstream).
- Chess-clock parameters (per-response blocks, dispute bond if any) — proposed during contract
  design from 943 block-time data; the spec fixes the mechanism, not the numbers.
- Ring-table spec (catalog entry 8) — written only when its turn arrives.
