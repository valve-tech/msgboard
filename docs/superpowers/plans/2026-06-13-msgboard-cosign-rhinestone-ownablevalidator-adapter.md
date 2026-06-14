# @msgboard/cosign Rhinestone OwnableValidator adapter Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL — `superpowers:test-driven-development`. Every task below is RED → GREEN → REFACTOR. Write the failing test first, run it, watch it fail for the *right* reason, then write the minimum code to pass. Do not skip the RED step. Do not write source before its test.

> **DEPENDS ON:** the cosign SDK (already BUILT in `packages/cosign`) and the Safe adapter (`src/adapters/safe.ts`, already shipped). This plan reads/reuses both. The SDK provides `src/record.ts` (`SignatureRecord` codec + `SCHEME = { ECDSA: 0, EIP1271: 1, EIP712: 2 }`), `src/client.ts` (`aggregate`, `groupByDigest`, …), and `src/adapters/adapter.ts` (the `CosignAdapter` interface). The Safe adapter provides the **recover + sort/dedup + 65-byte-word-blob patterns this plan extracts and reuses** (`splitSig`, the strictly-ascending `order` sort, the static-word concatenation). If `packages/cosign/src/adapters/safe.ts` does not exist, stop — the prerequisites are not in place.

## Goal

Ship `packages/cosign/src/adapters/rhinestone.ts`: the **third concrete `CosignAdapter`**, targeting **Rhinestone's `OwnableValidator`** — the canonical threshold-ECDSA validator module for ERC-7579 modular smart accounts (Kernel / Nexus / Safe7579). It turns board-shared `SignatureRecord`s into the concatenated 65-byte-ECDSA `userOp.signature` blob the validator's `validateUserOp` consumes (and, for the stateless / EIP-1271 message cases, the same blob `validateSignatureWithData` / `isValidSignatureWithSender` consume):

- `owners()` = `getOwners(account)`, `threshold()` = `threshold(account)` (read-only chain calls against the validator module, **keyed by the smart-account address** — the validator stores config per-account),
- `verify(record)` — recovers one owner's ECDSA signature over the **EIP-191-wrapped** digest (`ECDSA.toEthSignedMessageHash(userOpHash)`) and confirms owner-set membership via `getOwners(account)` (plus an optional EIP-1271 *raw-hash* path via `isValidSignatureWithSender` for the message case),
- `order(records)` — sorts **strictly ascending by signer address**, dedups, and concatenates the 65-byte ECDSA words into the blob the validator's Safe-derived `recoverNSignatures` parses (no EIP-1271 offset-tail complexity like the Safe adapter's contract-owner words — for the threshold-EOA path this is **plain 65-byte-word concatenation**).

Plus the caller-facing helpers:

- `encodeOwnableMeta` / `decodeOwnableMeta` — round-trip the `userOp` + `entryPoint` + `chainId` + `validator` + `account` carried in `SignatureRecord.meta`, so the `userOpHash` digest is reconstructible off-chain.
- `userOpHash(userOp, entryPoint, chainId)` — compute the ERC-4337 v0.7 `userOpHash` locally (the digest each owner signs), asserted byte-equal to the EntryPoint's on-chain `getUserOpHash(...)` in the integration test.
- `buildOwnableSignature(orderedRecords)` — concatenate ordered words → the final `Hex` blob (this IS the `userOp.signature` for the 4337 path, and the `signature`/`data` arg for the stateless / 1271 paths).
- `encodeStatelessData(threshold, sortedOwners)` — produce the `abi.encode(uint256 threshold, address[] owners)` blob `validateSignatureWithData` expects (owners pre-sorted/deduped).

The adapter only **verifies + orders**. Submitting the userOp to a bundler (4337 path) or calling the validator on-chain (stateless / 1271 path) is the caller's job (cosign writes nothing on-chain); the adapter reads the chain (`getOwners`/`threshold`) and hands back the blob.

### The honest caveat (design fit — keep this in the doc, not just the code)

ERC-4337 userOps are ultimately **bundler-submitted**, not signed-and-broadcast like a Safe `execTransaction`. But the multi-owner step that cosign exists for — **collecting each owner's ECDSA signature over the *shared* `userOpHash` off-chain, before the userOp is bundled** — is exactly what a threshold `OwnableValidator` needs. Each of the `t`-of-`n` owners signs the *same* `userOpHash`; cosign brokers those `t` signatures over the open board and aggregates them into the single concatenated `userOp.signature` blob the bundler submits. So this is a real fit, not a forced one. The plan also supports the simpler **EIP-1271 message case** (`isValidSignatureWithSender`) and the **stateless** case (`validateSignatureWithData`) — both consume the identical aggregated blob over a plain (un-prefixed) hash, and the stateless one is the cleanest thing to test on-chain (no account install, no bundler).

Source of truth for behavior: **`rhinestonewtf/core-modules` @ `src/OwnableValidator/OwnableValidator.sol`** (tag `v1.0.0`, commit `1f97c2920a17a43359413d8616a8228100c9f71a`) and its signature lib **`rhinestonewtf/checknsignatures` @ `src/CheckNSignatures.sol`**, plus the magic-value constants in **`rhinestonewtf/module-bases` @ `src/ERC7579ValidatorBase.sol`**. Every Solidity detail below is quoted from those files.

---

## Verified-from-source facts (quote these — they are *law*)

### A. Per-account storage + reads (`OwnableValidator.sol`)

The validator stores owners + threshold **per smart-account**, not globally:

```solidity
// account => owners
SentinelList4337Lib.SentinelList owners;
// account => threshold
mapping(address account => uint256) public threshold;
// account => ownerCount
mapping(address => uint256) public ownerCount;

function getOwners(address account) external view returns (address[] memory ownersArray) {
    (ownersArray,) = owners.getEntriesPaginated(account, SENTINEL, MAX_OWNERS);
}
```

So the adapter's reads are `getOwners(account)` and `threshold(account)` — **the account address is the argument**, and the adapter is configured with `{ validator, account }` (the validator module address is the contract called; the account is the key). `MAX_OWNERS = 32`. `ownerCount(account)` is also a public getter (used as a sanity read in tests). `owners` arrive from `getEntriesPaginated` — they are NOT guaranteed in any particular sort order on read (the sentinel list preserves insertion/link order), so the adapter must NOT assume `getOwners` returns sorted; membership is a set lookup.

### B. `validateUserOp` wraps the hash with EIP-191 (`ECDSA.toEthSignedMessageHash`)

```solidity
function validateUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash)
    external view override returns (ValidationData)
{
    bool isValid = _validateSignatureWithConfig(
        userOp.sender, ECDSA.toEthSignedMessageHash(userOpHash), userOp.signature
    );
    if (isValid) return VALIDATION_SUCCESS; // ValidationData.wrap(0)
    return VALIDATION_FAILED;               // ValidationData.wrap(1)
}
```

**Critical:** the hash passed into recovery is `ECDSA.toEthSignedMessageHash(userOpHash)` — the **EIP-191 personal-message prefix** `"\x19Ethereum Signed Message:\n32" ‖ userOpHash`, hashed. So for the **4337 userOp path**, each owner signs the *raw* `userOpHash` with a **personal_sign / eth_sign-style** signature (viem `signMessage({ message: { raw: userOpHash } })`), yielding `v ∈ {27,28}` over the *prefixed* hash. On-chain, `recoverNSignatures` is called with the **already-prefixed** hash and each 65-byte word's `v ∈ {27,28}` takes the plain-`ecrecover` branch (see D). This is the subtle part: the EIP-191 wrap happens **once, in `validateUserOp`, before `recoverNSignatures`** — it is NOT the `v>30` eth_sign branch inside `recoverNSignatures`. The adapter mirrors this by recovering over `toEthSignedMessageHash(userOpHash)` with viem's `recoverMessageAddress({ message: { raw: userOpHash } })`.

### C. The two non-4337 entry points

EIP-1271 **message** path (validates the **RAW** `hash`, no EIP-191 wrap), magic `0x1626ba7e`:

```solidity
function isValidSignatureWithSender(address, bytes32 hash, bytes calldata data)
    external view override returns (bytes4)
{
    bool isValid = _validateSignatureWithConfig(msg.sender, hash, data);
    if (isValid) return EIP1271_SUCCESS;   // 0x1626ba7e
    return EIP1271_FAILED;                  // 0xffffffff
}
```

Stateless validation (no storage read — `threshold`+`owners` arrive in `data`; owners **must be pre-sorted/deduped** or it returns `false`), validates the **RAW** `hash`, returns `bool`:

```solidity
function validateSignatureWithData(bytes32 hash, bytes calldata signature, bytes calldata data)
    external view returns (bool)
{
    (uint256 _threshold, address[] memory _owners) = abi.decode(data, (uint256, address[]));
    if (!_owners.isSortedAndUniquified()) return false;
    if (_threshold == 0) return false;
    address[] memory signers = CheckSignatures.recoverNSignatures(hash, signature, _threshold);
    signers.sort();
    signers.uniquifySorted();
    uint256 validSigners;
    for (uint256 i = 0; i < signers.length; i++) {
        (bool found,) = _owners.searchSorted(signers[i]);
        if (found) validSigners++;
    }
    return validSigners >= _threshold;
}
```

`data` for the stateless call is **`abi.encode(uint256 threshold, address[] owners)`** with `owners` sorted-ascending + deduped (else `isSortedAndUniquified()` → `false`). Note both `isValidSignatureWithSender` and `validateSignatureWithData` recover over the **raw** `hash` (NO EIP-191 wrap) — so for these two paths each owner signs the raw hash with a plain EIP-712-style ECDSA signature (`v ∈ {27,28}`, viem `sign({ hash })`). Only `validateUserOp` adds the EIP-191 prefix.

### D. `recoverNSignatures` — Safe-derived, parses concatenated 65-byte words (`CheckNSignatures.sol`)

```solidity
function recoverNSignatures(bytes32 dataHash, bytes memory signatures, uint256 requiredSignatures)
    internal view returns (address[] memory recoveredSigners)
{
    uint256 requiredSignatureLength = requiredSignatures * 65;
    if (signatures.length < requiredSignatureLength) revert InvalidSignature();
    recoveredSigners = new address[](requiredSignatures);
    for (uint256 i; i < requiredSignatures; i++) {
        (uint8 v, bytes32 r, bytes32 s) = signatureSplit({ signatures: signatures, pos: i });
        if (v == 0) {
            // contract signature: r = signer addr, s = offset to tail {len}{contractSig};
            // calls ISignatureValidator(signer).isValidSignature(bytes32 dataHash, bytes sig) == 0x1626ba7e
            ...
        } else if (v > 30) {
            // eth_sign: recover over ECDSA.toEthSignedMessageHash(dataHash) with v-4
            _signer = ECDSA.tryRecover({ hash: ECDSA.toEthSignedMessageHash(dataHash), v: v - 4, r: r, s: s });
        } else {
            // plain ecrecover over the passed-in hash
            _signer = ECDSA.tryRecover({ hash: dataHash, v: v, r: r, s: s });
        }
        recoveredSigners[i] = _signer;
    }
}
```

`signatureSplit` is the **exact Gnosis-Safe** layout — **compact `{bytes32 r}{bytes32 s}{uint8 v}`, 65 bytes per word** (the `uint8 v` is NOT padded). So the blob the adapter builds for the threshold-EOA path is **plain concatenation of 65-byte `r‖s‖v` words** — identical to the Safe adapter's EOA static region, minus the contract-owner offset-tail words. Three branches, by `v`:

| `v` | branch | what the owner signed | adapter recovers over | cosign `scheme` |
|---|---|---|---|---|
| `27`/`28` | `ECDSA.tryRecover(dataHash, v, r, s)` — plain | the hash `dataHash` **as passed into `recoverNSignatures`** | the digest as passed | `EIP712` (2) |
| `> 30` | `ECDSA.tryRecover(toEthSignedMessageHash(dataHash), v-4, …)` | EIP-191-prefixed `dataHash`, wallet `v∈{27,28}` → emit `v+4` | prefixed digest | `ECDSA` (0) |
| `0` | contract sig via `isValidSignature(bytes32,bytes)→0x1626ba7e` | (contract owner — out of scope, see note) | n/a | — |

The interaction with B is what to get right: **for the 4337 userOp path, `dataHash` passed into `recoverNSignatures` is already `toEthSignedMessageHash(userOpHash)`**. So a 4337 owner signature is a plain `v∈{27,28}` ECDSA over that prefixed hash — i.e. on the wire it is `scheme=EIP712` (the plain branch), and the *prefixing* is done by the caller/adapter producing the digest, not by the `v>30` branch. The cleanest, least-surprising mapping (pinned below in "Scheme mapping"): for the **4337 userOp path** the owner produces a signature over `toEthSignedMessageHash(userOpHash)` and we tag it `scheme=EIP712` with `verify` recovering over the same prefixed digest; for the **raw-hash stateless/1271 paths** the owner signs the raw hash, tagged `scheme=EIP712`, `verify` recovers over the raw digest. Both land in the plain `v∈{27,28}` branch on-chain. (The `v>30` eth_sign branch and the `v==0` contract-owner branch are **not produced** by this adapter — see "Out of scope".)

### E. After recovery: sort + uniquify + count owners (sorted-unique rule, like Safe)

Both `_validateSignatureWithConfig` (stateful) and `validateSignatureWithData` (stateless) do, after `recoverNSignatures`:

```solidity
signers.sort();
signers.uniquifySorted();              // a reused signer is collapsed → cannot double-count
for (each signer) if (isOwner(signer)) validSigners++;
return validSigners >= _threshold;
```

So **the on-chain side sorts the recovered signers itself** before counting — meaning the validator does not strictly *require* the input `signatures` blob to be pre-sorted (unlike Safe's `checkNSignatures`, which reverts `GS026` on wrong order). **However**, `recoverNSignatures` reads exactly `requiredSignatures` (= `threshold`) words and ignores extras beyond the first `threshold`; and `uniquifySorted` means duplicates are dropped (a duplicate signer wastes a slot and can make the count fall short of threshold). To be safe and deterministic, **the adapter still sorts ascending + dedups** (reusing the Safe adapter's `order` logic) and emits exactly the deduped set — this guarantees `threshold` distinct owners occupy the first `threshold` words and the count is met. (Pinning sorted+dedup also matches what a stateless `data` arg requires for its `owners[]`, keeping one ordering rule across the adapter.)

### F. Magic values + module type (`ERC7579ValidatorBase.sol`)

```solidity
ValidationData internal constant VALIDATION_SUCCESS = ValidationData.wrap(0);
ValidationData internal constant VALIDATION_FAILED  = ValidationData.wrap(1);
bytes4 internal constant EIP1271_SUCCESS = 0x1626ba7e;
bytes4 internal constant EIP1271_FAILED  = 0xFFFFFFFF;
```

`OwnableValidator.isModuleType` returns true for `TYPE_VALIDATOR` and `TYPE_STATELESS_VALIDATOR (7)`.

### G. Canonical deployed address + selectors (for the integration test)

The OwnableValidator is deployed at the **same canonical address on every supported chain**: **`0x2483DA3A338895199E5e538530213157e931Bf06`** (from `rhinestonewtf/module-sdk` `OWNABLE_VALIDATOR_ADDRESS`). Its deployed runtime bytecode (6633 bytes) is fetchable via `eth_getCode` and contains the selectors we call:

| function | selector |
|---|---|
| `validateSignatureWithData(bytes32,bytes,bytes)` | `0x940d3840` |
| `getOwners(address)` | `0xfd8b84b1` |
| `threshold(address)` | `0xc86ec2bf` |
| `ownerCount(address)` | `0xccfdec8c` |
| `isValidSignatureWithSender(address,bytes32,bytes)` | `0xf551e2ee` |

Because `validateSignatureWithData` is **stateless** (no install, no per-account storage), the integration test only needs the runtime bytecode `setCode`'d at any address on anvil — no EntryPoint, no 7579 account, no bundler. This is the smallest **real** on-chain check and is the one this plan pins (Task 6).

---

## Out of scope (pinned, with reasons)

- **EIP-1271 contract-owner words (`v==0`)** — the validator's `recoverNSignatures` supports nested contract owners (an owner that is itself a smart contract, verified via `isValidSignature(bytes32,bytes)→0x1626ba7e` with an offset-tail). cosign's `OwnableValidator` use-case is **threshold of EOAs** (the module's name + docs: "designate EOA owners"). Nested-contract owners add the same offset-tail blob complexity the Safe adapter already handles; if needed later they can be lifted from `safe.ts`'s `buildSignatureBlob` 1271 branch. This adapter emits **only EOA words**.
- **Full 4337 bundler submission** — the adapter produces the `userOp.signature` blob; building the `PackedUserOperation`, gas estimation, and bundler RPC are the caller's job.
- **Account installation / `onInstall`** — the integration test uses the **stateless** `validateSignatureWithData`, so no install. A full stateful userOp test (deploy a Kernel/Nexus account, install the module, build + validate a userOp) is documented as a heavier optional follow-up but NOT built here (it drags in the whole modulekit + account-factory toolchain for marginal extra coverage over the stateless real check).

---

## Scheme mapping (pinned — consistent with the SDK codec + the Safe adapter)

The cosign codec reserves `SCHEME = { ECDSA: 0, EIP1271: 1, EIP712: 2 }`. This adapter uses **only `SCHEME.EIP712` (2)** for the signatures it produces and verifies:

- **4337 userOp path**: owner signs `toEthSignedMessageHash(userOpHash)` (viem `signMessage({ message: { raw: userOpHash } })`), `scheme = EIP712`. `verify` recovers via `recoverMessageAddress({ message: { raw: userOpHash } })` (which applies the same EIP-191 prefix) and checks membership. On-chain this is a plain `v∈{27,28}` word and `validateUserOp` re-applies the prefix to `userOpHash` before `recoverNSignatures` — so the recovered signer matches.
- **raw-hash path (stateless / `isValidSignatureWithSender`)**: owner signs the raw `hash` (viem `sign({ hash })`), `scheme = EIP712`. `verify` recovers via `recoverAddress({ hash, signature })`. On-chain this is a plain `v∈{27,28}` word over the raw hash.

`order` does NOT re-recover; it sorts/dedups by `record.signer` (which `aggregate` has already asserted equals the recovered signer via `verify`). The blob is plain 65-byte-word concatenation. This is **exactly** the Safe adapter's EOA path with: (a) no `v+4` adjustment (we never emit the `v>30` eth_sign branch — the EIP-191 prefix is folded into the digest, not the v-byte), and (b) no 1271 offset-tail.

---

## Tech Stack

- **Language / module system**: TypeScript, ESM (`"type": "module"`), NodeNext. Source imports use explicit `.js` extensions — e.g. `import { decodeRecord } from '../record.js'`, `import { splitSig } from './safe.js'` (reused, see below).
- **Build**: `tsc` → `dist/` (the package's existing config; no changes).
- **Test runner**: **vitest** (`vitest run`), tests under `packages/cosign/test/adapters/`. The repo is **npm workspaces** (root `package.json` `workspaces` array + `package-lock.json`; install with `npm install` from repo root). NOT pnpm.
- **Crypto / encoding**: `viem` (`recoverAddress`, `recoverMessageAddress`, `signMessage`, `sign`, `serializeSignature`, `keccak256`, `encodeAbiParameters`, `decodeAbiParameters`, `encodePacked`, `concat`, `size`, `slice`, `getAddress`, `isAddressEqual`, `toHex`, `pad`). Already a cosign dep.
- **Integration-test deps (already present from the Safe adapter)**: `prool` (`^0.0.16`, anvil-in-JS), viem `createTestClient` + `setCode`. **No new deps** — unlike the Safe adapter we do NOT need `@safe-global/safe-deployments`; the OwnableValidator runtime bytecode is fetched via `eth_getCode` from a public RPC (with a pinned-bytecode fallback constant, so the test is deterministic even offline). Foundry/`anvil` is present on the dev machine (`~/.foundry/bin/anvil`).

> **Why fetch-bytecode-then-setCode (not deploy-from-source, not fork):** the validator is stateless for our check and lives at one canonical address on every chain. Fetching the **published, audited** runtime bytecode once and `setCode`-ing it onto a fresh anvil is fully self-contained and deterministic (no public-RPC dependency at run time once the bytecode is pinned, no fork-block flakiness). This mirrors the Safe fixture's `setCode` pattern. We pin the fetched bytecode as a constant in the fixture so the test never depends on a live RPC; a documented refresh command re-fetches it if the canonical deployment ever changes.

---

## Reuse from the Safe adapter (extract, don't duplicate)

The Safe adapter (`src/adapters/safe.ts`) already contains battle-tested helpers this adapter needs verbatim. **Task 2 extracts them into a shared internal module** `src/adapters/_ecdsa.ts` and re-points `safe.ts` at it (a pure refactor, all Safe tests stay green), then `rhinestone.ts` imports from there:

- `splitSig(sig: Hex): { r, s, v }` — splits a 65-byte `r‖s‖v` word (Safe adapter, lines ~376–380).
- `sortDedupBySigner(records): SignatureRecord[]` — the strictly-ascending-by-`record.signer` sort + dedup that is the body of Safe's `order` (Safe adapter, lines ~353–371).
- `concatEoaWords(orderedRecords): Hex` — concatenate one 65-byte `{r}{s}{v}` word per record (the EOA branch of Safe's `buildSignatureBlob`, **without** the `v+4` eth_sign adjustment and **without** 1271 tails; `rhinestone` always emits the verbatim `v`). To keep the Safe adapter's `v+4`/tail behavior intact, `_ecdsa.ts` exposes the *primitive* (`eoaWord(sig: Hex): Hex` = verbatim `{r}{s}{v}`) and each adapter composes its own word policy. Safe keeps its `v+4` + tail logic in `safe.ts`; `rhinestone` uses verbatim words only.

> If extracting is judged too invasive at execution time, the fallback is to **import the existing exports from `safe.ts`** where they are already exported (none of `splitSig`/the sort are currently exported — so extraction to `_ecdsa.ts` is the clean path and is the default). Either way, **do not copy-paste** the sort/split logic into `rhinestone.ts`.

---

## File structure

All paths relative to `packages/cosign/`.

| File | Responsibility | Task |
|---|---|---|
| `src/adapters/_ecdsa.ts` | **New**: extracted shared primitives — `splitSig`, `eoaWord`, `sortDedupBySigner`. | 2 |
| `src/adapters/safe.ts` | **Edit**: re-point `splitSig` + the `order` sort at `_ecdsa.ts` (pure refactor; Safe tests unchanged + green). | 2 |
| `src/adapters/rhinestone.ts` | **New**: the adapter — types, `userOpHash`, `encodeOwnableMeta`/`decodeOwnableMeta`, `encodeStatelessData`, `makeRhinestoneOwnableAdapter`, `buildOwnableSignature`, the minimal OwnableValidator + EntryPoint ABI fragments. | 3–5 |
| `src/index.ts` | **Edit**: re-export the rhinestone adapter surface. | 5 |
| `test/adapters/ecdsa-shared.test.ts` | Unit: `splitSig`/`eoaWord`/`sortDedupBySigner` behave identically to the prior Safe-internal versions. | 2 |
| `test/adapters/rhinestone-digest.test.ts` | Unit: `userOpHash` (local) determinism + sensitivity; `encodeStatelessData` sorted-encoding; meta round-trip. | 3 |
| `test/adapters/rhinestone-verify.test.ts` | Unit (fake `publicClient`): `owners`/`threshold` reads keyed by account; `verify` recovers EIP-191-wrapped (4337) + raw (stateless) sigs + membership; non-owner / wrong-digest / signer-mismatch → false; RPC error propagates. | 4 |
| `test/adapters/rhinestone-order.test.ts` | Unit (fake `publicClient`): `order` sorts ascending + dedups; `buildOwnableSignature` concatenates 65-byte words (no `v+4`, no tail); byte-layout assertions. | 4 |
| `test/adapters/rhinestone-integration.test.ts` | **Integration (real OwnableValidator bytecode on anvil via prool + setCode):** `setCode` the canonical runtime bytecode; sign with `t` of `n` EOAs over a raw hash; `aggregate` → `buildOwnableSignature`; call `validateSignatureWithData(hash, blob, abi.encode(threshold, sortedOwners))` → asserts `true`; negatives (too-few sigs, non-owner, unsorted owners) → `false`. | 6 |
| `test/adapters/_ownable-fixture.ts` | **New**: boots anvil, `setCode`s the OwnableValidator bytecode at the canonical address, returns clients + helpers. | 6 |

---

## Canonical encodings (pin these)

### 1. The digest each owner signs

- **4337 path**: `digest = userOpHash` (the ERC-4337 v0.7 userOp hash). The owner signs `toEthSignedMessageHash(userOpHash)`. `userOpHash = keccak256(abi.encode(keccak256(packedUserOpFields), entryPoint, chainId))` per EntryPoint v0.7 `getUserOpHash`. The adapter computes it locally via `userOpHash(userOp, entryPoint, chainId)` and asserts byte-equality to the on-chain `EntryPoint.getUserOpHash(userOp)` if an EntryPoint is available (documented; the pinned integration test uses the stateless raw-hash path and does not require a live EntryPoint).
- **raw-hash path (stateless / 1271)**: `digest = hash` (any 32-byte message hash). The owner signs the raw `hash`.

`SignatureRecord.digest` carries whichever applies; `SignatureRecord.meta` carries the reconstruction context (see 3).

### 2. The signature blob (`userOp.signature` / stateless `signature` / 1271 `data`)

```
signature = concat( for each owner in ascending order: {bytes32 r}{bytes32 s}{uint8 v} )   // 65 bytes/word, v verbatim ∈ {27,28}
```

Plain concatenation, strictly-ascending by signer, deduped. No `v` adjustment, no offset tails. `recoverNSignatures` reads the first `threshold` words; emit **exactly** the deduped set (≥ `threshold` words; the integration test emits exactly `threshold`).

### 3. The `meta` tuple carried in `record.meta`

ABI tuple — order is law. Carries enough to reconstruct the digest + identify the validator/account:

```
(uint8 mode, bytes32 hash, bytes packedUserOp, address entryPoint, address validator, address account, uint256 chainId)
```

- `mode`: `0` = raw-hash (stateless / 1271), `1` = 4337 userOp.
- `hash`: for `mode=0`, the raw message hash; for `mode=1`, the `userOpHash` (so a reader needn't re-pack the userOp to know the digest, but `packedUserOp` lets it re-derive + cross-check).
- `packedUserOp`: for `mode=1`, the abi-encoded `PackedUserOperation`; `0x` for `mode=0`.
- `entryPoint`: the 4337 EntryPoint (`mode=1`); `address(0)` for `mode=0`.
- `validator` + `account`: the OwnableValidator module + the smart-account address (the `getOwners`/`threshold` key).
- `chainId`: binds the `userOpHash` domain.

`encodeOwnableMeta({...})` / `decodeOwnableMeta(meta)` round-trip this.

---

## Task 1 — Verify prerequisites + pin the canonical bytecode (no source yet)

**Goal:** confirm the cosign SDK + Safe adapter are present, `anvil` is available, and capture the canonical OwnableValidator runtime bytecode + selectors so later tasks reference a pinned value (not a live RPC). No production source; a tiny smoke test proves the bytecode + selectors.

### 1.1 Sanity checks (run, eyeball, no commit yet)

```bash
cd /Users/michaelmclaughlin/Documents/valve-tech/github/msgboard
test -f packages/cosign/src/adapters/adapter.ts && echo "SDK ok"
test -f packages/cosign/src/adapters/safe.ts && echo "Safe adapter ok"
~/.foundry/bin/anvil --version || which anvil
```

**Expected:** `SDK ok`, `Safe adapter ok`, an anvil version string.

### 1.2 Fetch + pin the runtime bytecode (one-time; the value is committed into the fixture in Task 6)

```bash
# canonical address is identical on every chain; publicnode has a public no-key RPC
curl -s -X POST https://ethereum-rpc.publicnode.com \
  -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_getCode","params":["0x2483DA3A338895199E5e538530213157e931Bf06","latest"]}' \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const r=JSON.parse(d).result;console.error("len(bytes)=",(r.length-2)/2);process.stdout.write(r)})' \
  > /tmp/ownable-validator.runtime.hex
```

**Expected:** `len(bytes)= 6633` on stderr; `/tmp/ownable-validator.runtime.hex` holds `0x6080…`. (If publicnode is down, any chain's RPC works — the address is canonical. The value is pinned into `_ownable-fixture.ts` in Task 6, so this fetch is a one-time capture, not a per-run dependency.)

### 1.3 RED — `packages/cosign/test/adapters/rhinestone-bytecode.test.ts`

A tiny test proving the pinned bytecode contains the selectors we call. (This file is absorbed into the Task-6 fixture's assertions and may be deleted then, or kept as a fast non-anvil guard.)

```ts
import { describe, expect, it } from 'vitest'
import { OWNABLE_VALIDATOR_ADDRESS, OWNABLE_VALIDATOR_RUNTIME } from '../../src/adapters/rhinestone.js'

describe('OwnableValidator pinned constants', () => {
  it('pins the canonical module address', () => {
    expect(OWNABLE_VALIDATOR_ADDRESS).toBe('0x2483DA3A338895199E5e538530213157e931Bf06')
  })

  it('pins runtime bytecode that carries the selectors the adapter calls', () => {
    const code = OWNABLE_VALIDATOR_RUNTIME.toLowerCase()
    expect(code.startsWith('0x60')).toBe(true)
    // validateSignatureWithData / getOwners / threshold / isValidSignatureWithSender selectors
    for (const sel of ['940d3840', 'fd8b84b1', 'c86ec2bf', 'f551e2ee']) {
      expect(code.includes(sel)).toBe(true)
    }
  })
})
```

Run — must fail (no `rhinestone.ts`):

```bash
npm run test --workspace=packages/cosign -- rhinestone-bytecode
```

**Expected:** import-resolution failure for `../../src/adapters/rhinestone.js` (RED).

### 1.4 GREEN — create `packages/cosign/src/adapters/rhinestone.ts` (constants only)

```ts
import type { Hex } from 'viem'

/** The OwnableValidator's canonical address — identical on every supported chain. */
export const OWNABLE_VALIDATOR_ADDRESS = '0x2483DA3A338895199E5e538530213157e931Bf06' as const

/**
 * The audited OwnableValidator v1.0.0 runtime bytecode (6633 bytes), captured via eth_getCode
 * from the canonical deployment. Pinned so the integration test setCode's a real, deterministic
 * module with no live-RPC dependency. Refresh via the curl in Task 1.2 if the deployment changes.
 */
export const OWNABLE_VALIDATOR_RUNTIME: Hex =
  '0x6080...' /* PASTE the full hex from /tmp/ownable-validator.runtime.hex */ as Hex
```

> **Execution note:** paste the entire `/tmp/ownable-validator.runtime.hex` contents as the `OWNABLE_VALIDATOR_RUNTIME` value (it is one long `0x…` string, ~13.3k chars). Do NOT truncate. The Task-1.3 selector test fails until the real bytecode is in place — that is the RED→GREEN signal.

### 1.5 Run & verify

```bash
npm run test --workspace=packages/cosign -- rhinestone-bytecode
```

**Expected:** `Test Files 1 passed (1)` / `Tests 2 passed (2)` — address pinned, selectors present.

### 1.6 Commit

```bash
git add packages/cosign/src/adapters/rhinestone.ts packages/cosign/test/adapters/rhinestone-bytecode.test.ts
git commit -m "feat(cosign/rhinestone): pin OwnableValidator canonical address + runtime bytecode (+ selector smoke test)"
```

---

## Task 2 — Extract shared ECDSA primitives into `_ecdsa.ts` (refactor Safe; no behavior change)

**Goal:** lift `splitSig`, the strictly-ascending sort+dedup, and a verbatim-`eoaWord` primitive out of `safe.ts` into `src/adapters/_ecdsa.ts`, re-point `safe.ts` at them, and prove (a) the new module behaves identically and (b) every existing Safe test stays green. This keeps `rhinestone.ts` from copy-pasting Safe internals.

### 2.1 RED — `packages/cosign/test/adapters/ecdsa-shared.test.ts`

```ts
import { describe, expect, it } from 'vitest'
import { type Hex, serializeSignature, size, slice } from 'viem'
import { privateKeyToAccount, sign } from 'viem/accounts'
import { splitSig, eoaWord, sortDedupBySigner } from '../../src/adapters/_ecdsa.js'
import { SCHEME, type SignatureRecord } from '../../src/record.js'

const digest = `0x${'77'.repeat(32)}` as Hex
const PK_1 = `0x${'11'.repeat(32)}` as Hex
const PK_2 = `0x${'22'.repeat(32)}` as Hex
const PK_3 = `0x${'33'.repeat(32)}` as Hex
const a1 = privateKeyToAccount(PK_1)
const a2 = privateKeyToAccount(PK_2)
const a3 = privateKeyToAccount(PK_3)

async function rec(pk: Hex, signer: Hex): Promise<SignatureRecord> {
  return {
    digest,
    signer,
    signature: serializeSignature(await sign({ hash: digest, privateKey: pk })),
    scheme: SCHEME.EIP712,
    meta: '0x',
  }
}

describe('splitSig', () => {
  it('splits a 65-byte r||s||v word', async () => {
    const sig = serializeSignature(await sign({ hash: digest, privateKey: PK_1 }))
    const { r, s, v } = splitSig(sig)
    expect(size(r)).toBe(32)
    expect(size(s)).toBe(32)
    expect(v === 27 || v === 28).toBe(true)
    expect(slice(sig, 0, 32)).toBe(r)
    expect(slice(sig, 32, 64)).toBe(s)
  })

  it('throws on a non-65-byte signature', () => {
    expect(() => splitSig('0x1234' as Hex)).toThrow()
  })
})

describe('eoaWord', () => {
  it('returns the verbatim 65-byte {r}{s}{v} word (no v adjustment)', async () => {
    const sig = serializeSignature(await sign({ hash: digest, privateKey: PK_1 }))
    expect(eoaWord(sig)).toBe(sig) // verbatim
    expect(size(eoaWord(sig))).toBe(65)
  })
})

describe('sortDedupBySigner', () => {
  it('sorts strictly ascending by signer and dedups', async () => {
    const recs = [
      await rec(PK_3, a3.address as Hex),
      await rec(PK_1, a1.address as Hex),
      await rec(PK_2, a2.address as Hex),
      await rec(PK_1, a1.address as Hex), // dup signer
    ]
    const out = sortDedupBySigner(recs)
    expect(out).toHaveLength(3)
    const vals = out.map((r) => BigInt(r.signer))
    for (let i = 1; i < vals.length; i++) expect(vals[i] > vals[i - 1]).toBe(true)
  })
})
```

Run — must fail (no `_ecdsa.ts`):

```bash
npm run test --workspace=packages/cosign -- ecdsa-shared
```

**Expected:** import-resolution failure for `_ecdsa.js` (RED).

### 2.2 GREEN — create `packages/cosign/src/adapters/_ecdsa.ts`

```ts
import { type Hex, size, slice, getAddress } from 'viem'
import type { SignatureRecord } from '../record.js'

/** Splits a 65-byte ECDSA signature into r (32) ‖ s (32) ‖ v (1). Throws if not 65 bytes. */
export function splitSig(sig: Hex): { r: Hex; s: Hex; v: number } {
  if (size(sig) !== 65) throw new Error(`expected 65-byte signature, got ${size(sig)} bytes`)
  return { r: slice(sig, 0, 32), s: slice(sig, 32, 64), v: Number(BigInt(slice(sig, 64, 65))) }
}

/**
 * The verbatim 65-byte {r}{s}{v} word for an EOA signature — no v adjustment, no tail.
 * (The Safe adapter applies its own v+4 / 1271-tail policy on top of splitSig; OwnableValidator
 * uses verbatim words, so this primitive returns the signature unchanged after a length check.)
 */
export function eoaWord(sig: Hex): Hex {
  if (size(sig) !== 65) throw new Error(`expected 65-byte signature, got ${size(sig)} bytes`)
  return sig
}

/**
 * Sorts records strictly ascending by record.signer and dedups (keeps first). Pure + synchronous.
 * Callers must have already established record.signer == the effective recovered signer (aggregate
 * runs verify before order). Shared by the Safe and Rhinestone adapters.
 */
export function sortDedupBySigner(records: SignatureRecord[]): SignatureRecord[] {
  const seen = new Set<string>()
  const deduped: SignatureRecord[] = []
  for (const r of records) {
    const key = getAddress(r.signer).toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(r)
  }
  return deduped.sort((a, b) => {
    const av = BigInt(getAddress(a.signer))
    const bv = BigInt(getAddress(b.signer))
    return av < bv ? -1 : av > bv ? 1 : 0
  })
}
```

### 2.3 GREEN — re-point `safe.ts` at `_ecdsa.ts` (pure refactor)

In `packages/cosign/src/adapters/safe.ts`:

1. Add the import near the top: `import { splitSig, sortDedupBySigner } from './_ecdsa.js'`.
2. **Delete** the local `function splitSig(...)` definition (lines ~376–380) — it now lives in `_ecdsa.ts`.
3. Replace the body of `order` with a call to the shared sort:

```ts
  function order(records: SignatureRecord[]): SignatureRecord[] {
    // Shared strictly-ascending-by-signer sort + dedup (see _ecdsa.ts). The Safe blob's
    // GS026 strict-ascending requirement is satisfied by this exact ordering.
    return sortDedupBySigner(records)
  }
```

`buildSignatureBlob` keeps its own `splitSig`-based word policy (it applies `v+4` for eth_sign and the 1271 offset-tail) — only the *source* of `splitSig` moves; the Safe-specific word logic is unchanged.

### 2.4 Run & verify (the WHOLE Safe suite must stay green — this is the safety net)

```bash
npm run test --workspace=packages/cosign -- ecdsa-shared
npm run test --workspace=packages/cosign -- safe-digest safe-verify safe-order safe-1271 safe-aggregate
npm run test --workspace=packages/cosign            # full sweep
npm run build --workspace=packages/cosign           # tsc clean
```

**Expected:** `ecdsa-shared` green; **every** Safe suite still green (the refactor changed no behavior); full sweep green; `tsc` clean.

### 2.5 Commit

```bash
git add packages/cosign/src/adapters/_ecdsa.ts packages/cosign/src/adapters/safe.ts packages/cosign/test/adapters/ecdsa-shared.test.ts
git commit -m "refactor(cosign): extract splitSig + sortDedupBySigner + eoaWord into _ecdsa.ts; re-point Safe adapter (no behavior change)"
```

---

## Task 3 — `userOpHash`, `encodeStatelessData`, meta codec (pure)

**Goal:** the local digest computation + the stateless-`data` encoder + the `meta` round-trip. All pure; unit-tested for determinism, sensitivity, and the sorted-owners encoding rule.

### 3.1 RED — `packages/cosign/test/adapters/rhinestone-digest.test.ts`

```ts
import { describe, expect, it } from 'vitest'
import { type Hex, encodeAbiParameters, keccak256, getAddress } from 'viem'
import {
  type OwnableMeta,
  type PackedUserOp,
  userOpHash,
  encodeStatelessData,
  encodeOwnableMeta,
  decodeOwnableMeta,
  OWNABLE_VALIDATOR_ADDRESS,
} from '../../src/adapters/rhinestone.js'

const chainId = 1
const entryPoint = '0x0000000071727De22E5E9d8BAf0edAc6f37da032' as Hex // EntryPoint v0.7
const account = '0x1111111111111111111111111111111111111111' as Hex

const userOp: PackedUserOp = {
  sender: account,
  nonce: 0n,
  initCode: '0x',
  callData: '0xdeadbeef',
  accountGasLimits: `0x${'00'.repeat(32)}` as Hex,
  preVerificationGas: 0n,
  gasFees: `0x${'00'.repeat(32)}` as Hex,
  paymasterAndData: '0x',
  signature: '0x',
}

describe('userOpHash (ERC-4337 v0.7)', () => {
  it('is deterministic', () => {
    expect(userOpHash(userOp, entryPoint, chainId)).toBe(userOpHash(userOp, entryPoint, chainId))
  })

  it('equals keccak256(abi.encode(keccak256(packedFields), entryPoint, chainId))', () => {
    // hashed userOp = keccak256(abi.encode(sender, nonce, keccak256(initCode), keccak256(callData),
    //   accountGasLimits, preVerificationGas, gasFees, keccak256(paymasterAndData)))
    const hashedOp = keccak256(
      encodeAbiParameters(
        [
          { type: 'address' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'bytes32' },
          { type: 'bytes32' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'bytes32' },
        ],
        [
          userOp.sender, userOp.nonce, keccak256(userOp.initCode), keccak256(userOp.callData),
          userOp.accountGasLimits, userOp.preVerificationGas, userOp.gasFees, keccak256(userOp.paymasterAndData),
        ],
      ),
    )
    const expected = keccak256(
      encodeAbiParameters(
        [{ type: 'bytes32' }, { type: 'address' }, { type: 'uint256' }],
        [hashedOp, entryPoint, BigInt(chainId)],
      ),
    )
    expect(userOpHash(userOp, entryPoint, chainId)).toBe(expected)
  })

  it('is sensitive to chainId, entryPoint, nonce, callData', () => {
    const base = userOpHash(userOp, entryPoint, chainId)
    expect(userOpHash(userOp, entryPoint, 10)).not.toBe(base)
    expect(userOpHash(userOp, '0x000000000000000000000000000000000000beEF' as Hex, chainId)).not.toBe(base)
    expect(userOpHash({ ...userOp, nonce: 1n }, entryPoint, chainId)).not.toBe(base)
    expect(userOpHash({ ...userOp, callData: '0xfeed' }, entryPoint, chainId)).not.toBe(base)
  })
})

describe('encodeStatelessData', () => {
  it('abi.encodes (uint256 threshold, address[] owners) with owners sorted ascending', () => {
    const o1 = '0x0000000000000000000000000000000000000001' as Hex
    const o2 = '0x0000000000000000000000000000000000000002' as Hex
    // pass unsorted; encoder must emit sorted+deduped
    const data = encodeStatelessData(2, [o2, o1, o1])
    const expected = encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'address[]' }],
      [2n, [getAddress(o1), getAddress(o2)]],
    )
    expect(data).toBe(expected)
  })
})

describe('encodeOwnableMeta / decodeOwnableMeta', () => {
  it('round-trips a raw-hash (mode 0) record', () => {
    const meta: OwnableMeta = {
      mode: 0,
      hash: `0x${'ab'.repeat(32)}` as Hex,
      packedUserOp: '0x',
      entryPoint: '0x0000000000000000000000000000000000000000',
      validator: OWNABLE_VALIDATOR_ADDRESS,
      account,
      chainId,
    }
    expect(decodeOwnableMeta(encodeOwnableMeta(meta))).toEqual(meta)
  })

  it('round-trips a 4337 (mode 1) record', () => {
    const meta: OwnableMeta = {
      mode: 1,
      hash: userOpHash(userOp, entryPoint, chainId),
      packedUserOp: '0xabcdef',
      entryPoint,
      validator: OWNABLE_VALIDATOR_ADDRESS,
      account,
      chainId,
    }
    expect(decodeOwnableMeta(encodeOwnableMeta(meta))).toEqual(meta)
  })
})
```

Run — must fail:

```bash
npm run test --workspace=packages/cosign -- rhinestone-digest
```

**Expected:** import-resolution / missing-export failures (RED).

### 3.2 GREEN — append to `packages/cosign/src/adapters/rhinestone.ts`

Add to the top-of-file imports (merge into one `viem` import):

```ts
import {
  type Hex,
  encodeAbiParameters,
  decodeAbiParameters,
  keccak256,
  getAddress,
} from 'viem'
```

Then append:

```ts
/** ERC-4337 v0.7 PackedUserOperation fields (the shape the EntryPoint hashes). */
export interface PackedUserOp {
  sender: Hex
  nonce: bigint
  initCode: Hex
  callData: Hex
  /** packed (verificationGasLimit ‖ callGasLimit) — 32 bytes. */
  accountGasLimits: Hex
  preVerificationGas: bigint
  /** packed (maxPriorityFeePerGas ‖ maxFeePerGas) — 32 bytes. */
  gasFees: Hex
  paymasterAndData: Hex
  signature: Hex
}

/** The reconstruction context carried in SignatureRecord.meta. */
export interface OwnableMeta {
  /** 0 = raw-hash (stateless / 1271); 1 = 4337 userOp. */
  mode: number
  /** raw message hash (mode 0) or userOpHash (mode 1). */
  hash: Hex
  /** abi-encoded PackedUserOperation (mode 1) or 0x (mode 0). */
  packedUserOp: Hex
  /** 4337 EntryPoint (mode 1) or address(0). */
  entryPoint: Hex
  /** the OwnableValidator module address. */
  validator: Hex
  /** the smart-account address (the getOwners/threshold key). */
  account: Hex
  /** chain id (binds the userOpHash). */
  chainId: number
}

/**
 * The ERC-4337 v0.7 userOpHash:
 *   keccak256(abi.encode(keccak256(packedFields), entryPoint, chainId))
 * where packedFields = abi.encode(sender, nonce, keccak256(initCode), keccak256(callData),
 *   accountGasLimits, preVerificationGas, gasFees, keccak256(paymasterAndData)).
 * Byte-equal to EntryPoint.getUserOpHash(userOp); the on-chain read is canonical, this is for
 * offline digest building + parity checks.
 */
export function userOpHash(op: PackedUserOp, entryPoint: Hex, chainId: number): Hex {
  const hashedOp = keccak256(
    encodeAbiParameters(
      [
        { type: 'address' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'bytes32' },
        { type: 'bytes32' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'bytes32' },
      ],
      [
        op.sender, op.nonce, keccak256(op.initCode), keccak256(op.callData),
        op.accountGasLimits, op.preVerificationGas, op.gasFees, keccak256(op.paymasterAndData),
      ],
    ),
  )
  return keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'address' }, { type: 'uint256' }],
      [hashedOp, entryPoint, BigInt(chainId)],
    ),
  )
}

/**
 * The stateless `data` arg for validateSignatureWithData: abi.encode(uint256 threshold,
 * address[] owners). Owners are sorted ascending + deduped (the validator returns false on
 * !isSortedAndUniquified). Throws if threshold < 1 or > the deduped owner count.
 */
export function encodeStatelessData(threshold: number, owners: Hex[]): Hex {
  const seen = new Set<string>()
  const deduped: Hex[] = []
  for (const o of owners) {
    const k = getAddress(o).toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    deduped.push(getAddress(o))
  }
  deduped.sort((a, b) => {
    const av = BigInt(a)
    const bv = BigInt(b)
    return av < bv ? -1 : av > bv ? 1 : 0
  })
  if (threshold < 1 || threshold > deduped.length) {
    throw new Error(`invalid threshold ${threshold} for ${deduped.length} owners`)
  }
  return encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'address[]' }],
    [BigInt(threshold), deduped],
  )
}

/** ABI tuple for record.meta — order is law. */
const OWNABLE_META_ABI = [
  { name: 'mode', type: 'uint8' },
  { name: 'hash', type: 'bytes32' },
  { name: 'packedUserOp', type: 'bytes' },
  { name: 'entryPoint', type: 'address' },
  { name: 'validator', type: 'address' },
  { name: 'account', type: 'address' },
  { name: 'chainId', type: 'uint256' },
] as const

/** ABI-encodes the OwnableMeta tuple for SignatureRecord.meta. */
export function encodeOwnableMeta(m: OwnableMeta): Hex {
  return encodeAbiParameters(OWNABLE_META_ABI, [
    m.mode,
    m.hash,
    m.packedUserOp,
    getAddress(m.entryPoint),
    getAddress(m.validator),
    getAddress(m.account),
    BigInt(m.chainId),
  ])
}

/** Decodes record.meta back into OwnableMeta. Throws on malformed input. */
export function decodeOwnableMeta(meta: Hex): OwnableMeta {
  const [mode, hash, packedUserOp, entryPoint, validator, account, chainId] =
    decodeAbiParameters(OWNABLE_META_ABI, meta)
  return {
    mode: Number(mode),
    hash,
    packedUserOp,
    entryPoint: getAddress(entryPoint),
    validator: getAddress(validator),
    account: getAddress(account),
    chainId: Number(chainId),
  }
}
```

> **Note on `decodeOwnableMeta` round-trip + `getAddress`:** the test builds `OwnableMeta` with lowercase/`address(0)` strings; `decode` returns EIP-55-checksummed addresses. The round-trip test must compare against `getAddress`-normalized values OR construct the input already checksummed. The test above uses `OWNABLE_VALIDATOR_ADDRESS` (already checksummed) and `address(0)` / the checksummed `account`/`entryPoint` constants — confirm each literal in the test is the `getAddress` form (the `entryPoint` v0.7 literal `0x0000000071727De22E5E9d8BAf0edAc6f37da032` is already checksummed; `account` all-`1`s lowercases to itself but `getAddress` will checksum it — set the test's expected via `getAddress` if a mismatch appears). Keep the encoder/decoder normalizing through `getAddress` so the on-wire bytes are canonical.

### 3.3 Run & verify

```bash
npm run test --workspace=packages/cosign -- rhinestone-digest
```

**Expected:** all `rhinestone-digest.test.ts` cases pass — `userOpHash` deterministic + equals the hand-built v0.7 hash + sensitive; `encodeStatelessData` sorts/dedups; meta round-trips both modes.

### 3.4 Commit

```bash
git add packages/cosign/src/adapters/rhinestone.ts packages/cosign/test/adapters/rhinestone-digest.test.ts
git commit -m "feat(cosign/rhinestone): userOpHash (4337 v0.7) + encodeStatelessData (sorted owners) + meta codec"
```

---

## Task 4 — `makeRhinestoneOwnableAdapter`: owners/threshold/verify + order + buildOwnableSignature

**Goal:** the adapter factory with per-account reads, both verify digests (4337 EIP-191-wrapped + raw-hash), strictly-ascending order+dedup (via `_ecdsa.ts`), and the plain-concatenation blob builder. Unit-tested with a **fake `PublicClient`** + **real viem signatures**. No chain.

### 4.1 RED — `packages/cosign/test/adapters/rhinestone-verify.test.ts`

```ts
import { describe, expect, it, vi } from 'vitest'
import { type Hex, serializeSignature } from 'viem'
import { privateKeyToAccount, sign, signMessage } from 'viem/accounts'
import { SCHEME, type SignatureRecord } from '../../src/record.js'
import {
  makeRhinestoneOwnableAdapter,
  OWNABLE_VALIDATOR_ADDRESS,
  type OwnablePublicClient,
} from '../../src/adapters/rhinestone.js'

const chainId = 1
const validator = OWNABLE_VALIDATOR_ADDRESS
const account = '0x1111111111111111111111111111111111111111' as Hex
const rawHash = `0x${'77'.repeat(32)}` as Hex

const PK_A = `0x${'a'.repeat(64)}` as Hex
const PK_B = `0x${'b'.repeat(64)}` as Hex
const PK_C = `0x${'c'.repeat(64)}` as Hex
const ownerA = privateKeyToAccount(PK_A)
const ownerB = privateKeyToAccount(PK_B)
const ownerC = privateKeyToAccount(PK_C)

/** Fake client answering getOwners(account)/threshold(account) — asserts the account arg is passed. */
const fakeClient = (
  over?: Partial<Record<'getOwners' | 'threshold', unknown>>,
): OwnablePublicClient => ({
  readContract: vi.fn(async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
    if (functionName === 'getOwners') {
      expect(args?.[0]).toBe(account) // keyed by the smart-account address
      return over?.getOwners ?? [ownerA.address, ownerB.address]
    }
    if (functionName === 'threshold') {
      expect(args?.[0]).toBe(account)
      return over?.threshold ?? 2n
    }
    throw new Error(`unexpected readContract: ${functionName}`)
  }),
})

const adapterOf = (client: OwnablePublicClient) =>
  makeRhinestoneOwnableAdapter({ publicClient: client, validator, account, chainId })

const rec = (o: Partial<SignatureRecord>): SignatureRecord => ({
  digest: rawHash,
  signer: ownerA.address as Hex,
  signature: '0x',
  scheme: SCHEME.EIP712,
  meta: '0x',
  ...o,
})

/** raw-hash signature (stateless / 1271 path): plain ECDSA over the raw hash, v∈{27,28}. */
const rawSig = async (pk: Hex) => serializeSignature(await sign({ hash: rawHash, privateKey: pk }))
/** 4337 signature: personal_sign over the raw userOpHash → recovers via toEthSignedMessageHash. */
const userOpSig = async (pk: Hex) => signMessage({ message: { raw: rawHash }, privateKey: pk })

describe('owners / threshold (keyed by account)', () => {
  it('owners() returns getOwners(account)', async () => {
    expect(await adapterOf(fakeClient()).owners!()).toEqual([ownerA.address, ownerB.address])
  })
  it('threshold() returns threshold(account) as a number', async () => {
    expect(await adapterOf(fakeClient()).threshold!()).toBe(2)
  })
})

describe('verify — raw-hash path (stateless / 1271)', () => {
  it('accepts a valid owner raw-hash signature', async () => {
    const r = rec({ signature: await rawSig(PK_A), signer: ownerA.address as Hex })
    expect(await adapterOf(fakeClient()).verify(r)).toBe(true)
  })
  it('rejects a recovery != claimed signer', async () => {
    const r = rec({ signature: await rawSig(PK_A), signer: ownerB.address as Hex })
    expect(await adapterOf(fakeClient()).verify(r)).toBe(false)
  })
  it('rejects a non-owner', async () => {
    const r = rec({ signature: await rawSig(PK_C), signer: ownerC.address as Hex })
    expect(await adapterOf(fakeClient()).verify(r)).toBe(false)
  })
  it('rejects a wrong-digest signature', async () => {
    const wrong = serializeSignature(await sign({ hash: `0x${'00'.repeat(32)}` as Hex, privateKey: PK_A }))
    expect(await adapterOf(fakeClient()).verify(rec({ signature: wrong }))).toBe(false)
  })
})

describe('verify — 4337 userOp path (EIP-191-wrapped)', () => {
  it('accepts an owner signature over toEthSignedMessageHash(userOpHash)', async () => {
    // The record.meta.mode flags the 4337 path; digest is the userOpHash, signature is personal_sign.
    const { encodeOwnableMeta } = await import('../../src/adapters/rhinestone.js')
    const meta = encodeOwnableMeta({
      mode: 1, hash: rawHash, packedUserOp: '0x', entryPoint: '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
      validator, account, chainId,
    })
    const r = rec({ signature: await userOpSig(PK_A), signer: ownerA.address as Hex, meta })
    expect(await adapterOf(fakeClient()).verify(r)).toBe(true)
  })
  it('rejects a raw-signed signature presented as 4337 (prefix mismatch)', async () => {
    const { encodeOwnableMeta } = await import('../../src/adapters/rhinestone.js')
    const meta = encodeOwnableMeta({
      mode: 1, hash: rawHash, packedUserOp: '0x', entryPoint: '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
      validator, account, chainId,
    })
    const r = rec({ signature: await rawSig(PK_A), signer: ownerA.address as Hex, meta }) // raw, not personal_sign
    expect(await adapterOf(fakeClient()).verify(r)).toBe(false)
  })
})

describe('verify — error propagation', () => {
  it('propagates an RPC error (does not swallow as false)', async () => {
    const client: OwnablePublicClient = { readContract: vi.fn(async () => { throw new Error('rpc down') }) }
    const r = rec({ signature: await rawSig(PK_A), signer: ownerA.address as Hex })
    await expect(adapterOf(client).verify(r)).rejects.toThrow('rpc down')
  })
})
```

### 4.2 RED — `packages/cosign/test/adapters/rhinestone-order.test.ts`

```ts
import { describe, expect, it } from 'vitest'
import { type Hex, serializeSignature, size, slice, concat } from 'viem'
import { privateKeyToAccount, sign } from 'viem/accounts'
import { SCHEME, type SignatureRecord } from '../../src/record.js'
import {
  makeRhinestoneOwnableAdapter,
  buildOwnableSignature,
  OWNABLE_VALIDATOR_ADDRESS,
  type OwnablePublicClient,
} from '../../src/adapters/rhinestone.js'

const chainId = 1
const validator = OWNABLE_VALIDATOR_ADDRESS
const account = '0x1111111111111111111111111111111111111111' as Hex
const rawHash = `0x${'77'.repeat(32)}` as Hex

const PK_1 = `0x${'11'.repeat(32)}` as Hex
const PK_2 = `0x${'22'.repeat(32)}` as Hex
const PK_3 = `0x${'33'.repeat(32)}` as Hex
const a1 = privateKeyToAccount(PK_1)
const a2 = privateKeyToAccount(PK_2)
const a3 = privateKeyToAccount(PK_3)
const allOwners = [a1.address, a2.address, a3.address] as Hex[]

const fakeClient = (): OwnablePublicClient => ({
  readContract: async ({ functionName }: { functionName: string }) => {
    if (functionName === 'getOwners') return allOwners
    if (functionName === 'threshold') return 2n
    throw new Error(`unexpected: ${functionName}`)
  },
})

async function rec(pk: Hex, signer: Hex): Promise<SignatureRecord> {
  return {
    digest: rawHash,
    signer,
    signature: serializeSignature(await sign({ hash: rawHash, privateKey: pk })),
    scheme: SCHEME.EIP712,
    meta: '0x',
  }
}

const adapter = () => makeRhinestoneOwnableAdapter({ publicClient: fakeClient(), validator, account, chainId })

describe('order', () => {
  it('sorts strictly ascending by signer + dedups', async () => {
    const r1 = await rec(PK_1, a1.address as Hex)
    const r2 = await rec(PK_2, a2.address as Hex)
    const r3 = await rec(PK_3, a3.address as Hex)
    const out = adapter().order([r3, r1, r2, { ...r1 }])
    expect(out).toHaveLength(3)
    const vals = out.map((r) => BigInt(r.signer))
    for (let i = 1; i < vals.length; i++) expect(vals[i] > vals[i - 1]).toBe(true)
  })
})

describe('buildOwnableSignature', () => {
  it('concatenates one verbatim 65-byte word per signer in order (no v+4, no tail)', async () => {
    const r1 = await rec(PK_1, a1.address as Hex)
    const r2 = await rec(PK_2, a2.address as Hex)
    const ordered = adapter().order([r2, r1])
    const blob = buildOwnableSignature(ordered)
    expect(size(blob)).toBe(ordered.length * 65)
    // each 65-byte slice is the verbatim signature of the corresponding ordered record
    for (let i = 0; i < ordered.length; i++) {
      expect(slice(blob, i * 65, (i + 1) * 65)).toBe(ordered[i].signature)
    }
    expect(blob).toBe(concat(ordered.map((r) => r.signature)))
  })
})
```

Run both — must fail (no factory yet):

```bash
npm run test --workspace=packages/cosign -- rhinestone-verify rhinestone-order
```

**Expected:** import-resolution / `makeRhinestoneOwnableAdapter is not a function` (RED).

### 4.3 GREEN — append to `packages/cosign/src/adapters/rhinestone.ts`

Extend the imports:

```ts
import {
  type Hex,
  encodeAbiParameters,
  decodeAbiParameters,
  keccak256,
  getAddress,
  isAddressEqual,
  recoverAddress,
  recoverMessageAddress,
  concat,
} from 'viem'
import type { SignatureRecord } from '../record.js'
import { SCHEME } from '../record.js'
import type { CosignAdapter } from './adapter.js'
import { eoaWord, sortDedupBySigner } from './_ecdsa.js'
```

Append:

```ts
/** The minimal read-only client surface the adapter needs (a viem PublicClient satisfies it). */
export interface OwnablePublicClient {
  readContract(args: {
    address: Hex
    abi: readonly unknown[]
    functionName: string
    args?: readonly unknown[]
  }): Promise<unknown>
}

/** Config: one instance is pinned to one (chainId, validator, account). */
export interface RhinestoneOwnableConfig {
  publicClient: OwnablePublicClient
  /** The OwnableValidator module address (defaults to the canonical address). */
  validator?: Hex
  /** The ERC-7579 smart-account address — the getOwners/threshold storage key. */
  account: Hex
  /** Chain id (binds the userOpHash domain). */
  chainId: number
}

/** Minimal OwnableValidator ABI — only the reads the adapter calls (keyed by account). */
export const OWNABLE_VALIDATOR_ABI = [
  { type: 'function', name: 'getOwners', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'address[]' }] },
  { type: 'function', name: 'threshold', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'ownerCount', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] },
  {
    type: 'function', name: 'validateSignatureWithData', stateMutability: 'view',
    inputs: [{ name: 'hash', type: 'bytes32' }, { name: 'signature', type: 'bytes' }, { name: 'data', type: 'bytes' }],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function', name: 'isValidSignatureWithSender', stateMutability: 'view',
    inputs: [{ name: 'sender', type: 'address' }, { name: 'hash', type: 'bytes32' }, { name: 'data', type: 'bytes' }],
    outputs: [{ type: 'bytes4' }],
  },
] as const

/** ERC-7579 isValidSignatureWithSender success magic. */
export const EIP1271_SUCCESS = '0x1626ba7e' as const

/**
 * Recovers the effective signer for a record. For mode-1 (4337) records the validator wraps the
 * userOpHash with the EIP-191 prefix before recovery (ECDSA.toEthSignedMessageHash), so we recover
 * over the prefixed message; for mode-0 (raw-hash) records we recover over the raw digest. Both
 * are plain v∈{27,28} ECDSA on the wire. Throws on a malformed signature.
 */
async function effectiveSigner(record: SignatureRecord): Promise<Hex> {
  let mode = 0
  if (record.meta && record.meta !== '0x') {
    try {
      mode = decodeOwnableMeta(record.meta).mode
    } catch {
      mode = 0
    }
  }
  if (mode === 1) {
    // 4337: the owner personal-signed the raw userOpHash; recover over the EIP-191 message.
    return recoverMessageAddress({ message: { raw: record.digest }, signature: record.signature })
  }
  // raw-hash (stateless / 1271): plain ECDSA over the raw digest.
  return recoverAddress({ hash: record.digest, signature: record.signature })
}

/**
 * The Rhinestone OwnableValidator CosignAdapter (threshold-of-EOAs). Verifies one owner's ECDSA
 * signature over the appropriate digest + confirms membership via getOwners(account); orders
 * records strictly-ascending + deduped and concatenates the 65-byte words validateUserOp /
 * validateSignatureWithData / isValidSignatureWithSender consume.
 */
export function makeRhinestoneOwnableAdapter(config: RhinestoneOwnableConfig): CosignAdapter {
  const { publicClient, account } = config
  const validator = config.validator ?? OWNABLE_VALIDATOR_ADDRESS

  async function owners(): Promise<Hex[]> {
    const result = (await publicClient.readContract({
      address: validator,
      abi: OWNABLE_VALIDATOR_ABI,
      functionName: 'getOwners',
      args: [account],
    })) as readonly Hex[]
    return result.map((a) => getAddress(a))
  }

  async function threshold(): Promise<number> {
    const result = (await publicClient.readContract({
      address: validator,
      abi: OWNABLE_VALIDATOR_ABI,
      functionName: 'threshold',
      args: [account],
    })) as bigint
    return Number(result)
  }

  async function isOwner(addr: Hex): Promise<boolean> {
    const set = await owners()
    return set.some((o) => isAddressEqual(o, addr))
  }

  async function verify(record: SignatureRecord): Promise<boolean> {
    let recovered: Hex
    try {
      recovered = await effectiveSigner(record)
    } catch {
      return false // malformed signature = definitively invalid, not infra error
    }
    if (!isAddressEqual(recovered, record.signer)) return false
    return isOwner(recovered) // RPC errors here PROPAGATE
  }

  function order(records: SignatureRecord[]): SignatureRecord[] {
    return sortDedupBySigner(records)
  }

  return { verify, order, owners, threshold }
}

/**
 * Concatenates ordered records' verbatim 65-byte {r}{s}{v} words into the signature blob the
 * validator's recoverNSignatures parses. Pass the output of adapter.order. This IS the
 * userOp.signature (4337) and the `signature` arg of validateSignatureWithData / data of
 * isValidSignatureWithSender. No v adjustment, no offset tails (EOA owners only).
 */
export function buildOwnableSignature(orderedRecords: SignatureRecord[]): Hex {
  if (orderedRecords.length === 0) return '0x'
  return concat(orderedRecords.map((r) => eoaWord(r.signature)))
}

// (decodeOwnableMeta is defined above in Task 3; effectiveSigner references it.)
```

> **Ordering note:** `effectiveSigner` calls `decodeOwnableMeta`, which is declared earlier in the file (Task 3). If the linter complains about use-before-declaration, hoist `decodeOwnableMeta` above `effectiveSigner` or keep both in the order shown (function declarations hoist). `SCHEME` is imported but the adapter currently treats all its own signatures as the plain ECDSA branch regardless of the codec tag — the *mode* (from meta), not the scheme tag, selects the prefix. The `scheme` field stays `EIP712` on the wire for codec compatibility.

### 4.4 Run & verify

```bash
npm run test --workspace=packages/cosign -- rhinestone-verify rhinestone-order
npm run test --workspace=packages/cosign -- rhinestone-digest   # still green
```

**Expected:** `rhinestone-verify` green (owners/threshold keyed by account, raw-hash accept + 3 rejects, 4337 accept + prefix-mismatch reject, RPC propagation); `rhinestone-order` green (sort+dedup, verbatim 65-byte concatenation); digest suite still green.

### 4.5 Commit

```bash
git add packages/cosign/src/adapters/rhinestone.ts packages/cosign/test/adapters/rhinestone-verify.test.ts packages/cosign/test/adapters/rhinestone-order.test.ts
git commit -m "feat(cosign/rhinestone): makeRhinestoneOwnableAdapter (per-account owners/threshold, 4337+raw verify, order, buildOwnableSignature)"
```

---

## Task 5 — `aggregate` wiring + `src/index.ts` re-exports

**Goal:** prove the adapter composes with the SDK's `aggregate` (verify-then-order → submission-ready pairs) end-to-end with a fake client, and export the public surface.

### 5.1 RED — `packages/cosign/test/adapters/rhinestone-aggregate.test.ts`

```ts
import { describe, expect, it } from 'vitest'
import { type Hex, serializeSignature, concat, size } from 'viem'
import { privateKeyToAccount, sign } from 'viem/accounts'
import { SCHEME, type SignatureRecord } from '../../src/record.js'
import { aggregate, groupByDigest } from '../../src/client.js'
import {
  makeRhinestoneOwnableAdapter,
  buildOwnableSignature,
  OWNABLE_VALIDATOR_ADDRESS,
  type OwnablePublicClient,
} from '../../src/adapters/rhinestone.js'

const chainId = 1
const account = '0x1111111111111111111111111111111111111111' as Hex
const rawHash = `0x${'77'.repeat(32)}` as Hex
const PK_1 = `0x${'11'.repeat(32)}` as Hex
const PK_2 = `0x${'22'.repeat(32)}` as Hex
const PK_X = `0x${'ee'.repeat(32)}` as Hex // a non-owner
const a1 = privateKeyToAccount(PK_1)
const a2 = privateKeyToAccount(PK_2)
const ax = privateKeyToAccount(PK_X)

const client: OwnablePublicClient = {
  readContract: async ({ functionName }: { functionName: string }) => {
    if (functionName === 'getOwners') return [a1.address, a2.address]
    if (functionName === 'threshold') return 2n
    throw new Error(`unexpected: ${functionName}`)
  },
}

async function rec(pk: Hex, signer: Hex): Promise<SignatureRecord> {
  return {
    digest: rawHash,
    signer,
    signature: serializeSignature(await sign({ hash: rawHash, privateKey: pk })),
    scheme: SCHEME.EIP712,
    meta: '0x',
  }
}

describe('aggregate + buildOwnableSignature', () => {
  it('keeps only owner sigs, orders them, and builds a 2-word blob', async () => {
    const adapter = makeRhinestoneOwnableAdapter({ publicClient: client, validator: OWNABLE_VALIDATOR_ADDRESS, account, chainId })
    const records = [
      await rec(PK_2, a2.address as Hex),
      await rec(PK_X, ax.address as Hex), // non-owner → dropped by verify
      await rec(PK_1, a1.address as Hex),
    ]
    const perDigest = groupByDigest(records).get(rawHash)!
    const pairs = await aggregate(perDigest, adapter)
    expect(pairs).toHaveLength(2) // the non-owner was filtered
    // ascending by signer
    expect(BigInt(pairs[1].signer) > BigInt(pairs[0].signer)).toBe(true)
    const orderedRecords = pairs.map((p) => perDigest.find((r) => r.signer === p.signer)!)
    const blob = buildOwnableSignature(orderedRecords)
    expect(size(blob)).toBe(130) // 2 × 65
    expect(blob).toBe(concat(orderedRecords.map((r) => r.signature)))
  })
})
```

Run — must fail until imports resolve / index export added (the adapter itself already exists; this test imports from `client.js` + `rhinestone.js`, so it should largely pass once written — if `aggregate`/`groupByDigest` resolve, the RED is the *missing index export* checked in 5.3). Run:

```bash
npm run test --workspace=packages/cosign -- rhinestone-aggregate
```

**Expected:** green if the adapter+client are wired (this task mostly *confirms* composition). If it passes immediately, that is acceptable — the index-export step (5.2) is the remaining deliverable; add a failing index-export assertion if you want a strict RED (see 5.3).

### 5.2 GREEN — `packages/cosign/src/index.ts`

Append the rhinestone re-exports (keep existing exports):

```ts
export {
  type PackedUserOp,
  type OwnableMeta,
  type RhinestoneOwnableConfig,
  type OwnablePublicClient,
  OWNABLE_VALIDATOR_ADDRESS,
  OWNABLE_VALIDATOR_RUNTIME,
  OWNABLE_VALIDATOR_ABI,
  EIP1271_SUCCESS,
  userOpHash,
  encodeStatelessData,
  encodeOwnableMeta,
  decodeOwnableMeta,
  makeRhinestoneOwnableAdapter,
  buildOwnableSignature,
} from './adapters/rhinestone.js'
```

### 5.3 RED guard (optional, strict) — `packages/cosign/test/adapters/rhinestone-exports.test.ts`

```ts
import { describe, expect, it } from 'vitest'
import * as pkg from '../../src/index.js'

describe('package re-exports the rhinestone adapter', () => {
  it('exposes the adapter factory + helpers', () => {
    for (const name of [
      'makeRhinestoneOwnableAdapter', 'buildOwnableSignature', 'userOpHash',
      'encodeStatelessData', 'encodeOwnableMeta', 'decodeOwnableMeta',
      'OWNABLE_VALIDATOR_ADDRESS', 'OWNABLE_VALIDATOR_ABI', 'EIP1271_SUCCESS',
    ]) {
      expect(name in pkg).toBe(true)
    }
  })
})
```

### 5.4 Run & verify

```bash
npm run test --workspace=packages/cosign -- rhinestone-aggregate rhinestone-exports
npm run test --workspace=packages/cosign            # full sweep
npm run build --workspace=packages/cosign           # tsc clean
```

**Expected:** aggregate composition + exports green; full sweep green; `tsc` clean.

### 5.5 Commit

```bash
git add packages/cosign/src/index.ts packages/cosign/test/adapters/rhinestone-aggregate.test.ts packages/cosign/test/adapters/rhinestone-exports.test.ts
git commit -m "feat(cosign/rhinestone): wire aggregate composition + re-export adapter surface from index"
```

---

## Task 6 — Integration: real OwnableValidator bytecode on anvil (`validateSignatureWithData`)

**Goal:** the headline real check. `setCode` the canonical OwnableValidator runtime bytecode on a fresh anvil, sign a raw hash with `t` of `n` EOAs, `aggregate` → `buildOwnableSignature`, and call the **stateless** `validateSignatureWithData(hash, blob, abi.encode(threshold, sortedOwners))`, asserting it returns `true` — i.e. a board-aggregated blob accepted by the **real** validator's `recoverNSignatures` + sort/uniquify + threshold-count logic. Negatives (too-few sigs, a non-owner mixed in, unsorted owners in `data`) return `false`.

> This is stateless: no account install, no EntryPoint, no bundler. It exercises the exact on-chain recovery + counting path `validateUserOp` uses (minus the EIP-191 wrap, which the raw-hash path omits — and which the **unit** tests already cover for the 4337 case). It is the smallest possible *real* validation, pinned per the prompt over a pure mock.

### 6.1 Create the fixture — `packages/cosign/test/adapters/_ownable-fixture.ts`

```ts
import { createServer } from 'prool'
import { anvil } from 'prool/instances'
import {
  type Hex,
  type Address,
  createTestClient,
  createPublicClient,
  http,
  publicActions,
} from 'viem'
import { foundry } from 'viem/chains'
import { OWNABLE_VALIDATOR_ADDRESS, OWNABLE_VALIDATOR_RUNTIME } from '../../src/adapters/rhinestone.js'

export interface OwnableFixture {
  chainId: number
  publicClient: ReturnType<typeof createPublicClient>
  validator: Address
  stop: () => Promise<void>
}

/**
 * Boots anvil and setCode's the canonical OwnableValidator runtime bytecode at its address.
 * Because validateSignatureWithData is stateless, no install / EntryPoint / account is needed.
 */
export async function deployOwnableFixture(): Promise<OwnableFixture> {
  process.env.FOUNDRY_DISABLE_NIGHTLY_WARNING ??= '1'
  const server = createServer({ instance: anvil(), port: 0 })
  await server.start()
  const { port } = server.address()!
  const rpcUrl = `http://localhost:${port}/1`
  const chain = { ...foundry, id: foundry.id }

  const test = createTestClient({ mode: 'anvil', chain, transport: http(rpcUrl) }).extend(publicActions)
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) })

  const validator = OWNABLE_VALIDATOR_ADDRESS as Address
  await test.setCode({ address: validator, bytecode: OWNABLE_VALIDATOR_RUNTIME })

  // sanity: the code is present
  const code = await publicClient.getCode({ address: validator })
  if (!code || code === '0x') throw new Error('setCode failed — no bytecode at validator address')

  return {
    chainId: chain.id,
    publicClient,
    validator,
    stop: async () => { await server.stop() },
  }
}
```

### 6.2 RED — `packages/cosign/test/adapters/rhinestone-integration.test.ts`

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type Hex, getAddress, serializeSignature } from 'viem'
import { privateKeyToAccount, sign } from 'viem/accounts'
import { SCHEME, type SignatureRecord } from '../../src/record.js'
import { aggregate, groupByDigest } from '../../src/client.js'
import {
  makeRhinestoneOwnableAdapter,
  buildOwnableSignature,
  encodeStatelessData,
  OWNABLE_VALIDATOR_ABI,
} from '../../src/adapters/rhinestone.js'
import { deployOwnableFixture, type OwnableFixture } from './_ownable-fixture.js'

// A 2-of-3 owner set.
const PK_1 = `0x${'11'.repeat(32)}` as Hex
const PK_2 = `0x${'22'.repeat(32)}` as Hex
const PK_3 = `0x${'33'.repeat(32)}` as Hex
const PK_X = `0x${'ee'.repeat(32)}` as Hex // non-owner
const owners = [PK_1, PK_2, PK_3].map((pk) => getAddress(privateKeyToAccount(pk).address)) as Hex[]
const threshold = 2

const hash = `0x${'a7'.repeat(32)}` as Hex // an arbitrary raw message hash
// The account is irrelevant for the stateless call but required by the adapter config; any address.
const account = '0x1111111111111111111111111111111111111111' as Hex

let fx: OwnableFixture | undefined
let anvilAvailable = true

beforeAll(async () => {
  try {
    fx = await deployOwnableFixture()
  } catch (err) {
    anvilAvailable = false
    // eslint-disable-next-line no-console
    console.warn('[rhinestone-integration] anvil/prool unavailable — skipping:', err)
  }
}, 60_000)

afterAll(async () => { await fx?.stop() })

async function rawRec(pk: Hex): Promise<SignatureRecord> {
  return {
    digest: hash,
    signer: getAddress(privateKeyToAccount(pk).address),
    signature: serializeSignature(await sign({ hash, privateKey: pk })),
    scheme: SCHEME.EIP712,
    meta: '0x',
  }
}

describe.runIf(() => anvilAvailable)('OwnableValidator integration (real validateSignatureWithData on anvil)', () => {
  it('a 2-of-3 board-aggregated blob is accepted (returns true)', async () => {
    const f = fx!
    // For the stateless call the adapter only needs owners()/threshold() for verify membership;
    // point a fake-free path: use a client whose getOwners/threshold come from our known set is not
    // necessary because the stateless validator reads owners from `data`. But aggregate() calls
    // adapter.verify → isOwner → owners(). So we install a tiny client that returns our owner set.
    const ownersClient = {
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === 'getOwners') return owners
        if (functionName === 'threshold') return BigInt(threshold)
        throw new Error(`unexpected: ${functionName}`)
      },
    }
    const adapter = makeRhinestoneOwnableAdapter({
      publicClient: ownersClient as never, validator: f.validator, account, chainId: f.chainId,
    })

    const records = [await rawRec(PK_1), await rawRec(PK_2)]
    const perDigest = groupByDigest(records).get(hash)!
    const pairs = await aggregate(perDigest, adapter)
    const orderedRecords = pairs.map((p) => perDigest.find((r) => r.signer === p.signer)!)
    const blob = buildOwnableSignature(orderedRecords)
    const data = encodeStatelessData(threshold, owners)

    const ok = (await f.publicClient.readContract({
      address: f.validator,
      abi: OWNABLE_VALIDATOR_ABI,
      functionName: 'validateSignatureWithData',
      args: [hash, blob, data],
    })) as boolean
    expect(ok).toBe(true)
  })

  it('a single signature (below threshold 2) is rejected (false)', async () => {
    const f = fx!
    const blob = buildOwnableSignature([await rawRec(PK_1)])
    const data = encodeStatelessData(threshold, owners)
    const ok = (await f.publicClient.readContract({
      address: f.validator, abi: OWNABLE_VALIDATOR_ABI, functionName: 'validateSignatureWithData',
      args: [hash, blob, data],
    })) as boolean
    expect(ok).toBe(false)
  })

  it('a non-owner co-signer does not count toward threshold (false)', async () => {
    const f = fx!
    // one real owner + one non-owner; sorted blob of 2 words, but only 1 is an owner → < threshold
    const recs = [await rawRec(PK_1), await rawRec(PK_X)]
    const sorted = recs.sort((a, b) => (BigInt(a.signer) < BigInt(b.signer) ? -1 : 1))
    const blob = buildOwnableSignature(sorted)
    const data = encodeStatelessData(threshold, owners)
    const ok = (await f.publicClient.readContract({
      address: f.validator, abi: OWNABLE_VALIDATOR_ABI, functionName: 'validateSignatureWithData',
      args: [hash, blob, data],
    })) as boolean
    expect(ok).toBe(false)
  })

  it('unsorted owners in data are rejected by isSortedAndUniquified (false)', async () => {
    const f = fx!
    const blob = buildOwnableSignature([await rawRec(PK_1), await rawRec(PK_2)].sort(
      (a, b) => (BigInt(a.signer) < BigInt(b.signer) ? -1 : 1),
    ))
    // hand-build an UNSORTED owners array (bypass encodeStatelessData's sort) via raw abi encoding
    const { encodeAbiParameters } = await import('viem')
    const unsorted = [...owners].sort((a, b) => (BigInt(a) < BigInt(b) ? 1 : -1)) // descending
    const data = encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'address[]' }],
      [BigInt(threshold), unsorted],
    )
    const ok = (await f.publicClient.readContract({
      address: f.validator, abi: OWNABLE_VALIDATOR_ABI, functionName: 'validateSignatureWithData',
      args: [hash, blob, data],
    })) as boolean
    expect(ok).toBe(false)
  })
})
```

Run — must fail until the fixture + (already-built) adapter are wired and anvil is present:

```bash
npm run test --workspace=packages/cosign -- rhinestone-integration
```

**Expected (RED):** before the fixture exists, an import error; once wired with anvil present, GREEN.

### 6.3 GREEN

No new adapter source — the integration test exercises Tasks 1–5 against the real validator bytecode. GREEN when:
- the 2-of-3 aggregated blob → `validateSignatureWithData` returns `true`,
- a 1-sig blob returns `false` (below threshold),
- an owner+non-owner blob returns `false` (non-owner uncounted),
- a descending-owners `data` returns `false` (`isSortedAndUniquified` guard).

If anvil is unavailable, the suite **skips** (via `describe.runIf`) with the `beforeAll` warning — a visible skip, never a false pass.

### 6.4 Run & verify

```bash
npm run test --workspace=packages/cosign -- rhinestone-integration
npm run test --workspace=packages/cosign            # full package sweep
npm run build --workspace=packages/cosign
```

**Expected:**
- `rhinestone-integration.test.ts`: 4 passed when anvil is present; or a single skip notice if not.
- Full sweep: every cosign suite (Safe + rhinestone + SDK) green.
- `tsc`: clean.

### 6.5 Commit

```bash
git add packages/cosign/test/adapters/_ownable-fixture.ts packages/cosign/test/adapters/rhinestone-integration.test.ts
git commit -m "test(cosign/rhinestone): integration — real OwnableValidator on anvil, board-aggregated blob accepted by validateSignatureWithData"
```

---

## Self-review

### Source-fidelity checklist (against `OwnableValidator.sol` / `CheckNSignatures.sol` / `ERC7579ValidatorBase.sol`)

- [ ] Per-account storage: `getOwners(address)` / `threshold(address)` / `ownerCount(address)` — reads are keyed by the smart-account address (Task 4, asserted in `rhinestone-verify.test.ts`).
- [ ] `validateUserOp` wraps with `ECDSA.toEthSignedMessageHash(userOpHash)` (EIP-191) before `recoverNSignatures` — mirrored by the mode-1 `recoverMessageAddress({ message: { raw: userOpHash } })` path (Task 4, the 4337 accept + prefix-mismatch tests).
- [ ] `isValidSignatureWithSender(address,bytes32,bytes)` validates the RAW hash, returns `0x1626ba7e` — `EIP1271_SUCCESS` pinned (Task 4); raw-hash recovery path covered (Task 4) and the stateless equivalent is on-chain-tested (Task 6).
- [ ] `validateSignatureWithData(bytes32,bytes,bytes)`: `data = abi.encode(threshold, owners[])`, owners pre-sorted/deduped (`isSortedAndUniquified`), raw hash, returns `bool` — `encodeStatelessData` enforces sort+dedup (Task 3) and the real call is the integration headline (Task 6), including the unsorted-`data` → `false` negative.
- [ ] `recoverNSignatures`: 65-byte `{r}{s}{v}` `signatureSplit`, plain `v∈{27,28}` branch for our words — `eoaWord` emits verbatim words, `buildOwnableSignature` plain-concatenates (Tasks 2, 4), accepted on-chain (Task 6).
- [ ] Post-recovery `sort` + `uniquifySorted` + owner-count ≥ threshold — the adapter also sorts+dedups (`sortDedupBySigner`) so exactly `threshold` distinct owners occupy the first words; threshold/non-owner negatives proven on-chain (Task 6).
- [ ] Magic + validation constants: `EIP1271_SUCCESS=0x1626ba7e`, `EIP1271_FAILED=0xffffffff`, `VALIDATION_SUCCESS=0`, `VALIDATION_FAILED=1` — documented; `EIP1271_SUCCESS` exported (Task 4).
- [ ] Canonical address `0x2483DA3A338895199E5e538530213157e931Bf06` + runtime bytecode pinned + selectors verified (Task 1).

### Reuse / no-duplication checklist

- [ ] `splitSig` + `sortDedupBySigner` + `eoaWord` live ONCE in `_ecdsa.ts`; `safe.ts` re-points (Task 2) and stays green; `rhinestone.ts` imports them (Task 4). No copy-paste of Safe internals.
- [ ] The full Safe suite re-runs green after the Task-2 refactor (the safety net).

### Internal consistency

- [ ] `PackedUserOp` (Task 3) is the exact shape `userOpHash` consumes (Task 3) and `encodeOwnableMeta.packedUserOp` carries.
- [ ] `OwnableMeta.mode` (Task 3) is the flag `effectiveSigner` reads to choose the EIP-191 vs raw recovery (Task 4).
- [ ] `OwnablePublicClient` (Task 4) is the one read seam used by `owners`/`threshold`/`verify` and the fakes (Tasks 4–5) + the real viem client (Task 6, cast `as never` only at the call boundary).
- [ ] `buildOwnableSignature` (Task 4) output feeds `validateSignatureWithData` (Task 6) and IS the `userOp.signature` for the 4337 path (documented).
- [ ] `encodeStatelessData` (Task 3) sort+dedup matches the validator's `isSortedAndUniquified` requirement (Task 6 negative proves the validator rejects unsorted).

### Placeholder scan

Before the final commit:

```bash
grep -rnE 'TODO|FIXME|XXX|\?\?\?|placeholder|not yet implemented|0x6080\.\.\.|/\* PASTE' packages/cosign/src/adapters/rhinestone.ts
```

**Expected:** **no** matches — in particular the `0x6080...` / `/* PASTE` bytecode placeholder from Task 1.4 MUST be replaced with the full pinned runtime hex. (If `0x6080...` matches, Task 1 was left half-done.)

### Deviations / decisions (called out)

1. **Prompt said `verify` over `toEthSignedMessageHash(userOpHash)` "and (+ optional EIP-1271 via isValidSignatureWithSender)".** Implemented: the EIP-191 wrap is selected by `meta.mode` (1 = 4337 wrapped, 0 = raw). The raw-hash path covers both the stateless and `isValidSignatureWithSender` message cases (both recover over the raw hash). A *live* `isValidSignatureWithSender` call requires an installed module on an account (stateful) — out of scope for the pinned test; the stateless `validateSignatureWithData` exercises the identical recovery+count logic on-chain instead. This is the prompt's stated preference ("support the simpler EIP-1271 message case … if it's cleaner to test").
2. **Prompt's framing "recover over toEthSignedMessageHash(userOpHash) (EIP-191)" vs the raw-hash entry points.** Verified from source: only `validateUserOp` applies the EIP-191 wrap; `isValidSignatureWithSender` and `validateSignatureWithData` recover over the RAW hash. The adapter handles BOTH via `meta.mode` — this is a *correction/refinement* of treating every path as EIP-191-wrapped. Documented in "Verified-from-source facts" B + C.
3. **Contract-owner (`v==0`) words and full stateful userOp validation are out of scope** (see "Out of scope"), with the lift-from-`safe.ts` path noted for the former and the modulekit-toolchain cost noted for the latter.
4. **Integration uses fetch-bytecode + setCode, not deploy-from-source or fork** — fully self-contained + deterministic via a pinned constant, mirroring the Safe fixture's setCode pattern; no new dev deps. Documented in "Tech Stack".
5. **`scheme` stays `EIP712` on the wire** for every signature this adapter produces; the EIP-191-vs-raw decision is driven by `meta.mode`, not a codec scheme tag (no 4th scheme added). Documented in "Scheme mapping".

---

## Execution Handoff

This plan is ready to execute. It DEPENDS on the cosign SDK + the Safe adapter being present in `packages/cosign` (both already built). Two options:

- **Subagent-driven (recommended for isolation):** dispatch each task (1→6, sequential by dependency) to a fresh implementer subagent via `superpowers:subagent-driven-development`, with a review checkpoint after each commit. Each task is self-contained (its own RED→GREEN→commit) and leaves the suite green. **Task 2 (the Safe refactor) must re-run the full Safe suite green before proceeding** — it is the no-behavior-change safety net.
- **Inline:** execute here, task by task, pausing after each commit per `superpowers:executing-plans`.

Either way: enforce TDD (RED first, watch it fail for the right reason, then GREEN), run the exact commands shown, confirm the expected output before committing, paste the **full** runtime bytecode in Task 1.4 (no `0x6080...` placeholder survives to the final commit — the placeholder scan must be clean), and keep the integration test (Task 6) **real** — a board-aggregated blob accepted by the actual OwnableValidator bytecode, not a mock. If anvil is unavailable on the execution host, install Foundry (`foundryup`); the suite skips loudly rather than passing falsely.

Offer to begin execution of Task 1 (pin the canonical bytecode + selector smoke test), or to wire the whole sequence under a subagent-driven run. **Do NOT git add or git commit on behalf of the controller unless executing — this plan-authoring step writes only the plan doc.**
