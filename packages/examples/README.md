# @msgboard/examples

Runnable, self-contained demos for the msgboard TypeScript packages. This is a private
workspace package (`private: true`) — it is not published to npm; it exists so the docs in
the other packages can point at working code.

Each demo is safe by default: read-only demos fall back gracefully when no node is reachable,
and write demos refuse to do real proof-of-work unless you explicitly point them at a node
with `MSGBOARD_RPC`.

## The demos

| Demo | run | reads/writes | demonstrates |
|---|---|---|---|
| `viem-demo.ts` | `npm run viem-demo --workspace=packages/examples` | read-only | a viem `PublicClient` works directly as the SDK `Provider` |
| `submit-message.ts` | `npm run submit-message --workspace=packages/examples` | writes (live) | the canonical write flow: `status` → `doPoW` → `addMessage` |
| `keep-alive.ts` | `npm run keep-alive --workspace=packages/examples` | writes (live) | keep a message in the ephemeral pool by re-posting before it ages out of the ~120-block window |
| `request-fulfill.ts` | `npm run request-fulfill --workspace=packages/examples` | read-only / watcher | broadcast a signed request, watch a category, verify the signature, fulfill — the skeleton behind Intent Distribution, Action Requests, and Account Abstraction |
| `multi-sig-collect.ts` | `npm run multi-sig-collect --workspace=packages/examples` | read-only / watcher | collect M-of-N owner signatures over a shared payload and assemble them once the threshold is met |
| `antagonistic-game.ts` | `npm run antagonistic-game --workspace=packages/examples` | read-only / watcher | a commit-reveal rock-paper-scissors round refereed over the board — impartial inputs, cheating caught |
| `write-for-me.ts` | `npm run write-for-me --workspace=packages/examples` | writes (relay) | a push-based relay that forwards client-computed RLP without re-doing proof-of-work |
| `archivist.ts` | `npm run archivist --workspace=packages/examples` | read-only + Postgres | sink-only relayer that archives every message to Postgres |

## Endpoints

All demos default to (or require) `MSGBOARD_RPC` — a JSON-RPC endpoint served by a node running
the msgboard reth fork. The public demo endpoint is:

```
https://one.valve.city/rpc/vk_demo/evm/943   # chain 943 (testnet)
https://one.valve.city/rpc/vk_demo/evm/369   # chain 369 (PulseChain mainnet)
```

`vk_demo` is a public, rate-limited demo key — fine for trying the demos, not for production.
Note that ordinary RPC endpoints (for example `rpc.pulsechain.com`) do **not** serve the
`msgboard_` namespace; only msgboard-fork nodes such as valve.city do.

## Demo details

### viem-demo

Confirms the SDK is provider-agnostic: a `createPublicClient` from viem is passed straight into
`new MsgBoardClient(...)`. Reads `status()` and `content()`. Falls back to an explanatory message
if no live node is reachable.

### submit-message

The fundamental write path, in four steps:

1. `status()` — read the board's difficulty factors.
2. `setDifficultyFactors(...)` — grind against the same difficulty the node enforces.
3. `doPoW(category, data)` — find a valid nonce (minutes at production difficulty; pegs a core).
4. `addMessage(work.message)` — submit; the node re-verifies the work before accepting.

Because it does real work and posts a live message, it requires `MSGBOARD_RPC` to be set and
prints the flow without grinding when it is not.

### keep-alive

The board is ephemeral — it retains only roughly the last ~120 blocks of messages, so a message
rooted at block B is evicted once the head advances ~120 blocks past it. Any use case where a
message must persist (a standing multi-sig request, an open intent for solvers, a pending action
request) has to watch its own message and re-post fresh proof-of-work before it ages out.

This demo posts a message, then each interval:

1. reads the head block and looks the message up by hash (`getMessage` returns `null` once evicted),
2. computes remaining life = `RETENTION_BLOCKS - (head - rootBlock)`,
3. re-grinds and re-submits when the message is gone or within `REFRESH_AT_BLOCKS_LEFT` of eviction
   — re-grinding re-roots the message to the current head, buying a fresh ~120-block lease.

Tunable via `RETENTION_BLOCKS`, `REFRESH_AT_BLOCKS_LEFT`, and `CHECK_INTERVAL_MS`. Requires
`MSGBOARD_RPC`; prints the strategy without grinding when it is not set. Note that each grind
takes a few minutes in the JavaScript SDK even at demo difficulty (the node grinds faster
natively), so a tight retention window may not leave enough time to re-grind before eviction —
in production you would lower the board's difficulty or grind with a faster implementation.

### request-fulfill

The shared pattern behind **Intent Distribution**, **Action Requests**, and **Account Abstraction**:
a user signs a request off-chain, posts it under a category, and any watcher recovers the signer and
decides whether to fulfill it. Because board data is untrusted, the fulfiller must verify the
signature before acting.

- No `MSGBOARD_RPC`: runs the whole pipeline in-process against a fresh signature — sign → encode →
  decode → recover → verify → fulfill — and shows that a tampered request fails verification.
- `MSGBOARD_RPC` set: runs a relayer-engine watcher (`msgboardContentSource` + a signature-checking
  condition + a fulfilling action) over the `intent` category.

### multi-sig-collect

**Multi-Sigs**: owners share their individual signatures over the board instead of routing through a
central coordinator. Each owner signs the same payload and posts it under a category; a collector
verifies each signature against the known owner set, dedups by signer, and assembles the set (sorted
by signer, as on-chain verifiers expect) once it reaches the threshold.

- No `MSGBOARD_RPC`: simulates a 2-of-3 signing, showing a non-owner signature and a duplicate signer
  both rejected, then the threshold met and the set assembled.
- `MSGBOARD_RPC` + `MULTISIG_OWNERS`: runs a relayer-engine watcher over the `multisig` category that
  accumulates signatures across polls.

### antagonistic-game

**Antagonistic Games**: games that need impartial inputs use the board as a neutral channel and
commit-reveal to pit players against each other. Each player commits `keccak256(move, salt)` (hiding
the move but binding to it), then reveals `(move, salt)` once both commits are posted; anyone can
check the reveal against the commit and adjudicate. Proof of work makes fake commits costly and the
~120-block ephemerality gives a natural reveal deadline (stalling forfeits).

- No `MSGBOARD_RPC`: plays one rock-paper-scissors round in-process and shows a player who reveals a
  move they did not commit to being disqualified.
- `MSGBOARD_RPC` set: runs a relayer-engine referee over the `rps` category.

### write-for-me

A long-running relay. Clients solve proof-of-work locally and POST the resulting RLP; the relay
forwards every accepted submission on chain without doing any proof-of-work itself.

```sh
curl -X POST http://localhost:3001/submit \
  -H 'Content-Type: application/json' \
  -d '{"rlp":"0x..."}'
```

Protect the endpoint by setting `RELAY_TOKEN` and sending `Authorization: Bearer <token>`.
Defaults to the testnet demo endpoint so a misconfigured relay never posts to mainnet by accident.

### archivist

A sink-only relayer: every message the board returns is recorded to a Postgres `message_archive`
table with a one-year retention. Runs in `observe` mode (the sink always runs; no on-chain action).
Requires `DATABASE_URL`.

## Foundry / Solidity

The Solidity-side demo lives in [`packages/foundry`](../foundry):

- [`script/PostMessage.s.sol`](../foundry/script/PostMessage.s.sol) — a Forge script that grinds a
  valid message off-chain (via the core SDK over `--ffi`) and submits it with the `MsgBoard`
  cheatcode helper.
- [`examples/PoWGate.sol`](../foundry/examples/PoWGate.sol) — a contract that gates an action behind
  on-chain proof-of-work verification using `MsgPow.sol`.
- [`examples/PoWMint.sol`](../foundry/examples/PoWMint.sol) — **Onboarding/Education**: a token whose
  mint is gated by proof of work. Each unique work stamp mints once, making "burn some CPU" a
  sybil-resistant cost of entry with no whitelist or payment. Exercised by `test/PoWMint.t.sol`.
