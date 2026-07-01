# safe-indexer

A self-hosted **Safe-owner indexer** for **PulseChain (369)** and its **v4 testnet (943)** — chains that
have **no official Safe Transaction Service**. It maps `owner address → [safe addresses]` and exposes
that under the **same response shape** as the Safe Tx Service, so the cosign UI can keep **one client**:

| chain | how the app finds a wallet's Safes |
|-------|------------------------------------|
| 1 (mainnet) | official Safe Tx Service — `GET https://safe-transaction-mainnet.safe.global/api/v1/owners/{address}/safes/` |
| 369 / 943   | **this indexer** — `GET /owners/{address}/safes?chainId={369\|943}` |

Built on **Ponder 0.16.6** (same stack/version/conventions as `deploy/games-indexer`).

## How it works

Every Gnosis Safe is a CREATE2 proxy minted by the canonical **SafeProxyFactory**, which emits
`ProxyCreation(proxy, singleton)`. Ponder's **factory pattern** auto-registers each `proxy` as a Safe
instance, and we then index its ownership events:

- **`SafeSetup(initiator, owners[], threshold, …)`** — the initial owner set + threshold
- **`AddedOwner(owner)`** / **`RemovedOwner(owner)`** — owner set changes
- **`ChangedThreshold(threshold)`** — threshold changes

`SafeSetup`/`AddedOwner` **insert** an owner edge; `RemovedOwner` **deletes** it — so the live rows are
always a Safe's current owner set.

### Two Safe generations

The v1.3.0 factory deploys v1.3.0 singletons and v1.4.1 deploys v1.4.1 singletons, and their
`AddedOwner`/`RemovedOwner` events differ in their `indexed` flags (v1.3.0 = not indexed, v1.4.1 =
indexed). `indexed`-ness controls where viem reads the arg (topic vs data), so **one ABI can't decode
both** — hence two contract definitions (`SafeV130`, `SafeV141`), each wired to its own factory with its
own ABI (`abis.ts`).

## Chains, factories, and start blocks indexed

Canonical SafeProxyFactory addresses (deterministic CREATE2, identical across EVM chains):

| version | factory address |
|---------|-----------------|
| v1.3.0  | `0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2` |
| v1.4.1  | `0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67` |

**Verified deployed** via `eth_getCode` against `https://one.valve.city/rpc/vk_demo/evm/{chain}`
(2026-07-01):

| chain | v1.3.0 | v1.4.1 | indexed |
|-------|:------:|:------:|---------|
| 369 (PulseChain)    | ✅ | ✅ | both factories |
| 943 (PulseChain v4) | ✅ | ❌ (`eth_getCode` → `0x`) | v1.3.0 only |

**Start blocks** = the exact factory contract-creation blocks (binary-searched via `eth_getCode`):

| chain | version | start block | source |
|-------|---------|-------------|--------|
| 369 | v1.3.0 | `12_504_126` | factory deploy block |
| 369 | v1.4.1 | `18_804_210` | factory deploy block |
| 943 | v1.3.0 | `12_504_126` | factory deploy block |

> **Backfill cost / caps.** 369 and 943 inherited Ethereum's pre-fork history, so the v1.3.0 factory
> "appears" at ETH mainnet's deploy block `12_504_126` — a **~14M-block** range to 369's head
> (~26.9M). Backfill is a sparse `eth_getLogs` scan (fine, but not instant). If you only need
> **PulseChain-native** Safes, raise the start block to the PulseChain fork (~`17_233_000` on 369) or a
> recent block via the env vars below — **whatever you set is what gets indexed**:
>
> ```
> PONDER_START_369_V130   (default 12_504_126)
> PONDER_START_369_V141   (default 18_804_210)
> PONDER_START_943_V130   (default 12_504_126)
> ```

## Schema (owner ↔ safe, many-to-many)

`ponder.schema.ts`:

- **`safe`** — one row per discovered Safe **per chain**. PK is `${chainId}:${safeAddress}` (CREATE2
  makes the bare address collide across 369/943, so chainId is part of the key). Tracks `address`,
  `chainId`, `threshold`, `version`, `createdBlock`, `createdAt`.
- **`safe_owner`** — the owner↔safe edge, one row per **current** owner. PK
  `${chainId}:${safe}:${owner}`. Indexed on `(chainId, owner)` (owner→safes, the hot query) and
  `(chainId, safe)` (safe→owners).

## Endpoints

Served by `src/api/index.ts` (Hono, mirroring games-indexer):

### REST (the contract the app uses)

```
GET /owners/:address/safes            # all indexed chains (369 + 943)
GET /owners/:address/safes?chainId=369
```

Response — **identical shape to the Safe Tx Service**, addresses **checksummed** and **deduped**:

```json
{ "safes": ["0xAbC0000000000000000000000000000000000001", "0x…"] }
```

- invalid address → `400 { "error": "invalid address" }`
- an owner with no Safes → `200 { "safes": [] }`
- trailing slash accepted (`/owners/:address/safes/`, matching the upstream)

### GraphQL (auto-generated from the schema)

```
POST /            (graphql)
POST /graphql
```

e.g. query `safeOwner(where: { owner: "0x…", chainId: 369 })` for the raw edges, or `safe(id: …)` for
threshold/version.

### Health

```
GET /health   →  ok
```

## Develop / verify

```bash
npm install
PONDER_RPC_URL_369=https://one.valve.city/rpc/vk_demo/evm/369 \
PONDER_RPC_URL_943=https://one.valve.city/rpc/vk_demo/evm/943 \
  npm run codegen           # validates config + schema, writes ponder-env.d.ts
npm test                    # vitest — owner→safes resolver + row-key unit tests
```

`ponder codegen` + `npm test` are the CI bar (matches games-indexer, which ships no tsconfig). The pure
resolver/row-key logic lives in `src/safes.ts` and is fully unit-tested in `test/safes.test.ts`.

**Still needs a live-chain run to confirm** (network-dependent, not run here): a full `ponder start`
against 369/943 with Postgres to confirm the factory discovery + ownership decode against real Safe
proxies end-to-end, and to measure real backfill time from block `12_504_126`.

## Deploy (not done yet — documented for the runbook)

Per repo policy, deploys **MUST** go through `ansible/` (idempotent, safe Caddy reload with rollback) —
not ad-hoc ssh/scp. This service is **not yet wired in**. To add it:

1. **Ansible:** add a `deploy-safe-indexer.yml` play modelled on `ansible/deploy-cosign.yml` — build the
   image (`deploy/safe-indexer/Dockerfile`), run it as a compose service `safe-indexer` with
   `PONDER_RPC_URL_369` / `PONDER_RPC_URL_943` and a fresh `PONDER_SCHEMA` (e.g. `safe_0`), then add the
   Caddy route with the same backup → `caddy adapt` validate → reload-with-rollback + body-aware smoke
   (this box's `caddy reload` does **not** reliably apply a brand-NEW host, so restart + `--resolve`
   healthcheck).
2. **Caddy:** simplest is a **path route** under the existing cosign host (zero DNS work) —
   `cosign.msgboard.xyz/safe-indexer/*` → `safe-indexer:42069` (see `install-caddy-route.sh`, which
   encodes the exact block and safety dance). Alternatively a dedicated `safe-indexer.msgboard.xyz` host,
   mirroring games-indexer — that needs a hand-added Cloudflare record (no API token on the box).

The cosign app then points its Safe-service client at `…/safe-indexer` for chains 369/943 and at the
official Safe Tx Service for chain 1.
