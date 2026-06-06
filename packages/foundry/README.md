# MsgBoard for Foundry

Solidity helpers for the MsgBoard proof-of-work message board.

## Install

```sh
forge install pulsechaincom/msgboard
```

Then remap to this package's `src` (the library lives under `packages/foundry/src`),
or vendor the two files you need.

## Verify proof of work

```solidity
import {MsgPow} from "msgboard/MsgPow.sol";

MsgPow.Message memory m = MsgPow.Message({
    nonce: nonce,
    blockHash: blockHash,
    category: category,
    data: hex"...",
    workMultiplier: workMultiplier,
    workDivisor: workDivisor
});
require(MsgPow.verify(m, difficulty), "invalid work");
```

`MsgPow` reproduces `@msgboard/core`'s work algorithm exactly (verified byte-for-byte by a
golden vector generated from the SDK). Verification costs ~700k gas (a secp256k1 `ecMul`), so
use it in tests/scripts or off the hot path.

## Talk to a node in tests/scripts

Configure an endpoint in `foundry.toml`:

```toml
[rpc_endpoints]
msgboard = "${MSGBOARD_RPC}"
```

```solidity
import {MsgBoard} from "msgboard/MsgBoard.sol";

bytes32 hash = MsgBoard.submit("msgboard", rlpEncodedMessage);
bytes memory status = MsgBoard.raw("msgboard", "msgboard_status", "[]");
```

`submit` posts an RLP-encoded message (`msgboard_addMessage`) and returns its hash. `raw` is a
passthrough for any `msgboard_*` method.

### A note on `vm.rpc` result encoding

`vm.rpc` decodes **scalar** results cleanly — a hash comes back as `bytes32`, a quantity as a
`uint`. But **object** results (`msgboard_status`, `content`, `getMessage`) come back as an
opaque ABI blob, *not* the JSON text. So typed struct-readers (e.g. a `status()` returning a
`Status` struct) can't simply lean on `vm.rpc`; for object methods, use `raw()` and parse
out-of-band for now. Typed readers are a planned addition built on that parse path.

## Examples

- [`examples/PoWGate.sol`](examples/PoWGate.sol) — a contract that gates an action behind a
  valid proof of work (`MsgPow.verify`), with replay protection. Exercised by
  `test/PoWGate.t.sol` against the golden vector.
- [`examples/PoWMint.sol`](examples/PoWMint.sol) — onboarding by proof of work: a minimal token
  whose mint is gated by `MsgPow.verify`. Each unique work stamp mints exactly once (for anyone),
  so "burn some CPU" becomes a sybil-resistant cost of entry with no whitelist or payment rail.
  Exercised by `test/PoWMint.t.sol`.
- [`script/PostMessage.s.sol`](script/PostMessage.s.sol) — a Forge script that posts a real
  message: it grinds a valid proof-of-work message off-chain via the SDK (over FFI), then
  `submit`s it. Posting requires proof of work tied to a recent block, which is impractical in
  Solidity — hence the FFI grind. **Proof of work takes minutes at production difficulty.**

  ```sh
  npm run build --workspace @msgboard/core   # from the repo root (the grinder needs core's dist)
  MSGBOARD_RPC=https://one.valve.city/rpc/vk_demo/evm/943 \
    forge script script/PostMessage.s.sol --ffi -vvv
  ```

## Layout & testing

```
src/                 MsgPow.sol (verifier), MsgBoard.sol (cheatcode helper)
test/                MsgPow.t.sol, PoWGate.t.sol, PoWMint.t.sol   — unit/example tests (deterministic, CI)
test/integration/    MsgBoard.t.sol                — live tests, gated on MSGBOARD_RPC
examples/            PoWGate.sol, PoWMint.sol
script/              gen-vectors.cjs, grind-message.cjs, PostMessage.s.sol
```

```sh
forge build
forge test                                   # unit + example tests (integration auto-skips)
node script/gen-vectors.cjs                  # regenerate the golden vector from @msgboard/core

# run the live integration tests against a real msgboard node:
MSGBOARD_RPC=https://one.valve.city/rpc/vk_demo/evm/943 \
  forge test --match-path "test/integration/*" -vv
```
