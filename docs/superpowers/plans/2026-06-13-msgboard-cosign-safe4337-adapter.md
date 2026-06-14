# @msgboard/cosign Safe4337Module adapter Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL — `superpowers:test-driven-development`. Every task below is RED → GREEN → REFACTOR. Write the failing test first, run it, watch it fail for the *right* reason, then write the minimum code to pass. Do not skip the RED step. Do not write source before its test.

> **DEPENDS ON (both already BUILT):**
> 1. The cosign SDK — `packages/cosign/src/{keys,record,client}.ts` + `src/adapters/adapter.ts` (the `CosignAdapter` interface, `SCHEME = { ECDSA: 0, EIP1271: 1, EIP712: 2 }`, `aggregate`, `groupByDigest`).
> 2. The **Safe adapter** — `packages/cosign/src/adapters/safe.ts` (plan: `docs/superpowers/plans/2026-06-13-msgboard-cosign-safe-adapter.md`; spec: `docs/superpowers/specs/2026-06-13-msgboard-cosign-safe-adapter-design.md`). This plan **reuses** that adapter's v-byte signature scheme, ascending-order blob builder, EIP-1271 offset-tail layout, and EOA verify core.
>
> If `packages/cosign/src/adapters/safe.ts` does not export `makeSafeAdapter`, `buildSignatureBlob`, `order` (via the adapter), `SafePublicClient`, `SAFE_ABI`, and `EIP1271_MAGIC_VALUE`, stop and execute the Safe adapter plan first.

## Goal

Ship `@msgboard/cosign/src/adapters/safe4337.ts`: the **second concrete `CosignAdapter`**, targeting the **Safe4337Module** (the ERC-4337 extension to a Safe; `@safe-global/safe-4337` **v0.3.0**, EntryPoint **v0.7** / `PackedUserOperation`). It is a **thin variant** of the Safe adapter: the owner set, threshold, the 65-byte `{r}{s}{v}` signature scheme, strictly-ascending order, the EIP-1271 offset-tail blob, and the deferral to the Safe's `checkSignatures` are **byte-identical** to the Safe adapter. **The ONE difference is the digest:** owners sign the Safe4337Module's *SafeOp operation hash* (its own EIP-712 domain + `SAFE_OP_TYPEHASH` over the userOp), **not** the Safe's `getTransactionHash`.

The adapter ships:

- `safe4337OperationDigest(userOp, moduleAddress, chainId)` — compute the SafeOp operation hash **locally** (viem), asserted byte-equal to the module's on-chain `getOperationHash(userOp)` read (the canonical source).
- `safe4337DomainSeparator(chainId, moduleAddress)` + `safe4337OperationData(...)` — the domain separator (verifyingContract = the **module**) and the `0x19 0x01 ‖ domainSeparator ‖ safeOpStructHash` pre-image (the `data` arg owners' EIP-1271 validators receive; `keccak256(data) === digest`).
- `makeSafe4337Adapter({ publicClient, safe, module, chainId })` → `CosignAdapter`:
  - `owners()` / `threshold()` read the **Safe** (`getOwners` / `getThreshold`) — identical to the Safe adapter (the module defers to the Safe).
  - `verify(record)` — recovers/validates one owner's signature over the **4337 operation digest** per the Safe v-byte scheme (reusing the Safe adapter's EOA recover core), and for `v==0` calls the owner's `isValidSignature(bytes data, bytes contractSignature) → 0x20c13b0b` with the **4337 `operationData` pre-image** (not the Safe-tx pre-image).
  - `order(records)` — **reuses** the Safe adapter's strictly-ascending sort + dedup (the same `order` function; it is digest-agnostic).
- `encodeSafe4337Meta` / `decodeSafe4337Meta` — round-trip the userOp + module + validity-window carried in `SignatureRecord.meta`.
- `buildSafe4337Signature(orderedRecords, validAfter, validUntil)` — assemble the **`userOp.signature` blob**: the 12-byte validity-window prefix (`abi.encodePacked(uint48 validAfter, uint48 validUntil)`) **prepended** to the ordered v-byte blob produced by the Safe adapter's `buildSignatureBlob`.

The adapter only **verifies + orders + assembles**. Building/submitting the userOp to a bundler/EntryPoint is the caller's job (cosign writes nothing on-chain). The adapter reads the chain (`getOwners`/`getThreshold`/`getOperationHash`/`isValidSignature`) and hands back the `userOp.signature` blob.

Source of truth for the digest: `safe-global/safe-modules` `modules/4337/contracts/Safe4337Module.sol` (**v0.3.0**, package `@safe-global/safe-4337@0.3.0-1`), quoted byte-exact below. Source of truth for the v-byte scheme / blob / order / EIP-1271: the already-built `packages/cosign/src/adapters/safe.ts` + its spec.

## Architecture

```
caller's signing tooling                                  caller's submit path (NOT this adapter)
   │ postSignature({ scope:`${chainId}:${module}:${safe}`, record })   ▲
   ▼                                                                   │ userOp.signature = buildSafe4337Signature(...)
cosign core: client.ts / keys.ts / record.ts                          │ → submit userOp to bundler/EntryPoint
   │ readSignatures → groupByDigest → aggregate(records, adapter)      │
   ▼                                                                   │
┌──────────────────────────  src/adapters/safe4337.ts  ─────────────────────────┐
│ makeSafe4337Adapter({ publicClient, safe, module, chainId }) : CosignAdapter   │
│   owners()    → readContract Safe.getOwners()      (same as Safe adapter)       │
│   threshold() → readContract Safe.getThreshold()   (same as Safe adapter)       │
│   verify(r)   → Safe v-byte recover over the 4337 OPERATION digest;             │
│                 v==0 → module-isValidSignature(operationData, sig) + isOwner     │
│   order(rs)   → REUSE Safe adapter's order (ascending + dedup; digest-agnostic) │
│ ── pure / helpers ──                                                            │
│   safe4337DomainSeparator / safe4337OperationDigest  (local; == getOperationHash)│
│   safe4337OperationData     (0x19 0x01 ‖ domainSep ‖ safeOpStructHash)          │
│   encodeSafe4337Meta / decodeSafe4337Meta  (userOp + module + window in meta)   │
│   buildSafe4337Signature(ordered, validAfter, validUntil) → userOp.signature    │
│      = encodePacked(uint48 validAfter, uint48 validUntil) ‖ buildSignatureBlob  │
└────────────────────────────────────────────────────────────────────────────────┘
   │ reads (viem PublicClient)                    ▲ local-vs-onchain digest parity asserted in tests
   ▼                                              │ blob byte-identical to Safe adapter (reused builders)
 the live Safe + Safe4337Module (the module's domain binds chainId + the MODULE address)
                          │ _validateSignatures → ISafe(safe).checkSignatures(keccak(opData), opData, signatures)
                          ▼
                    the Safe's checkNSignatures  ←  (same v-byte blob the Safe adapter builds)
```

**Reuse vs extract — the decision (pinned):**

- `buildSignatureBlob(ordered)` from `safe.ts` is **digest-agnostic** (it reads `record.signature` / `record.signer` / `record.scheme` only). **Reuse by import — do not duplicate.** `buildSafe4337Signature` calls it and prepends the 12-byte window.
- The adapter `order` from `makeSafeAdapter` is **digest-agnostic** (sorts by `record.signer`, dedups). The 4337 adapter's `order` **delegates to** the Safe adapter's `order` (one shared sort).
- The EOA verify core in `safe.ts` (`effectiveSigner` — recover over `record.digest` for EIP712 / `recoverMessageAddress` for ECDSA) is **digest-agnostic** but currently **not exported**. **Extract it** from `safe.ts` into an exported helper so both adapters share it (Task 1 — a no-behavior-change refactor of `safe.ts`).
- The EIP-1271 verify path differs **only** in which `data` pre-image is passed to `isValidSignature(bytes,bytes)` (`safeTransactionData` vs `safe4337OperationData`). **Extract** a shared `verifyErc1271Against(publicClient, record, owners, dataPreimage)` helper from `safe.ts` so the 4337 path injects its own pre-image (Task 1).
- `EIP1271_MAGIC_VALUE`, `SafePublicClient`, `SAFE_ABI`, and the `splitSig`/static-word logic (inside `buildSignatureBlob`) are reused via import — **not** redefined.

`safe4337DomainSeparator` / `safe4337OperationDigest` / `safe4337OperationData` / `encodeSafe4337Meta` / `decodeSafe4337Meta` / `buildSafe4337Signature` are **pure** (no I/O) and unit-tested with no chain. `owners` / `threshold` / `verify` make read-only `publicClient` calls; they are unit-tested with a **fake `PublicClient`** and end-to-end-tested against a **real Safe + Safe4337Module on anvil** (Task 6, reusing the Safe adapter's anvil/`@safe-global` fixture pattern).

## Tech Stack

- **Language / module system**: TypeScript, ESM (`"type": "module"`), `module`/`moduleResolution`: `NodeNext`. Source imports use explicit `.js` extensions — e.g. `import { buildSignatureBlob } from './safe.js'`.
- **Build**: `tsc` → `dist/` (the package's existing config; no changes).
- **Test runner**: **vitest** (`vitest run`), tests under `packages/cosign/test/adapters/`. The repo is **npm workspaces** (root `package.json` `workspaces` + `package-lock.json`; install with `npm install` from the repo root).
- **Crypto / encoding**: `viem` (`hashTypedData`, `keccak256`, `encodeAbiParameters`, `encodePacked`, `concat`, `pad`, `toHex`, `size`, `slice`, `getAddress`, `isAddressEqual`, `recoverAddress`, `recoverMessageAddress`). Already a cosign dep.
- **Integration-test deps (already devDependencies — added by the Safe adapter plan):** `@safe-global/safe-deployments` (Safe v1.4.1 artifacts), `@safe-global/safe-contracts` (`1.4.1`), `prool` (anvil-in-JS). **NEW in Task 1 of this plan:** `@safe-global/safe-4337@^0.3.0` — ships the **Safe4337Module v0.3.0 artifact** (ABI + deployed bytecode + the `AddModulesLib`/`SafeModuleSetup` enable-module helper) used by the integration fixture.
- **Why deploy-into-anvil (option a), not fork (option b):** self-contained + deterministic — no public-RPC dependency, runs in CI. The integration fixture (Task 6) extends the Safe adapter's `deploySafeFixture` to also `setCode` the published **audited** Safe4337Module runtime bytecode at its canonical address, enable it as a module + fallback handler on a fresh Safe, then asserts the board-aggregated blob is accepted by the module's `_validateSignatures` path (via `getOperationHash` + `checkSignatures`). The fork path (b) stays documented as a fallback (Task 6.6) in case `anvil` is unavailable.

---

## Canonical encodings (pin these — the digest and the `userOp.signature` framing are *law*)

All quoted byte-exact from `safe-global/safe-modules` `modules/4337/contracts/Safe4337Module.sol` (**v0.3.0**, `@safe-global/safe-4337@0.3.0-1`) and EntryPoint v0.7 (`eth-infinitism/account-abstraction@v0.7.0`).

### 1. The Safe4337Module domain separator (verifyingContract = the MODULE)

Same `DOMAIN_SEPARATOR_TYPEHASH` as the Safe — but `verifyingContract` is the **module address**, not the Safe:

```solidity
// keccak256("EIP712Domain(uint256 chainId,address verifyingContract)")
bytes32 private constant DOMAIN_SEPARATOR_TYPEHASH = 0x47e79534a245952e8b16893a336b85a3d9ea9fa8c573f3d803afb92a79469218;

function domainSeparator() public view returns (bytes32 domainSeparatorHash) {
    domainSeparatorHash = keccak256(abi.encode(DOMAIN_SEPARATOR_TYPEHASH, block.chainid, this));
}
```

`this` = the Safe4337Module contract. So `domainSeparator = keccak256(abi.encode(DOMAIN_SEPARATOR_TYPEHASH, chainId, MODULE_ADDRESS))`. **This is the single most important difference from the Safe adapter** — same typehash, **different `verifyingContract`** (module vs Safe).

### 2. The SafeOp typehash + struct (14 hashed 32-byte fields)

```solidity
// keccak256(
//   "SafeOp(address safe,uint256 nonce,bytes initCode,bytes callData,uint128 verificationGasLimit,
//    uint128 callGasLimit,uint256 preVerificationGas,uint128 maxPriorityFeePerGas,uint128 maxFeePerGas,
//    bytes paymasterAndData,uint48 validAfter,uint48 validUntil,address entryPoint)"
// ) = 0xc03dfc11d8b10bf9cf703d558958c8c42777f785d998c62060d85a4f0ef6ea7f
bytes32 private constant SAFE_OP_TYPEHASH = 0xc03dfc11d8b10bf9cf703d558958c8c42777f785d998c62060d85a4f0ef6ea7f;

struct EncodedSafeOpStruct {
    bytes32 typeHash;            // SAFE_OP_TYPEHASH
    address safe;                // userOp.sender
    uint256 nonce;               // userOp.nonce
    bytes32 initCodeHash;        // keccak256(userOp.initCode)
    bytes32 callDataHash;        // keccak256(userOp.callData)
    uint128 verificationGasLimit;// unpackHigh128(userOp.accountGasLimits)
    uint128 callGasLimit;        // unpackLow128(userOp.accountGasLimits)
    uint256 preVerificationGas;  // userOp.preVerificationGas
    uint128 maxPriorityFeePerGas;// unpackHigh128(userOp.gasFees)
    uint128 maxFeePerGas;        // unpackLow128(userOp.gasFees)
    bytes32 paymasterAndDataHash;// keccak256(userOp.paymasterAndData)
    uint48  validAfter;          // from the signature prefix
    uint48  validUntil;          // from the signature prefix
    address entryPoint;          // SUPPORTED_ENTRYPOINT (immutable on the module)
}
// safeOpStructHash = keccak256(encodedSafeOp, 448)   // 14 * 32 = 448 bytes, NO dynamic fields
```

> **Hashing rule (verified):** the struct hash is `keccak256` over **14 consecutive 32-byte words** — the typehash followed by the 13 SafeOp fields, each ABI-encoded as a 32-byte word (`bytes` fields are pre-hashed to `bytes32`, `address`/`uintN` left-padded to 32 bytes). This equals `abi.encode(SAFE_OP_TYPEHASH, safe, nonce, keccak256(initCode), keccak256(callData), verificationGasLimit, callGasLimit, preVerificationGas, maxPriorityFeePerGas, maxFeePerGas, keccak256(paymasterAndData), validAfter, validUntil, entryPoint)` then `keccak256` — which is exactly what `hashTypedData` produces for the `SafeOp` primaryType with the no-name/no-version domain.

### 3. The operation hash (what owners sign)

```solidity
function getOperationHash(PackedUserOperation calldata userOp) external view returns (bytes32 operationHash) {
    (bytes memory operationData, , , ) = _getSafeOp(userOp);
    operationHash = keccak256(operationData);
}

// inside _getSafeOp:
operationData = abi.encodePacked(bytes1(0x19), bytes1(0x01), domainSeparator(), safeOpStructHash);
```

So `digest = keccak256(0x19 ‖ 0x01 ‖ domainSeparator(module,chainId) ‖ safeOpStructHash)`. The adapter treats on-chain `getOperationHash(userOp)` as canonical; the local `safe4337OperationDigest(...)` must equal it (asserted in Task 6). With viem, this is `hashTypedData({ domain: { chainId, verifyingContract: module }, types: { SafeOp: [...] }, primaryType: 'SafeOp', message })`.

### 4. The `userOp.signature` framing (the validity-window prefix + the v-byte blob)

```solidity
// inside _getSafeOp:
bytes calldata sig = userOp.signature;
validAfter  = uint48(bytes6(sig[0:6]));
validUntil  = uint48(bytes6(sig[6:12]));
signatures  = sig[12:];
// ...
try ISafe(payable(userOp.sender)).checkSignatures(keccak256(operationData), operationData, signatures) {} ...
```

So **`userOp.signature = abi.encodePacked(uint48 validAfter, uint48 validUntil, signatures)`** — a **12-byte big-endian prefix** (6 bytes `validAfter` ‖ 6 bytes `validUntil`) followed by **exactly the same v-byte `signatures` blob the Safe adapter's `buildSignatureBlob` produces**. The module strips the 12-byte prefix and forwards `signatures` to the Safe's `checkSignatures` (which is `checkNSignatures` under the hood) — so **strictly-ascending order, the 65-byte `{r}{s}{v}` words, eth_sign `v+4`, and the EIP-1271 offset-tail layout are all identical to the Safe adapter.** `validAfter`/`validUntil` are also bound into the digest (SafeOp fields 11/12), so the prefix and the signed struct must agree.

> **`_checkSignaturesLength` (verified):** the module rejects `signatures` longer than the canonical Safe encoding (`threshold * 65` + each `v==0` tail's `32 + len`). The Safe adapter's `buildSignatureBlob` already produces exactly the canonical encoding (static `count*65` ‖ tight dynamic tails), so its output passes `_checkSignaturesLength` with no padding. No change needed — but the integration test (Task 6) asserts it.

### 5. The validity window

`validAfter` / `validUntil` are **`uint48`** (6-byte) timestamps. `validUntil == 0` means "valid forever" (per the module's `_packValidationData` semantics). The adapter encodes them big-endian into the 12-byte prefix and binds the same values into the digest. The adapter does **not** check timestamps itself (the EntryPoint does); it only ensures prefix↔digest agreement.

### 6. The `SafeOp` / userOp tuple carried in `record.meta`

The record must be self-describing: the full `PackedUserOperation` fields the digest depends on (sender, nonce, initCode, callData, accountGasLimits, preVerificationGas, gasFees, paymasterAndData) + `module` + `entryPoint` + `chainId` + `validAfter` + `validUntil`. ABI tuple — order is law:

```
(address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits,
 uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData,
 address module, address entryPoint, uint256 chainId, uint48 validAfter, uint48 validUntil)
```

> We carry the **packed** `accountGasLimits` / `gasFees` (`bytes32`) exactly as the on-chain `PackedUserOperation` does (EntryPoint v0.7), and the helper unpacks high/low 128 bits when building the SafeOp struct — matching `UserOperationLib.unpackHigh128`/`unpackLow128`. `entryPoint` is included because it is a hashed SafeOp field (= the module's immutable `SUPPORTED_ENTRYPOINT`); the digest is wrong if it drifts. `encodeSafe4337Meta` ABI-encodes the tuple; `decodeSafe4337Meta` decodes it back.

### 7. The TS userOp shape

```ts
/** EntryPoint v0.7 PackedUserOperation (the fields the SafeOp digest depends on). */
export interface Safe4337UserOp {
  sender: Hex            // the Safe
  nonce: bigint
  initCode: Hex          // 0x for an already-deployed Safe
  callData: Hex          // executeUserOp(...) calldata
  accountGasLimits: Hex  // bytes32: {uint128 verificationGasLimit}{uint128 callGasLimit}
  preVerificationGas: bigint
  gasFees: Hex           // bytes32: {uint128 maxPriorityFeePerGas}{uint128 maxFeePerGas}
  paymasterAndData: Hex  // 0x when no paymaster
}
```

`verificationGasLimit = unpackHigh128(accountGasLimits)` (first 16 bytes), `callGasLimit = unpackLow128` (last 16 bytes); `maxPriorityFeePerGas = unpackHigh128(gasFees)`, `maxFeePerGas = unpackLow128`.

---

## File structure

All paths relative to `packages/cosign/`. The package + the Safe adapter already exist; this plan **adds** `safe4337.ts` + its tests, **edits** `safe.ts` (extract two shared helpers — no behavior change), and **edits** `package.json` + `src/index.ts`.

| File | Responsibility | Task |
|---|---|---|
| `src/adapters/safe.ts` | **Edit**: export the shared EOA verify core (`recoverEffectiveSigner`) and the injectable EIP-1271 verifier (`verifyErc1271Against`); refactor `makeSafeAdapter` to use them (no behavior change). | 1 |
| `package.json` | **Edit**: add dev dep `@safe-global/safe-4337`. | 1 |
| `test/adapters/safe-shared.test.ts` | Unit: the extracted helpers behave identically (re-asserts the Safe EOA + 1271 paths through the new exported helpers). | 1 |
| `src/adapters/safe4337.ts` | The 4337 adapter: `Safe4337UserOp`, typehash consts, `safe4337DomainSeparator`/`safe4337OperationDigest`/`safe4337OperationData`, `encodeSafe4337Meta`/`decodeSafe4337Meta`, `makeSafe4337Adapter`, `buildSafe4337Signature`, the minimal module ABI fragment. | 2–5 |
| `src/index.ts` | **Edit**: re-export the 4337 adapter surface. | 5 |
| `test/adapters/safe4337-digest.test.ts` | Unit: `safe4337DomainSeparator`/`safe4337OperationDigest` (vs hand-built `0x1901…` + viem `hashTypedData`); module-vs-Safe domain divergence; sensitivity to nonce/callData/window/module; meta round-trip. | 2 |
| `test/adapters/safe4337-verify.test.ts` | Unit (fake `publicClient`): `verify` for eip712/ethSign over the 4337 digest; non-owner/wrong-digest/mismatch → false; RPC error propagates; `owners`/`threshold` read the Safe. | 3 |
| `test/adapters/safe4337-1271.test.ts` | Unit (fake `publicClient`): `verify` erc1271 via `isValidSignature(bytes,bytes)→0x20c13b0b` with the **4337 operationData** pre-image; wrong-magic → false; non-owner → false. | 3 |
| `test/adapters/safe4337-signature.test.ts` | Unit: `buildSafe4337Signature` = 12-byte window prefix ‖ Safe `buildSignatureBlob`; window bytes correct (uint48 BE); `order` delegates to the Safe sort (ascending + dedup); reuse-not-duplicate assertion (blob suffix === `buildSignatureBlob(ordered)`). | 4 |
| `test/adapters/safe4337-integration.test.ts` + `test/adapters/_safe4337-fixture.ts` | **Integration (real Safe + Safe4337Module on anvil):** enable the module, owners sign the op digest, `aggregate` → `buildSafe4337Signature`, assert local digest == on-chain `getOperationHash`, `checkSignatures(keccak(opData), opData, signatures)` accepts, and a wrong-order blob reverts `GS026`. Skip-loud if anvil absent. | 6 |

---

## Task 1 — Extract shared helpers from `safe.ts` + add the 4337 dev dep

**Goal:** Make the Safe adapter's digest-agnostic verify core reusable by the 4337 adapter **without copy-paste**, as a pure refactor (the existing Safe suites stay green — that is the proof of no-behavior-change). Add `@safe-global/safe-4337` for the Task-6 fixture.

### 1.1 Edit `packages/cosign/package.json` `devDependencies`

Add `@safe-global/safe-4337` (keep all existing entries):

```json
  "devDependencies": {
    "@safe-global/safe-4337": "^0.3.0",
    "@safe-global/safe-contracts": "1.4.1",
    "@safe-global/safe-deployments": "^1.37.0",
    "prool": "^0.0.16",
    "typescript": "^5.8.2",
    "vitest": "^3.1.1"
  }
```

### 1.2 RED — `packages/cosign/test/adapters/safe-shared.test.ts`

This pins the **new exported** helpers' behavior (so the refactor cannot silently change it). It re-derives the Safe EOA + 1271 verdicts through the extracted functions.

```ts
import { describe, expect, it, vi } from 'vitest'
import { type Hex, serializeSignature, getAddress } from 'viem'
import { privateKeyToAccount, sign, signMessage } from 'viem/accounts'
import { SCHEME, type SignatureRecord } from '../../src/record.js'
import {
  recoverEffectiveSigner,
  verifyErc1271Against,
  EIP1271_MAGIC_VALUE,
  type SafePublicClient,
} from '../../src/adapters/safe.js'

const digest = `0x${'77'.repeat(32)}` as Hex
const PK = `0x${'a'.repeat(64)}` as Hex
const acc = privateKeyToAccount(PK)

const rec = (over: Partial<SignatureRecord>): SignatureRecord => ({
  digest,
  signer: acc.address as Hex,
  signature: '0x',
  scheme: SCHEME.EIP712,
  meta: '0x',
  ...over,
})

describe('recoverEffectiveSigner (extracted EOA core — digest-agnostic)', () => {
  it('recovers an eip712 ECDSA signature over the digest', async () => {
    const signature = serializeSignature(await sign({ hash: digest, privateKey: PK }))
    const got = await recoverEffectiveSigner(rec({ scheme: SCHEME.EIP712, signature }))
    expect(getAddress(got)).toBe(getAddress(acc.address))
  })

  it('recovers an eth_sign (ECDSA) signature over the raw digest', async () => {
    const signature = await signMessage({ message: { raw: digest }, privateKey: PK })
    const got = await recoverEffectiveSigner(rec({ scheme: SCHEME.ECDSA, signature }))
    expect(getAddress(got)).toBe(getAddress(acc.address))
  })

  it('returns record.signer as-is for an EIP1271 record', async () => {
    const got = await recoverEffectiveSigner(rec({ scheme: SCHEME.EIP1271, signer: acc.address as Hex }))
    expect(getAddress(got)).toBe(getAddress(acc.address))
  })

  it('throws on a malformed signature (caller decides to map to false)', async () => {
    await expect(recoverEffectiveSigner(rec({ scheme: SCHEME.EIP712, signature: '0x1234' as Hex }))).rejects.toThrow()
  })
})

describe('verifyErc1271Against (extracted, injectable data pre-image)', () => {
  const owner = '0x0000000000000000000000000000000000000abc' as Hex
  const dataPreimage = ('0x1901' + 'ab'.repeat(32) + 'cd'.repeat(32)) as Hex
  const contractSig = '0xdeadbeef' as Hex

  const client = (magic: Hex): SafePublicClient =>
    ({
      readContract: vi.fn(async (args: { functionName: string; address: Hex; args?: readonly unknown[] }) => {
        if (args.functionName === 'isValidSignature') {
          expect(getAddress(args.address)).toBe(getAddress(owner))
          expect(args.args).toEqual([dataPreimage, contractSig]) // (bytes data, bytes signature)
          return magic
        }
        throw new Error(`unexpected: ${args.functionName}`)
      }),
    }) as SafePublicClient

  const record = (): SignatureRecord =>
    ({ digest, signer: owner, signature: contractSig, scheme: SCHEME.EIP1271, meta: '0x' })

  it('accepts when isValidSignature(bytes,bytes) returns 0x20c13b0b', async () => {
    expect(await verifyErc1271Against(client(EIP1271_MAGIC_VALUE), record(), dataPreimage)).toBe(true)
  })

  it('rejects on the wrong magic value', async () => {
    expect(await verifyErc1271Against(client('0x1626ba7e' as Hex), record(), dataPreimage)).toBe(false)
  })
})
```

Run — must fail (the helpers are not exported yet):

```bash
npm run test --workspace=packages/cosign -- safe-shared
```

**Expected:** import-resolution failure for `recoverEffectiveSigner` / `verifyErc1271Against` (RED).

### 1.3 GREEN — refactor `packages/cosign/src/adapters/safe.ts`

**(a)** Promote the private `effectiveSigner` to an **exported** `recoverEffectiveSigner` (rename only; identical body). Replace the existing private function:

```ts
// REMOVE: async function effectiveSigner(record: SignatureRecord): Promise<Hex> { ... }
// ADD (exported, body unchanged):
/**
 * The effective signer address for a record under its digest. DIGEST-AGNOSTIC — it recovers
 * over `record.digest`, so any adapter (Safe, Safe4337Module, …) reuses it unchanged:
 * - EIP712: ecrecover over the digest.
 * - ECDSA (eth_sign): recover over the personal-message-prefixed digest.
 * - EIP1271: record.signer (the contract owner) as-is.
 * Throws on a malformed signature (the caller maps the throw to a `false` verdict).
 */
export async function recoverEffectiveSigner(record: SignatureRecord): Promise<Hex> {
  if (record.scheme === SCHEME.EIP712) {
    return recoverAddress({ hash: record.digest, signature: record.signature })
  }
  if (record.scheme === SCHEME.ECDSA) {
    return recoverMessageAddress({ message: { raw: record.digest }, signature: record.signature })
  }
  return getAddress(record.signer)
}
```

Update the one caller inside `makeSafeAdapter.verify` (`effectiveSigner(record)` → `recoverEffectiveSigner(record)`).

**(b)** Extract the EIP-1271 chain call into an **exported, pre-image-injectable** helper, and have `makeSafeAdapter.verifyErc1271` call it with the Safe pre-image:

```ts
/**
 * Calls a contract owner's LEGACY EIP-1271 validator `isValidSignature(bytes data, bytes sig)`
 * and returns whether it yields the magic `0x20c13b0b`. The `dataPreimage` is injected so the
 * Safe adapter passes the Safe-tx pre-image and the Safe4337Module adapter passes the SafeOp
 * operationData pre-image — the ONLY thing that differs between the two backends. Errors propagate.
 */
export async function verifyErc1271Against(
  publicClient: SafePublicClient,
  record: SignatureRecord,
  dataPreimage: Hex,
): Promise<boolean> {
  const magic = (await publicClient.readContract({
    address: record.signer,
    abi: ISIGNATURE_VALIDATOR_ABI,
    functionName: 'isValidSignature',
    args: [dataPreimage, record.signature],
  })) as Hex
  return magic.toLowerCase() === EIP1271_MAGIC_VALUE
}
```

Then rewrite the existing `verifyErc1271` inside `makeSafeAdapter` to delegate (membership check unchanged; pre-image unchanged):

```ts
  async function verifyErc1271(record: SignatureRecord): Promise<boolean> {
    if (!(await isOwner(record.signer))) return false
    const { safeTx, safe: metaSafe, chainId: metaChainId } = decodeSafeMeta(record.meta)
    const data = safeTransactionData(safeTx, metaChainId, metaSafe)
    return verifyErc1271Against(publicClient, record, data)
  }
```

> `ISIGNATURE_VALIDATOR_ABI` is the existing private const in `safe.ts`; `verifyErc1271Against` is declared in the same module so it sees it. No new ABI is introduced. The membership (`isOwner`) check stays inside the adapter (it reads the adapter's pinned Safe), so the helper is a pure "ask the validator" call — exactly what the 4337 adapter needs (it does its own membership check against the Safe).

No other lines change. The `verify` dispatch, EOA paths, `order`, `buildSignatureBlob`, `buildExecTransactionArgs`, digest/meta helpers are untouched.

### 1.4 Install, run & verify

```bash
cd /Users/michaelmclaughlin/Documents/valve-tech/github/msgboard
npm install
npm run test --workspace=packages/cosign -- safe-shared
npm run test --workspace=packages/cosign -- safe-verify safe-1271 safe-order safe-digest safe-aggregate
npm run build --workspace=packages/cosign
```

**Expected:**
- `npm install` resolves `@safe-global/safe-4337` into the workspace.
- `safe-shared.test.ts`: all green — the extracted helpers behave as specified.
- **The existing Safe suites stay green** (this is the no-behavior-change proof: `safe-verify`, `safe-1271`, `safe-order`, `safe-digest`, `safe-aggregate` all pass unchanged).
- `tsc`: clean; `recoverEffectiveSigner` / `verifyErc1271Against` emitted in `dist/adapters/safe.d.ts`.

### 1.5 Commit

```bash
git add packages/cosign/package.json package-lock.json packages/cosign/src/adapters/safe.ts packages/cosign/test/adapters/safe-shared.test.ts
git commit -m "refactor(cosign/safe): export recoverEffectiveSigner + verifyErc1271Against (shared by 4337 adapter); add safe-4337 dev dep"
```

---

## Task 2 — `safe4337DomainSeparator`, `safe4337OperationDigest`, `safe4337OperationData`, meta codec (pure)

**Goal:** Local SafeOp digest computation (domain `verifyingContract` = the **module**) + the userOp meta codec. Pure; the integration test (Task 6) asserts `safe4337OperationDigest(...)` equals on-chain `getOperationHash(...)`. Here: determinism, the hand-built `0x1901…` parity, viem `hashTypedData` parity, sensitivity, module-vs-Safe domain divergence, and meta round-trip.

### 2.1 RED — `packages/cosign/test/adapters/safe4337-digest.test.ts`

```ts
import { describe, expect, it } from 'vitest'
import { type Hex, hashTypedData, keccak256, encodeAbiParameters, slice } from 'viem'
import {
  type Safe4337UserOp,
  safe4337DomainSeparator,
  safe4337OperationDigest,
  safe4337OperationData,
  encodeSafe4337Meta,
  decodeSafe4337Meta,
  SAFE_OP_TYPEHASH,
  SAFE4337_DOMAIN_SEPARATOR_TYPEHASH,
} from '../../src/adapters/safe4337.js'
import { safeDomain } from '../../src/adapters/safe.js'

const module_ = '0x0000000000000000000000000000000000004337' as Hex
const entryPoint = '0x0000000071727De22E5E9d8BAf0edAc6f37da032' as Hex // canonical EntryPoint v0.7
const chainId = 369
const safe = '0x1111111111111111111111111111111111111111' as Hex

// helper: pack two uint128 into a bytes32 (high||low)
function pack128(high: bigint, low: bigint): Hex {
  const h = high.toString(16).padStart(32, '0')
  const l = low.toString(16).padStart(32, '0')
  return `0x${h}${l}` as Hex
}

const userOp: Safe4337UserOp = {
  sender: safe,
  nonce: 0n,
  initCode: '0x',
  callData: '0x7bb37428', // some executeUserOp selector + args (opaque here)
  accountGasLimits: pack128(100000n, 200000n), // verificationGasLimit=100000, callGasLimit=200000
  preVerificationGas: 21000n,
  gasFees: pack128(1_000_000_000n, 2_000_000_000n), // maxPriorityFeePerGas, maxFeePerGas
  paymasterAndData: '0x',
}
const validAfter = 0
const validUntil = 0

describe('SAFE_OP typehash constants (verified from Safe4337Module v0.3.0 source)', () => {
  it('pins the domain + SafeOp typehashes', () => {
    expect(SAFE4337_DOMAIN_SEPARATOR_TYPEHASH).toBe(
      '0x47e79534a245952e8b16893a336b85a3d9ea9fa8c573f3d803afb92a79469218',
    )
    expect(SAFE_OP_TYPEHASH).toBe('0xc03dfc11d8b10bf9cf703d558958c8c42777f785d998c62060d85a4f0ef6ea7f')
  })

  it('SAFE_OP_TYPEHASH equals keccak256 of its canonical type string', () => {
    const typeString =
      'SafeOp(address safe,uint256 nonce,bytes initCode,bytes callData,uint128 verificationGasLimit,uint128 callGasLimit,uint256 preVerificationGas,uint128 maxPriorityFeePerGas,uint128 maxFeePerGas,bytes paymasterAndData,uint48 validAfter,uint48 validUntil,address entryPoint)'
    expect(keccak256(new TextEncoder().encode(typeString))).toBe(SAFE_OP_TYPEHASH)
  })
})

describe('safe4337DomainSeparator (verifyingContract == the MODULE)', () => {
  it('equals keccak256(abi.encode(typehash, chainId, module))', () => {
    const expected = keccak256(
      encodeAbiParameters(
        [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
        [SAFE4337_DOMAIN_SEPARATOR_TYPEHASH, BigInt(chainId), module_],
      ),
    )
    expect(safe4337DomainSeparator(chainId, module_)).toBe(expected)
  })

  it('DIFFERS from the Safe adapter domain (module address != Safe address)', () => {
    expect(safe4337DomainSeparator(chainId, module_)).not.toBe(safeDomain(chainId, safe))
    // but using the module address in safeDomain yields the same separator (same typehash):
    expect(safe4337DomainSeparator(chainId, module_)).toBe(safeDomain(chainId, module_))
  })
})

describe('safe4337OperationDigest', () => {
  it('is deterministic', () => {
    const a = safe4337OperationDigest(userOp, module_, entryPoint, chainId, validAfter, validUntil)
    const b = safe4337OperationDigest(userOp, module_, entryPoint, chainId, validAfter, validUntil)
    expect(a).toBe(b)
  })

  it('equals keccak256(safe4337OperationData(...))', () => {
    const data = safe4337OperationData(userOp, module_, entryPoint, chainId, validAfter, validUntil)
    expect(safe4337OperationDigest(userOp, module_, entryPoint, chainId, validAfter, validUntil)).toBe(keccak256(data))
  })

  it('equals the hand-built 0x19 0x01 domainSeparator safeOpStructHash pre-image hash', () => {
    const safeOpStructHash = keccak256(
      encodeAbiParameters(
        [
          { type: 'bytes32' }, // SAFE_OP_TYPEHASH
          { type: 'address' }, // safe
          { type: 'uint256' }, // nonce
          { type: 'bytes32' }, // keccak256(initCode)
          { type: 'bytes32' }, // keccak256(callData)
          { type: 'uint128' }, // verificationGasLimit
          { type: 'uint128' }, // callGasLimit
          { type: 'uint256' }, // preVerificationGas
          { type: 'uint128' }, // maxPriorityFeePerGas
          { type: 'uint128' }, // maxFeePerGas
          { type: 'bytes32' }, // keccak256(paymasterAndData)
          { type: 'uint48' }, // validAfter
          { type: 'uint48' }, // validUntil
          { type: 'address' }, // entryPoint
        ],
        [
          SAFE_OP_TYPEHASH,
          userOp.sender,
          userOp.nonce,
          keccak256(userOp.initCode),
          keccak256(userOp.callData),
          100000n, // unpackHigh128(accountGasLimits)
          200000n, // unpackLow128(accountGasLimits)
          userOp.preVerificationGas,
          1_000_000_000n, // unpackHigh128(gasFees)
          2_000_000_000n, // unpackLow128(gasFees)
          keccak256(userOp.paymasterAndData),
          BigInt(validAfter),
          BigInt(validUntil),
          entryPoint,
        ],
      ),
    )
    const domain = safe4337DomainSeparator(chainId, module_)
    const expected = keccak256(`0x1901${domain.slice(2)}${safeOpStructHash.slice(2)}` as Hex)
    expect(safe4337OperationDigest(userOp, module_, entryPoint, chainId, validAfter, validUntil)).toBe(expected)
  })

  it('matches viem hashTypedData with the no-name/version domain (verifyingContract = module)', () => {
    const viemDigest = hashTypedData({
      domain: { chainId, verifyingContract: module_ },
      types: {
        SafeOp: [
          { name: 'safe', type: 'address' },
          { name: 'nonce', type: 'uint256' },
          { name: 'initCode', type: 'bytes' },
          { name: 'callData', type: 'bytes' },
          { name: 'verificationGasLimit', type: 'uint128' },
          { name: 'callGasLimit', type: 'uint128' },
          { name: 'preVerificationGas', type: 'uint256' },
          { name: 'maxPriorityFeePerGas', type: 'uint128' },
          { name: 'maxFeePerGas', type: 'uint128' },
          { name: 'paymasterAndData', type: 'bytes' },
          { name: 'validAfter', type: 'uint48' },
          { name: 'validUntil', type: 'uint48' },
          { name: 'entryPoint', type: 'address' },
        ],
      },
      primaryType: 'SafeOp',
      message: {
        safe: userOp.sender,
        nonce: userOp.nonce,
        initCode: userOp.initCode,
        callData: userOp.callData,
        verificationGasLimit: 100000n,
        callGasLimit: 200000n,
        preVerificationGas: userOp.preVerificationGas,
        maxPriorityFeePerGas: 1_000_000_000n,
        maxFeePerGas: 2_000_000_000n,
        paymasterAndData: userOp.paymasterAndData,
        validAfter: BigInt(validAfter),
        validUntil: BigInt(validUntil),
        entryPoint,
      },
    })
    expect(safe4337OperationDigest(userOp, module_, entryPoint, chainId, validAfter, validUntil)).toBe(viemDigest)
  })

  it('is sensitive to nonce, callData, module, entryPoint, chainId, and the validity window', () => {
    const base = safe4337OperationDigest(userOp, module_, entryPoint, chainId, validAfter, validUntil)
    expect(safe4337OperationDigest({ ...userOp, nonce: 1n }, module_, entryPoint, chainId, validAfter, validUntil)).not.toBe(base)
    expect(safe4337OperationDigest({ ...userOp, callData: '0xdead' }, module_, entryPoint, chainId, validAfter, validUntil)).not.toBe(base)
    expect(safe4337OperationDigest(userOp, '0x0000000000000000000000000000000000009999' as Hex, entryPoint, chainId, validAfter, validUntil)).not.toBe(base)
    expect(safe4337OperationDigest(userOp, module_, '0x0000000000000000000000000000000000008888' as Hex, chainId, validAfter, validUntil)).not.toBe(base)
    expect(safe4337OperationDigest(userOp, module_, entryPoint, 1, validAfter, validUntil)).not.toBe(base)
    expect(safe4337OperationDigest(userOp, module_, entryPoint, chainId, 1, validUntil)).not.toBe(base)
    expect(safe4337OperationDigest(userOp, module_, entryPoint, chainId, validAfter, 999)).not.toBe(base)
  })
})

describe('safe4337OperationData', () => {
  it('is 0x1901 ‖ 32-byte domainSeparator ‖ 32-byte structHash (66 bytes)', () => {
    const data = safe4337OperationData(userOp, module_, entryPoint, chainId, validAfter, validUntil)
    expect(slice(data, 0, 2)).toBe('0x1901')
    expect(slice(data, 2, 34)).toBe(safe4337DomainSeparator(chainId, module_))
    // total length = 2 + 32 + 32 = 66 bytes
    expect((data.length - 2) / 2).toBe(66)
  })
})

describe('encodeSafe4337Meta / decodeSafe4337Meta', () => {
  it('round-trips userOp + module + entryPoint + chainId + window', () => {
    const meta = encodeSafe4337Meta(userOp, module_, entryPoint, chainId, validAfter, validUntil)
    const d = decodeSafe4337Meta(meta)
    expect(d.userOp).toEqual(userOp)
    expect(d.module).toBe(module_)
    expect(d.entryPoint).toBe(entryPoint)
    expect(d.chainId).toBe(chainId)
    expect(d.validAfter).toBe(validAfter)
    expect(d.validUntil).toBe(validUntil)
  })

  it('round-trips a rich userOp (non-empty initCode + paymasterAndData + non-zero window)', () => {
    const rich: Safe4337UserOp = {
      ...userOp,
      initCode: '0xabcdef',
      paymasterAndData: '0x1234567890',
      nonce: 42n,
    }
    const d = decodeSafe4337Meta(encodeSafe4337Meta(rich, module_, entryPoint, chainId, 100, 999))
    expect(d.userOp).toEqual(rich)
    expect(d.validAfter).toBe(100)
    expect(d.validUntil).toBe(999)
  })
})
```

Run — must fail (no `src/adapters/safe4337.ts`):

```bash
npm run test --workspace=packages/cosign -- safe4337-digest
```

**Expected:** import-resolution failure for `../../src/adapters/safe4337.js` (RED).

### 2.2 GREEN — create `packages/cosign/src/adapters/safe4337.ts` (digest + meta portion)

```ts
import {
  type Hex,
  encodeAbiParameters,
  decodeAbiParameters,
  hashTypedData,
  keccak256,
  slice,
} from 'viem'

/**
 * EntryPoint v0.7 PackedUserOperation — the subset of fields the SafeOp digest depends on.
 * `accountGasLimits` packs {uint128 verificationGasLimit}{uint128 callGasLimit} into bytes32;
 * `gasFees` packs {uint128 maxPriorityFeePerGas}{uint128 maxFeePerGas}. Matches UserOperationLib.
 */
export interface Safe4337UserOp {
  sender: Hex
  nonce: bigint
  initCode: Hex
  callData: Hex
  accountGasLimits: Hex
  preVerificationGas: bigint
  gasFees: Hex
  paymasterAndData: Hex
}

/** keccak256("EIP712Domain(uint256 chainId,address verifyingContract)") — same typehash as the Safe. */
export const SAFE4337_DOMAIN_SEPARATOR_TYPEHASH =
  '0x47e79534a245952e8b16893a336b85a3d9ea9fa8c573f3d803afb92a79469218' as const

/**
 * keccak256("SafeOp(address safe,uint256 nonce,bytes initCode,bytes callData,uint128 verificationGasLimit,
 * uint128 callGasLimit,uint256 preVerificationGas,uint128 maxPriorityFeePerGas,uint128 maxFeePerGas,
 * bytes paymasterAndData,uint48 validAfter,uint48 validUntil,address entryPoint)")
 * — Safe4337Module v0.3.0.
 */
export const SAFE_OP_TYPEHASH =
  '0xc03dfc11d8b10bf9cf703d558958c8c42777f785d998c62060d85a4f0ef6ea7f' as const

/** The viem typed-data `types` for a SafeOp (no EIP712Domain entry → no name/version in the domain). */
const SAFE_OP_TYPES = {
  SafeOp: [
    { name: 'safe', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'initCode', type: 'bytes' },
    { name: 'callData', type: 'bytes' },
    { name: 'verificationGasLimit', type: 'uint128' },
    { name: 'callGasLimit', type: 'uint128' },
    { name: 'preVerificationGas', type: 'uint256' },
    { name: 'maxPriorityFeePerGas', type: 'uint128' },
    { name: 'maxFeePerGas', type: 'uint128' },
    { name: 'paymasterAndData', type: 'bytes' },
    { name: 'validAfter', type: 'uint48' },
    { name: 'validUntil', type: 'uint48' },
    { name: 'entryPoint', type: 'address' },
  ],
} as const

/** unpackHigh128 — the first 16 bytes of a packed bytes32 (verificationGasLimit / maxPriorityFeePerGas). */
function unpackHigh128(packed: Hex): bigint {
  return BigInt(slice(packed, 0, 16))
}

/** unpackLow128 — the last 16 bytes of a packed bytes32 (callGasLimit / maxFeePerGas). */
function unpackLow128(packed: Hex): bigint {
  return BigInt(slice(packed, 16, 32))
}

/**
 * The Safe4337Module domain separator. NO name, NO version — only chainId + verifyingContract,
 * where verifyingContract is the MODULE address (NOT the Safe). Equals the module's on-chain
 * `domainSeparator()`: keccak256(abi.encode(DOMAIN_SEPARATOR_TYPEHASH, chainId, module)).
 */
export function safe4337DomainSeparator(chainId: number, module: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
      [SAFE4337_DOMAIN_SEPARATOR_TYPEHASH, BigInt(chainId), module],
    ),
  )
}

/**
 * The SafeOp operation digest, computed locally. Byte-equal to the module's on-chain
 * `getOperationHash(userOp)` (asserted in the integration test). The canonical source at
 * runtime is the on-chain read; this local fn is for parity checks + offline digest building.
 */
export function safe4337OperationDigest(
  userOp: Safe4337UserOp,
  module: Hex,
  entryPoint: Hex,
  chainId: number,
  validAfter: number,
  validUntil: number,
): Hex {
  return hashTypedData({
    domain: { chainId, verifyingContract: module },
    types: SAFE_OP_TYPES,
    primaryType: 'SafeOp',
    message: {
      safe: userOp.sender,
      nonce: userOp.nonce,
      initCode: userOp.initCode,
      callData: userOp.callData,
      verificationGasLimit: unpackHigh128(userOp.accountGasLimits),
      callGasLimit: unpackLow128(userOp.accountGasLimits),
      preVerificationGas: userOp.preVerificationGas,
      maxPriorityFeePerGas: unpackHigh128(userOp.gasFees),
      maxFeePerGas: unpackLow128(userOp.gasFees),
      paymasterAndData: userOp.paymasterAndData,
      validAfter: BigInt(validAfter),
      validUntil: BigInt(validUntil),
      entryPoint,
    },
  })
}

/**
 * The module's `operationData` pre-image bytes: 0x19 ‖ 0x01 ‖ domainSeparator ‖ safeOpStructHash.
 * This is the `data` argument the module passes to a contract owner's isValidSignature(bytes,bytes)
 * (via the Safe's checkSignatures), and keccak256(data) === the operation digest. Used by the
 * erc1271 verify path. The structHash is computed exactly as the module's assembly keccak over the
 * 14 32-byte words (typehash + 13 SafeOp fields).
 */
export function safe4337OperationData(
  userOp: Safe4337UserOp,
  module: Hex,
  entryPoint: Hex,
  chainId: number,
  validAfter: number,
  validUntil: number,
): Hex {
  const safeOpStructHash = keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' }, // SAFE_OP_TYPEHASH
        { type: 'address' }, // safe
        { type: 'uint256' }, // nonce
        { type: 'bytes32' }, // keccak256(initCode)
        { type: 'bytes32' }, // keccak256(callData)
        { type: 'uint128' }, // verificationGasLimit
        { type: 'uint128' }, // callGasLimit
        { type: 'uint256' }, // preVerificationGas
        { type: 'uint128' }, // maxPriorityFeePerGas
        { type: 'uint128' }, // maxFeePerGas
        { type: 'bytes32' }, // keccak256(paymasterAndData)
        { type: 'uint48' }, // validAfter
        { type: 'uint48' }, // validUntil
        { type: 'address' }, // entryPoint
      ],
      [
        SAFE_OP_TYPEHASH,
        userOp.sender,
        userOp.nonce,
        keccak256(userOp.initCode),
        keccak256(userOp.callData),
        unpackHigh128(userOp.accountGasLimits),
        unpackLow128(userOp.accountGasLimits),
        userOp.preVerificationGas,
        unpackHigh128(userOp.gasFees),
        unpackLow128(userOp.gasFees),
        keccak256(userOp.paymasterAndData),
        BigInt(validAfter),
        BigInt(validUntil),
        entryPoint,
      ],
    ),
  )
  const domain = safe4337DomainSeparator(chainId, module)
  return `0x1901${domain.slice(2)}${safeOpStructHash.slice(2)}` as Hex
}

/** The ABI tuple for record.meta: the userOp fields + module + entryPoint + chainId + window. Order is law. */
const SAFE4337_META_ABI = [
  { name: 'sender', type: 'address' },
  { name: 'nonce', type: 'uint256' },
  { name: 'initCode', type: 'bytes' },
  { name: 'callData', type: 'bytes' },
  { name: 'accountGasLimits', type: 'bytes32' },
  { name: 'preVerificationGas', type: 'uint256' },
  { name: 'gasFees', type: 'bytes32' },
  { name: 'paymasterAndData', type: 'bytes' },
  { name: 'module', type: 'address' },
  { name: 'entryPoint', type: 'address' },
  { name: 'chainId', type: 'uint256' },
  { name: 'validAfter', type: 'uint48' },
  { name: 'validUntil', type: 'uint48' },
] as const

/** ABI-encodes the userOp (+ module + entryPoint + chainId + window) for SignatureRecord.meta. */
export function encodeSafe4337Meta(
  userOp: Safe4337UserOp,
  module: Hex,
  entryPoint: Hex,
  chainId: number,
  validAfter: number,
  validUntil: number,
): Hex {
  return encodeAbiParameters(SAFE4337_META_ABI, [
    userOp.sender,
    userOp.nonce,
    userOp.initCode,
    userOp.callData,
    userOp.accountGasLimits,
    userOp.preVerificationGas,
    userOp.gasFees,
    userOp.paymasterAndData,
    module,
    entryPoint,
    BigInt(chainId),
    validAfter,
    validUntil,
  ])
}

/** Decodes record.meta back into the userOp + module + entryPoint + chainId + window. Throws on malformed input. */
export function decodeSafe4337Meta(meta: Hex): {
  userOp: Safe4337UserOp
  module: Hex
  entryPoint: Hex
  chainId: number
  validAfter: number
  validUntil: number
} {
  const [
    sender,
    nonce,
    initCode,
    callData,
    accountGasLimits,
    preVerificationGas,
    gasFees,
    paymasterAndData,
    module,
    entryPoint,
    chainId,
    validAfter,
    validUntil,
  ] = decodeAbiParameters(SAFE4337_META_ABI, meta)
  return {
    userOp: {
      sender,
      nonce,
      initCode,
      callData,
      accountGasLimits,
      preVerificationGas,
      gasFees,
      paymasterAndData,
    },
    module,
    entryPoint,
    chainId: Number(chainId),
    validAfter: Number(validAfter),
    validUntil: Number(validUntil),
  }
}
```

### 2.3 Run & verify

```bash
npm run test --workspace=packages/cosign -- safe4337-digest
```

**Expected:** all `safe4337-digest.test.ts` cases pass — typehash pins, domain separator (module address) + module-vs-Safe divergence, digest == keccak(operationData) == hand-built `0x1901…` == viem `hashTypedData`, sensitivity (nonce/callData/module/entryPoint/chainId/window), 66-byte operationData layout, meta round-trip.

### 2.4 Commit

```bash
git add packages/cosign/src/adapters/safe4337.ts packages/cosign/test/adapters/safe4337-digest.test.ts
git commit -m "feat(cosign/safe4337): safe4337 domain (module verifyingContract) + SafeOp operation digest + userOp meta codec"
```

---

## Task 3 — `makeSafe4337Adapter`: `owners`, `threshold`, `verify` (EOA + EIP-1271)

**Goal:** The 4337 adapter factory. `owners`/`threshold` read the **Safe** (the module defers to it). `verify` reuses the Safe adapter's `recoverEffectiveSigner` for EOA paths (digest-agnostic) and `verifyErc1271Against` for the `v==0` path with the **4337 operationData** pre-image. Unit-tested with a fake `publicClient` + real viem signatures.

### 3.1 RED — `packages/cosign/test/adapters/safe4337-verify.test.ts`

```ts
import { describe, expect, it, vi } from 'vitest'
import { type Hex, serializeSignature } from 'viem'
import { privateKeyToAccount, sign, signMessage } from 'viem/accounts'
import { SCHEME, type SignatureRecord } from '../../src/record.js'
import type { SafePublicClient } from '../../src/adapters/safe.js'
import {
  makeSafe4337Adapter,
  safe4337OperationDigest,
  encodeSafe4337Meta,
  type Safe4337UserOp,
} from '../../src/adapters/safe4337.js'

const module_ = '0x0000000000000000000000000000000000004337' as Hex
const entryPoint = '0x0000000071727De22E5E9d8BAf0edAc6f37da032' as Hex
const chainId = 369
const safe = '0x1111111111111111111111111111111111111111' as Hex
const validAfter = 0
const validUntil = 0

function pack128(high: bigint, low: bigint): Hex {
  return `0x${high.toString(16).padStart(32, '0')}${low.toString(16).padStart(32, '0')}` as Hex
}

const userOp: Safe4337UserOp = {
  sender: safe,
  nonce: 0n,
  initCode: '0x',
  callData: '0x7bb37428',
  accountGasLimits: pack128(100000n, 200000n),
  preVerificationGas: 21000n,
  gasFees: pack128(1n, 2n),
  paymasterAndData: '0x',
}
const digest = safe4337OperationDigest(userOp, module_, entryPoint, chainId, validAfter, validUntil)
const meta = encodeSafe4337Meta(userOp, module_, entryPoint, chainId, validAfter, validUntil)

const PK_A = `0x${'a'.repeat(64)}` as Hex
const PK_B = `0x${'b'.repeat(64)}` as Hex
const PK_C = `0x${'c'.repeat(64)}` as Hex
const ownerA = privateKeyToAccount(PK_A)
const ownerB = privateKeyToAccount(PK_B)
const ownerC = privateKeyToAccount(PK_C)

const fakeClient = (): SafePublicClient => ({
  readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
    if (functionName === 'getOwners') return [ownerA.address, ownerB.address]
    if (functionName === 'getThreshold') return 2n
    throw new Error(`unexpected readContract: ${functionName}`)
  }),
})

const rec = (over: Partial<SignatureRecord>): SignatureRecord => ({
  digest,
  signer: ownerA.address as Hex,
  signature: '0x',
  scheme: SCHEME.EIP712,
  meta,
  ...over,
})

describe('makeSafe4337Adapter.owners / threshold (read the SAFE)', () => {
  it('owners() returns the Safe getOwners()', async () => {
    const adapter = makeSafe4337Adapter({ publicClient: fakeClient(), safe, module: module_, chainId })
    expect(await adapter.owners!()).toEqual([ownerA.address, ownerB.address])
  })

  it('threshold() returns the Safe getThreshold() as a number', async () => {
    const adapter = makeSafe4337Adapter({ publicClient: fakeClient(), safe, module: module_, chainId })
    expect(await adapter.threshold!()).toBe(2)
  })
})

describe('makeSafe4337Adapter.verify — eip712 over the 4337 operation digest', () => {
  it('accepts a valid owner EIP-712 signature over the op digest', async () => {
    const adapter = makeSafe4337Adapter({ publicClient: fakeClient(), safe, module: module_, chainId })
    const signature = serializeSignature(await sign({ hash: digest, privateKey: PK_A }))
    expect(await adapter.verify(rec({ scheme: SCHEME.EIP712, signature, signer: ownerA.address as Hex }))).toBe(true)
  })

  it('rejects when recovery != claimed signer', async () => {
    const adapter = makeSafe4337Adapter({ publicClient: fakeClient(), safe, module: module_, chainId })
    const signature = serializeSignature(await sign({ hash: digest, privateKey: PK_A }))
    expect(await adapter.verify(rec({ scheme: SCHEME.EIP712, signature, signer: ownerB.address as Hex }))).toBe(false)
  })

  it('rejects a non-owner signer', async () => {
    const adapter = makeSafe4337Adapter({ publicClient: fakeClient(), safe, module: module_, chainId })
    const signature = serializeSignature(await sign({ hash: digest, privateKey: PK_C }))
    expect(await adapter.verify(rec({ scheme: SCHEME.EIP712, signature, signer: ownerC.address as Hex }))).toBe(false)
  })

  it('rejects a signature over the wrong digest', async () => {
    const adapter = makeSafe4337Adapter({ publicClient: fakeClient(), safe, module: module_, chainId })
    const wrong = serializeSignature(await sign({ hash: `0x${'00'.repeat(32)}` as Hex, privateKey: PK_A }))
    expect(await adapter.verify(rec({ scheme: SCHEME.EIP712, signature: wrong, signer: ownerA.address as Hex }))).toBe(false)
  })
})

describe('makeSafe4337Adapter.verify — ethSign (v>30) over the op digest', () => {
  it('accepts a valid owner eth_sign signature', async () => {
    const adapter = makeSafe4337Adapter({ publicClient: fakeClient(), safe, module: module_, chainId })
    const signature = await signMessage({ message: { raw: digest }, privateKey: PK_B })
    expect(await adapter.verify(rec({ scheme: SCHEME.ECDSA, signature, signer: ownerB.address as Hex }))).toBe(true)
  })
})

describe('makeSafe4337Adapter.verify — error propagation', () => {
  it('propagates an RPC error from readContract', async () => {
    const client: SafePublicClient = {
      readContract: vi.fn(async () => {
        throw new Error('rpc down')
      }),
    }
    const adapter = makeSafe4337Adapter({ publicClient: client, safe, module: module_, chainId })
    const signature = serializeSignature(await sign({ hash: digest, privateKey: PK_A }))
    await expect(
      adapter.verify(rec({ scheme: SCHEME.EIP712, signature, signer: ownerA.address as Hex })),
    ).rejects.toThrow('rpc down')
  })
})
```

### 3.2 RED — `packages/cosign/test/adapters/safe4337-1271.test.ts`

```ts
import { describe, expect, it, vi } from 'vitest'
import { type Hex, getAddress } from 'viem'
import { SCHEME, type SignatureRecord } from '../../src/record.js'
import { EIP1271_MAGIC_VALUE, type SafePublicClient } from '../../src/adapters/safe.js'
import {
  makeSafe4337Adapter,
  safe4337OperationDigest,
  safe4337OperationData,
  encodeSafe4337Meta,
  type Safe4337UserOp,
} from '../../src/adapters/safe4337.js'

const module_ = '0x0000000000000000000000000000000000004337' as Hex
const entryPoint = '0x0000000071727De22E5E9d8BAf0edAc6f37da032' as Hex
const chainId = 369
const safe = '0x1111111111111111111111111111111111111111' as Hex
const validAfter = 0
const validUntil = 0
const contractOwner = '0x0000000000000000000000000000000000000abc' as Hex
const contractSig = '0xdeadbeefdeadbeef' as Hex

function pack128(high: bigint, low: bigint): Hex {
  return `0x${high.toString(16).padStart(32, '0')}${low.toString(16).padStart(32, '0')}` as Hex
}
const userOp: Safe4337UserOp = {
  sender: safe,
  nonce: 0n,
  initCode: '0x',
  callData: '0x7bb37428',
  accountGasLimits: pack128(100000n, 200000n),
  preVerificationGas: 21000n,
  gasFees: pack128(1n, 2n),
  paymasterAndData: '0x',
}
const digest = safe4337OperationDigest(userOp, module_, entryPoint, chainId, validAfter, validUntil)
const meta = encodeSafe4337Meta(userOp, module_, entryPoint, chainId, validAfter, validUntil)

const erc1271Rec: SignatureRecord = {
  digest,
  signer: contractOwner,
  signature: contractSig,
  scheme: SCHEME.EIP1271,
  meta,
}

const fakeClient = (magic: Hex = EIP1271_MAGIC_VALUE): SafePublicClient => ({
  readContract: vi.fn(async (args: { functionName: string; address: Hex; args?: readonly unknown[] }) => {
    if (args.functionName === 'getOwners') return [contractOwner, '0x000000000000000000000000000000000000bEEF']
    if (args.functionName === 'getThreshold') return 2n
    if (args.functionName === 'isValidSignature') {
      expect(getAddress(args.address)).toBe(getAddress(contractOwner))
      // The module passes the 4337 operationData pre-image (NOT a Safe-tx pre-image).
      expect(args.args).toEqual([safe4337OperationData(userOp, module_, entryPoint, chainId, validAfter, validUntil), contractSig])
      return magic
    }
    throw new Error(`unexpected: ${args.functionName}`)
  }),
})

describe('makeSafe4337Adapter.verify — erc1271 (v==0) over the 4337 operationData', () => {
  it('accepts when isValidSignature(bytes,bytes) returns 0x20c13b0b', async () => {
    const adapter = makeSafe4337Adapter({ publicClient: fakeClient(), safe, module: module_, chainId })
    expect(await adapter.verify(erc1271Rec)).toBe(true)
  })

  it('rejects on the wrong magic', async () => {
    const adapter = makeSafe4337Adapter({ publicClient: fakeClient('0x1626ba7e' as Hex), safe, module: module_, chainId })
    expect(await adapter.verify(erc1271Rec)).toBe(false)
  })

  it('rejects an erc1271 record whose signer is not an owner', async () => {
    const adapter = makeSafe4337Adapter({ publicClient: fakeClient(), safe, module: module_, chainId })
    expect(await adapter.verify({ ...erc1271Rec, signer: '0x000000000000000000000000000000000000dEaD' as Hex })).toBe(false)
  })
})
```

Run both — must fail (no `makeSafe4337Adapter` yet):

```bash
npm run test --workspace=packages/cosign -- safe4337-verify safe4337-1271
```

**Expected:** `makeSafe4337Adapter is not a function` / import-resolution (RED).

### 3.3 GREEN — append `makeSafe4337Adapter` to `packages/cosign/src/adapters/safe4337.ts`

Add imports at the top (merge the new `viem` names + the cross-adapter imports):

```ts
import { getAddress, isAddressEqual } from 'viem' // merge into the existing top-level viem import
import type { SignatureRecord } from '../record.js'
import { SCHEME } from '../record.js'
import type { CosignAdapter } from './adapter.js'
import {
  type SafePublicClient,
  SAFE_ABI,
  recoverEffectiveSigner,
  verifyErc1271Against,
  makeSafeAdapter,
} from './safe.js'
```

Then append:

```ts
/** Config for the Safe4337Module adapter. One instance is pinned to one (chainId, safe, module). */
export interface Safe4337AdapterConfig {
  publicClient: SafePublicClient
  /** The Safe (proxy) address — the userOp.sender; owners()/threshold() read THIS. */
  safe: Hex
  /** The Safe4337Module address — the EIP-712 verifyingContract for the operation digest. */
  module: Hex
  /** The chain id — binds the digest's domain. */
  chainId: number
}

/**
 * The concrete Safe4337Module CosignAdapter (module v0.3.0, EntryPoint v0.7). A thin variant of
 * the Safe adapter: owners/threshold read the Safe; the v-byte scheme, ascending order, EIP-1271
 * offset-tail blob, and deferral to the Safe's checkSignatures are identical — the ONLY difference
 * is the digest is the module's SafeOp operation hash, so verify recovers over THAT digest and the
 * 1271 path passes the SafeOp operationData pre-image. The userOp.signature framing (validity-window
 * prefix) is assembled by buildSafe4337Signature.
 */
export function makeSafe4337Adapter(config: Safe4337AdapterConfig): CosignAdapter {
  const { publicClient, safe } = config

  // owners()/threshold() read the SAFE. Reuse the Safe adapter (it is pinned to the Safe address);
  // its `order` is digest-agnostic, so we delegate to it too.
  const safeAdapter = makeSafeAdapter({ publicClient, safe, chainId: config.chainId })

  async function owners(): Promise<Hex[]> {
    return safeAdapter.owners!()
  }

  async function threshold(): Promise<number> {
    return safeAdapter.threshold!()
  }

  async function isOwner(addr: Hex): Promise<boolean> {
    const set = await owners()
    return set.some((o) => isAddressEqual(o, addr))
  }

  async function verify(record: SignatureRecord): Promise<boolean> {
    if (record.scheme === SCHEME.EIP1271) {
      return verifyErc1271(record)
    }
    // EOA paths: recover over the 4337 operation digest (recoverEffectiveSigner is digest-agnostic).
    let recovered: Hex
    try {
      recovered = await recoverEffectiveSigner(record)
    } catch {
      return false // malformed signature is "definitively invalid", not an infra error
    }
    if (!isAddressEqual(recovered, record.signer)) return false
    return isOwner(recovered)
  }

  async function verifyErc1271(record: SignatureRecord): Promise<boolean> {
    // Membership first (cheap; a non-owner can never count regardless of the 1271 result).
    if (!(await isOwner(record.signer))) return false
    // Rebuild the exact `data` pre-image the module passes to isValidSignature(bytes,bytes):
    // 0x19 ‖ 0x01 ‖ domainSeparator(module) ‖ safeOpStructHash, whose keccak256 == record.digest.
    const { userOp, module, entryPoint, chainId, validAfter, validUntil } = decodeSafe4337Meta(record.meta)
    const data = safe4337OperationData(userOp, module, entryPoint, chainId, validAfter, validUntil)
    return verifyErc1271Against(publicClient, record, data)
  }

  // order is digest-agnostic — delegate to the Safe adapter's strictly-ascending sort + dedup.
  function order(records: SignatureRecord[]): SignatureRecord[] {
    return safeAdapter.order(records)
  }

  return { verify, order, owners, threshold }
}
```

> **`SAFE_ABI` import** is listed for symmetry / future direct reads but `owners`/`threshold`/`isOwner` are fully served by delegating to `makeSafeAdapter`. If `noUnusedLocals` flags `SAFE_ABI`, drop it from the import — the delegation needs only `makeSafeAdapter`, `recoverEffectiveSigner`, `verifyErc1271Against`, `SafePublicClient`.

### 3.4 Run & verify

```bash
npm run test --workspace=packages/cosign -- safe4337-verify safe4337-1271 safe4337-digest
```

**Expected:** `safe4337-verify.test.ts` green (owners/threshold read the Safe; eip712 accept + 3 rejects; ethSign accept; RPC-error propagation), `safe4337-1271.test.ts` green (accept on magic with the **4337 operationData** pre-image asserted, reject on wrong magic, reject non-owner), `safe4337-digest.test.ts` still green.

### 3.5 Commit

```bash
git add packages/cosign/src/adapters/safe4337.ts packages/cosign/test/adapters/safe4337-verify.test.ts packages/cosign/test/adapters/safe4337-1271.test.ts
git commit -m "feat(cosign/safe4337): makeSafe4337Adapter owners/threshold (Safe) + verify (EOA + 1271) over SafeOp digest"
```

---

## Task 4 — `buildSafe4337Signature`: the validity-window prefix + the reused v-byte blob

**Goal:** Assemble the `userOp.signature` blob: `abi.encodePacked(uint48 validAfter, uint48 validUntil)` (12 bytes) ‖ the ordered v-byte blob from the Safe adapter's `buildSignatureBlob` (**reused, not duplicated**). Unit-test the window bytes, the reuse (suffix == `buildSignatureBlob(ordered)`), and that `order` delegates to the Safe sort.

### 4.1 RED — `packages/cosign/test/adapters/safe4337-signature.test.ts`

```ts
import { describe, expect, it } from 'vitest'
import { type Hex, serializeSignature, size, slice, hexToNumber } from 'viem'
import { privateKeyToAccount, sign } from 'viem/accounts'
import { SCHEME, type SignatureRecord } from '../../src/record.js'
import { buildSignatureBlob, type SafePublicClient } from '../../src/adapters/safe.js'
import {
  makeSafe4337Adapter,
  buildSafe4337Signature,
  safe4337OperationDigest,
  encodeSafe4337Meta,
  type Safe4337UserOp,
} from '../../src/adapters/safe4337.js'

const module_ = '0x0000000000000000000000000000000000004337' as Hex
const entryPoint = '0x0000000071727De22E5E9d8BAf0edAc6f37da032' as Hex
const chainId = 369
const safe = '0x1111111111111111111111111111111111111111' as Hex

function pack128(high: bigint, low: bigint): Hex {
  return `0x${high.toString(16).padStart(32, '0')}${low.toString(16).padStart(32, '0')}` as Hex
}
const userOp: Safe4337UserOp = {
  sender: safe,
  nonce: 0n,
  initCode: '0x',
  callData: '0x7bb37428',
  accountGasLimits: pack128(100000n, 200000n),
  preVerificationGas: 21000n,
  gasFees: pack128(1n, 2n),
  paymasterAndData: '0x',
}

const PK_1 = `0x${'11'.repeat(32)}` as Hex
const PK_2 = `0x${'22'.repeat(32)}` as Hex
const PK_3 = `0x${'33'.repeat(32)}` as Hex
const acc1 = privateKeyToAccount(PK_1)
const acc2 = privateKeyToAccount(PK_2)
const acc3 = privateKeyToAccount(PK_3)

const fakeClient = (): SafePublicClient => ({
  readContract: async ({ functionName }: { functionName: string }) => {
    if (functionName === 'getOwners') return [acc1.address, acc2.address, acc3.address]
    if (functionName === 'getThreshold') return 3n
    throw new Error(`unexpected: ${functionName}`)
  },
})

async function eip712Rec(pk: Hex, signer: Hex, validAfter: number, validUntil: number): Promise<SignatureRecord> {
  const digest = safe4337OperationDigest(userOp, module_, entryPoint, chainId, validAfter, validUntil)
  return {
    digest,
    signer,
    signature: serializeSignature(await sign({ hash: digest, privateKey: pk })),
    scheme: SCHEME.EIP712,
    meta: encodeSafe4337Meta(userOp, module_, entryPoint, chainId, validAfter, validUntil),
  }
}

describe('order delegates to the Safe adapter sort (ascending + dedup)', () => {
  it('sorts strictly ascending by signer and dedups', async () => {
    const adapter = makeSafe4337Adapter({ publicClient: fakeClient(), safe, module: module_, chainId })
    const r1 = await eip712Rec(PK_1, acc1.address as Hex, 0, 0)
    const r2 = await eip712Rec(PK_2, acc2.address as Hex, 0, 0)
    const r3 = await eip712Rec(PK_3, acc3.address as Hex, 0, 0)
    const ordered = adapter.order([r3, r1, r2, { ...r1 }]) // includes a dup of r1
    expect(ordered).toHaveLength(3)
    for (let i = 1; i < ordered.length; i++) {
      expect(BigInt(ordered[i].signer) > BigInt(ordered[i - 1].signer)).toBe(true)
    }
  })
})

describe('buildSafe4337Signature', () => {
  it('prepends a 12-byte validity-window prefix (uint48 validAfter ‖ uint48 validUntil)', async () => {
    const adapter = makeSafe4337Adapter({ publicClient: fakeClient(), safe, module: module_, chainId })
    const validAfter = 0x010203
    const validUntil = 0x0a0b0c
    const ordered = adapter.order([await eip712Rec(PK_1, acc1.address as Hex, validAfter, validUntil)])
    const sig = buildSafe4337Signature(ordered, validAfter, validUntil)
    // prefix: 6 bytes validAfter (big-endian uint48) ‖ 6 bytes validUntil
    expect(slice(sig, 0, 6)).toBe('0x000000010203')
    expect(slice(sig, 6, 12)).toBe('0x0000000a0b0c')
  })

  it('the body after the 12-byte prefix is EXACTLY the Safe adapter buildSignatureBlob (reuse, not duplicate)', async () => {
    const adapter = makeSafe4337Adapter({ publicClient: fakeClient(), safe, module: module_, chainId })
    const ordered = adapter.order([
      await eip712Rec(PK_1, acc1.address as Hex, 0, 0),
      await eip712Rec(PK_2, acc2.address as Hex, 0, 0),
    ])
    const sig = buildSafe4337Signature(ordered, 0, 0)
    const expectedBlob = buildSignatureBlob(ordered)
    expect(slice(sig, 12)).toBe(expectedBlob)
    // total = 12-byte prefix + 2 * 65-byte words
    expect(size(sig)).toBe(12 + 2 * 65)
  })

  it('window of zero produces a 12-byte zero prefix', async () => {
    const adapter = makeSafe4337Adapter({ publicClient: fakeClient(), safe, module: module_, chainId })
    const ordered = adapter.order([await eip712Rec(PK_1, acc1.address as Hex, 0, 0)])
    const sig = buildSafe4337Signature(ordered, 0, 0)
    expect(slice(sig, 0, 12)).toBe('0x000000000000000000000000')
    // each ordered eip712 word ends in v 27/28
    const v = hexToNumber(slice(sig, 12 + 64, 12 + 65))
    expect(v === 27 || v === 28).toBe(true)
  })
})
```

Run — must fail (no `buildSafe4337Signature`):

```bash
npm run test --workspace=packages/cosign -- safe4337-signature
```

**Expected:** import-resolution / `buildSafe4337Signature is not a function` (RED).

### 4.2 GREEN — append `buildSafe4337Signature` to `safe4337.ts`

Add to the cross-adapter import from `./safe.js`:

```ts
import {
  type SafePublicClient,
  recoverEffectiveSigner,
  verifyErc1271Against,
  makeSafeAdapter,
  buildSignatureBlob, // ADD — reused for the v-byte blob body
} from './safe.js'
```

Add to the top-level `viem` import: `encodePacked, concat`. Then append:

```ts
/**
 * Assembles the `userOp.signature` blob the Safe4337Module expects:
 *   abi.encodePacked(uint48 validAfter, uint48 validUntil) ‖ signatures
 * where `signatures` is the strictly-ascending v-byte blob the Safe adapter's `buildSignatureBlob`
 * produces (REUSED, not duplicated). The module strips the 12-byte prefix and forwards `signatures`
 * to the Safe's checkSignatures. `validAfter`/`validUntil` MUST equal the values bound into the
 * signed digest (SafeOp fields 11/12), or validation fails.
 */
export function buildSafe4337Signature(
  ordered: SignatureRecord[],
  validAfter: number,
  validUntil: number,
): Hex {
  const prefix = encodePacked(['uint48', 'uint48'], [validAfter, validUntil])
  const signatures = buildSignatureBlob(ordered)
  return concat([prefix, signatures])
}
```

### 4.3 Run & verify

```bash
npm run test --workspace=packages/cosign -- safe4337-signature
npm run test --workspace=packages/cosign -- safe4337-verify safe4337-1271 safe4337-digest
```

**Expected:** `safe4337-signature.test.ts` green (order delegates ascending+dedup; 12-byte uint48‖uint48 prefix; body === `buildSignatureBlob(ordered)`; zero-window prefix + v 27/28 word); the Task 2/3 suites still green.

### 4.4 Commit

```bash
git add packages/cosign/src/adapters/safe4337.ts packages/cosign/test/adapters/safe4337-signature.test.ts
git commit -m "feat(cosign/safe4337): buildSafe4337Signature (validity-window prefix + reused v-byte blob)"
```

---

## Task 5 — Wire `src/index.ts` re-exports + an `aggregate`-through-adapter unit test

**Goal:** Export the 4337 adapter surface, and prove it plugs into the cosign `aggregate(records, makeSafe4337Adapter(...))` pipeline with a fake client (no chain).

### 5.1 Edit `packages/cosign/src/index.ts`

Append after the Safe adapter re-export block:

```ts
export {
  type Safe4337UserOp,
  type Safe4337AdapterConfig,
  SAFE_OP_TYPEHASH,
  SAFE4337_DOMAIN_SEPARATOR_TYPEHASH,
  safe4337DomainSeparator,
  safe4337OperationDigest,
  safe4337OperationData,
  encodeSafe4337Meta,
  decodeSafe4337Meta,
  makeSafe4337Adapter,
  buildSafe4337Signature,
} from './adapters/safe4337.js'
```

Also export the two newly-shared Safe helpers (so external callers can build other module adapters):

```ts
// add to the existing './adapters/safe.js' re-export block:
//   recoverEffectiveSigner,
//   verifyErc1271Against,
```

### 5.2 RED — `packages/cosign/test/adapters/safe4337-aggregate.test.ts`

```ts
import { describe, expect, it } from 'vitest'
import { type Hex, serializeSignature, size, slice } from 'viem'
import { privateKeyToAccount, sign } from 'viem/accounts'
import { SCHEME, type SignatureRecord } from '../../src/record.js'
import { aggregate } from '../../src/client.js'
import { type SafePublicClient } from '../../src/adapters/safe.js'
import {
  makeSafe4337Adapter,
  buildSafe4337Signature,
  safe4337OperationDigest,
  encodeSafe4337Meta,
  type Safe4337UserOp,
} from '../../src/adapters/safe4337.js'

const module_ = '0x0000000000000000000000000000000000004337' as Hex
const entryPoint = '0x0000000071727De22E5E9d8BAf0edAc6f37da032' as Hex
const chainId = 369
const safe = '0x1111111111111111111111111111111111111111' as Hex

function pack128(high: bigint, low: bigint): Hex {
  return `0x${high.toString(16).padStart(32, '0')}${low.toString(16).padStart(32, '0')}` as Hex
}
const userOp: Safe4337UserOp = {
  sender: safe,
  nonce: 0n,
  initCode: '0x',
  callData: '0x7bb37428',
  accountGasLimits: pack128(100000n, 200000n),
  preVerificationGas: 21000n,
  gasFees: pack128(1n, 2n),
  paymasterAndData: '0x',
}
const digest = safe4337OperationDigest(userOp, module_, entryPoint, chainId, 0, 0)
const meta = encodeSafe4337Meta(userOp, module_, entryPoint, chainId, 0, 0)

const PK_1 = `0x${'11'.repeat(32)}` as Hex
const PK_2 = `0x${'22'.repeat(32)}` as Hex
const PK_X = `0x${'99'.repeat(32)}` as Hex
const acc1 = privateKeyToAccount(PK_1)
const acc2 = privateKeyToAccount(PK_2)
const accX = privateKeyToAccount(PK_X)

const client: SafePublicClient = {
  readContract: async ({ functionName }: { functionName: string }) => {
    if (functionName === 'getOwners') return [acc1.address, acc2.address]
    if (functionName === 'getThreshold') return 2n
    throw new Error(`unexpected: ${functionName}`)
  },
}

async function rec(pk: Hex, signer: Hex): Promise<SignatureRecord> {
  return {
    digest,
    signer,
    signature: serializeSignature(await sign({ hash: digest, privateKey: pk })),
    scheme: SCHEME.EIP712,
    meta,
  }
}

describe('aggregate(records, makeSafe4337Adapter(...))', () => {
  it('drops the non-owner, orders ascending, and yields a window-prefixed 2×65 signature', async () => {
    const adapter = makeSafe4337Adapter({ publicClient: client, safe, module: module_, chainId })
    const records = [
      await rec(PK_2, acc2.address as Hex),
      await rec(PK_X, accX.address as Hex), // non-owner — filtered by verify
      await rec(PK_1, acc1.address as Hex),
    ]
    const ordered = await aggregate(records, adapter)
    expect(ordered).toHaveLength(2)
    expect(BigInt(ordered[1].signer) > BigInt(ordered[0].signer)).toBe(true)
    const orderedRecords = ordered.map((o) => records.find((r) => r.signer === o.signer)!)
    const sig = buildSafe4337Signature(orderedRecords, 0, 0)
    expect(slice(sig, 0, 12)).toBe('0x000000000000000000000000') // zero window
    expect(size(sig)).toBe(12 + 2 * 65)
  })
})
```

Run — RED before 5.1, GREEN after:

```bash
npm run test --workspace=packages/cosign -- safe4337-aggregate
```

### 5.3 GREEN

No new adapter source beyond 5.1's re-exports — the adapter already satisfies `CosignAdapter`; `aggregate` filters by `verify` then applies `order`.

### 5.4 Full sweep + typecheck

```bash
cd /Users/michaelmclaughlin/Documents/valve-tech/github/msgboard
npm run test --workspace=packages/cosign
npm run build --workspace=packages/cosign
```

**Expected:**
- vitest: all suites green — the new `safe4337-*` suites + `safe-shared` + every pre-existing `safe-*` and SDK-core suite. `Test Files  N passed`.
- `tsc`: clean; `dist/adapters/safe4337.{js,d.ts}` emitted; `index.d.ts` includes the 4337 exports.

### 5.5 Commit

```bash
git add packages/cosign/src/index.ts packages/cosign/test/adapters/safe4337-aggregate.test.ts
git commit -m "feat(cosign/safe4337): re-export 4337 adapter surface + aggregate-through-adapter unit test"
```

---

## Task 6 — Integration: real Safe + Safe4337Module on anvil — op digest parity + blob accepted by the module's validation

**Goal:** The demoable proof that cosign's board output is a **Safe4337Module-accepted** `userOp.signature`. Reuse the Safe adapter's `deploySafeFixture` (anvil via `prool` + `@safe-global/safe-deployments`), additionally `setCode` the published Safe4337Module v0.3.0 runtime bytecode at its canonical address and **enable it on the Safe** (module + fallback handler), have two of three owners sign the op digest, run `aggregate` → `buildSafe4337Signature`, and assert:
1. `safe4337OperationDigest(...)` (local) == `getOperationHash(userOp)` (on-chain module read) — digest parity.
2. `checkSignatures(keccak256(operationData), operationData, signatures)` on the **Safe** does **not** revert (this is exactly the call `_validateSignatures` makes; `signatures` is `slice(buildSafe4337Signature(...), 12)`).
3. A wrong-order blob reverts with `GS026`.

> **Why assert the `checkSignatures` call directly** (rather than driving a full bundler/EntryPoint round-trip): `_validateSignatures` is `onlySupportedEntryPoint` and `validateUserOp` requires the EntryPoint as caller — standing up a full v0.7 EntryPoint + bundler in a unit test is heavy and flaky. The module's own validation reduces to `ISafe(safe).checkSignatures(keccak256(operationData), operationData, signatures)` where `operationData` is exactly `getOperationHash`'s pre-image. Asserting (1) on-chain `getOperationHash` parity + (2) that the Safe accepts `(keccak(opData), opData, signatures)` proves the module would accept the blob, against the **real** audited module + Safe bytecode — no mock. (A full EntryPoint round-trip is sketched as an optional extension in 6.6.)

> **anvil availability:** `prool` shells to the local `anvil` (Foundry). The integration `describe` is guarded so it **skips with a clear message** (not a false pass) if anvil cannot start — same pattern as the Safe adapter's `safe-integration.test.ts`.

### 6.1 Helper — `packages/cosign/test/adapters/_safe4337-fixture.ts`

Extends the Safe adapter fixture: deploy the Safe stack, then inject + enable the Safe4337Module.

```ts
import {
  type Hex,
  type Address,
  parseAbi,
  encodeFunctionData,
} from 'viem'
import {
  getSafeL2SingletonDeployment,
  getSafeSingletonDeployment,
  getProxyFactoryDeployment,
  getCompatibilityFallbackHandlerDeployment,
} from '@safe-global/safe-deployments'
// Reuse the Safe adapter's anvil fixture (already in the repo from the Safe adapter plan).
import { deploySafeFixture, type SafeFixture } from './_safe-fixture.js'
// The Safe4337Module v0.3.0 artifact + the SafeModuleSetup (enableModules) helper.
import Safe4337ModuleArtifact from '@safe-global/safe-4337/build/artifacts/contracts/Safe4337Module.sol/Safe4337Module.json' assert { type: 'json' }
import SafeModuleSetupArtifact from '@safe-global/safe-4337/build/artifacts/contracts/SafeModuleSetup.sol/SafeModuleSetup.json' assert { type: 'json' }

/** Canonical EntryPoint v0.7 address (eth-infinitism). */
export const ENTRYPOINT_V07 = '0x0000000071727De22E5E9d8BAf0edAc6f37da032' as Address

export interface Safe4337Fixture extends SafeFixture {
  module: Address
  entryPoint: Address
}

const SAFE_EXEC_ABI = parseAbi([
  'function getTransactionHash(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 _nonce) view returns (bytes32)',
  'function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address payable refundReceiver,bytes signatures) payable returns (bool)',
  'function nonce() view returns (uint256)',
  'function enableModule(address module)',
  'function isModuleEnabled(address module) view returns (bool)',
])

const MODULE_SETUP_ABI = parseAbi(['function enableModules(address[] modules)'])

/**
 * Boots a Safe via the Safe adapter fixture, injects the Safe4337Module v0.3.0 runtime bytecode at a
 * deterministic address, and enables it on the Safe via a self-call `enableModule` (signed by enough
 * owners). Returns the SafeFixture plus the module + entryPoint addresses.
 *
 * NOTE: enabling a module requires a Safe transaction (execTransaction) signed by `threshold` owners.
 * We sign the enableModule SafeTx with the same owner keys used to create the Safe.
 */
export async function deploySafe4337Fixture(ownerPks: Hex[], threshold: number): Promise<Safe4337Fixture> {
  const fx = await deploySafeFixture(ownerPks, threshold)

  // 1) inject the module runtime bytecode at a fixed test address (constructor arg = entryPoint;
  //    deployedBytecode embeds the immutable, but for a checkSignatures-only assertion the module's
  //    SUPPORTED_ENTRYPOINT only matters for the SafeOp digest — we read it back via getOperationHash,
  //    so we deploy the module the canonical way: via a real CREATE so the immutable is set).
  //    Simplest deterministic path: deploy the module with `deployContract` using its creation
  //    bytecode + the entryPoint constructor arg, so SUPPORTED_ENTRYPOINT == ENTRYPOINT_V07.
  const moduleBytecode = (Safe4337ModuleArtifact as { bytecode: Hex }).bytecode
  const moduleAbi = (Safe4337ModuleArtifact as { abi: readonly unknown[] }).abi
  const moduleDeployHash = await fx.walletClient.deployContract({
    abi: moduleAbi,
    bytecode: moduleBytecode,
    args: [ENTRYPOINT_V07],
  })
  const moduleReceipt = await fx.publicClient.waitForTransactionReceipt({ hash: moduleDeployHash })
  const module = moduleReceipt.contractAddress as Address
  if (!module) throw new Error('Safe4337Module deploy failed (no contractAddress)')

  // 2) enable the module on the Safe via a Safe transaction (self-call enableModule), signed by owners.
  //    Build the enableModule SafeTx, sign with threshold owners, execTransaction.
  const { safeTransactionDigest, buildSignatureBlob } = await import('../../src/adapters/safe.js')
  const { serializeSignature, sign } = await import('viem/accounts')
  const enableData = encodeFunctionData({ abi: SAFE_EXEC_ABI, functionName: 'enableModule', args: [module] })
  const safeTx = {
    to: fx.safe,
    value: 0n,
    data: enableData,
    operation: 0,
    safeTxGas: 0n,
    baseGas: 0n,
    gasPrice: 0n,
    gasToken: '0x0000000000000000000000000000000000000000' as Hex,
    refundReceiver: '0x0000000000000000000000000000000000000000' as Hex,
    nonce: 0n,
  }
  const txDigest = safeTransactionDigest(safeTx, fx.chainId, fx.safe)
  // owners sorted ascending; sign with the first `threshold` of them
  const signers = [...fx.owners].sort((a, b) => (BigInt(a.address) < BigInt(b.address) ? -1 : 1)).slice(0, threshold)
  const ownerPkByAddr = new Map(ownerPks.map((pk) => [require('viem/accounts').privateKeyToAccount(pk).address.toLowerCase(), pk]))
  const ordered = signers.map((s) => ({
    digest: txDigest,
    signer: s.address as Hex,
    signature: '0x' as Hex, // filled below
    scheme: 2, // SCHEME.EIP712
    meta: '0x' as Hex,
  }))
  for (const r of ordered) {
    const pk = ownerPkByAddr.get(r.signer.toLowerCase())!
    r.signature = serializeSignature(await sign({ hash: txDigest, privateKey: pk }))
  }
  const blob = buildSignatureBlob(ordered)
  const enableHash = await fx.walletClient.writeContract({
    address: fx.safe,
    abi: SAFE_EXEC_ABI,
    functionName: 'execTransaction',
    args: [safeTx.to, safeTx.value, safeTx.data, safeTx.operation, safeTx.safeTxGas, safeTx.baseGas, safeTx.gasPrice, safeTx.gasToken, safeTx.refundReceiver, blob],
  })
  await fx.publicClient.waitForTransactionReceipt({ hash: enableHash })

  const enabled = (await fx.publicClient.readContract({
    address: fx.safe,
    abi: SAFE_EXEC_ABI,
    functionName: 'isModuleEnabled',
    args: [module],
  })) as boolean
  if (!enabled) throw new Error('Safe4337Module was not enabled on the Safe')

  return { ...fx, module, entryPoint: ENTRYPOINT_V07 }
}

export { SAFE_EXEC_ABI, MODULE_SETUP_ABI }
// re-export the deployments helpers so the test can introspect if needed
export {
  getSafeSingletonDeployment,
  getSafeL2SingletonDeployment,
  getProxyFactoryDeployment,
  getCompatibilityFallbackHandlerDeployment,
}
```

> **Artifact-path robustness:** the `@safe-global/safe-4337` build artifact path can vary by release. If `build/artifacts/.../Safe4337Module.json` is not present in the installed package, locate the JSON with `node -e "console.log(require.resolve('@safe-global/safe-4337/package.json'))"` then `find` the artifact, and adjust the import. The execution step (6.2 run) verifies the import resolves; if it does not, the `beforeAll` catch marks the suite skip-loud (never a false pass) and logs the resolution hint. Using `deployContract` with the **creation** bytecode (not `setCode` of runtime) ensures the module's `SUPPORTED_ENTRYPOINT` immutable is set to `ENTRYPOINT_V07` — required for `getOperationHash` to match the local digest's `entryPoint`.

### 6.2 RED — `packages/cosign/test/adapters/safe4337-integration.test.ts`

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type Hex, parseAbi, getAddress, slice } from 'viem'
import { serializeSignature, sign, privateKeyToAccount } from 'viem/accounts'
import { SCHEME, type SignatureRecord } from '../../src/record.js'
import { aggregate, groupByDigest } from '../../src/client.js'
import {
  makeSafe4337Adapter,
  buildSafe4337Signature,
  safe4337OperationDigest,
  encodeSafe4337Meta,
  type Safe4337UserOp,
} from '../../src/adapters/safe4337.js'
import { deploySafe4337Fixture, type Safe4337Fixture } from './_safe4337-fixture.js'

const MODULE_ABI = parseAbi([
  'function getOperationHash((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature) userOp) view returns (bytes32)',
])
const SAFE_CHECK_ABI = parseAbi([
  'function checkSignatures(bytes32 dataHash, bytes data, bytes signatures) view',
])

const PK_1 = `0x${'11'.repeat(32)}` as Hex
const PK_2 = `0x${'22'.repeat(32)}` as Hex
const PK_3 = `0x${'33'.repeat(32)}` as Hex

function pack128(high: bigint, low: bigint): Hex {
  return `0x${high.toString(16).padStart(32, '0')}${low.toString(16).padStart(32, '0')}` as Hex
}

let fx: Safe4337Fixture | undefined
let anvilAvailable = true

beforeAll(async () => {
  try {
    fx = await deploySafe4337Fixture([PK_1, PK_2, PK_3], 2)
  } catch (err) {
    anvilAvailable = false
    // eslint-disable-next-line no-console
    console.warn('[safe4337-integration] anvil/prool/module-artifact unavailable — skipping:', err)
  }
}, 90_000)

afterAll(async () => {
  await fx?.stop()
})

describe.runIf(() => anvilAvailable)('Safe4337Module v0.3.0 integration (real getOperationHash + checkSignatures)', () => {
  function makeUserOp(f: Safe4337Fixture): Safe4337UserOp {
    return {
      sender: f.safe,
      nonce: 0n,
      initCode: '0x',
      // executeUserOp(address,uint256,bytes,uint8) selector + a no-op call to 0xdead
      callData: '0x7bb37428000000000000000000000000000000000000000000000000000000000000dEaD' as Hex,
      accountGasLimits: pack128(100000n, 200000n),
      preVerificationGas: 21000n,
      gasFees: pack128(1n, 2n),
      paymasterAndData: '0x',
    }
  }

  it('local op digest equals on-chain module.getOperationHash', async () => {
    const f = fx!
    const userOp = makeUserOp(f)
    const validAfter = 0
    const validUntil = 0
    const local = safe4337OperationDigest(userOp, f.module, f.entryPoint, f.chainId, validAfter, validUntil)
    // For getOperationHash the module reads validAfter/validUntil from userOp.signature[0:12].
    const sigForHash = (`0x${'00'.repeat(12)}`) as Hex // window = 0,0; signatures empty is fine for the hash read
    const onChain = (await f.publicClient.readContract({
      address: f.module,
      abi: MODULE_ABI,
      functionName: 'getOperationHash',
      args: [
        {
          sender: userOp.sender,
          nonce: userOp.nonce,
          initCode: userOp.initCode,
          callData: userOp.callData,
          accountGasLimits: userOp.accountGasLimits,
          preVerificationGas: userOp.preVerificationGas,
          gasFees: userOp.gasFees,
          paymasterAndData: userOp.paymasterAndData,
          signature: sigForHash,
        },
      ],
    })) as Hex
    expect(local).toBe(onChain)
  })

  it('aggregated blob is accepted by the Safe checkSignatures over the operationData', async () => {
    const f = fx!
    const userOp = makeUserOp(f)
    const validAfter = 0
    const validUntil = 0
    const digest = safe4337OperationDigest(userOp, f.module, f.entryPoint, f.chainId, validAfter, validUntil)
    const meta = encodeSafe4337Meta(userOp, f.module, f.entryPoint, f.chainId, validAfter, validUntil)

    const records: SignatureRecord[] = []
    for (const pk of [PK_1, PK_2]) {
      records.push({
        digest,
        signer: getAddress(privateKeyToAccount(pk).address),
        signature: serializeSignature(await sign({ hash: digest, privateKey: pk })),
        scheme: SCHEME.EIP712,
        meta,
      })
    }

    const adapter = makeSafe4337Adapter({ publicClient: f.publicClient as never, safe: f.safe, module: f.module, chainId: f.chainId })
    expect((await adapter.owners!()).length).toBe(3)
    expect(await adapter.threshold!()).toBe(2)

    const perDigest = groupByDigest(records).get(digest)!
    const orderedPairs = await aggregate(perDigest, adapter)
    const orderedRecords = orderedPairs.map((p) => perDigest.find((r) => r.signer === p.signer)!)
    const fullSig = buildSafe4337Signature(orderedRecords, validAfter, validUntil)
    const signatures = slice(fullSig, 12) // strip the 12-byte window prefix (what the module forwards)

    // operationData is the pre-image; the module computes keccak256(operationData) == digest.
    const { safe4337OperationData } = await import('../../src/adapters/safe4337.js')
    const operationData = safe4337OperationData(userOp, f.module, f.entryPoint, f.chainId, validAfter, validUntil)

    await expect(
      f.publicClient.readContract({
        address: f.safe,
        abi: SAFE_CHECK_ABI,
        functionName: 'checkSignatures',
        args: [digest, operationData, signatures],
      }),
    ).resolves.toBeUndefined()
  })

  it('a wrong-order blob reverts with GS026', async () => {
    const f = fx!
    const userOp = makeUserOp(f)
    const digest = safe4337OperationDigest(userOp, f.module, f.entryPoint, f.chainId, 0, 0)
    const meta = encodeSafe4337Meta(userOp, f.module, f.entryPoint, f.chainId, 0, 0)
    const recs: SignatureRecord[] = []
    for (const pk of [PK_1, PK_2]) {
      recs.push({
        digest,
        signer: getAddress(privateKeyToAccount(pk).address),
        signature: serializeSignature(await sign({ hash: digest, privateKey: pk })),
        scheme: SCHEME.EIP712,
        meta,
      })
    }
    const adapter = makeSafe4337Adapter({ publicClient: f.publicClient as never, safe: f.safe, module: f.module, chainId: f.chainId })
    const ordered = adapter.order(recs)
    const fullSig = buildSafe4337Signature([...ordered].reverse(), 0, 0) // violate ascending
    const signatures = slice(fullSig, 12)
    const { safe4337OperationData } = await import('../../src/adapters/safe4337.js')
    const operationData = safe4337OperationData(userOp, f.module, f.entryPoint, f.chainId, 0, 0)
    await expect(
      f.publicClient.readContract({
        address: f.safe,
        abi: SAFE_CHECK_ABI,
        functionName: 'checkSignatures',
        args: [digest, operationData, signatures],
      }),
    ).rejects.toThrow(/GS026/)
  })
})
```

Run — RED until the fixture + adapter wire up and (if anvil present) the module deploys + enables:

```bash
npm run test --workspace=packages/cosign -- safe4337-integration
```

**Expected (RED):** before the fixture exists, an import error; with the fixture but any digest/blob regression, the parity or `checkSignatures` assertion fails. With everything correct + anvil present, GREEN.

### 6.3 GREEN

No new adapter source — the integration test exercises Tasks 2–5 against a real Safe + Safe4337Module. GREEN when: digest parity holds (`safe4337OperationDigest` == `getOperationHash`), the Safe accepts `(digest, operationData, signatures)`, and the reversed blob reverts `GS026`. If anvil/module-artifact is unavailable, the suite **skips** (visible warning, never a false pass).

### 6.4 Run & verify

```bash
npm run test --workspace=packages/cosign -- safe4337-integration
npm run test --workspace=packages/cosign        # full package sweep
npm run build --workspace=packages/cosign
```

**Expected:**
- `safe4337-integration.test.ts`: 3 passed (digest parity, checkSignatures accept, GS026 revert) with anvil present; or a single skip notice if not.
- Full sweep: every cosign suite green (4337 + Safe + shared + SDK core).
- `tsc`: clean.

### 6.5 Commit

```bash
git add packages/cosign/test/adapters/_safe4337-fixture.ts packages/cosign/test/adapters/safe4337-integration.test.ts
git commit -m "test(cosign/safe4337): integration — real Safe + Safe4337Module v0.3.0 on anvil, getOperationHash parity + checkSignatures accepts the blob"
```

### 6.6 Optional extension — full EntryPoint v0.7 round-trip (documented, not required)

For the strongest possible proof, stand up the canonical EntryPoint v0.7 (`@account-abstraction/contracts` or its deployed bytecode at `0x0000000071727De22E5E9d8BAf0edAc6f37da032` via `setCode`), fund the Safe, build the full `PackedUserOperation` with `signature = buildSafe4337Signature(...)`, and call `EntryPoint.handleOps([userOp], beneficiary)` — asserting it does not revert with `AA24 signature error` and the `executeUserOp` target call is observed. This is heavier (prefund, gas accounting, the module's `execTransactionFromModule` path) and is **not** needed to prove signature acceptance — the 6.2 assertions already exercise the module's exact `_validateSignatures` reduction against real bytecode. Keep it as a follow-up if a CI lane wants the end-to-end bundler flow. **Do not** weaken the 6.2 test to a mock.

---

## Self-review

### Spec / source coverage checklist

- [ ] Adapter lives at `src/adapters/safe4337.ts`; factory `makeSafe4337Adapter({ publicClient, safe, module, chainId })` → `CosignAdapter` — Tasks 3–5.
- [ ] `owners()`/`threshold()` read the **Safe** (`getOwners`/`getThreshold`) — identical to the Safe adapter; the module defers to the Safe — Task 3 (delegates to `makeSafeAdapter`).
- [ ] Digest = the module's SafeOp operation hash: domain `verifyingContract = module` (NOT the Safe), `SAFE_OP_TYPEHASH = 0xc03d…ea7f`, `DOMAIN_SEPARATOR_TYPEHASH = 0x47e7…9218`, `keccak256(0x19 0x01 ‖ domainSeparator ‖ safeOpStructHash)` — pinned + asserted local-vs-`getOperationHash` (Task 6) — Tasks 2, 6.
- [ ] The 14-word struct hash (typehash + 13 SafeOp fields; `bytes` pre-hashed; `accountGasLimits`/`gasFees` unpacked high/low 128) — verified from `EncodedSafeOpStruct` + `UserOperationLib` — Task 2.
- [ ] `verify`: EOA paths reuse `recoverEffectiveSigner` (digest-agnostic, over the op digest); `v==0` reuses `verifyErc1271Against` with the **4337 operationData** pre-image; non-owner/mismatch/wrong-digest → false; RPC error propagates — Tasks 1, 3.
- [ ] `order`: **reuses** the Safe adapter's strictly-ascending sort + dedup (GS026) — Tasks 3, 4; asserted on-chain in Task 6.
- [ ] EIP-1271 offset-tail blob + the 65-byte `{r}{s}{v}` words + eth_sign `v+4`: **reused** via `buildSignatureBlob` (no duplication) — Task 4.
- [ ] `userOp.signature` framing = `abi.encodePacked(uint48 validAfter, uint48 validUntil) ‖ signatures` — verified from `_getSafeOp`; `buildSafe4337Signature` produces it; body === `buildSignatureBlob(ordered)` — Task 4.
- [ ] `meta` = ABI userOp tuple + module + entryPoint + chainId + window; `encodeSafe4337Meta`/`decodeSafe4337Meta` round-trip — Task 2.
- [ ] Integration: `getOperationHash` parity + the module's `_validateSignatures` reduction (`checkSignatures(keccak(opData), opData, signatures)`) accepts the aggregated blob; wrong-order reverts `GS026` — Task 6.
- [ ] Out of scope: secp256r1/passkey owners; full bundler round-trip (6.6 optional); v0.6 EntryPoint (this targets v0.7 / `PackedUserOperation`, matching module v0.3.0).

### Reuse vs extract (the explicit answer the prompt asks for)

- **Reused by import (no duplication):** `buildSignatureBlob` (the entire v-byte blob + EIP-1271 offset-tail builder), the adapter `order` (via `makeSafeAdapter(...).order`), `owners`/`threshold` (via `makeSafeAdapter`), `EIP1271_MAGIC_VALUE`, `SafePublicClient`, `SAFE_ABI`.
- **Extracted from `safe.ts` in Task 1 (new exports, no behavior change):** `recoverEffectiveSigner` (was the private `effectiveSigner` — the digest-agnostic EOA recover core), and `verifyErc1271Against(publicClient, record, dataPreimage)` (the injectable EIP-1271 chain call — the ONLY 1271 difference between backends is the `data` pre-image). The Safe adapter is refactored to call both; its suites staying green proves the refactor is behavior-preserving.
- **New + 4337-specific:** `safe4337DomainSeparator` (module verifyingContract), `safe4337OperationDigest`/`safe4337OperationData` (SafeOp hashing), `encodeSafe4337Meta`/`decodeSafe4337Meta`, `buildSafe4337Signature` (the window prefix), `makeSafe4337Adapter`.

### Internal consistency

- `Safe4337UserOp` (Task 2) is the exact shape consumed by `safe4337OperationDigest`/`safe4337OperationData`/the meta codec (Task 2), `verifyErc1271` (Task 3), and every test.
- `safe4337OperationData` (Task 2) builds the pre-image used by `verifyErc1271` (Task 3) and asserted in the Task-3/6 tests.
- `recoverEffectiveSigner` + `verifyErc1271Against` (extracted Task 1) are the same functions the Safe adapter now uses and the 4337 adapter imports — one code path, two backends.
- `buildSignatureBlob` (Safe adapter) feeds `buildSafe4337Signature` (Task 4) whose suffix the Task-4 test asserts is byte-identical — proving the reuse.
- `makeSafeAdapter(...).order` (Safe adapter) is the 4337 adapter's `order` (Task 3) — proven ascending+dedup in Task 4 and on-chain in Task 6.

### Placeholder scan

Before the final commit:

```bash
grep -rnE 'TODO|FIXME|XXX|\?\?\?|placeholder|not yet implemented' packages/cosign/src/adapters/safe4337.ts packages/cosign/src/adapters/safe.ts
```

**Expected:** **no** matches — the 4337 adapter ships complete; the `safe.ts` refactor only renames/extracts.

### Deviations / decisions (called out)

1. **EntryPoint version** — this targets module **v0.3.0** + EntryPoint **v0.7** (`PackedUserOperation`, packed `accountGasLimits`/`gasFees`). Module v0.2.0 (EntryPoint v0.6, the unpacked `UserOperation` + a different `SAFE_OP_TYPEHASH`) is **out of scope**; a v0.6 variant would be a separate typehash + struct (note it but do not build it).
2. **Integration depth** — Task 6 asserts the module's exact `_validateSignatures` reduction (`getOperationHash` parity + `checkSignatures` accept) against **real** audited Safe + module bytecode, not a full bundler round-trip (6.6 documents the heavier path). This is a faithful, non-mock proof of signature acceptance.
3. **`order`/blob reuse** — rather than re-implement, the 4337 adapter delegates `order` to the Safe adapter and imports `buildSignatureBlob`; the only new framing is the 12-byte validity-window prefix. This is the "thin variant" the roadmap intends.

---

## Execution Handoff

This plan is ready to execute. It DEPENDS on the cosign SDK **and** the Safe adapter (both already built in `packages/cosign`). Two options:

- **Subagent-driven (recommended):** dispatch each task (1→6, sequential by dependency) to a fresh implementer subagent via `superpowers:subagent-driven-development`, with a review checkpoint after each commit. Each task is self-contained (RED→GREEN→commit) and leaves the suite green.
- **Inline:** execute here, task by task, pausing after each commit per `superpowers:executing-plans`.

Either way: enforce TDD (RED first, watch it fail for the right reason, then GREEN), run the exact commands shown, confirm the expected output before committing, and ensure the placeholder scan is clean before the final commit. **Task 1 is a behavior-preserving refactor of `safe.ts`** — the existing Safe suites staying green is the gate; do not proceed to Task 2 until they do. The integration test (Task 6) is the headline deliverable — a board-aggregated `userOp.signature` accepted by a **real** Safe4337Module's validation path; do not weaken it to a mock. If anvil is unavailable, install Foundry (`foundryup`) or use the documented fork fallback — but keep the test real.

Offer to begin execution of Task 1 (extract shared helpers + add the safe-4337 dev dep), or to wire the whole sequence under a subagent-driven run.
