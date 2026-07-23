# @msgboard/settle

On-chain settlement seam over the Plan-1 [`@msgboard/games`](../msgboard-games) substrate.

`@msgboard/games` plays the session entirely off-chain — provably-fair rounds, EIP-712 co-signed `SessionState` transitions, a hash-chained transcript — and never submits a transaction. This package is the bridge to chain: given a *retained transcript*, it reconstructs the co-signed states and builds the viem `TxRequest` calldata that settles the session against one of two backend contracts. It does not submit the transaction either — the caller simulates then writes (the `@msgboard/games-core` operator pattern); we only build the request shape.

---

## Exports

- **`Settlement`** — the seam (spec §6): one interface, interchangeable backends. `buildSettle(transcriptJson) → TxRequest`.
- **`replaySession(transcriptJson, ctx) → { open, final, rounds }`** — reconstructs the open (nonce 0) and final co-signed `SessionState`s from a retained transcript alone, re-verifying:
  1. the transcript chain links + sequence + EIP-191 envelope signatures (`Transcript.verify`),
  2. the published `rngCommit` matches `ctx.commit`,
  3. every server-seed reveal against the prior chain link,
  4. every round outcome recomputed from `(serverSeed, clientSeed, nonce)` against the recorded values,
  5. both parties' EIP-712 co-signatures on every reconstructed state.

  It throws on any mismatch (and on balance underflow / conservation), so settlement never builds calldata from a tampered transcript. This is the spec §2 **ephemerality** property: settle from the retained transcript alone, with no dependence on the (ephemeral) board.
- **`OptimisticSettlement`** / **`EscrowedSettlement`** — the two backend builders (below). Each wraps `replaySession` and emits `TxRequest`s.
- **`OpenTerms`** / **`OPEN_TERMS_TYPES`** / **`signOpenTerms`** / **`verifyOpenTermsSig`** — the house's off-chain authorization for an escrowed open. The field order mirrors `HouseChannel.sol`'s `OpenTermsLib` TYPEHASH exactly.
- **`makeSettleDomain(chainId, verifyingContract)`** — the EIP-712 domain for the settlement contracts (same name/version as `SessionState`); `verifyingContract` is the `HouseBankroll` or `HouseChannel` address.

---

## The two backends + their trust models

Both backends adjudicate **by co-signed balances only**. Neither recomputes a game round on-chain — the on-chain Dice/Limbo rules mirror is deferred (see below). The contracts trust the final both-signed `SessionState`, not a replay of the dice.

### Optimistic — `HouseBankroll` (spec §6.1)

A shared player deposit + a house pool. Both parties hold the open (nonce 0) and final co-signed states; anyone may submit `settle(openState, finalState, openSigPlayer, openSigHouse, finalSigPlayer, finalSigHouse)`. The contract recovers the player key from the open state, requires the same key on the final state and the configured `houseKey` on both, checks conservation (`open.player + open.house == final.player + final.house`), then moves **only the net delta** between the player's deposit and the house pool.

- **Incremental baseline.** The first settle of a session measures from the genesis open balance; a later settle of the same session measures from the *last-settled* balance, so re-settling at a higher nonce moves only the increment — never re-applies the whole genesis→final delta (no double-pay / double-debit).
- **Highest-nonce-wins.** `settle` reverts on a stale nonce (`finalState.nonce <= settledNonce[tableId]`).
- **Deposits are keyed by the session signing key** — the "fund the session key" model. This is a known v1 simplification; the fuller wallet-bound `SessionAuth` (deposit owned by the wallet, session key merely authorized) is a noted follow-up.
- **Trust model.** Settlement timing + the house's willingness to honor (it can mint chips to pay, so house solvency never picks the mode). The player's principal is never at risk beyond their deposit — losses are capped at `deposits[player]`.

### Escrowed — `HouseChannel` (spec §6.2)

Per-table escrow with a chess-clock dispute path — the hard-guarantee backend.

- **`open(OpenTerms, houseSig)`** — one player tx, no house tx. The player escrows their own chips and the contract reserves the house's escrow from the pool, authorized by the house's off-chain `OpenTerms` signature (the house pre-funds the pool via `fundHouse` and signs each open). Validates expiry, clock bounds (`MIN_CLOCK_BLOCKS`/`MAX_CLOCK_BLOCKS`), and that the table is fresh.
- **`settle(finalState, sigPlayer, sigHouse)`** — cooperative: anyone submits the final both-signed state; payout comes from locked escrow to the opening wallet, house share returns to the pool. Checks conservation against the locked escrows.
- **Dispute path** — `dispute(state, ...)` posts your latest both-signed state and starts the clock; `respondWithState(newerState, ...)` overrides with a strictly-newer both-signed state and settles immediately (single-draw games have no further play to resume); `resolveTimeout(tableId)` lets the disputer's posted state stand if the clock expires unanswered. Because Plan-1 `open` co-signs state 0, a party always holds at least one both-signed state, so no separate pre-state setup is needed.
- **Payout to the opening wallet** (`t.player`), not the session key.

`OpenTerms` is the single house authorization that makes the open a one-player transaction: `{ tableId, player, playerKey, escrowPlayer, escrowHouse, gameId, rngCommit, clockBlocks, expiry }`.

---

## Ephemerality

`replaySession` works from `transcript.toJSON()` alone — no board, no live session, no server state. A board outage after the session ends cannot block settlement: the retained transcript is the evidence. This is the spec §2 property that makes the broadcast layer disposable.

---

## Deferred to the ZK plan (spec §13, plan 5)

The on-chain Dice/Limbo **game-rules mirror** (and fuzzed rules parity against the off-chain `Game` seam) is **not** in Plan 2. Both Plan-2 backends adjudicate purely by co-signed balances; they never recompute a round on-chain. Recomputing rounds on-chain (and the ZK-RNG privacy/unilateral/fairness work) is the subject of the later ZK plan.

---

## Build-order note

The settle builders import compiled ABIs from `@msgboard/games-contracts/artifacts/contracts/games/*.json` (`HouseBankroll.json`, `HouseChannel.json`). **The contracts package must be built first:**

```sh
pnpm --filter @gibs/random build
```

before this package's tests or typecheck run, or the ABI imports resolve to nothing.

---

## Running

```sh
# off-chain settle package (build contracts first, see above)
pnpm test        # vitest — replay + optimistic + escrowed + openTerms
pnpm typecheck   # tsc --noEmit
```

The contracts themselves are tested in `packages/contracts`:

```sh
cd ../../../packages/contracts

# Foundry — the four games contracts
forge test --match-contract "SessionStateDigestTest|ChipsTest|HouseBankrollTest|HouseChannelTest" -vv

# Hardhat — EIP-712 parity + off-chain-play/on-chain-settle E2E
pnpm build && pnpm test --grep "SessionStateSig|MsgBoard settlement E2E"
```

---

Design spec: `docs/superpowers/specs/2026-06-13-msgboard-games-design.md` (§6 backends, §10, §12) in the msgboard repo.
