# Coin Flip — Two-Player Duel Harness (Plan)

Date: 2026-06-09
Status: In progress
Depends on: `2026-06-08-coin-flip-design.md` (spec), `2026-06-08-coin-flip-contract.md` (contract, built + merged locally)

## What this delivers

The first time two distinct wallets take opposite sides of a real flip on chain and
the pot actually moves to the parity-selected winner. Two phases, agreed with the user:

1. **Script harness** (`duel-943.ts`) — the fastest path to a real settled duel, on
   PulseChain testnet v4 (chain 943). Becomes the reference the web interface later mirrors.
2. **Web interface** — a minimal, explicitly testnet-only "two private key" duel page in
   the msgboard app (sub-project 3, first slice). Designed separately after Phase 1 proves
   the flow end to end.

## The dependency reality (why "two keys" is necessary but not sufficient)

`enterAndMatch(side, preimage, validatorLocations[])` cannot settle with only two player
keys. A duel needs three things to already be true on chain:

1. **`CoinFlip` is deployed** — it is not. Core `Random` already is, at
   `0x775AF72d62c85d2F7f0Bcc05BAa4Be0830087217` on 943.
2. **A validator entropy pool is inked** at a price-0 section — `validatorLocations[]` point
   into it. (Heat forwards no value, so every consumed preimage must be price 0.)
3. **Someone casts** the reveal within the request window to finalize the seed.

The script does all three in one self-contained run, mirroring the proven
`scripts/demo-consume-943.ts` pattern.

## Phase 1 — the script (`packages/contracts/scripts/duel-943.ts` in gibsfinance/random)

Mirrors `demo-consume-943.ts`: `op read` mnemonic in via `MNEMONIC`, viem + `pulsechainV4`,
simulate-then-send, event parsing, `DRY_RUN` support. Steps:

1. Derive account 0 from the funded mnemonic (`0xAF2b…4225`) — it is deployer, validator
   provider, funder, and caster. Derive two player wallets at account index 1 and 2.
2. Deploy `CoinFlip(random)` if no address is cached; persist the address.
3. Fund each player with `stake + gas` from account 0 if under-funded.
4. Ink a 3-preimage validator pool as account 0: price 0, token native, duration 12. Read
   the pool offset from the `Ink` event; build the three validator locations + secrets.
5. Player 0 enters **heads** (queues, empty validator array). Player 1 enters **tails** with
   `validatorLocations` — this pairs, inks both players, heats `[p0, p1, …3 validators]`, and
   returns the request `key`. Parse `Paired` (flipId), `Heated` (key, offset), `Start` (key).
6. Build the cast selection in heat order: `playerSection(offset,0)`, `playerSection(offset,1)`,
   then the three validator locations. Secrets in the same order:
   `[secretP0, secretP1, …validatorSecrets]`.
7. Cast as account 0 → `Random` fires `onCast` → `_settle` pays the winner, emits `Settled`.
8. Read `randomness(key).seed`; even = heads, odd = tails. Print the winner and the
   before/after balances showing the pot moved.

Config via env (all optional): `STAKE_943` (default 0.1 tPLS), `RPC_943` (default g4mm4;
override to valve.city for the 12-block window), `COINFLIP` (reuse a deployed address),
`WALK_AWAY=true` (both players commit the public walk-away secret, demonstrating the
validator-finalizable path). `DRY_RUN=true` simulates and stops before any broadcast.

### Key risk — the 12-block request window

`FLIP_DURATION = 12` blocks governs the heat request's expiry. The cast must land within ~12
blocks (~2 min on 943) of the match, or the request expires. The script casts immediately, so
it is fine; in production this tight window is exactly what the always-on validator node
service (sub-project 2) exists to satisfy. `claim()` recovers a finalized-but-unpushed seed;
`refundStale()` refunds both players after 200 blocks if the seed never finalizes.

### Verification

- `DRY_RUN=true` first: deploy + ink + match simulate clean against the live contract.
- Full run: a `Settled` event with a payout of `stake * 2`, the winner's balance up by ~`stake`
  (minus gas), the loser's down by `stake`, and the printed seed parity matching the winner.

## Phase 2 — the web interface (designed after Phase 1)

A minimal, clearly-labelled **testnet dev harness** page in the msgboard app: paste/select two
keys, pick sides and stake, fire the duel, watch the board, see the seed and winner with
citations (block, key, seed, parity). Not the production UX — pasting private keys is a dev
affordance. Production is wallet-connect plus the validator node service supplying entropy and
casting. Phase 2 gets its own short design pass: where it lives in the app, whether it drives
the chain directly or via a small backend, and how it reuses the Phase 1 sequence.

## Out of scope here

Pushing/PR-ing the contract to `origin/master`; the validator node service (sub-project 2);
ERC-20 stakes; configurable fees. All noted in `progress.txt`.
