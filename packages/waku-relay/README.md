# @msgboard/waku-relay

A local, one-way **Waku → MsgBoard** relay. It subscribes to Waku content topics and re-posts every
message it sees onto the MsgBoard board (and thus PulseChain), proof-of-work stamped — **no wallet, no
gas**. This is the v1 direction: a request that originates on Waku also lands on MsgBoard.

## Why one-way (v1)

- It's the primary goal: surface Waku messages on MsgBoard/PulseChain.
- With a single writer per side there is **no echo loop**, so it's safe to run before the persistent
  dedup + origin envelope are battle-tested.
- It lets you measure real proof-of-work throughput before considering the reverse direction. The
  `MsgBoard → Waku` pass is cheap (Waku has no PoW) but is the half that creates the echo loop — add it
  later, gated on the persistent seen-set this package already ships.

## The asymmetry that shapes everything

MsgBoard requires a **proof-of-work "stamp" per write** — the stamp *is* the spam gate (there is no
signature and no gas). Waku has none. So **every message crossing into MsgBoard costs a PoW grind**
(~1–2s with a native grinder; the pure-JS SDK path is much slower). Posts are therefore **serialized**
(one stamp at a time) and that grind rate is your throughput ceiling — check the board's difficulty via
`status()` before relaying high-volume topics.

## Install

```sh
npm i               # from the repo root (workspaces)
npm i @waku/sdk -w @msgboard/waku-relay   # the live Waku source (optional dep)
```

`@waku/sdk` is an **optional dependency**, imported dynamically — the package builds, type-checks, and
unit-tests without it. You only need it installed to run the live relay.

## Run

```sh
cp packages/waku-relay/.env.example packages/waku-relay/.env   # then edit
# from packages/waku-relay:
npm run start -- --channels lobby,games
# or a no-PoW preview of what would be posted:
npm run start -- --dry-run
```

### The category-encoding flag

Two conventions for turning a channel name into a board category coexist in this codebase and they
produce **different** `bytes32` for the same name. The relay pins one explicitly:

| encoding | formula | used by |
| --- | --- | --- |
| `keccak256` *(default)* | `keccak256(utf8(name))` | `@msgboard/sdk`, the games platform |
| `ascii32` | `stringToHex(name, { size: 32 })` | `@msgboard/relayer` |

Flip it with `--category-encoding ascii32` (or `RELAY_CATEGORY_ENCODING=ascii32`). An already-resolved
`0x…` 32-byte category passes through unchanged under either.

### Flags

```
--category-encoding <keccak256|ascii32>   default keccak256
--raw | --envelope                        bare payload vs origin-tagged envelope (default envelope)
--channels <a,b,c>                        channels to relay
--board-rpc <url>                         MsgBoard node RPC
--seen-path <file>                        persistent dedup log (recommended)
--dry-run                                 log would-be posts; spend no PoW
```

## How it works

```
Waku filter.subscribe(channel)
  → dedup by content id (in-memory + optional persistent append-log)
  → map channel → board category (keccak256 | ascii32)
  → build data: origin-tagged envelope (default) or raw payload
  → serialized stamp queue → doPoW(category, data) → addMessage   (one grind at a time)
```

A message is marked *seen* only **after** a successful post, so a failed post retries on redelivery; an
in-flight guard prevents a concurrent redelivery from double-posting in the meantime. Persisting the
seen-log (`--seen-path`) means a restart doesn't re-stamp and re-post everything Waku redelivers.

## Module map

| file | role |
| --- | --- |
| `src/category.ts` | channel → category, with the `keccak256`/`ascii32` flag |
| `src/envelope.ts` | origin-tagged envelope + origin-independent content id (dedup/echo key) |
| `src/seen.ts` | dedup set, in-memory + optional restart-persistent append-log |
| `src/msgboard.ts` | fetch JSON-RPC provider + `doPoW → addMessage` poster |
| `src/waku.ts` | `WakuSource` interface, live `@waku/sdk` light-node source, `MockWakuSource` |
| `src/relay.ts` | the bridge loop (subscribe → dedup → map → serialized stamp+post) |
| `src/config.ts` | env → config |
| `src/bin/relay.ts` | CLI (flag overrides, dry-run, graceful shutdown) |

## Not in v1

- **MsgBoard → Waku** (the reverse pass). The `origin`-tagged envelope and the origin-independent
  content id are already here so it can be added without an echo loop.
- A **native/worker-thread PoW grinder**. v1 uses the SDK's in-process grinder; swap `createBoardPoster`
  for a `worker_threads` grinder when throughput matters. The `BoardPoster` interface is the seam.
- **RLN** on the Waku side (not needed for a local light node).
