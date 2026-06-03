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
passthrough for any `msgboard_*` method. Typed object-readers (status/content structs) are a
planned addition.

## Develop

```sh
forge build
forge test
node script/gen-vectors.cjs   # regenerate the golden vector from @msgboard/core
```
