# Petition Fleet — 3 bots continuously sending gas-free petitions (chain 943)

`scripts/petition-fleet.sh` launches **3 testnet bots** that keep **creating + co-signing fresh
petitions** on the msgboard platform, forever, until you Ctrl-C. Both the create and the sign are
gas-free msgboard board posts (PoW only). The bots need **no on-chain balance**.

## What it does

Each bot, every cycle:
1. creates **one fresh, uniquely-worded petition** (gas-free board post), then
2. co-signs it with `SIGNER_COUNT` (default 5) addressIndex-derived keys (gas-free board posts).

Statements are made unique per cycle with a timestamp + counter, because the bot **dedups
petitions by statement text** — a fixed statement list would create once then idle. The harness
relaunches each bot with `ONCE=true` and a freshly generated statement each cycle to keep it sending.

The on-chain **settle** phase (`submitBatch`, which needs 943 gas + a funded creator key) is
**SKIPPED** via the `NO_SETTLE` flag. That's the whole point: continuous sending with zero gas.

## Setup — the two secrets

```bash
cp games/e2e/.env.petition-fleet.example games/e2e/.env.petition-fleet
# then edit games/e2e/.env.petition-fleet and set:
#   MNEMONIC=<12/24-word test mnemonic>
#   VALVE_RPC_KEY=<valve one.valve.city RPC key>
```

`.env.petition-fleet` is gitignored. The RPC endpoint is built as
`https://one.valve.city/rpc/<VALVE_RPC_KEY>/evm/943`.

## Run it

Dry run first (posts **nothing** — just logs what each bot would create/sign):

```bash
DRY_RUN=1 games/e2e/scripts/petition-fleet.sh
```

Go live (continuous gas-free sending; `Ctrl-C` stops all three bots):

```bash
games/e2e/scripts/petition-fleet.sh
```

Output is line-prefixed `[A]` / `[B]` / `[C]` per bot.

## Index map (disjoint key blocks — bots never collide)

| Bot | `CREATOR_INDEX` | `SIGNER_START_INDEX` | signer indices |
|-----|-----------------|----------------------|----------------|
| A   | 60              | 61                   | 61–65          |
| B   | 70              | 71                   | 71–75          |
| C   | 80              | 81                   | 81–85          |

Fixed per bot: `CHAIN=943`, `PETITION_VERIFIER=0x4e1c2e17fd4b9200654081a6f47a9b34ce498024`,
`SIGNER_COUNT=5`, `SETTLE_INTERVAL_MS=60000`, `NO_SETTLE=1`, `ONCE=true`.

## Gas-free (no-settle) note

- **Create + sign are gas-free** — they're msgboard board posts secured by PoW, not chain txs.
- **Settle is intentionally skipped** (`NO_SETTLE=1`), so no key needs a balance. If you later want
  the signatures recorded on-chain, run the plain `npm run petition-bot` (without `NO_SETTLE`) with a
  **funded** `CREATOR_INDEX` — that submits `submitBatch` and does cost 943 gas.

## Caveats / blockers a human must resolve

- **Secrets required.** The harness refuses to start until `MNEMONIC` and `VALVE_RPC_KEY` are set in
  `.env.petition-fleet`.
- **Chain 943 only.** `PetitionSignatures` is deployed on 943 (`0x4e1c2e17…`). It is **not deployed
  on 369**, so this fleet targets 943 exclusively.
- **PoW cost per post.** Each create/sign grinds PoW (~1–2s with the native/WASM grinder). With 3
  bots × (1 create + 5 signs) per cycle that's ~18 board posts/cycle; keep `CYCLE_SLEEP_SECS`
  reasonable so you're not perpetually grinding.
- **Signing window grows.** Each cycle the bot re-reads all petitions in the 30-day window to skip
  already-signed ones; after very many cycles that read pass gets slower. Lower
  `PETITION_WINDOW_DAYS` if you run it for a long time.
- **First-cycle grind on a cold machine.** The native grinder may fall back to WASM/JS if it isn't
  built; posts still succeed, just slower.
