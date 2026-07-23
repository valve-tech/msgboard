# Games Platform — off-chain core and consumers

> Extracted from gibsfinance/random (2026-07): the platform now lives here under `games/`,
> published as `@msgboard/*`. It consumes the Random protocol as a regular dependency
> (`@gibs/random`); the protocol repo holds only the protocol again.
>
> Build order on a fresh clone: `npm install` at the repo root, then `npm run build -w
> @msgboard/games-contracts` (hardhat compile — the web app and indexer import its artifacts),
> then anything else.

The off-chain half of the games platform: a chain-agnostic core library, one thin package per
game, and an end-to-end harness that proves the off-chain settlement always names the same winner
the contract pays.

## Package layout

- **`core/` (`@msgboard/games-core`)** — the substrate every game and every front end builds on. It
  owns the chain registry (a local development node on chain identifier 31337 and PulseChain
  testnet version four on chain identifier 943), the contract bindings and client factories, the
  validator secret and seed helpers, the round-state reader, the operator helpers (inking a
  validator pool, building bound heat locations, casting the seed), and the four-method `Game`
  interface. The fairness guarantee is structural: `settle(params, entries, seed)` takes the seed
  as an input only, so a game implementation physically cannot route player data back into the
  seed.
- **`coinflip/` (`@msgboard/coinflip`)** — the coin flip as a `Game` implementation: an even seed pays
  the heads player, an odd seed pays the tails player, exactly as the contract computes it.
- **`raffle/` (`@msgboard/raffle`)** — the raffle as a `Game` implementation: the revealed guess
  closest to the draw (one plus the seed modulo two hundred fifty-six, in the range one to two
  hundred fifty-six) wins; ties break to the earliest commit block and then the smallest ticket
  identifier, identical to the contract's comparison.
- **`e2e/` (`@msgboard/games-e2e`)** — the deploy helper, the cross-layer parity test, and the two
  runnable scripts. Nothing here contains game logic; it exercises the packages above against real
  contracts on a real node.

## Running the local end to end

Prerequisites: install Foundry so the `anvil` local node is available, compile the contracts once
(`npx hardhat compile` inside `packages/contracts`), and run `pnpm install` at the repository root.

1. Start the local node in one terminal: `anvil`
2. From the repository root, in another terminal:
   - `pnpm --filter @msgboard/games-e2e test` — the cross-layer parity test: a full raffle round
     on-chain, then the off-chain `settle` over the same entries and seed, asserting both name the
     same winning ticket.
   - `pnpm --filter @msgboard/games-e2e duel` — a complete coin flip: two players enter, the validator
     subset is heated, the secrets are cast, and the script prints the off-chain winner beside the
     on-chain winner followed by `PARITY OK`.
   - `pnpm --filter @msgboard/games-e2e raffle` — a complete raffle round through finalisation, with
     the same parity print.

Each script deploys fresh contracts, so restart `anvil` between runs (or just leave it running —
fresh deployments do not collide, but event scans start from block zero, so a fresh chain keeps
the output unambiguous).

## MsgBoard transport — hard rules

The off-chain session games can broadcast over MsgBoard (`@msgboard/games` `board.ts` /
`msgboardTransport.ts`). Two rules that are enforced in code, not just convention:

- **NEVER run MsgBoard proof-of-work (`doPoW`, i.e. `BoardClient.addMessage`) on a browser's main
  thread.** It is a multi-second busy-grind (~30–110s on the 943 board) and the main thread renders
  the UI — grinding there freezes the tab for the whole grind. `board.ts` guards this: `addMessage`
  throws if it detects a DOM (`typeof document !== 'undefined'`), so the mistake fails loudly instead
  of hanging the page. To post from the browser, grind inside a **Web Worker**. Reading the board
  (`content` / polling the live feed) needs no PoW and is fine on the main thread. Locked by
  `msgboard-games/test/board.test.ts`.
- **The discoverable feed category is `games.msgboard.xyz:lobby:<chain>`** (verbose, no abbreviation).
  Per-table feeds are `games.msgboard.xyz:table:<tableId>`. Bots post lifecycle notices (table open +
  settle summary) — never per round (PoW is too slow) — with a drop-if-busy guard so the queue can't
  grow unbounded. Any reader computing the same category name lands on the same `categoryHash`.

## The web app

`web/` (`@msgboard/games-web`) is the player-facing surface: Vite + React over the core, with no
game arithmetic of its own — every rule goes through the game packages, and every settled round
renders a "verify this draw yourself" panel that recomputes the winner off-chain (the parity
assertion as a product feature, with an explicit MISMATCH state). The trust disclosure below is
acknowledge-to-play.

Local development (anvil running):

1. `pnpm --filter @msgboard/games-web dev:local` — deploys Random + both games, allowlists three
   validators with sixteen-preimage pools (a preimage is one-shot; each pairing or arming
   consumes one per validator), seeds a waiting heads entry and a two-of-three raffle round,
   writes `src/generated/local.json`, and starts the dev server.
2. Point a browser wallet at `http://127.0.0.1:8545` (chain 31337) with any spare anvil key
   (account 9 is free) and play.
3. `pnpm --filter @msgboard/games-web dev:cast` is the stand-in validator: it casts any outstanding
   seeds and reveals the seeded bots' tickets. `dev:cast mine 31` passes the raffle period;
   `dev:cast mine 101` closes a reveal window so Finalise opens (anvil only mines on
   transactions).
4. `pnpm --filter @msgboard/games-web dev:walkthrough full` runs the whole loop headlessly —
   exactly the transactions the buttons send — and asserts both verify-panel parity conditions.

Raffle salt custody: the salt proving a hidden guess lives in the browser's localStorage; the
commit flow shows a backup string immediately, and losing the salt before revealing forfeits
the stake to the pot. The import field restores a backup on another browser.

PulseChain testnet v4 is LIVE in `web/src/config.ts` (filled from the 2026-06-10 gate run —
see the run log below and `e2e/scripts/943-deployment.json`). For settlement to happen, a cast
watcher must be running: `MNEMONIC=… SEEDS0=… pnpm --filter @msgboard/games-e2e cast-watcher`
(secrets re-derive from the seeds0 mnemonic; see `e2e/scripts/seeds0.ts` for the convention,
`ink-pools.ts` to provision fresh pools when the current ones run dry).

### Production deployment (games.msgboard.xyz)

The build is a fully static bundle (`pnpm --filter @msgboard/games-web build` → `web/dist/`); the
browser talks straight to the chain, so hosting is one Caddy site block on the msgboard box
behind the existing Cloudflare-proxied `msgboard.xyz` zone. The sequence, blocked first on the
live 943 gate run (without it the site has no playable chain):

1. Run the gate (`pnpm gate` with the funded mnemonic), fill `web/src/config.ts`'s 943 entry
   from the run log, commit, `pnpm --filter @msgboard/games-web build`.
2. Cloudflare dashboard: add a proxied A record `games` → the msgboard box, same as the
   existing `archive`/`evm-943-entropy` records.
3. On the box: copy `web/dist/` to `/var/www/games`, and add to the Caddyfile (it already
   terminates `*.msgboard.xyz` with the Cloudflare origin certificate):

   ```
   games.msgboard.xyz {
       tls /etc/caddy/origin.pem /etc/caddy/origin.key
       encode gzip zstd
       root * /var/www/games
       try_files {path} /index.html
       file_server
   }
   ```

   (Match the cert paths and any common snippets to the existing site blocks on the box —
   this lives in the private `deploy/` tree, not in this repository.) Validate with
   `caddy validate` before reloading, then `systemctl reload caddy`.
4. Smoke: `https://games.msgboard.xyz` loads, the trust banner shows, the chain picker offers
   PulseChain testnet v4, and a settled round's verify panel shows the match state.

## The disclosed trust assumption

Any player-facing surface must show this plainly: **a draw is safe as long as at least one of the
chosen validators is honest.** The contracts bind the heated entropy locations to the declared
validator subset positionally, so no party — not the operator, not the other player, not the game
itself — can substitute entropy sources after entry. What remains is the honesty assumption over
the subset the players accepted: if every validator in the subset colludes, they can grind the
seed; if even one is honest, they cannot.

## The live run (the parity gate)

The live run is a deliberate manual gate, not part of continuous integration, but the whole
procedure is automated by `e2e/scripts/parity-gate.ts`. It is chain-agnostic — `CHAIN` takes a
chain name as exported by viem's chain registry (case-insensitive: `pulsechainV4`, `pulsechain`,
`sepolia`, `foundry`, …), a friendly alias (`local`, `anvil`, `hardhat`, `dev` all mean the
development chain 31337), or a raw numeric chain identifier. The default is 943 (PulseChain
testnet version four). The endpoint defaults to the chain's public one, so `RPC` is only an
override. An operator holding the funded mnemonic runs, from `games/e2e`:

```bash
# PulseChain testnet version four (the default chain)
MNEMONIC="$(op read 'op://valve/randomness/recovery phrase')" \
  RPC=<the valve.city endpoint> \
  pnpm gate

# any other chain by name: supply the core Random address and the expected account
CHAIN=pulsechain RANDOM_ADDRESS=0x… EXPECTED_PROVIDER=0x… MNEMONIC=… pnpm gate
```

The script deploys `CoinFlip` and `Raffle` against core Random (943's live deployment at
`0x775AF72d62c85d2F7f0Bcc05BAa4Be0830087217` is pinned in `@msgboard/games-core`'s chain registry;
elsewhere pass `RANDOM_ADDRESS`) and caches the addresses per chain in
`scripts/.gate-deployments.json` so a re-run reuses them; allowlists three mnemonic-derived
validators and inks two price-zero preimages per validator (one for each game — a preimage is
one-shot); funds the player wallets from account zero with explicit gas caps (the PulseChain
call-prevalidation quirk, harmless elsewhere); runs one coin-flip duel and one full raffle round,
casting inside the twelve-block heat window; asserts at every settlement that the off-chain
`settle` names the on-chain winner; waits out the hundred-block claim window and finalises the
raffle payout; and appends the run record below under "Run log".

Useful switches: `DRY_RUN=true` simulates the deploys and an ink without broadcasting anything;
`SKIP_FINALISE=true` stops after the parity assertions instead of waiting out the claim window
(anyone may call `finalise` later); `COINFLIP=0x…`/`RAFFLE=0x…` reuse known deployments;
`EXPECTED_PROVIDER` guards against running with the wrong mnemonic (defaults to the known funded
account on 943). `CHAIN=local` runs the identical code path against anvil as a smoke test (mining
instead of waiting, no run-log append). The original `packages/contracts/scripts/duel-943.ts`
remains the historical reference for the funding and gas-cap patterns.

## Run log

### Run 2026-06-11 (chain 369)

- Random: `0x87fc31413534733a09df5dc5aa33b4dba1f64b61`
- CoinFlip: `0x66bdacfdd918f9d4c29f0a7d26609912ab478f4d`
- Raffle: `0x004564d44E6921FFA68936F44ae58988Cd146b10`
- Duel: seed `0xc723d413c3503c39e2063ec1dff03c9693c48e7af477e1773429132470e83a85`, winner `0x21D9FF00c90BDd06B0F87A186A64BB8713C6AB3B` (tails) — off-chain == on-chain ✓
- Raffle: draw 147, winning ticket 2 (`0x7eF899A02762AC1A65DFaA1D162Ef296a97Fe870`) — off-chain == on-chain ✓; finalised, payout 0.3 PLS to 0x7eF899A02762AC1A65DFaA1D162Ef296a97Fe870


### Run 2026-06-10 (chain 943)

- Random: `0x775AF72d62c85d2F7f0Bcc05BAa4Be0830087217`
- CoinFlip: `0x8d3a58d77d22636026066200f8868cd653ec2b2a`
- Raffle: `0x33f506fafe4f05c8de9a07e1c8a7f73f50f1da36`
- Duel: seed `0x99c565d15e3724c0fef09dcca5a20cd7adc0dc6acfd28c8260a53f7bde852929`, winner `0x21D9FF00c90BDd06B0F87A186A64BB8713C6AB3B` (tails) — off-chain == on-chain ✓
- Raffle: draw 73, winning ticket 3 (`0x568333a2F743FbCAdfDE027f2d72a4E43aDa891f`) — off-chain == on-chain ✓; finalised, payout 0.3 v4PLS to 0x568333a2F743FbCAdfDE027f2d72a4E43aDa891f


