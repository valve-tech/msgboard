# MsgBoard Games — Broadcast-Bus Play + Async Settlement + Pluggable Trust (Design Spec)

Date: 2026-06-13
Status: Draft for review

Related specs:
- `2026-06-09-games-platform-design.md` — the validator-beacon house games (coin flip, raffle) and `GameBase`. This spec deliberately does NOT extend `GameBase`; the beacon's per-bet `heat→cast` round-trip is the latency we are eliminating. The beacon model remains valid for the large-output randomness it was designed for and stays the fallback entropy upgrade (see §4.3).
- `2026-06-11-zk-card-games-design.md` — the ZK mental-poker rails (`ZkTable` + `IGameRules` + Hi-Lo War). This spec REUSES those rails as the ZK corner of the settlement seam (§6.3) and AMENDS one claim in it (see §11).
- `2026-06-05-msgboard-relayer-design.md` — the `@msgboard/relayer` pool-watcher engine. The async settlement worker (§7) is a relayer composition that finally needs the nonce-window / replace-by-fee repricing that spec deferred to its §13.

## 1. Summary

A casino-games platform whose defining property is that **players never wait for a transaction to mine to keep playing.** Play is a sequence of cryptographically-authenticated steps each participant **broadcasts directly to everyone over MsgBoard** — no intermediary in the delivery path. Settlement is decoupled and **asynchronous**: an untrusted, anyone-can-run worker lands the net result on-chain in the background.

The platform recreates the `morbius.io`-style "Originals" suite — **Plinko, Keno, Mines, Dice, Limbo** (player-vs-house RNG games, captured from the reference recording `IMG_2259.MP4`) — and shares one broadcast/settlement substrate with the existing hidden-state card games (Hi-Lo War today; Poker/Blackjack later).

Two things are being shown off, deliberately:
1. **MsgBoard as a direct broadcast bus** — you publish your own step (a ZK input, a turn's result, or a signature proving intent) and the whole world can see and act on it, with no relay deciding delivery.
2. **ZK proofs** — both for hidden-state games and as a settlement *compressor* that lets one proof settle a whole batch of rounds trustlessly.

The same game can settle under one of three interchangeable trust models — chosen per session by **what the house has in its coffers** and **what the user is willing to do** — behind a single settlement seam.

## 2. What MsgBoard is, and is not (load-bearing)

This section governs the rest of the design.

- **MsgBoard is an ephemeral, intermediary-free broadcast bus.** A message is an RLP payload stamped with proof-of-work (`msgboard_addMessage`; difficulty scales with payload size — PoW is the anti-spam cost *in place of gas*, so posting is local-compute fast with no mining wait) and read back by category (`msgboard_content`). Any participant publishes their own steps directly; readers act on them immediately. There is no trusted relay in the transport path — a relay can at most observe, never gate.
- **MsgBoard is NOT a permanent record.** Messages are transient and may be evicted. Nothing in this design may depend on reading a message back off the board later. `archive.msgboard.xyz` offers best-effort historical lookup, but finding any given message there is **not guaranteed** — it is an audit convenience, never a trust anchor.
- **The blockchain is the permanent record.** Durable truth and every dispute resolution anchor on-chain in the settlement backend. The board's job is *liveness and coordination* (broadcast your step so the counterparty can respond now), not durable proof.
- **Therefore each participant locally retains its own evidence.** Every party keeps its own hash-chained transcript of co-signed states plus the counterparty's signatures. Settlement and disputes are driven by a party submitting **its retained** latest co-signed state on-chain — never by fetching it from MsgBoard. A board outage or eviction can stall *new* coordination but can never cost a party money it already holds a signature for.

The consequence is a clean split: **broadcast is ephemeral and trustless-by-publicity; money is permanent and trustless-by-chain.**

## 3. Goals and non-goals

### Goals
- Zero wait-to-play: no on-chain transaction sits in the critical path of a bet/round. Posting a step is PoW-stamped broadcast; the counterparty reacts off the board.
- One broadcast + session substrate shared by RNG games and card games.
- A single settlement seam with three interchangeable backends (optimistic / escrowed channel / ZK-proven), selectable per session.
- Recreate the five RNG games (Plinko, Keno, Mines, Dice, Limbo) faithful to the reference, each as a thin pure-rules consumer of the substrate.
- Async, untrusted settlement: anyone can run the worker; its only power is *when* settlement lands, never *whether* a player is paid what their signatures entitle them to.
- Parallel sessions: a player may run many games at once; nothing serializes them.
- Honest disclosure of the per-mode trust assumption in the UI.

### Non-goals (this design)
- On-chain or MsgBoard-sourced randomness in v1 — randomness is participant commit-reveal ("just the players involved"); a board/beacon entropy source is a later upgrade (§4.3).
- Treating MsgBoard as durable storage, a mempool replacement, or an ordering oracle.
- Matchmaking/lobby UX beyond canonical presets, spectating, tournaments, ERC-20 stakes, and a governance multisig (native token + plain owner in v1, behind swappable interfaces as the existing specs do).
- Re-implementing the validator-beacon games; they coexist unchanged.

## 4. The session and state model (game-agnostic)

### 4.1 Co-signed states
Every game advances a co-signed state, EIP-712 typed and reproducible on-chain, reusing the `ChannelState` patterns from the ZK rails:

```
SessionState {
  bytes32 tableId;        // session id
  uint64  nonce;          // monotonic; replay defense
  uint256 balancePlayer;  // running balances within the session
  uint256 balanceHouse;
  uint8   settlementMode; // 0 optimistic, 1 escrowed, 2 zk
  uint8   gameId;         // dice, limbo, plinko, keno, mines, …
  bytes32 gameStateHash;  // keccak over the game's canonical encoding
  bytes32 rngCommit;      // house server-seed chain head for this session
}
```

A state is valid only when carrying both signatures (player + house). Money moves only against a both-signed state (cooperative settle) or through the dispute path of the chosen backend. Each party retains its own hash-chained transcript of these (the §2 retention rule).

### 4.2 Randomness — participant commit-reveal (v1)
No on-chain randomness. The house pre-commits a **server-seed hash chain**: it draws `seed_N`, computes `h_i = H(h_{i+1})` down to `h_0`, and publishes `h_0` as `rngCommit` in the opening state. Per round it reveals the next `seed_i` in reverse; each reveal verifies against the previously-published hash, so the house cannot retroactively choose a seed. The player contributes a **client seed** + per-round nonce. The round result is `keccak256(serverSeed, clientSeed, nonce)` mapped by the game's rules. Because the server seed for a round is committed before the player's client seed is fixed and the client seed is unknown to the house when it commits the chain, neither side can grind a small-output result — the same property the beacon spec proves it needs, achieved here between the two participants without a validator. The house reveals consumed server seeds (per round or at settle) so the player verifies fairness exactly as on `morbius.io`.

### 4.3 Deferred entropy upgrades
A MsgBoard-sourced or validator-beacon entropy input is reachable later behind the same per-round seed interface (e.g., fold a board-derived value into the round hash) without changing the session model. Out of scope for v1 by explicit decision.

## 5. Games and rules modules

Each game is a pure rules module (TS off-chain, mirrored in Solidity only where a backend must adjudicate — parity-tested, exactly as Hi-Lo War's rules mirror is). The on-chain mirror is needed only for the escrowed and ZK backends' dispute/verify paths; the optimistic backend needs only the off-chain rules.

| Game | Shape | Per-round inputs | Mapping | Notes |
|---|---|---|---|---|
| **Dice** | single draw | clientSeed, nonce, target | roll-under in [0,100); `mult = (100/target)·(1−edge)` | trivial |
| **Limbo** | single draw | clientSeed, nonce, target | `roll = (1−edge)/(1−U)`, win if `roll ≥ target` | trivial |
| **Plinko** | single draw → table | clientSeed, nonce, rows, risk | 16 binary deflections → bucket → per-risk multiplier table | result is a path |
| **Keno** | draw-without-replacement | clientSeed, nonce, picks | K of 40 drawn; hits→paytable | |
| **Mines** | **stateful** | board commit, per-tile reveals, cash-out | product of per-step (cells/safe) ratios; cash-out before a mine | the only multi-step game; each reveal and the cash-out are co-signed steps |

Mines is the long pole on the rules side: its session has internal state (revealed tiles, running multiplier) and a cash-out decision, so its `gameStateHash` evolves within a single "round" and its dispute mirror must validate a reveal sequence against the committed board.

The existing card games (Hi-Lo War; Poker/Blackjack later) are the hidden-state members of the same roster; they ride the same broadcast layer (§2) and settle through the ZK backend (§6.3).

## 6. The settlement seam (the variable)

A single interface; three implementations selectable per session. Selection is a function of **house coffers** (how much, if anything, the house can lock) and **user willingness** (trust/gas/effort the player accepts). The session's `settlementMode` records the choice.

```ts
interface Settlement {
  open(session): Promise<OpenResult>           // optional escrow / commitment
  // play happens off-chain via §4 broadcast; the backend is not in the loop
  settle(latestCoSignedState, evidence): Promise<TxRequest>   // async, off critical path
  dispute(retainedState, demand): Promise<TxRequest>          // party-driven, on-chain
}
```

### 6.1 Optimistic (thin coffers / trusting user)
No *per-table* escrow, but not no backing: the player holds a **shared deposited balance** in the House bankroll (deposited once, drawn against by many sessions), and the house holds its bankroll — so a player can never lose more than deposited and the house can never owe more than its bankroll. Player and house exchange co-signed round receipts (broadcast on the board, retained locally). The settlement worker (or either party) submits the latest co-signed net delta to the bankroll, which pays the net between the two balances. Two safety rules carry it: both-signatures-required, and **highest-co-signed-nonce-wins** (a party submitting a stale favorable state is overridden by the counterparty's retained higher-nonce state). What "optimistic" gives up vs §6.2 is the *per-table forfeit clock* — there is no on-chain timer forcing a stalled session closed, so the residual exposure is settlement *timing* and reliance on bankroll solvency, not principal. Suited to small stakes and the demo path; the purest MsgBoard story. House coffers needed: only the standing bankroll, no per-table lock.

### 6.2 Escrowed channel (house has coffers / user wants a guarantee)
A `HouseChannel` contract: both sides escrow at `open`; play is co-signed states; `settle` submits the final both-signed state and pays from escrow; `dispute` lets either party post **its retained** latest co-signed state and, where the game requires it, the demanded revealed server-seed, with a chess-clock forfeit of the disputed amount on non-response (the `ZkTable` dispute pattern, minus the shuffle machinery). Trustless within the escrowed amount. House coffers needed: per-table escrow.

### 6.3 ZK-proven (showcase ZK / hidden state / batched trustless settle)
Two uses of one corner:
- **Hidden-state games (cards):** settle through the **existing `ZkTable` rails** — the shuffle/reveal verifiers and `IGameRules` already shipped. No new contract; Hi-Lo War is the worked example, Poker/Blackjack are future `IGameRules`.
- **RNG batched settlement:** a **batch-validity proof** attests "these N co-signed rounds, against server-seed chain head `rngCommit` and the players' client seeds, net to delta D, with every revealed seed consistent with the chain" — so the bankroll settles a whole batch with **one** proof and no per-round signature replay on-chain. Verified by a Groth16 verifier (the vendored uzkge Groth16 path is the reuse candidate; the circuit itself is new work and is the heaviest single piece of this spec). This is both the "really cool ZK" showcase and the strongest async-settle compressor.

## 7. Async settlement relayer

A composition over `@msgboard/relayer`, finally exercising the **nonce-window / replace-by-fee repricing** that relayer spec deferred to its §13. Responsibilities, all *off* the play critical path:

- **Land settlements.** Watch for sessions whose latest co-signed state is settle-ready (cooperative final, batch threshold reached, or a player closing out) and submit to the chosen backend.
- **Bump stuck transactions.** Replace-by-fee when a settlement tx is underpriced/stuck; a nonce window so multiple settlements pipeline rather than head-of-line block.
- **Nudge, don't gate.** Prompt a participant to sign the next state, or to top up gas, when progress stalls for want of a signature or fee — the user's "manage / remind / bump for signatures." These are reminders surfaced to the UI; the worker never forges or withholds.
- **Parallel sessions.** Independent sessions settle independently; the worker pipelines them.

It is **untrusted and anyone-can-run**: because play is broadcast on the board and money is bound by retained signatures, the worker's only power is *when* settlement lands. A malicious or absent worker delays settlement but cannot censor play (that is on the board) nor alter a payout (that is the signatures + chain). A party can always run its own worker — or call the backend directly — to self-settle.

## 8. Front end (`games.msgboard.xyz`)

Lives in `gibsfinance/random` at `examples/games/web/` (`@gibs/games-web`, Vite + React + viem-only, the existing games app). Additions:
- Each RNG game as a thin shell over its pure rules module; **instant results** rendered from the locally-computed round outcome the instant the counterparty's step appears on the board.
- **Parallel sessions** surface: multiple games in flight at once.
- A **settlement-status indicator** per session (playing → settle-pending → landed), because settlement is async — the user sees their balance as authoritative off-chain and watches it anchor on-chain in the background.
- Per-mode **trust disclosure** (optimistic vs escrowed vs ZK), and the provably-fair verify panel (reveal server seed, recompute the round) as a product feature.
- Relayer **nudges** (sign next state / top up gas) shown inline.

## 9. Where the code lives (cross-repo)

As with the current games work, this spans both repos; `progress.txt` in the msgboard repo is the shared worklog.

- **Contracts** — `HouseChannel`, House bankroll, the RNG batch-settlement verifier + circuit, and any on-chain rules mirrors → `gibsfinance/random` `packages/contracts`, beside `ZkTable`.
- **Off-chain session engine + rules modules + RNG core** → `gibsfinance/random` `examples/games` (beside `@gibs/zk-cards-core`, `@gibs/hilo-war`, `@gibs/games-core`).
- **Broadcast + async settlement relayer** → msgboard `packages/relayer`; MsgBoard posting via msgboard `packages/sdk`.
- **Web UI** → `gibsfinance/random` `examples/games/web`.

## 10. Error handling, recovery, security

- **Board ephemerality (§2).** No path reads a needed artifact back from the board. Every party persists its transcript; settle/dispute use the retained copy. A board outage stalls new coordination only.
- **Counterparty stall.** Escrowed: chess-clock forfeit on the disputed amount. Optimistic: the worker (or the party) settles the latest co-signed state; an un-signed proposed step is simply never money. ZK: a batch settles what was co-signed; an unfinished round is excluded.
- **House under-settlement.** Escrowed/ZK: impossible within escrow / proof — the contract pays from the signed state. Optimistic: bounded by bankroll solvency and caught by public signed evidence; mitigated by keeping optimistic stakes small (disclosed).
- **Player repudiation of a loss.** The player's signature on the prior state is retained by the house; settlement submits it. A player who stops signing forfeits only the ability to start new rounds, not escrowed balances.
- **Server-seed grinding.** Defeated by the pre-committed hash chain + the player's later client seed (§4.2); a reveal inconsistent with the chain is rejected at verify/dispute.
- **Conservation.** Every backend checks `balancePlayer + balanceHouse == escrow/bankroll debit` at settle; the dispute/settle status guard makes double-payout impossible (the `ZkTable` status-before-transfer rule).
- **Worker trust.** Untrusted by construction (§7).

## 11. Amendment to the ZK card games spec

`2026-06-11-zk-card-games-design.md` describes the MsgBoard mirror as "the permanent public record from which anyone can re-verify the entire session." Per §2 that is incorrect: MsgBoard is ephemeral, the blockchain is the permanent record, and `archive.msgboard.xyz` is best-effort. The card-game security argument must rest on **participant-retained transcripts + on-chain dispute**, not on board durability — which the `ZkTable` dispute machine already does (a party posts its own retained co-signed state; nothing fetches from the board). The card spec's wording should be amended to call the board mirror an *ephemeral broadcast/coordination layer and best-effort audit feed*, not the permanent record. (Tracked as a follow-up edit to that spec; no contract change implied.)

## 12. Testing

- **Rules parity (highest value).** For each game, fuzzed (seed, inputs) → the off-chain pure-rules result must equal the on-chain mirror used by the escrowed/ZK backends. The optimistic-only games still get the off-chain rules fuzzed against known vectors.
- **Provably-fair.** Server-seed chain verification (a reveal inconsistent with the published head is rejected); result determinism from (serverSeed, clientSeed, nonce); a grind-resistance assertion that neither party can bias a small-output result given the commit ordering.
- **Settlement backends.** Optimistic: bankroll pays the latest co-signed net, rejects stale nonce, rejects a single-signed state. Escrowed: open/settle/dispute/forfeit, conservation, no double pay. ZK: the batch proof verifies a correct net delta and rejects a tampered batch or an inconsistent revealed seed.
- **Relayer.** `runOnce` against fakes: lands a settle-ready session, replace-by-fee bumps a stuck tx, a nonce window pipelines two settlements, a nudge fires on a stalled signature — all with the safety default that it never forges or withholds.
- **Ephemerality.** A test that drops all board messages after broadcast and proves settle/dispute still succeed from retained transcripts alone.
- **End-to-end on a local chain.** Each game played through several rounds with instant results, then async settlement landing under each backend; plus the stall/dispute recovery paths.

## 13. Decomposition into sequenced plans

"Full spectrum" is several implementation plans, each shipping on top of the last. The spec is the shared architecture; the plans are:

1. **Session + broadcast substrate.** The `SessionState` model, EIP-712 typing + on-chain hash parity, the participant commit-reveal RNG (server-seed chain), MsgBoard broadcast/read helpers, retained-transcript persistence. Land Dice + Limbo (the two trivial games) end-to-end off-chain with instant play and local verification — no settlement yet.
2. **Settlement seam + optimistic + escrowed.** The `Settlement` interface; House bankroll (optimistic) and `HouseChannel` (escrowed) contracts + dispute/forfeit; settle Dice/Limbo under both. Conservation and parity tests.
3. **Async settlement relayer.** The `@msgboard/relayer` composition: land/settle, replace-by-fee + nonce window, sign/gas nudges, parallel sessions.
4. **Remaining games.** Plinko, Keno, then Mines (stateful — its own rules mirror + reveal-sequence dispute).
5. **ZK-proven RNG backend.** The batch-settlement circuit + Groth16 verifier wiring; the heaviest piece, sequenced last and independently. (Card games already occupy the ZK corner via `ZkTable`.)
6. **Web UI.** The five games in `examples/games/web`, parallel-session surface, settlement-status indicators, per-mode trust disclosure, provably-fair verify panel.

## 14. Open items carried into the plans

- House-coffers policy: the rule that maps (stake, game volatility, max payout) → which settlement mode is offered, and the per-mode escrow/bankroll sizing.
- House edge constants per game and whether they are owner-adjustable (default fixed, disclosed).
- Server-seed chain length / rotation cadence per session (how many rounds before a fresh chain head must be committed).
- The exact batch-proof public-input layout and whether the vendored uzkge Groth16 verifier is reused as-is or a fresh verifying key is generated for the RNG circuit (interacts with the uzkge pre-mainnet SRS-provenance blocker).
- Whether the House signer is co-located with the async worker or a separate always-online service (it can be either; affects ops, not safety).
