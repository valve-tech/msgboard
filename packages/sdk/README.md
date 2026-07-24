# @msgboard/sdk

Distribute ephemeral messages across EVM networks using proof of work as the gate — no gas, no token, no account. You mint your own proof-of-work "stamp" for each message; that stamp is what keeps the board spam-resistant.

## Install

```sh
npm i --save @msgboard/sdk
```

## Quickstart

You need an RPC endpoint whose node runs the `msgboard_` module. Public PulseChain/Ethereum RPCs do **not** run it yet; [valve.city](https://valve.city) does. Its RPC endpoints are **keyed** — the API key sits in the path (`https://one.valve.city/rpc/<key>/evm/<chainId>`), and `vk_demo` is a public demo key for trying it out (for example `https://one.valve.city/rpc/vk_demo/evm/369`). You can also run your own node with the module.

### with viem

```ts
import * as msgboard from '@msgboard/sdk'
import { createPublicClient, http } from 'viem'
import { pulsechain } from 'viem/chains'

const client = createPublicClient({
  chain: pulsechain,
  transport: http('https://one.valve.city/rpc/vk_demo/evm/369'),
})
const board = new msgboard.MsgBoardClient(client)

// do the work for your category and data
const work = await board.grind('gasmoneyplease', 'hello board')
// submit the valid message
const hash = await board.addMessage(work.message)
```

### with ethers

```ts
import * as msgboard from '@msgboard/sdk'
import { providers } from 'ethers'

const provider = new providers.JsonRpcProvider('https://one.valve.city/rpc/vk_demo/evm/369')
const board = new msgboard.MsgBoardClient(msgboard.wrapLegacySend(provider))

const work = await board.grind('gasmoneyplease', 'hello board')
const hash = await board.addMessage(work.message)
```

### read the board

```ts
const status = await board.status()       // enabled, counts, difficulty factors
const categories = await board.categories()
const content = await board.content()      // messages grouped by category
```

## Finding a node

A node must run the `msgboard_` module to serve these methods. Ordinary public RPCs (for example `rpc.pulsechain.com`) do **not** run it. If `status()` reports `enabled: false`, or a call returns JSON-RPC error `-32601` (method not found), the node does not have the module — point at one that does.

### Supporting providers

| Provider | RPC | Chains | Node code |
|---|---|---|---|
| [valve.city](https://valve.city) | `https://one.valve.city/rpc/<key>/evm/<chainId>` | 1, 369, 943 | [valve-tech/reth](https://github.com/valve-tech/reth) |

The endpoints are **keyed** — the API key sits in the path, and `vk_demo` is a public, rate-limited demo key for trying things out (for example `https://one.valve.city/rpc/vk_demo/evm/369`). The list is small for now; other node teams (PulseChain, g4mm4) are working toward serving the module. The live support matrix is the **Join the Network** section on https://msgboard.xyz.

### Running your own

The module is implemented in the [valve-tech/reth](https://github.com/valve-tech/reth) fork (`crates/net/msgboard` + `msgboard-types`). Run that node for a chain and its RPC will serve the `msgboard_` methods — verify with `status()` returning `enabled: true`. There is no separate gateway to deploy: the module lives in the execution client itself.

## Proof of work and difficulty

Submission is gated by proof of work, not a fee. Difficulty scales with message size:

```ts
((2n ** 24n + BigInt(dataLen) * 10_000n) * workMultiplier) / workDivisor
```

`dataLen` is measured in **bytes** (not hex characters); each byte adds 10,000 to the difficulty under the default factors, which rewards compact message packing. Compute the difficulty for a payload with:

```ts
board.getDifficulty('0x...') // bigint
```

`workMultiplier` and `workDivisor` come from `status()` and are applied automatically by `grind`.

### The board enforces a floor, not a fixed config

A message **declares its own** `workMultiplier` and `workDivisor` — they are fields of the message, and they are cryptographically baked into the work (the challenge is derived from a digest of the two factors, so you cannot misreport them without redoing the grind). The node computes the message's difficulty from the message's *own* declared factors and accepts it when **both**:

1. the proof of work satisfies that declared difficulty (`workHash % difficulty == 0`), and
2. the declared difficulty is **at least** the board's current minimum — a single work threshold.

The consequence is the part that surprises people: **a message does not have to use the same factors as the board.** It only has to do *at least* as much work as the floor demands. Any factor pair whose resulting difficulty meets or exceeds the floor is accepted — even a different ratio, even far more work than required. (Verified on a live node: a message declaring `30000 / 3000000` was accepted by a board configured for `10000 / 1000000`.)

### Manipulating the work

`grind` reads the board's live factors from `status()` because they produce the **cheapest valid message** — the least work that still clears the floor. But you can deliberately do more:

```ts
const status = await board.status()
// Default: grind exactly to the board's floor (cheapest acceptable message).
board.setDifficultyFactors(BigInt(status.workMultiplier), BigInt(status.workDivisor))

// Or do extra work — e.g. halve the divisor to double the difficulty. Still accepted (it
// clears the floor), and it stays valid even if the board later tightens up to that level.
board.setDifficultyFactors(BigInt(status.workMultiplier), BigInt(status.workDivisor) / 2n)
```

So the two factors are best understood as a **board-level floor** plus a **per-message dial**: operators raise the floor (a higher `workMultiplier` or lower `workDivisor`) to admit fewer messages and resist spam, or lower it to admit more; individual senders may always pay *above* the floor. The only failure mode is paying **below** it — work that cleared a looser floor is rejected once the board raises it, which is why `grind` grinds against the **live** factors by default.

## Categories

A category is a 32-byte hash. Pass a string and the client hashes it for you (`categoryHash`); pass hex and it is used as-is. The demo board uses the `gasmoneyplease` category.

## Ephemerality

Messages are short-lived: the board retains roughly the last 120 blocks of messages, so the board is a live signal, not durable storage. The board also has a maximum size cap — if a burst of large messages fills the cap before the 120-block window expires, new submissions may be rejected until older messages age out. Design for loss: treat the board as a delivery channel, not a store.

## Keeping work off the UI thread

`grind` is a busy loop; JavaScript blocks while it runs. In a browser, run it in a Web Worker so the interface stays responsive. The client yields periodically (`breakInterval`) to let block updates resolve, but the heavy hashing still occupies the thread it runs on.

<!-- GENERATED:OPENRPC:START -->

## JSON-RPC methods

### msgboard_status

Board status and the difficulty factors required for valid messages.

| Parameter | Type | Required |
| --- | --- | --- |
| _(none)_ | | |

**Returns:** `Status`

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "msgboard_status",
  "params": []
}
```

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "enabled": true,
    "count": "0x0",
    "size": "0x0",
    "workMultiplier": "0x2710",
    "workDivisor": "0xf4240"
  }
}
```

### msgboard_categories

The list of 32-byte category hashes currently present on the board.

| Parameter | Type | Required |
| --- | --- | --- |
| _(none)_ | | |

**Returns:** `Categories`

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "msgboard_categories",
  "params": []
}
```

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": [
    "0x6761736d6f6e6579706c65617365000000000000000000000000000000000000"
  ]
}
```

### msgboard_content

All messages on the board, grouped by category hash. Optionally filtered.

| Parameter | Type | Required |
| --- | --- | --- |
| `filter` | `ContentFilter` | no |

**Returns:** `Content`

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "msgboard_content",
  "params": [
    {}
  ]
}
```

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {}
}
```

### msgboard_addMessage

Submit a proof-of-work message (RLP-encoded) to the board.

| Parameter | Type | Required |
| --- | --- | --- |
| `rlp` | `Hex` | yes |

**Returns:** `Hex`

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "msgboard_addMessage",
  "params": [
    "0xf800"
  ]
}
```

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": "0x0d1e2f00000000000000000000000000000000000000000000000000c46845f9"
}
```

### msgboard_getMessage

Fetch a single message by its hash.

| Parameter | Type | Required |
| --- | --- | --- |
| `hash` | `Hex` | yes |

**Returns:** `RPCMessage`

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "msgboard_getMessage",
  "params": [
    "0x0000000000000000000000000000000000000000000000000000000000000000"
  ]
}
```

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "version": "0x1",
    "blockHash": "0x0000000000000000000000000000000000000000000000000000000000000000",
    "blockNumber": "0x0",
    "category": "0x0000000000000000000000000000000000000000000000000000000000000000",
    "data": "0x0000000000000000000000000000000000000000000000000000000000000000",
    "nonce": "0x0",
    "hash": "0x0000000000000000000000000000000000000000000000000000000000000000",
    "workMultiplier": "0x0",
    "workDivisor": "0x0"
  }
}
```

## Schemas

### Hex

String matching `^0x[0-9a-fA-F]*$`.

### Status

| Field | Type | Description |
| --- | --- | --- |
| `enabled` (required) | `boolean` | Whether the module is enabled on this node. |
| `count` (required) | `Hex` | Overall count of messages stored on the board. |
| `size` (required) | `Hex` | Overall size of messages stored on the board. |
| `workMultiplier` (required) | `Hex` | Factor that increases required work. |
| `workDivisor` (required) | `Hex` | Factor that decreases required work. |

### Categories

Array of `Hex`.

### ContentFilter

| Field | Type | Description |
| --- | --- | --- |
| `category` | `Hex` | Restrict to one category hash. |
| `fromBlock` | `Hex` | Lower block bound (hex quantity). |
| `toBlock` | `Hex` | Upper block bound (hex quantity). |

### RPCMessage

| Field | Type | Description |
| --- | --- | --- |
| `version` (required) | `Hex` | Message/encoding version. |
| `blockHash` (required) | `Hex` | Hash of the block the message is rooted to. |
| `blockNumber` (required) | `Hex` | Number of the block the message is rooted to. |
| `category` (required) | `Hex` | 32-byte category hash. |
| `data` (required) | `Hex` | Arbitrary message data. |
| `nonce` (required) | `Hex` | Nonce discovered through proof of work. |
| `hash` (required) | `Hex` | The message hash. |
| `workMultiplier` (required) | `Hex` | Work multiplier in force when posted. |
| `workDivisor` (required) | `Hex` | Work divisor in force when posted. |

### Content

Messages grouped by category hash.

Object whose values are `RPCMessage[]`.

<!-- GENERATED:OPENRPC:END -->

## Client methods (not JSON-RPC)

These run in the client process, not on the node, so they are not part of the OpenRPC spec.

### `grind(category, data, limit?)`

Grinds a valid proof-of-work message. Reads current difficulty from `status()` before starting, so the work is always valid for the live board settings. Returns `{ message, stats }` where `stats` includes `nonce`, `duration`, and the number of iterations. The `limit` parameter sets a maximum number of iterations — useful for streaming progress or cancellation in long-running environments.

Since 0.0.33 the grind runs on the fastest engine available in your environment — the native/WASM `@msgboard/pow-grinder` if it loads, otherwise a pure-JS search — so a stamp is typically ~1–2s instead of tens of seconds. Pass a `stamper` in the client config to override the engine, or `stamper: null` to force the JS search.

> `doPoW(category, data, limit?)` is a retained alias for `grind` — older code that calls `doPoW` keeps working unchanged.

### `getDifficulty(data)`

Returns the difficulty threshold for a given payload hex string as a `bigint`. Helpful for estimating how long `grind` will take before committing to it.

### `categoryHash(name)`

Encodes a plain-text category name to the 32-byte hex hash the board stores. Pass the result directly to `grind` or `content()` filters.

### `wrapLegacySend(provider)`

Wraps an ethers v5 `JsonRpcProvider` (or any provider with a `send` method) into the `Provider` interface the client expects. Use this when you cannot upgrade to viem.

### Other utilities

`checkWork`, `difficulty`, `encodeData`, `toRLP`, `fromRLP`, `fromRPCMessage`, `toRPCMessage` — lower-level building blocks for custom proof-of-work loops, message encoding, and RPC message conversion. Their signatures are in the TypeScript types shipped with the package.

## Building automations

For server-side work — polling continuously, reacting to specific categories, archiving messages, triggering cross-chain actions — install the companion relayer package:

```sh
npm i @msgboard/relayer
```

```ts
import { http } from 'viem'
import { Relayer, msgboardContentSource, noopAction } from '@msgboard/relayer'
import type { RPCMessage } from '@msgboard/sdk'

const relayer = new Relayer<RPCMessage>({
  node: { transport: http('https://one.valve.city/rpc/vk_demo/evm/369') },
  // chain is auto-detected via eth_chainId — pass node.chain to override
  source: msgboardContentSource({ category: 'myapp' }),
  key: (msg) => msg.hash,
  action: noopAction(),
  // mode defaults to 'observe' — swap in webhookAction or submitMessageAction and set
  // mode: 'live' to execute real effects
})

relayer.start()
```

`Relayer` polls on a configurable heartbeat, deduplicates via a pluggable store (in-memory, Postgres), records everything to an optional archive sink regardless of mode, and gates `action.execute` on `mode: 'live'`. See the [`@msgboard/relayer`](https://www.npmjs.com/package/@msgboard/relayer) package for the full API, built-in sources/actions, and runnable examples.

## Machine-readable spec

The JSON-RPC surface is published as an OpenRPC document — [`openrpc.json`](https://github.com/valve-tech/msgboard/blob/master/packages/sdk/openrpc.json) — in this package, and hosted at [`msgboard.xyz/openrpc.json`](https://msgboard.xyz/openrpc.json). Open it in the [OpenRPC Playground](https://playground.open-rpc.org/?schemaUrl=https%3A%2F%2Fmsgboard.xyz%2Fopenrpc.json) (it loads the schema and pre-selects the valve.city PulseChain mainnet endpoint so you can call live methods directly), or point a code generator at the hosted spec.

All published packages are under the [`@msgboard`](https://www.npmjs.com/search?q=%40msgboard) scope on npm.

## License

MIT
