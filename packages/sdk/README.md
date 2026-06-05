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
const work = await board.doPoW('gasmoneyplease', 'hello board')
// submit the valid message
const hash = await board.addMessage(work.message)
```

### with ethers

```ts
import * as msgboard from '@msgboard/sdk'
import { providers } from 'ethers'

const provider = new providers.JsonRpcProvider('https://one.valve.city/rpc/vk_demo/evm/369')
const board = new msgboard.MsgBoardClient(msgboard.wrapLegacySend(provider))

const work = await board.doPoW('gasmoneyplease', 'hello board')
const hash = await board.addMessage(work.message)
```

### read the board

```ts
const status = await board.status()       // enabled, counts, difficulty factors
const categories = await board.categories()
const content = await board.content()      // messages grouped by category
```

## Finding a node

A node must run the `msgboard_` module to serve these methods. If `status()` reports `enabled: false`, or a call returns JSON-RPC error `-32601` (method not found), the node does not have the module — point at one that does. See the live status badge on https://msgboard.xyz for working endpoints.

## Proof of work and difficulty

Submission is gated by proof of work, not a fee. Difficulty scales with message size:

```ts
((2n ** 24n + BigInt(dataLen) * 10_000n) * workMultiplier) / workDivisor
```

`dataLen` is measured in **bytes** (not hex characters); each byte adds 10,000 to the difficulty under the default factors, which rewards compact message packing. Compute the difficulty for a payload with:

```ts
board.getDifficulty('0x...') // bigint
```

`workMultiplier` and `workDivisor` come from `status()` and are applied automatically by `doPoW`.

Because each node validates incoming messages against **its own** current factors, these two numbers are also an implicit board-level setting, not just a per-message cost. Raising the required work — a higher `workMultiplier`, or a lower `workDivisor` — makes the board reject any message whose proof of work falls below the new threshold, so it accumulates **fewer** messages; loosening them admits **more**. Operators tune the same two knobs to trade spam-resistance against message volume. A client must therefore grind against the board's **live** factors (which `doPoW` reads from `status()`): work that was valid under looser settings can be rejected once a board tightens them.

## Categories

A category is a 32-byte hash. Pass a string and the client hashes it for you (`categoryHash`); pass hex and it is used as-is. The demo board uses the `gasmoneyplease` category.

## Ephemerality

Messages are short-lived: the board retains roughly the last 120 blocks of messages, so the board is a live signal, not durable storage.

## Keeping work off the UI thread

`doPoW` is a busy loop; JavaScript blocks while it runs. In a browser, run it in a Web Worker so the interface stays responsive. The client yields periodically (`breakInterval`) to let block updates resolve, but the heavy hashing still occupies the thread it runs on.

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

These run in the client, not on the node, so they are not in the OpenRPC spec:

- `doPoW(category, data, limit?)` — grind a valid proof-of-work message. Returns `{ message, stats }`.
- `getDifficulty(data)` — the difficulty for a given payload, as a `bigint`.
- Utilities: `categoryHash`, `checkWork`, `difficulty`, `encodeData`, `toRLP`, `fromRLP`, `fromRPCMessage`, `toRPCMessage`, `wrapLegacySend`.

## Machine-readable spec

The JSON-RPC surface is published as an OpenRPC document — [`openrpc.json`](https://github.com/valve-tech/msgboard/blob/master/packages/sdk/openrpc.json) — in this package, and hosted at [`msgboard.xyz/openrpc.json`](https://msgboard.xyz/openrpc.json). Open it in the [OpenRPC Playground](https://playground.open-rpc.org/?schemaUrl=https%3A%2F%2Fmsgboard.xyz%2Fopenrpc.json) (it loads automatically), or point a code generator at the hosted spec.

## License

MIT
