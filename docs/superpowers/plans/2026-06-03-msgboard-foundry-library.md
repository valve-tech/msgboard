# MsgBoard Foundry Library Implementation Plan — Plan B

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Foundry developers a `forge`-installable Solidity package (`packages/foundry`) that (a) verifies the MsgBoard proof of work on-chain/in-tests (`MsgPow.sol`), and (b) lets tests/scripts talk to a msgboard node via cheatcodes (`MsgBoard.sol`).

**Architecture:** A standalone Forge project under `packages/foundry`. `MsgPow.sol` re-implements the `@msgboard/core` work algorithm in Solidity, using Witnet's `EllipticCurve` for the secp256k1 `G·k` step. Correctness is pinned by a golden-vector test whose vectors are generated from `@msgboard/core` itself (at a low test difficulty so a valid nonce is found instantly). `MsgBoard.sol` is a cheatcode helper that submits messages (`msgboard_addMessage`) and exposes a generic raw JSON-RPC passthrough via `vm.rpc`.

**Tech Stack:** Solidity ^0.8.20, Foundry (forge), forge-std, witnet/elliptic-curve-solidity, Node (`@msgboard/core`) for vector generation.

**Spec:** `docs/superpowers/specs/2026-06-03-msgboard-brand-and-packages-design.md` (Plan B portion).

**The msgpow algorithm (from `packages/core/src/utils.ts`, the oracle this must match):**
- `digest = lowest 128 bits of sha256( workMultiplier as 8-byte BE ‖ workDivisor as 8-byte BE )`.
  (Core takes `"0x"+sha256(...).slice(34)` = the last 16 bytes = low 128 bits.)
- `k = ( nonce · digest + uint256(blockHash) ) mod n` where `n` is the secp256k1 order.
  (Core computes the full integer then `G.mul` reduces mod n; modular arithmetic is equivalent.)
- `X = ( k · G ).x`, encoded as **minimal big-endian bytes** (BN `toArray()` strips leading zero bytes — fidelity trap).
- `workHash = sha256( X ‖ category[32] ‖ data )`.
- Valid iff `uint256(workHash) % difficulty == 0`, where `difficulty = ((2^24 + dataLen·10000) · workMultiplier) / workDivisor`.

**Commit signing:** every commit signed via the 1Password SSH agent. NEVER `--no-gpg-sign`/`--no-verify`. No AI attribution. If signing fails, STOP and report BLOCKED. Platform: macOS (`sed -i ''`). Keep 1Password's auto-lock long during execution.

**Scope note:** Typed object-readers for `msgboard_status`/`content`/`getMessage` (returning Solidity structs) are deferred — they depend on `vm.rpc`'s undocumented object-result encoding, which needs a live-endpoint spike. This plan ships the verifier, the write path, and a generic raw passthrough; the typed readers are a follow-up once the encoding is confirmed.

---

## File Structure

**Create (all under `packages/foundry/`):**
- `foundry.toml` — Forge config + remappings.
- `.gitignore` — `out/`, `cache/`, `lib/` (deps installed via forge).
- `src/MsgPow.sol` — the verifier library.
- `src/MsgBoard.sol` — the cheatcode helper library.
- `test/MsgPow.t.sol` — golden-vector verifier tests.
- `test/MsgBoard.t.sol` — endpoint-gated integration test for submit/raw.
- `test/vectors/valid.json` — generated golden vector (committed).
- `script/gen-vectors.cjs` — Node generator (uses `@msgboard/core`).
- `README.md` — install + usage.

**Modify:**
- `.gitlab-ci.yml` — add a `forge test` job.
- Root `.gitignore` — ignore `packages/foundry/{out,cache,lib}`.

---

## Phase 1 — Scaffold the Forge project

### Task 1.1: Foundry project + dependencies

- [ ] **Step 1: Create `packages/foundry/foundry.toml`**

```toml
[profile.default]
src = "src"
out = "out"
libs = ["lib"]
test = "test"
fs_permissions = [{ access = "read", path = "./test/vectors" }]
remappings = [
  "forge-std/=lib/forge-std/src/",
  "elliptic-curve-solidity/=lib/elliptic-curve-solidity/src/",
]

[rpc_endpoints]
msgboard = "${MSGBOARD_RPC}"
```

- [ ] **Step 2: Create `packages/foundry/.gitignore`**

```gitignore
out/
cache/
lib/
```

- [ ] **Step 3: Install Forge dependencies (no git submodules — this repo is one git tree)**

```bash
cd /Users/michaelmclaughlin/Documents/3commascapital/gitlab/pulsechaincom/msgboard/packages/foundry
forge install foundry-rs/forge-std --no-git
forge install witnet/elliptic-curve-solidity --no-git
```
(`--no-git` vendors the libs into `lib/` without nested submodules, which is correct inside an existing repo. They are gitignored; CI re-installs them.)

- [ ] **Step 4: Verify the empty project builds**

Run: `cd packages/foundry && forge build`
Expected: compiles `forge-std` + `elliptic-curve-solidity`, exit 0.

- [ ] **Step 5: Ignore Forge artifacts at the repo root**

Append to the root `.gitignore`:
```
packages/foundry/out/
packages/foundry/cache/
packages/foundry/lib/
```

- [ ] **Step 6: Commit**

```bash
cd /Users/michaelmclaughlin/Documents/3commascapital/gitlab/pulsechaincom/msgboard
git add packages/foundry/foundry.toml packages/foundry/.gitignore .gitignore
git commit -m "chore(foundry): scaffold forge project for @msgboard"
```

---

## Phase 2 — `MsgPow.sol` verifier (golden-vector TDD)

### Task 2.1: Vector generator + golden vector (red needs a vector)

- [ ] **Step 1: Create `packages/foundry/script/gen-vectors.cjs`**

```js
// Generates a golden msgpow vector from @msgboard/core at a LOW difficulty so a
// valid nonce is found instantly. Writes packages/foundry/test/vectors/valid.json.
const path = require('node:path')
const fs = require('node:fs')
const repo = path.resolve(__dirname, '..', '..', '..')
const core = require(path.join(repo, 'packages/core/dist/index.js'))
const { bytesToHex } = require(path.join(repo, 'node_modules/viem'))

// workMultiplier/workDivisor chosen so difficulty = (2^24 * wm)/wd = 256
const workMultiplier = 1n
const workDivisor = 65536n
const category = core.categoryHash('gasmoneyplease') // 32-byte hex
const data = '0x'
const blockHash = '0x' + '00'.repeat(32)
const difficulty = core.difficulty({ workMultiplier, workDivisor }, 0) // 256n

let nonce = 0n
let valid = null
while (nonce < 10000000n) {
  nonce += 1n
  const msg = { version: 1, blockHash, category, data, nonce, workMultiplier, workDivisor }
  if (core.checkWork(msg, difficulty)) { valid = msg; break }
}
if (!valid) throw new Error('no vector found')

const vector = {
  nonce: valid.nonce.toString(),
  blockHash,
  category,
  data,
  workMultiplier: workMultiplier.toString(),
  workDivisor: workDivisor.toString(),
  difficulty: difficulty.toString(),
  challengeX: bytesToHex(core.getChallenge(valid)),
  workHash: core.checkWork(valid, difficulty),
}
const outDir = path.join(__dirname, '..', 'test', 'vectors')
fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(path.join(outDir, 'valid.json'), JSON.stringify(vector, null, 2) + '\n')
console.log('wrote test/vectors/valid.json:', vector)
```

- [ ] **Step 2: Generate the vector**

```bash
cd /Users/michaelmclaughlin/Documents/3commascapital/gitlab/pulsechaincom/msgboard
npm run build --workspace @msgboard/core   # ensure core/dist exists
node packages/foundry/script/gen-vectors.cjs
cat packages/foundry/test/vectors/valid.json
```
Expected: prints a vector with `difficulty: "256"`, a `nonce`, a `challengeX`, and a `workHash` whose `uint % 256 == 0`.

### Task 2.2: Failing test for the verifier

- [ ] **Step 1: Create `packages/foundry/test/MsgPow.t.sol`**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {MsgPow} from "../src/MsgPow.sol";

contract MsgPowTest is Test {
    function _load() internal view returns (MsgPow.Message memory m, uint256 difficulty) {
        string memory json = vm.readFile("./test/vectors/valid.json");
        m.nonce = vm.parseUint(vm.parseJsonString(json, ".nonce"));
        m.blockHash = vm.parseJsonBytes32(json, ".blockHash");
        m.category = vm.parseJsonBytes32(json, ".category");
        m.data = vm.parseJsonBytes(json, ".data");
        m.workMultiplier = uint64(vm.parseUint(vm.parseJsonString(json, ".workMultiplier")));
        m.workDivisor = uint64(vm.parseUint(vm.parseJsonString(json, ".workDivisor")));
        difficulty = vm.parseUint(vm.parseJsonString(json, ".difficulty"));
    }

    function test_verifies_valid_vector() public view {
        (MsgPow.Message memory m, uint256 difficulty) = _load();
        assertTrue(MsgPow.verify(m, difficulty), "valid vector must verify");
    }

    function test_rejects_tampered_nonce() public view {
        (MsgPow.Message memory m, uint256 difficulty) = _load();
        m.nonce += 1;
        assertFalse(MsgPow.verify(m, difficulty), "tampered nonce must not verify");
    }

    function test_workHash_matches_core() public view {
        (MsgPow.Message memory m, ) = _load();
        string memory json = vm.readFile("./test/vectors/valid.json");
        bytes32 expected = vm.parseJsonBytes32(json, ".workHash");
        assertEq(MsgPow.workHash(m), expected, "workHash must match @msgboard/core");
    }
}
```

- [ ] **Step 2: Run — expect FAIL (MsgPow.sol does not exist)**

Run: `cd packages/foundry && forge test --match-contract MsgPowTest`
Expected: compile error / fail (no `src/MsgPow.sol`).

### Task 2.3: Implement `MsgPow.sol` (green)

- [ ] **Step 1: Create `packages/foundry/src/MsgPow.sol`**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {EllipticCurve} from "elliptic-curve-solidity/EllipticCurve.sol";

/// @title MsgPow — Solidity verification of the MsgBoard proof of work (msgpow).
/// @notice Mirrors @msgboard/core's checkWork. See the plan header for the algorithm.
library MsgPow {
    // secp256k1 parameters
    uint256 internal constant GX = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798;
    uint256 internal constant GY = 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8;
    uint256 internal constant AA = 0;
    uint256 internal constant PP = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F;
    uint256 internal constant NN = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    struct Message {
        uint256 nonce;
        bytes32 blockHash;
        bytes32 category;
        bytes data;
        uint64 workMultiplier;
        uint64 workDivisor;
    }

    /// @dev low 128 bits of sha256(workMultiplier(8B BE) ‖ workDivisor(8B BE)).
    function digest(uint64 workMultiplier, uint64 workDivisor) internal pure returns (uint256) {
        bytes32 h = sha256(abi.encodePacked(workMultiplier, workDivisor));
        return uint256(h) & type(uint128).max;
    }

    /// @dev k = (nonce*digest + blockHash) mod n, matching elliptic's reduction.
    function challengeX(Message memory m) internal pure returns (uint256 qx) {
        uint256 d = digest(m.workMultiplier, m.workDivisor);
        uint256 k = addmod(mulmod(m.nonce, d, NN), uint256(m.blockHash) % NN, NN);
        (qx,) = EllipticCurve.ecMul(k, GX, GY, AA, PP);
    }

    /// @dev minimal big-endian bytes (strip leading zero bytes) — matches BN.toArray().
    function minimalBytes(uint256 x) internal pure returns (bytes memory out) {
        if (x == 0) return new bytes(0);
        uint256 n = 0;
        uint256 t = x;
        while (t != 0) {
            n++;
            t >>= 8;
        }
        out = new bytes(n);
        for (uint256 i = 0; i < n; i++) {
            out[n - 1 - i] = bytes1(uint8(x >> (8 * i)));
        }
    }

    function workHash(Message memory m) internal pure returns (bytes32) {
        bytes memory pre = abi.encodePacked(minimalBytes(challengeX(m)), m.category, m.data);
        return sha256(pre);
    }

    function verify(Message memory m, uint256 difficulty) internal pure returns (bool) {
        require(difficulty != 0, "MsgPow: zero difficulty");
        return uint256(workHash(m)) % difficulty == 0;
    }
}
```

- [ ] **Step 2: Run — expect PASS**

Run: `cd packages/foundry && forge test --match-contract MsgPowTest -vv`
Expected: 3 tests pass. If `test_workHash_matches_core` fails, the discrepancy is almost certainly in `minimalBytes` (leading-zero handling) or the `digest` slice — compare `MsgPow.workHash` against the vector's `challengeX`/`workHash` and fix until it matches. The golden vector from `@msgboard/core` is the source of truth.

- [ ] **Step 3: Commit**

```bash
cd /Users/michaelmclaughlin/Documents/3commascapital/gitlab/pulsechaincom/msgboard
git add packages/foundry/src/MsgPow.sol packages/foundry/test/MsgPow.t.sol packages/foundry/test/vectors/valid.json packages/foundry/script/gen-vectors.cjs
git commit -m "feat(foundry): MsgPow Solidity proof-of-work verifier"
```

---

## Phase 3 — `MsgBoard.sol` cheatcode helper (write path + raw passthrough)

### Task 3.1: The library

- [ ] **Step 1: Create `packages/foundry/src/MsgBoard.sol`**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Vm} from "forge-std/Vm.sol";

/// @title MsgBoard — Foundry cheatcode helper to talk to a msgboard node.
/// @notice Uses vm.rpc against a named endpoint (configure [rpc_endpoints] msgboard).
/// Typed object-readers (status/content/getMessage structs) are intentionally omitted
/// pending confirmation of vm.rpc's object-result encoding; use raw() for those today.
library MsgBoard {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @notice Submit an RLP-encoded message; returns the message hash.
    /// @param endpoint the rpc alias or URL of a msgboard-serving node
    /// @param rlp the RLP-encoded message (hex)
    function submit(string memory endpoint, bytes memory rlp) internal returns (bytes32 hash) {
        string memory params = string.concat('["', _toHexString(rlp), '"]');
        bytes memory result = vm.rpc(endpoint, "msgboard_addMessage", params);
        // addMessage returns a 32-byte hash; vm.rpc decodes the hex result to raw bytes
        require(result.length == 32, "MsgBoard: unexpected addMessage result");
        hash = bytes32(result);
    }

    /// @notice Raw JSON-RPC passthrough for any msgboard_* method.
    /// @return the raw bytes result as decoded by vm.rpc
    function raw(string memory endpoint, string memory method, string memory params)
        internal
        returns (bytes memory)
    {
        return vm.rpc(endpoint, method, params);
    }

    function _toHexString(bytes memory b) private pure returns (string memory) {
        bytes memory alphabet = "0123456789abcdef";
        bytes memory out = new bytes(2 + b.length * 2);
        out[0] = "0";
        out[1] = "x";
        for (uint256 i = 0; i < b.length; i++) {
            out[2 + i * 2] = alphabet[uint8(b[i]) >> 4];
            out[3 + i * 2] = alphabet[uint8(b[i]) & 0x0f];
        }
        return string(out);
    }
}
```

Note: `vm.rpc(endpoint, method, params)` is the three-argument overload (alias/URL + method + params). If the installed forge-std only exposes the two-argument `vm.rpc(method, params)`, switch `submit`/`raw` to set the fork first via `vm.createSelectFork(endpoint)` and call the two-arg form — verify the available signature in `lib/forge-std/src/Vm.sol` during Step 2.

### Task 3.2: Endpoint-gated integration test

- [ ] **Step 1: Create `packages/foundry/test/MsgBoard.t.sol`**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {MsgBoard} from "../src/MsgBoard.sol";

/// Integration test: only runs when MSGBOARD_RPC points at a msgboard-serving node.
/// Without it, the test returns early (passes) so CI without an endpoint stays green.
contract MsgBoardTest is Test {
    function test_raw_status_when_endpoint_set() public {
        string memory rpc = vm.envOr("MSGBOARD_RPC", string(""));
        if (bytes(rpc).length == 0) {
            emit log("MSGBOARD_RPC unset — skipping integration test");
            return;
        }
        bytes memory result = MsgBoard.raw("msgboard", "msgboard_status", "[]");
        assertGt(result.length, 0, "status should return data");
    }
}
```

- [ ] **Step 2: Verify the Vm signature, then build + test**

```bash
cd packages/foundry
grep -n "function rpc(" lib/forge-std/src/Vm.sol   # confirm the 2- vs 3-arg overload
forge build
forge test --match-contract MsgBoardTest -vv
```
Expected: `forge build` exits 0; the integration test logs "skipping" and passes (no endpoint in this environment). If the three-arg `rpc` overload is absent, apply the `createSelectFork` fallback noted in Task 3.1 Step 1 and rebuild.

- [ ] **Step 3: Commit**

```bash
cd /Users/michaelmclaughlin/Documents/3commascapital/gitlab/pulsechaincom/msgboard
git add packages/foundry/src/MsgBoard.sol packages/foundry/test/MsgBoard.t.sol
git commit -m "feat(foundry): MsgBoard cheatcode helper (submit + raw)"
```

---

## Phase 4 — README + CI

### Task 4.1: Package README

- [ ] **Step 1: Create `packages/foundry/README.md`**

````markdown
# MsgBoard for Foundry

Solidity helpers for the MsgBoard proof-of-work message board.

## Install

```sh
forge install pulsechaincom/msgboard
```
(then remap to `packages/foundry/src`, or vendor the two files you need.)

## Verify proof of work

```solidity
import {MsgPow} from "msgboard/MsgPow.sol";

MsgPow.Message memory m = MsgPow.Message({
    nonce: ..., blockHash: ..., category: ..., data: hex"...",
    workMultiplier: ..., workDivisor: ...
});
require(MsgPow.verify(m, difficulty), "invalid work");
```

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

Verifying the proof of work costs ~550k gas per `ecMul` (secp256k1), so `MsgPow.verify`
is best used in tests/scripts or off the hot path.
````

- [ ] **Step 2: Commit**

```bash
git add packages/foundry/README.md
git commit -m "docs(foundry): usage README"
```

### Task 4.2: Add a Forge test job to CI

- [ ] **Step 1: Append a `forge` job to `.gitlab-ci.yml`**

Add this job (it runs on every push/MR, not just tags — it's a test gate, not a publish):
```yaml
foundry:
  stage: publish
  image: ghcr.io/foundry-rs/foundry:latest
  rules:
    - if: '$CI_PIPELINE_SOURCE'
  script:
    - cd packages/foundry
    - forge install foundry-rs/forge-std --no-git
    - forge install witnet/elliptic-curve-solidity --no-git
    - forge build
    - forge test -vv
```

- [ ] **Step 2: Validate YAML**

```bash
cd /Users/michaelmclaughlin/Documents/3commascapital/gitlab/pulsechaincom/msgboard
python3 -c "import yaml; yaml.safe_load(open('.gitlab-ci.yml')); print('yaml ok')"
```
Expected: `yaml ok`.

- [ ] **Step 3: Commit**

```bash
git add .gitlab-ci.yml
git commit -m "ci(foundry): run forge build + test"
```

---

## Self-Review

**Spec coverage:**
- Foundry library in `packages/foundry` (monorepo) → Phase 1. ✓
- `MsgPow.sol` Solidity verifier, golden-vector tested against `@msgboard/core` → Phase 2. ✓
- `MsgBoard.sol` cheatcode helper (submit + raw) → Phase 3. ✓
- "Do both" (cheatcode wrapper AND msgpow verifier) → both present. ✓ (Typed object-readers explicitly deferred with reason — `vm.rpc` object-encoding spike.)
- forge install + CI gate → Phases 1, 4. ✓

**Placeholder scan:** No TBD/TODO. The one genuine API uncertainty (`vm.rpc` overload arity, and object-result encoding) is handled by (a) a concrete `grep` verification step with a stated fallback for the overload, and (b) explicit, reasoned deferral of the typed readers — not a placeholder in shipped code.

**Type/name consistency:** `MsgPow.Message` fields used identically in `MsgPow.sol`, `MsgPow.t.sol`, and the generator's JSON keys (`nonce`, `blockHash`, `category`, `data`, `workMultiplier`, `workDivisor`, `difficulty`, `workHash`). The golden vector's `difficulty` (256) comes from `wm=1, wd=65536` per the generator, matching the algorithm.

**Risk note:** `MsgPow.workHash` must byte-match `@msgboard/core`. The two fidelity traps are `minimalBytes` (BN `toArray()` strips leading zeros — the implementation does too) and `digest` (low 128 bits, not high). The `test_workHash_matches_core` golden assertion catches any divergence; iterate against it. If Witnet's `EllipticCurve.ecMul` argument order differs in the installed version, confirm against `lib/elliptic-curve-solidity/src/EllipticCurve.sol` during Task 2.3.
