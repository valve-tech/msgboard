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

The same game can settle under one of three interchangeable trust models — chosen per session by **the trust, privacy, and effort the user wants** (and whether the house chooses to lock escrow) — behind a single settlement seam.

## 2. Two stores, different trust assumptions; cryptography is king (load-bearing)

This section governs the rest of the design. The platform does not push one stream of data through a fast tier into a slow tier. It uses **two distinct stores** and writes each datum to whichever one's trust model and cost fit it. They are complementary, not a pipeline.

- **The blockchain store.** A write costs gas and inherits the chain's **sybil resistance**, consensus, and **permanence**. Use it only for what must be scarce, final, and value-bearing: escrow, settlement, payouts, dispute outcomes. Expensive and slow, but durable and sybil-resistant.
- **The MsgBoard store.** A write costs **proof-of-work that scales per byte** — every byte raises the difficulty (`msgboard_addMessage`, RLP payload, read back by category via `msgboard_content`). That per-byte cost is the whole trust model: it makes posting a credible (if small) signal that the sender judged the message *marginally worth distributing*, and it makes spam self-limiting — in place of gas, and with no mining wait. It is **not sybil-resistant and not permanent**: messages are ephemeral and may be evicted, and `archive.msgboard.xyz` is best-effort lookup, **not a guarantee**. What it buys is the opposite of the chain's strengths: **everyone can see the information at zero cost to the reader and only compute-cost to the sender** — no gas, no on-chain footprint, no intermediary gating delivery.
- **Cryptography is king, independent of the store.** Signatures, commit-reveal, and ZK proofs are what make any artifact trustworthy — *not* where it was posted. A co-signed state is binding because of its signatures; a revealed seed is verifiable because of its prior commitment; a proof is sound on its own. So a self-authenticating artifact sitting on the ephemeral board is exactly as verifiable as one on chain — it simply is not permanent or sybil-resistant, which a thing you already hold a signature for does not need to be.
- **The incentive bridge (why this matters).** A participant frequently has no incentive to pay for a blockchain write — yet can still give everyone else exactly what they need by **revealing a secret or other information on MsgBoard at ~zero cost**. The house broadcasts its server seed so the player can verify a round; a player broadcasts a signature proving it wants to do X so the counterparty proceeds; a prover publishes a ZK input. None of these need sybil resistance or permanence — they need to be *seen* and *cryptographically bound*, which board + crypto deliver. The chain is touched only when sybil-resistant permanence actually matters: locking and settling money.

**Consequences for this design.** Money and finality live on-chain (the settlement backends, §6). Verifiable coordination — every play step, reveal, and proof input — is broadcast on MsgBoard. And because the board is ephemeral and not sybil-resistant, **each participant retains its own copy of anything it might later need to present on-chain**: its hash-chained transcript of co-signed states plus the counterparty's signatures. Disputes and settlement are driven by a party submitting **its retained, self-authenticating evidence** on-chain — never by reading it back off the board. A board outage stalls *new* coordination but can never cost a party money it already holds a signature for.

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
- Matchmaking/lobby UX beyond canonical presets, spectating, tournaments, and a governance multisig (plain owner in v1, behind swappable interfaces as the existing specs do).
- Chip tokenomics — peg, supply policy, cross-chain value, mint/faucet authority. Chips are a mintable per-chain ERC20 *unit of account* here; how they acquire and hold value is a separate decision.
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

### 4.3 Session keys — in-memory signing, no per-turn wallet popups
A co-signed `SessionState` per round would mean a wallet-signature popup per round if signed by the user's main wallet — fatal to instant play. Instead each side signs with an **in-memory session key** (a fresh ephemeral keypair held in the tab, never the main wallet key), the standard delegated-signing-key pattern:

- At session open the user authorizes the session key **once** with a single wallet signature/tx: *"session key K may act for me at table T, up to escrow E, until expiry X."* Thereafter every per-round co-signature is produced by K automatically — no popup, instant.
- On-chain, settlement/dispute verify signatures against the **authorized session key**, and the one-time wallet authorization binds it. A leaked session key risks only that session's escrow/expiry window, never the wallet.
- The house signs with its own hot session key (the signer ≠ settler split, §14). The wallet only reappears for principal-moving actions: the open authorization and settlement (which the relayer can sponsor, §7).

This is already latent in the rails: `ZkTable` separates the channel signing key from the wallet (`keyA`/`keyB`, set via a `channelKey` at create/join), and `HouseChannel.open` records the authorized session key the same way. In the off-chain substrate the player/house `Signer` is just `{ address, signTypedData/signMessage }`, so an in-memory key (e.g. viem `privateKeyToAccount`) is a drop-in signer — the substrate needs no special support; the authorization + on-chain key-binding live in the settlement plan and the UI's one-time "authorize session key" step.

### 4.4 Deferred entropy upgrades
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

A single interface; three implementations selectable per session. **Chips are a mintable per-chain ERC20 accounting unit** (the platform can mint to pay), so house solvency and per-session max-exposure are *not* what picks the mode — `stake × max-multiplier` is never a capital constraint. Selection is purely a **trust / UX / privacy** choice (and "what the user is willing to do"): optimistic for instant-and-trusting, escrowed for trustless-within-escrow, ZK for private and/or unilateral. The session's `settlementMode` records the choice. (What gives chips their *value* — peg, supply policy, tokenomics — is out of scope here per §3; this design treats chips as the unit of account.)

```ts
interface Settlement {
  open(session): Promise<OpenResult>           // optional escrow / commitment
  // play happens off-chain via §4 broadcast; the backend is not in the loop
  settle(latestCoSignedState, evidence): Promise<TxRequest>   // async, off critical path
  dispute(retainedState, demand): Promise<TxRequest>          // party-driven, on-chain
}
```

### 6.1 Optimistic (no per-table lock / trusting user)
No *per-table* escrow, but not no backing: the player holds a **shared deposited balance** in the House bankroll (deposited once, drawn against by many sessions) so a player can never lose more than deposited. Player and house exchange co-signed round receipts (broadcast on the board, retained locally). The settlement worker (or either party) submits the latest co-signed net delta to the bankroll, which pays the net between the two balances. Two safety rules carry it: both-signatures-required, and **highest-co-signed-nonce-wins** (a party submitting a stale favorable state is overridden by the counterparty's retained higher-nonce state). What "optimistic" gives up vs §6.2 is the *per-table forfeit clock* — there is no on-chain timer forcing a stalled session closed, so the residual exposure is settlement *timing* and reliance on the house actually paying (it can mint, so this is a willingness-to-honor trust, not a solvency one), never the player's principal. Suited to small stakes and the demo path; the purest MsgBoard story.

### 6.2 Escrowed channel (per-table lock / user wants a guarantee)
A `HouseChannel` contract: both sides escrow at `open`; play is co-signed states; `settle` submits the final both-signed state and pays from escrow; `dispute` lets either party post **its retained** latest co-signed state and, where the game requires it, the demanded revealed server-seed, with a chess-clock forfeit of the disputed amount on non-response (the `ZkTable` dispute pattern, minus the shuffle machinery). Trustless within the escrowed amount — the player needs no trust that the house will pay, since the funds are already locked. The house locks per-table escrow (cheap, since it can mint the chips it locks).

### 6.3 ZK-proven (showcase ZK / hidden state / private + unilateral RNG)
Two uses of one corner:
- **Hidden-state games (cards):** settle through the **existing `ZkTable` rails** — the shuffle/reveal verifiers and `IGameRules` already shipped. No new contract; Hi-Lo War is the worked example, Poker/Blackjack are future `IGameRules`.
- **RNG batch-validity proof.** One circuit, verified by the **vendored Plonk verifier** (universal KZG setup — no per-circuit ceremony; the SRS-provenance pre-mainnet blocker in VENDOR.md is shared with the card games and resolved once, not per circuit). The circuit proves: *from a committed opening balance, a sequence of N rounds — each a fair draw `result = f(serverSeed_i, clientSeed_i, nonce_i)` against the pre-committed server-seed chain head `rngCommit`, every stake/payout obeying the game rules — nets to delta D.* Its three jobs are selectable public-input configurations of this one circuit (all three pursued):
  1. **Privacy** — publish only `D` (or the final balance); keep per-round stakes/results/trajectory private. Fairness moves from publicly-recomputed to proven-in-circuit (the trade that makes this a mode, not the default).
  2. **Unilateral trustless settle** — because `rngCommit` is pre-committed, post-checkpoint outcomes are fixed by data the house already bound itself to plus the player's committed client seed; the proof stands in for the house's missing final signature, so a party settles the true final balance without counterparty cooperation.
  3. **Fairness-of-sequence** — one verification attests the whole session obeyed the committed chain (no off-chain seed, every reveal chain-consistent, every payout rule-correct); this is what makes (1) and (2) sound.

  This is the "really cool ZK" showcase and the strongest exit guarantee. The circuit is the heaviest single piece of this spec (sequenced last, §13 plan 5).

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
- **House under-settlement.** Escrowed/ZK: impossible within escrow / proof — the contract pays from the signed state. Optimistic: the residual trust is that the house honors (mints to pay) the player's retained co-signed balance; a refusal is publicly and cryptographically evidenced, and the player can switch to escrowed/ZK for any session it wants a hard guarantee on. Disclosed in the per-mode trust notice.
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
5. **ZK-proven RNG backend.** The one batch-validity circuit (privacy / unilateral-settle / fairness-of-sequence via selectable public inputs) wired to the **vendored Plonk verifier**; the heaviest piece, sequenced last and independently. (Card games already occupy the ZK corner via `ZkTable`.)
6. **Web UI.** The five games in `examples/games/web`, parallel-session surface, settlement-status indicators, per-mode trust disclosure, provably-fair verify panel.

## 14. Decisions and remaining open items

Resolved in review (2026-06-13):
- **Settlement-mode driver:** chips are a mintable per-chain ERC20, so exposure/solvency does not gate the choice; mode is a trust/UX/privacy decision (§6). Any MAX_WIN is a game-rules knob, not a solvency requirement.
- **House edge:** a term of the opening co-signed state the player signs (house publishes defaults); no owner-adjustable global, no mid-life mutation.
- **Server-seed rotation:** the stake.com pattern — published server-seed hash, player-set client seed, per-bet nonce, rotate on demand/per-session with reveal-on-rotation (old seed revealed so past bets become verifiable); chain length bounded by a max nonce per server seed.
- **ZK verifier + jobs:** the **vendored Plonk verifier** (universal setup, no per-circuit ceremony); one RNG batch-validity circuit exposing all three jobs — privacy, unilateral trustless settle, fairness-of-sequence (§6.3).
- **House signer vs settler:** roles separate (the signer authorizes play within house policy; settling is permissionless — anyone, including the player, can run it), co-located in v1 if convenient; safety does not depend on the split.

Still open (carried into the plans):
- The exact RNG batch-proof public-input layout and per-game witness encoding (interacts with the shared uzkge SRS-provenance pre-mainnet blocker — regenerated from a public ceremony once, for both the card and RNG circuits).
- Whether privacy mode also encrypts in-flight board messages (commitments instead of plaintext steps) or only hides at settlement — the board-fairness-vs-privacy trade of §6.3 job 1.
- Per-game rule constants (edge defaults, paytables, Mines grid/limits) — pinned when each game's rules module is built.
