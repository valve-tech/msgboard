# @msgboard/cosign Safe adapter Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL — `superpowers:test-driven-development`. Every task below is RED → GREEN → REFACTOR. Write the failing test first, run it, watch it fail for the *right* reason, then write the minimum code to pass. Do not skip the RED step. Do not write source before its test.

> **DEPENDS ON:** the cosign SDK plan (`docs/superpowers/plans/2026-06-13-msgboard-cosign-sdk.md`) being executed first. That plan ships `packages/cosign` with `src/keys.ts`, `src/record.ts` (the `SignatureRecord` codec + `SCHEME = { ECDSA: 0, EIP1271: 1, EIP712: 2 }`), `src/client.ts` (`BoardClient`, `postSignature`, `readSignatures`, `groupByDigest`, `aggregate`), and `src/adapters/adapter.ts` (the `CosignAdapter` interface). **This plan adds the first concrete adapter — `src/adapters/safe.ts` — on top of that core.** If `packages/cosign/src/adapters/adapter.ts` does not exist, stop and execute the SDK plan first.

## Goal

Ship `@msgboard/cosign/src/adapters/safe.ts`: the **first fully-working concrete `CosignAdapter`**, targeting Gnosis Safe v1.3.0 / v1.4.1 (byte-identical for everything we touch — §4.6 of the design spec). It turns board-shared `SignatureRecord`s into an `execTransaction`-ready `signatures` blob:

- `owners()` = `getOwners()`, `threshold()` = `getThreshold()` (read-only chain calls),
- `verify(record)` — recovers/validates one owner's signature over the `SafeTx` digest per Safe's `v`-byte scheme (EIP-712 ECDSA `v∈{27,28}`; `eth_sign` legacy `v>30`; EIP-1271 contract-owner `v==0` via the **legacy `isValidSignature(bytes,bytes) → 0x20c13b0b`** interface) and confirms owner-set membership,
- `order(records)` — sorts **strictly ascending by effective signer address**, dedups, and prepares the exact concatenated 65-byte-word blob (with EIP-1271 dynamic tails appended and `s`-offsets back-patched) that Safe's `checkNSignatures` accepts (it reverts `GS026` on wrong order / dup, `GS024` on a bad 1271 sig).

Plus three pure/helper exports the caller needs end-to-end:

- `safeDomain(chainId, safe)` + `safeTransactionDigest(safeTx, chainId, safe)` — compute the EIP-712 digest **locally** (viem `hashTypedData`, no-name/no-version domain), asserted byte-equal to the on-chain `getTransactionHash(...)` read (the canonical source).
- `encodeSafeMeta` / `decodeSafeMeta` — round-trip the full `SafeTx` tuple (+ `safe`, `chainId`) carried in `SignatureRecord.meta`.
- `buildSignatureBlob(orderedRecords)` — concatenate ordered words + append/patch 1271 tails → the final `Hex` blob.
- `buildExecTransactionArgs(orderedRecords, safeTx)` — produce the exact positional args for `execTransaction`, so a caller goes `records → aggregate → buildExecTransactionArgs → writeContract`.

The adapter only **verifies + orders**. Building and submitting the on-chain `execTransaction` is the caller's job (cosign writes nothing on-chain); the adapter reads the chain (`getOwners`/`getThreshold`/`getTransactionHash`/`isValidSignature`) and hands back the blob + args.

Source of truth for behavior: `docs/superpowers/specs/2026-06-13-msgboard-cosign-safe-adapter-design.md`. This plan implements exactly that spec. Every Safe detail below is quoted from `safe-global/safe-smart-account` at tag **v1.4.1** (`contracts/Safe.sol`, `contracts/base/OwnerManager.sol`, `contracts/common/SignatureDecoder.sol`, `contracts/interfaces/ISignatureValidator.sol`, `contracts/proxies/SafeProxyFactory.sol`) and cross-checked byte-identical at v1.3.0.

## Architecture

```
caller's signing tooling                                          caller's execute path (NOT this adapter)
        │ postSignature({ scope:`${chainId}:${safe}`, record })          ▲
        ▼                                                                │ writeContract('execTransaction', args)
   cosign core (SDK plan): client.ts / keys.ts / record.ts               │
        │ readSignatures → groupByDigest → aggregate(records, adapter)   │
        ▼                                                                │
   ┌─────────────────────────  src/adapters/safe.ts  ─────────────────────────┐
   │ makeSafeAdapter({ publicClient, safe, chainId }) : CosignAdapter          │
   │   owners()    → readContract getOwners()                                  │
   │   threshold() → readContract getThreshold()                               │
   │   verify(r)   → v-scheme recover / isValidSignature(bytes,bytes) + isOwner│
   │   order(rs)   → sort ↑ by effective signer, dedup, prepare words+tails    │
   │ ── pure / helpers ──                                                      │
   │   safeDomain / safeTransactionDigest   (local EIP-712, == getTransactionHash)│
   │   encodeSafeMeta / decodeSafeMeta      (SafeTx tuple in record.meta)      │
   │   buildSignatureBlob(ordered) → Hex    (static words ‖ dynamic 1271 tails)│
   │   buildExecTransactionArgs(ordered, safeTx) → execTransaction args tuple  │
   └──────────────────────────────────────────────────────────────────────────┘
        │ reads (viem PublicClient)                          ▲ local-vs-onchain digest parity asserted in tests
        ▼                                                    │
   the live Safe (any chain; digest binds chainId + safe via the domain)
```

`safeDomain` / `safeTransactionDigest` / `encodeSafeMeta` / `decodeSafeMeta` / `buildSignatureBlob` / `buildExecTransactionArgs` are **pure** (no I/O) and unit-tested with no chain. `owners` / `threshold` / `verify` make read-only `publicClient` calls; they are unit-tested with a **fake `PublicClient`** (stubbed `readContract`) and end-to-end-tested against a **real Safe on a local anvil** (the integration test, Task 7).

## Tech Stack

- **Language / module system**: TypeScript, ESM (`"type": "module"`), `module`/`moduleResolution`: `NodeNext`. Source imports use explicit `.js` extensions (NodeNext requirement) — e.g. `import { decodeRecord } from '../record.js'`.
- **Build**: `tsc` → `dist/` (the package's existing config from the SDK plan; no changes).
- **Test runner**: **vitest** (`vitest run`), tests in `packages/cosign/test/` (the package convention from the SDK plan; this plan adds files under `test/adapters/`). The repo is **npm workspaces** (NOT pnpm — root `package.json` has a `workspaces` array + `package-lock.json`; install with `npm install` from the repo root).
- **Crypto / encoding**: `viem` (`recoverAddress`, `recoverMessageAddress`, `hashTypedData`, `encodeAbiParameters`, `decodeAbiParameters`, `encodePacked`, `pad`, `toHex`, `concat`, `size`, `slice`, `getAddress`, `isAddressEqual`). Already a cosign dep.
- **Integration-test deps (devDependencies, added in Task 1)**:
  - `@safe-global/safe-deployments` (`^1.37.0`) — ships the **canonical Safe v1.4.1 artifacts** (ABI + deployed bytecode + `defaultAddress`) for the singleton, proxy factory, and `CompatibilityFallbackHandler`. We deploy those exact artifacts into a fresh chain.
  - `prool` (`^0.0.16`) — spins an **anvil** instance from JS so the integration test is self-contained inside vitest (no external `anvil` process to manage). `prool` shells out to the locally-installed `anvil` (Foundry — confirmed present on the dev machine at `~/.foundry/bin/anvil`).
  - viem's `createTestClient` + `setCode` set the Safe artifacts' runtime bytecode at the canonical addresses, then `setup` is called to initialize a real Safe. (Deterministic, no network, no fork.)

> **Why deploy-into-anvil (option a), not fork (option b):** option (a) is fully self-contained and deterministic — no public-RPC dependency, no pinned-block flakiness, runs in CI. We deploy the **published, audited** Safe v1.4.1 runtime bytecode from `@safe-global/safe-deployments` (the same bytecode at `0x41675C099F32341bf84BFc5382aF534df5C7461a` on mainnet/PulseChain-369 et al.), so the blob is verified against the **real** `checkNSignatures`, not a mock. The fork path (b) stays documented as a fallback in the integration-test task in case `anvil` is unavailable on a given runner.

> **viem version note:** `setCode` / `getCode` are the viem 2.x names (older docs say `setBytecode` / `getBytecode`; both are aliased in 2.25, but use `setCode`/`getCode`). If a runner pins an older 2.x, the alias still resolves.

---

## Canonical encodings (pin these — the blob and the digest are *law*; Safe reverts otherwise)

These are verified byte-exact from Safe v1.4.1 source. Any drift makes `checkNSignatures` revert on-chain.

### 1. The `SafeTx` EIP-712 digest

Domain has **NO `name`, NO `version`** — only `chainId` + `verifyingContract`:

```
EIP712Domain(uint256 chainId,address verifyingContract)
// DOMAIN_SEPARATOR_TYPEHASH = 0x47e79534a245952e8b16893a336b85a3d9ea9fa8c573f3d803afb92a79469218
// domainSeparator() = keccak256(abi.encode(DOMAIN_SEPARATOR_TYPEHASH, chainId, address(this)))
```

`verifyingContract` = the Safe (proxy) address. The struct type:

```
SafeTx(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 nonce)
// SAFE_TX_TYPEHASH = 0xbb8310d486368db6bd6f849402fdd73ad53d316b5a4b2644ad6efe0f941286d8
```

The digest is `getTransactionHash(...)` = `keccak256(0x19 ‖ 0x01 ‖ domainSeparator ‖ safeTxHash)`. **It is nonce-bound** (the 10th field) and **chain+Safe-bound** (the domain). The adapter treats the on-chain `getTransactionHash(...)` read as canonical; the local `safeTransactionDigest(...)` must equal it (asserted in tests). With viem, the no-name/no-version domain is expressed by passing a `domain` object with only `{ chainId, verifyingContract }` to `hashTypedData` (viem omits absent domain fields from `EIP712Domain`, producing exactly Safe's typehash).

### 2. The `v`-byte signature scheme (from `Safe.sol::checkNSignatures`)

Each signature word is **65 bytes**, compact `{bytes32 r}{bytes32 s}{uint8 v}` (`SignatureDecoder.signatureSplit`). Branch on `v`:

| `v` | Scheme | How the adapter verifies | How `order` emits the word | cosign `scheme` |
|---|---|---|---|---|
| `27`/`28` | EIP-712 ECDSA | `recoverAddress({ hash: digest, signature })` | `{r}{s}{v}` straight from the 65-byte sig | `EIP712` (2) |
| `> 30` | `eth_sign` legacy | `recoverMessageAddress({ message: { raw: digest }, signature })` (viem applies `"\x19Ethereum Signed Message:\n32" ‖ digest`) | `{r}{s}{v+4}` — wallet yields v∈{27,28} over the prefixed hash; Safe does `ecrecover(prefixed, v-4, …)`, so we add 4 | `ECDSA` (0) + `v>30` byte |
| `0` | EIP-1271 contract owner | call **`isValidSignature(bytes data, bytes contractSignature) → 0x20c13b0b`** on `record.signer`, passing the **full `encodeTransactionData` pre-image** as `data` | `{r = left-pad(signer,32)}{s = byte-offset to tail}{v = 0x00}`; tail `{uint256 len}{contractSignature}` appended in the dynamic region | `EIP1271` (1) |
| `1` | approved hash (on-chain) | **IGNORED** — cosign never aggregates a `v==1` word (§2 of spec) | n/a | — |
| `2` | secp256r1 / passkey | out of scope (§12 of spec) | n/a | — |

### 3. The CRITICAL EIP-1271 detail (the single most error-prone part — verified from source)

`checkNSignatures` for `v==0` calls **`ISignatureValidator(currentOwner).isValidSignature(data, contractSignature) == EIP1271_MAGIC_VALUE`** where, from `contracts/interfaces/ISignatureValidator.sol`:

```solidity
// bytes4(keccak256("isValidSignature(bytes,bytes)"))
bytes4 internal constant EIP1271_MAGIC_VALUE = 0x20c13b0b;
function isValidSignature(bytes memory _data, bytes memory _signature) public view virtual returns (bytes4);
```

This is the **LEGACY `bytes,bytes` interface returning `0x20c13b0b`**, and it is passed the **full `data` pre-image** (the `encodeTransactionData` bytes), **NOT** the 32-byte hash. It is **NOT** the newer `isValidSignature(bytes32,bytes) → 0x1626ba7e` (that is what a Safe's `CompatibilityFallbackHandler` exposes when a Safe is queried *as* a 1271 signer by third parties). The adapter MUST mirror the on-chain path: verify a `v==0` owner by calling `isValidSignature(bytes data, bytes contractSignature)` and requiring `0x20c13b0b`. (The design spec §4.3 calls this out as an explicit correction to the prompt's stated fact; this plan implements the verified-from-source version.)

`checkNSignatures` also requires `keccak256(data) == dataHash` (GS027) when any `v==0` word is present — so `data` passed to `execTransaction` must be the exact `encodeTransactionData` pre-image whose keccak is the digest. `buildExecTransactionArgs` does not pass `data`/`dataHash` (those are internal to `execTransaction`), but the adapter's local `data` pre-image (for the 1271 `verify` call) is built identically: `0x19 ‖ 0x01 ‖ domainSeparator ‖ safeTxHash`.

### 4. The EIP-1271 offset-tail blob layout (`v==0`)

```
signatures = [ static region: count × 65-byte words ] ‖ [ dynamic region: per-1271-owner {uint256 len}{bytes sig} ]
```

- Static region: one 65-byte word per signer, in **strictly ascending** owner order. A contract owner's word is `{r = left-pad32(owner)}{s = offset}{v = 0x00}`.
- Dynamic region: for each contract owner (same ascending order), append `{uint256 length}{contractSignature bytes}`. That owner's static-word `s` is the **byte offset from the start of `signatures`** to its length word.
- First tail offset = `count × 65`. Each subsequent offset accumulates `32 + len` of the prior tail.
- Safe bounds checks: `s >= count*65` (GS021), `s + 32 <= signatures.length` (GS022), `s + 32 + len <= signatures.length` (GS023).

### 5. The `SafeTx` tuple carried in `record.meta`

ABI tuple — order is law:

```
(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 nonce, address safe, uint256 chainId)
```

The trailing `safe` + `chainId` make a record self-describing (the archivist + cross-checks use them). `encodeSafeMeta(safeTx, safe, chainId)` ABI-encodes it; `decodeSafeMeta(meta)` decodes it back to `{ safeTx, safe, chainId }`.

---

## File structure

All paths relative to `packages/cosign/`. (The package itself is created by the SDK plan; this plan only **adds** the files below and edits `package.json` + `src/index.ts`.)

| File | Responsibility | Task |
|---|---|---|
| `package.json` | **Edit**: add dev deps `@safe-global/safe-deployments`, `prool`. | 1 |
| `src/adapters/safe.ts` | The Safe adapter: types, `safeDomain`, `safeTransactionDigest`, `encodeSafeMeta`/`decodeSafeMeta`, `makeSafeAdapter`, `buildSignatureBlob`, `buildExecTransactionArgs`, the minimal Safe ABI fragment. | 2–6 |
| `src/index.ts` | **Edit**: re-export the Safe adapter surface. | 6 |
| `test/adapters/safe-digest.test.ts` | Unit: `safeDomain`/`safeTransactionDigest` + `encodeSafeMeta`/`decodeSafeMeta` round-trip; digest determinism + chain/safe/nonce sensitivity. | 2 |
| `test/adapters/safe-verify.test.ts` | Unit (fake `publicClient`): `verify` for `eip712`/`ethSign` (real viem sign + recover), non-owner/wrong-digest/signer-mismatch → false, RPC error → propagates; `owners`/`threshold`. | 3 |
| `test/adapters/safe-order.test.ts` | Unit (fake `publicClient`): `order` sorts strictly ascending + dedups; `buildSignatureBlob` static-word layout for EOA; `buildExecTransactionArgs` arg tuple. | 4 |
| `test/adapters/safe-1271.test.ts` | Unit (fake `publicClient`): `verify` `erc1271` via `isValidSignature(bytes,bytes)→0x20c13b0b` (stub call), wrong-magic → false; `buildSignatureBlob` offset-tail layout + back-patched `s`; mixed EOA+1271 blob byte-layout assertions. | 5 |
| `test/adapters/safe-integration.test.ts` | **Integration (real Safe on anvil via prool + safe-deployments):** deploy singleton+factory+fallback, create a 2-of-3 Safe, owners sign the digest, `aggregate` → `buildSignatureBlob` → `checkNSignatures` accepts + `execTransaction` succeeds (`ExecutionSuccess`, nonce++); negative blobs revert with `GS026`. | 7 |

---

## Task 1 — Add integration-test dev deps

**Goal:** `@safe-global/safe-deployments` (Safe v1.4.1 artifacts) and `prool` (anvil-in-JS) are installed so the integration test (Task 7) is self-contained. No source changes; verified by a tiny artifact-load smoke test.

### 1.1 Edit `packages/cosign/package.json` `devDependencies`

Add (keep the existing `typescript` / `vitest` from the SDK plan):

```json
  "devDependencies": {
    "@safe-global/safe-deployments": "^1.37.0",
    "prool": "^0.0.16",
    "typescript": "^5.8.2",
    "vitest": "^3.1.1"
  }
```

### 1.2 RED — `packages/cosign/test/adapters/safe-integration-deps.test.ts`

This proves the artifacts resolve and carry deployed bytecode (the integration test depends on it). Keep it tiny; it is removed/absorbed when Task 7 lands.

```ts
import { describe, expect, it } from 'vitest'
import { getSafeSingletonDeployment, getProxyFactoryDeployment } from '@safe-global/safe-deployments'

describe('safe-deployments v1.4.1 artifacts', () => {
  it('ships singleton + proxy factory artifacts with deployed bytecode', () => {
    const singleton = getSafeSingletonDeployment({ version: '1.4.1' })
    const factory = getProxyFactoryDeployment({ version: '1.4.1' })
    expect(singleton).toBeTruthy()
    expect(factory).toBeTruthy()
    // deployedBytecode is what we set via anvil setCode in Task 7.
    expect(singleton!.deployedBytecode).toMatch(/^0x[0-9a-f]+$/)
    expect(factory!.deployedBytecode).toMatch(/^0x[0-9a-f]+$/)
    // canonical singleton address (mainnet/PulseChain-369/etc.)
    expect(singleton!.defaultAddress).toBe('0x41675C099F32341bf84BFc5382aF534df5C7461a')
  })
})
```

### 1.3 Install & run

```bash
cd /Users/michaelmclaughlin/Documents/valve-tech/github/msgboard
npm install
npm run test --workspace=packages/cosign -- safe-integration-deps
```

**Expected:**
- `npm install` resolves `@safe-global/safe-deployments` + `prool` into the workspace.
- vitest: `Test Files  1 passed (1)` / `Tests  1 passed (1)` — the singleton/factory artifacts load and the canonical address matches.

> If `getSafeSingletonDeployment` is undefined for `'1.4.1'`, the installed `@safe-global/safe-deployments` is too old; bump to a version whose changelog lists Safe 1.4.1 (≥ `1.34.0`). The `^1.37.0` pin includes it.

### 1.4 Commit

```bash
git add packages/cosign/package.json package-lock.json packages/cosign/test/adapters/safe-integration-deps.test.ts
git commit -m "test(cosign/safe): add safe-deployments + prool dev deps; assert v1.4.1 artifacts load"
```

---

## Task 2 — `safeDomain`, `safeTransactionDigest`, `encodeSafeMeta`/`decodeSafeMeta` (pure)

**Goal:** Local EIP-712 digest computation (no-name/no-version domain) + the `SafeTx` meta codec. These are pure functions; the integration test (Task 7) asserts `safeTransactionDigest(...)` equals the on-chain `getTransactionHash(...)`. Here we assert determinism, sensitivity, and round-trip.

### 2.1 RED — `packages/cosign/test/adapters/safe-digest.test.ts`

```ts
import { describe, expect, it } from 'vitest'
import { type Hex, hashTypedData, keccak256, encodeAbiParameters } from 'viem'
import {
  type SafeTx,
  safeDomain,
  safeTransactionDigest,
  encodeSafeMeta,
  decodeSafeMeta,
  SAFE_TX_TYPEHASH,
  DOMAIN_SEPARATOR_TYPEHASH,
} from '../../src/adapters/safe.js'

const safe = '0x1111111111111111111111111111111111111111' as Hex
const chainId = 369

const tx: SafeTx = {
  to: '0x2222222222222222222222222222222222222222',
  value: 0n,
  data: '0x',
  operation: 0,
  safeTxGas: 0n,
  baseGas: 0n,
  gasPrice: 0n,
  gasToken: '0x0000000000000000000000000000000000000000',
  refundReceiver: '0x0000000000000000000000000000000000000000',
  nonce: 0n,
}

describe('SAFE typehash constants (verified from Safe v1.4.1 source)', () => {
  it('pins the domain + SafeTx typehashes', () => {
    expect(DOMAIN_SEPARATOR_TYPEHASH).toBe(
      '0x47e79534a245952e8b16893a336b85a3d9ea9fa8c573f3d803afb92a79469218',
    )
    expect(SAFE_TX_TYPEHASH).toBe(
      '0xbb8310d486368db6bd6f849402fdd73ad53d316b5a4b2644ad6efe0f941286d8',
    )
  })

  it('the typehashes equal keccak256 of their canonical type strings', () => {
    expect(keccak256(new TextEncoder().encode('EIP712Domain(uint256 chainId,address verifyingContract)'))).toBe(
      DOMAIN_SEPARATOR_TYPEHASH,
    )
    expect(
      keccak256(
        new TextEncoder().encode(
          'SafeTx(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 nonce)',
        ),
      ),
    ).toBe(SAFE_TX_TYPEHASH)
  })
})

describe('safeDomain', () => {
  it('equals the on-chain domainSeparator pre-image (no name/version)', () => {
    // domainSeparator() = keccak256(abi.encode(DOMAIN_SEPARATOR_TYPEHASH, chainId, this))
    const expected = keccak256(
      encodeAbiParameters(
        [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
        [DOMAIN_SEPARATOR_TYPEHASH, BigInt(chainId), safe],
      ),
    )
    expect(safeDomain(chainId, safe)).toBe(expected)
  })
})

describe('safeTransactionDigest', () => {
  it('is deterministic', () => {
    expect(safeTransactionDigest(tx, chainId, safe)).toBe(safeTransactionDigest(tx, chainId, safe))
  })

  it('equals the hand-built 0x19 0x01 domainSeparator safeTxHash pre-image hash', () => {
    const safeTxHash = keccak256(
      encodeAbiParameters(
        [
          { type: 'bytes32' }, // SAFE_TX_TYPEHASH
          { type: 'address' }, // to
          { type: 'uint256' }, // value
          { type: 'bytes32' }, // keccak256(data)
          { type: 'uint8' }, // operation
          { type: 'uint256' }, // safeTxGas
          { type: 'uint256' }, // baseGas
          { type: 'uint256' }, // gasPrice
          { type: 'address' }, // gasToken
          { type: 'address' }, // refundReceiver
          { type: 'uint256' }, // nonce
        ],
        [
          SAFE_TX_TYPEHASH,
          tx.to,
          tx.value,
          keccak256(tx.data),
          tx.operation,
          tx.safeTxGas,
          tx.baseGas,
          tx.gasPrice,
          tx.gasToken,
          tx.refundReceiver,
          tx.nonce,
        ],
      ),
    )
    const domain = safeDomain(chainId, safe)
    const expected = keccak256(`0x1901${domain.slice(2)}${safeTxHash.slice(2)}` as Hex)
    expect(safeTransactionDigest(tx, chainId, safe)).toBe(expected)
  })

  it('matches viem hashTypedData with the no-name/version domain', () => {
    const viemDigest = hashTypedData({
      domain: { chainId, verifyingContract: safe },
      types: {
        SafeTx: [
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'data', type: 'bytes' },
          { name: 'operation', type: 'uint8' },
          { name: 'safeTxGas', type: 'uint256' },
          { name: 'baseGas', type: 'uint256' },
          { name: 'gasPrice', type: 'uint256' },
          { name: 'gasToken', type: 'address' },
          { name: 'refundReceiver', type: 'address' },
          { name: 'nonce', type: 'uint256' },
        ],
      },
      primaryType: 'SafeTx',
      message: { ...tx },
    })
    expect(safeTransactionDigest(tx, chainId, safe)).toBe(viemDigest)
  })

  it('is sensitive to chainId, safe, and nonce', () => {
    const base = safeTransactionDigest(tx, chainId, safe)
    expect(safeTransactionDigest(tx, 1, safe)).not.toBe(base)
    expect(safeTransactionDigest(tx, chainId, '0x3333333333333333333333333333333333333333')).not.toBe(base)
    expect(safeTransactionDigest({ ...tx, nonce: 1n }, chainId, safe)).not.toBe(base)
  })

  it('is sensitive to non-empty data', () => {
    expect(safeTransactionDigest({ ...tx, data: '0xdeadbeef' }, chainId, safe)).not.toBe(
      safeTransactionDigest(tx, chainId, safe),
    )
  })
})

describe('encodeSafeMeta / decodeSafeMeta', () => {
  it('round-trips the SafeTx tuple + safe + chainId', () => {
    const meta = encodeSafeMeta(tx, safe, chainId)
    const decoded = decodeSafeMeta(meta)
    expect(decoded.safe).toBe(safe)
    expect(decoded.chainId).toBe(chainId)
    expect(decoded.safeTx).toEqual(tx)
  })

  it('round-trips a tx with non-empty data + non-zero gas fields', () => {
    const rich: SafeTx = {
      ...tx,
      data: '0xabcdef',
      value: 123n,
      operation: 1,
      safeTxGas: 21000n,
      baseGas: 5000n,
      gasPrice: 7n,
      gasToken: '0x4444444444444444444444444444444444444444',
      refundReceiver: '0x5555555555555555555555555555555555555555',
      nonce: 9n,
    }
    expect(decodeSafeMeta(encodeSafeMeta(rich, safe, chainId)).safeTx).toEqual(rich)
  })
})
```

Run — must fail (no `src/adapters/safe.ts`):

```bash
npm run test --workspace=packages/cosign -- safe-digest
```

**Expected:** import-resolution failure for `../../src/adapters/safe.js` (RED).

### 2.2 GREEN — create `packages/cosign/src/adapters/safe.ts` (digest + meta portion)

```ts
import {
  type Hex,
  encodeAbiParameters,
  decodeAbiParameters,
  hashTypedData,
  keccak256,
} from 'viem'

/**
 * The Safe transaction tuple that is EIP-712-signed and carried in SignatureRecord.meta.
 * Field order matches Safe's encodeTransactionData / SAFE_TX_TYPEHASH exactly.
 */
export interface SafeTx {
  to: Hex
  value: bigint
  data: Hex
  /** Enum.Operation: 0 = Call, 1 = DelegateCall. */
  operation: number
  safeTxGas: bigint
  baseGas: bigint
  gasPrice: bigint
  gasToken: Hex
  refundReceiver: Hex
  nonce: bigint
}

/** keccak256("EIP712Domain(uint256 chainId,address verifyingContract)") — Safe v1.4.1 (== v1.3.0). */
export const DOMAIN_SEPARATOR_TYPEHASH =
  '0x47e79534a245952e8b16893a336b85a3d9ea9fa8c573f3d803afb92a79469218' as const

/**
 * keccak256("SafeTx(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,
 * uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 nonce)")
 * — Safe v1.4.1 (== v1.3.0).
 */
export const SAFE_TX_TYPEHASH =
  '0xbb8310d486368db6bd6f849402fdd73ad53d316b5a4b2644ad6efe0f941286d8' as const

/** The viem typed-data `types` for a SafeTx (no EIP712Domain entry → no name/version in the domain). */
const SAFE_TX_TYPES = {
  SafeTx: [
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'data', type: 'bytes' },
    { name: 'operation', type: 'uint8' },
    { name: 'safeTxGas', type: 'uint256' },
    { name: 'baseGas', type: 'uint256' },
    { name: 'gasPrice', type: 'uint256' },
    { name: 'gasToken', type: 'address' },
    { name: 'refundReceiver', type: 'address' },
    { name: 'nonce', type: 'uint256' },
  ],
} as const

/**
 * The Safe EIP-712 domain separator. NO name, NO version — only chainId + verifyingContract.
 * Equals the on-chain `domainSeparator()`:
 *   keccak256(abi.encode(DOMAIN_SEPARATOR_TYPEHASH, chainId, safe)).
 */
export function safeDomain(chainId: number, safe: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
      [DOMAIN_SEPARATOR_TYPEHASH, BigInt(chainId), safe],
    ),
  )
}

/**
 * The SafeTx EIP-712 digest, computed locally. Byte-equal to the Safe's on-chain
 * `getTransactionHash(...)` (asserted in the integration test). The canonical source at
 * runtime is the on-chain read; this local fn is for parity checks + offline digest building.
 */
export function safeTransactionDigest(safeTx: SafeTx, chainId: number, safe: Hex): Hex {
  return hashTypedData({
    domain: { chainId, verifyingContract: safe },
    types: SAFE_TX_TYPES,
    primaryType: 'SafeTx',
    message: {
      to: safeTx.to,
      value: safeTx.value,
      data: safeTx.data,
      operation: safeTx.operation,
      safeTxGas: safeTx.safeTxGas,
      baseGas: safeTx.baseGas,
      gasPrice: safeTx.gasPrice,
      gasToken: safeTx.gasToken,
      refundReceiver: safeTx.refundReceiver,
      nonce: safeTx.nonce,
    },
  })
}

/**
 * The `encodeTransactionData` pre-image bytes: 0x19 ‖ 0x01 ‖ domainSeparator ‖ safeTxHash.
 * This is the `data` argument Safe passes to a contract owner's isValidSignature(bytes,bytes),
 * and `keccak256(data) === digest` (Safe's GS027 check). Used by the erc1271 verify path.
 */
export function safeTransactionData(safeTx: SafeTx, chainId: number, safe: Hex): Hex {
  const safeTxHash = keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'address' },
        { type: 'uint256' },
        { type: 'bytes32' },
        { type: 'uint8' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'address' },
        { type: 'address' },
        { type: 'uint256' },
      ],
      [
        SAFE_TX_TYPEHASH,
        safeTx.to,
        safeTx.value,
        keccak256(safeTx.data),
        safeTx.operation,
        safeTx.safeTxGas,
        safeTx.baseGas,
        safeTx.gasPrice,
        safeTx.gasToken,
        safeTx.refundReceiver,
        safeTx.nonce,
      ],
    ),
  )
  const domain = safeDomain(chainId, safe)
  return `0x1901${domain.slice(2)}${safeTxHash.slice(2)}` as Hex
}

/** The ABI tuple for record.meta: the SafeTx fields + safe + chainId. Order is law. */
const SAFE_META_ABI = [
  { name: 'to', type: 'address' },
  { name: 'value', type: 'uint256' },
  { name: 'data', type: 'bytes' },
  { name: 'operation', type: 'uint8' },
  { name: 'safeTxGas', type: 'uint256' },
  { name: 'baseGas', type: 'uint256' },
  { name: 'gasPrice', type: 'uint256' },
  { name: 'gasToken', type: 'address' },
  { name: 'refundReceiver', type: 'address' },
  { name: 'nonce', type: 'uint256' },
  { name: 'safe', type: 'address' },
  { name: 'chainId', type: 'uint256' },
] as const

/** ABI-encodes the SafeTx tuple (+ safe + chainId) for SignatureRecord.meta. */
export function encodeSafeMeta(safeTx: SafeTx, safe: Hex, chainId: number): Hex {
  return encodeAbiParameters(SAFE_META_ABI, [
    safeTx.to,
    safeTx.value,
    safeTx.data,
    safeTx.operation,
    safeTx.safeTxGas,
    safeTx.baseGas,
    safeTx.gasPrice,
    safeTx.gasToken,
    safeTx.refundReceiver,
    safeTx.nonce,
    safe,
    BigInt(chainId),
  ])
}

/** Decodes record.meta back into the SafeTx tuple + safe + chainId. Throws on malformed input. */
export function decodeSafeMeta(meta: Hex): { safeTx: SafeTx; safe: Hex; chainId: number } {
  const [to, value, data, operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver, nonce, safe, chainId] =
    decodeAbiParameters(SAFE_META_ABI, meta)
  return {
    safeTx: {
      to,
      value,
      data,
      operation: Number(operation),
      safeTxGas,
      baseGas,
      gasPrice,
      gasToken,
      refundReceiver,
      nonce,
    },
    safe,
    chainId: Number(chainId),
  }
}
```

### 2.3 Run & verify

```bash
npm run test --workspace=packages/cosign -- safe-digest
```

**Expected:** all `safe-digest.test.ts` cases pass — typehash pins match, `safeDomain` equals the abi.encode pre-image hash, `safeTransactionDigest` equals both the hand-built `0x1901…` hash and viem's `hashTypedData`, sensitivity holds, meta round-trips.

### 2.4 Commit

```bash
git add packages/cosign/src/adapters/safe.ts packages/cosign/test/adapters/safe-digest.test.ts
git commit -m "feat(cosign/safe): safeDomain + safeTransactionDigest (no name/version) + SafeTx meta codec"
```

---

## Task 3 — `makeSafeAdapter`: `owners`, `threshold`, `verify` for EOA (`eip712` + `ethSign`)

**Goal:** The adapter factory with the read methods and the two ECDSA verify paths, unit-tested with a **fake `PublicClient`** (stubbed `readContract`) and **real viem signatures** (`privateKeyToAccount` + `sign` / `signMessage`). No chain.

### 3.1 RED — `packages/cosign/test/adapters/safe-verify.test.ts`

```ts
import { describe, expect, it, vi } from 'vitest'
import { type Hex, serializeSignature } from 'viem'
import { privateKeyToAccount, sign, signMessage } from 'viem/accounts'
import { SCHEME, type SignatureRecord } from '../../src/record.js'
import { makeSafeAdapter, type SafePublicClient } from '../../src/adapters/safe.js'

const chainId = 369
const safe = '0x1111111111111111111111111111111111111111' as Hex
const digest = `0x${'77'.repeat(32)}` as Hex

// Three deterministic EOAs; ownerA/ownerB are owners, ownerC is NOT.
const PK_A = `0x${'a'.repeat(64)}` as Hex
const PK_B = `0x${'b'.repeat(64)}` as Hex
const PK_C = `0x${'c'.repeat(64)}` as Hex
const ownerA = privateKeyToAccount(PK_A)
const ownerB = privateKeyToAccount(PK_B)
const ownerC = privateKeyToAccount(PK_C)

/** A fake PublicClient whose readContract answers getOwners/getThreshold for OUR Safe. */
const fakeClient = (over?: Partial<Record<'getOwners' | 'getThreshold', unknown>>): SafePublicClient => ({
  readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
    if (functionName === 'getOwners') return over?.getOwners ?? [ownerA.address, ownerB.address]
    if (functionName === 'getThreshold') return over?.getThreshold ?? 2n
    throw new Error(`unexpected readContract: ${functionName}`)
  }),
})

const rec = (overrides: Partial<SignatureRecord>): SignatureRecord => ({
  digest,
  signer: ownerA.address as Hex,
  signature: '0x',
  scheme: SCHEME.EIP712,
  meta: '0x',
  ...overrides,
})

/** A raw EIP-712-style ECDSA signature over `digest` (v ∈ {27,28}). */
async function eip712Sig(pk: Hex): Promise<Hex> {
  return serializeSignature(await sign({ hash: digest, privateKey: pk }))
}

/** An eth_sign-style signature: personal_sign over the raw 32-byte digest (v ∈ {27,28}). */
async function ethSignSig(pk: Hex): Promise<Hex> {
  return signMessage({ message: { raw: digest }, privateKey: pk })
}

describe('makeSafeAdapter.owners / threshold', () => {
  it('owners() returns getOwners()', async () => {
    const adapter = makeSafeAdapter({ publicClient: fakeClient(), safe, chainId })
    expect(await adapter.owners!()).toEqual([ownerA.address, ownerB.address])
  })

  it('threshold() returns getThreshold() as a number', async () => {
    const adapter = makeSafeAdapter({ publicClient: fakeClient(), safe, chainId })
    expect(await adapter.threshold!()).toBe(2)
  })
})

describe('makeSafeAdapter.verify — eip712 (v 27/28 ECDSA)', () => {
  it('accepts a valid owner EIP-712 signature', async () => {
    const adapter = makeSafeAdapter({ publicClient: fakeClient(), safe, chainId })
    const sig = await eip712Sig(PK_A)
    expect(await adapter.verify(rec({ scheme: SCHEME.EIP712, signature: sig, signer: ownerA.address as Hex }))).toBe(
      true,
    )
  })

  it('rejects a signature whose recovery != claimed signer', async () => {
    const adapter = makeSafeAdapter({ publicClient: fakeClient(), safe, chainId })
    const sig = await eip712Sig(PK_A) // signed by A …
    expect(await adapter.verify(rec({ scheme: SCHEME.EIP712, signature: sig, signer: ownerB.address as Hex }))).toBe(
      false, // … but claims B
    )
  })

  it('rejects a non-owner signer (valid sig, not in owner set)', async () => {
    const adapter = makeSafeAdapter({ publicClient: fakeClient(), safe, chainId })
    const sig = await eip712Sig(PK_C)
    expect(await adapter.verify(rec({ scheme: SCHEME.EIP712, signature: sig, signer: ownerC.address as Hex }))).toBe(
      false,
    )
  })

  it('rejects a signature over the wrong digest', async () => {
    const adapter = makeSafeAdapter({ publicClient: fakeClient(), safe, chainId })
    const wrong = serializeSignature(await sign({ hash: `0x${'00'.repeat(32)}` as Hex, privateKey: PK_A }))
    expect(await adapter.verify(rec({ scheme: SCHEME.EIP712, signature: wrong, signer: ownerA.address as Hex }))).toBe(
      false,
    )
  })
})

describe('makeSafeAdapter.verify — ethSign (v > 30)', () => {
  it('accepts a valid owner eth_sign signature (scheme ECDSA)', async () => {
    const adapter = makeSafeAdapter({ publicClient: fakeClient(), safe, chainId })
    const sig = await ethSignSig(PK_B)
    expect(await adapter.verify(rec({ scheme: SCHEME.ECDSA, signature: sig, signer: ownerB.address as Hex }))).toBe(
      true,
    )
  })

  it('rejects an eth_sign signature from a non-owner', async () => {
    const adapter = makeSafeAdapter({ publicClient: fakeClient(), safe, chainId })
    const sig = await ethSignSig(PK_C)
    expect(await adapter.verify(rec({ scheme: SCHEME.ECDSA, signature: sig, signer: ownerC.address as Hex }))).toBe(
      false,
    )
  })
})

describe('makeSafeAdapter.verify — error propagation', () => {
  it('propagates an RPC error from readContract (does not swallow as false)', async () => {
    const client: SafePublicClient = {
      readContract: vi.fn(async () => {
        throw new Error('rpc down')
      }),
    }
    const adapter = makeSafeAdapter({ publicClient: client, safe, chainId })
    const sig = await eip712Sig(PK_A)
    await expect(
      adapter.verify(rec({ scheme: SCHEME.EIP712, signature: sig, signer: ownerA.address as Hex })),
    ).rejects.toThrow('rpc down')
  })
})
```

Run — must fail (no `makeSafeAdapter` yet):

```bash
npm run test --workspace=packages/cosign -- safe-verify
```

**Expected:** import-resolution / `makeSafeAdapter is not a function` (RED).

### 3.2 GREEN — append to `packages/cosign/src/adapters/safe.ts`

Add these imports to the existing `viem` import at the top of the file (merge into the one import statement):

```ts
import {
  type Hex,
  encodeAbiParameters,
  decodeAbiParameters,
  hashTypedData,
  keccak256,
  recoverAddress,
  recoverMessageAddress,
  isAddressEqual,
  getAddress,
} from 'viem'
import type { SignatureRecord } from '../record.js'
import { SCHEME } from '../record.js'
import type { CosignAdapter } from './adapter.js'
```

Then append:

```ts
/**
 * The minimal read-only client surface the adapter needs. A viem `PublicClient` satisfies it;
 * tests pass a fake with a stubbed `readContract`. Errors PROPAGATE (per cosign SDK §6).
 */
export interface SafePublicClient {
  readContract(args: {
    address: Hex
    abi: readonly unknown[]
    functionName: string
    args?: readonly unknown[]
  }): Promise<unknown>
}

/** Config for the Safe adapter. One instance is pinned to one (chainId, safe). */
export interface SafeAdapterConfig {
  publicClient: SafePublicClient
  /** The Safe (proxy) address — also the EIP-712 verifyingContract. */
  safe: Hex
  /** The chain id — binds the digest's domain. */
  chainId: number
}

/** Minimal Safe ABI fragment — only the read functions the adapter calls. */
export const SAFE_ABI = [
  { type: 'function', name: 'getOwners', stateMutability: 'view', inputs: [], outputs: [{ type: 'address[]' }] },
  { type: 'function', name: 'getThreshold', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  {
    type: 'function',
    name: 'isOwner',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'getTransactionHash',
    stateMutability: 'view',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
      { name: 'operation', type: 'uint8' },
      { name: 'safeTxGas', type: 'uint256' },
      { name: 'baseGas', type: 'uint256' },
      { name: 'gasPrice', type: 'uint256' },
      { name: 'gasToken', type: 'address' },
      { name: 'refundReceiver', type: 'address' },
      { name: '_nonce', type: 'uint256' },
    ],
    outputs: [{ type: 'bytes32' }],
  },
] as const

/** The legacy EIP-1271 magic value: bytes4(keccak256("isValidSignature(bytes,bytes)")). */
export const EIP1271_MAGIC_VALUE = '0x20c13b0b' as const

/** ABI fragment for the LEGACY EIP-1271 interface Safe's checkNSignatures uses for v==0 owners. */
const ISIGNATURE_VALIDATOR_ABI = [
  {
    type: 'function',
    name: 'isValidSignature',
    stateMutability: 'view',
    inputs: [
      { name: '_data', type: 'bytes' },
      { name: '_signature', type: 'bytes' },
    ],
    outputs: [{ type: 'bytes4' }],
  },
] as const

/**
 * The effective signer address for a record under a given digest:
 * - EIP712: ecrecover over the digest.
 * - ECDSA (eth_sign): recover over the personal-message-prefixed digest.
 * - EIP1271: the record.signer (the contract owner) as-is.
 * Throws on a malformed signature (errors propagate).
 */
async function effectiveSigner(record: SignatureRecord): Promise<Hex> {
  if (record.scheme === SCHEME.EIP712) {
    return recoverAddress({ hash: record.digest, signature: record.signature })
  }
  if (record.scheme === SCHEME.ECDSA) {
    // eth_sign: viem applies "\x19Ethereum Signed Message:\n32" ‖ digest internally.
    return recoverMessageAddress({ message: { raw: record.digest }, signature: record.signature })
  }
  // EIP1271 contract owner.
  return getAddress(record.signer)
}

/**
 * The concrete Gnosis Safe CosignAdapter (v1.3.0 / v1.4.1). Verifies a single owner's
 * signature over the SafeTx digest per Safe's v-byte scheme + confirms membership, and
 * orders records into the strictly-ascending blob `checkNSignatures` accepts.
 */
export function makeSafeAdapter(config: SafeAdapterConfig): CosignAdapter {
  const { publicClient, safe, chainId } = config

  async function owners(): Promise<Hex[]> {
    const result = (await publicClient.readContract({
      address: safe,
      abi: SAFE_ABI,
      functionName: 'getOwners',
    })) as readonly Hex[]
    return result.map((a) => getAddress(a))
  }

  async function threshold(): Promise<number> {
    const result = (await publicClient.readContract({
      address: safe,
      abi: SAFE_ABI,
      functionName: 'getThreshold',
    })) as bigint
    return Number(result)
  }

  async function isOwner(addr: Hex): Promise<boolean> {
    const set = await owners()
    return set.some((o) => isAddressEqual(o, addr))
  }

  async function verify(record: SignatureRecord): Promise<boolean> {
    if (record.scheme === SCHEME.EIP1271) {
      return verifyErc1271(record)
    }
    // EOA paths: recover, require recovered === claimed signer, require membership.
    let recovered: Hex
    try {
      recovered = await effectiveSigner(record)
    } catch {
      return false // malformed signature is "definitively invalid", not an infra error
    }
    if (!isAddressEqual(recovered, record.signer)) return false
    return isOwner(recovered)
  }

  async function verifyErc1271(record: SignatureRecord): Promise<boolean> {
    // Implemented in Task 5 (the EIP-1271 path). For Task 3 this is unreachable in tests.
    void record
    throw new Error('erc1271 verify not yet implemented')
  }

  function order(records: SignatureRecord[]): SignatureRecord[] {
    // Implemented in Task 4.
    void records
    throw new Error('order not yet implemented')
  }

  return { verify, order, owners, threshold }
}
```

> **Note on the `verifyErc1271` / `order` stubs:** they `throw` (not silently no-op) so any accidental call before Tasks 4/5 fails loudly. The Task-3 tests never hit them. Tasks 4 and 5 replace the stub bodies with real implementations in the same file — the function names and signatures are unchanged, so callers and earlier tests are unaffected.

### 3.3 Run & verify

```bash
npm run test --workspace=packages/cosign -- safe-verify
npm run test --workspace=packages/cosign -- safe-digest
```

**Expected:** `safe-verify.test.ts` all green (owners/threshold, eip712 accept + 3 rejects, ethSign accept + reject, RPC-error propagation); `safe-digest.test.ts` still green.

### 3.4 Commit

```bash
git add packages/cosign/src/adapters/safe.ts packages/cosign/test/adapters/safe-verify.test.ts
git commit -m "feat(cosign/safe): makeSafeAdapter owners/threshold + verify (eip712 + ethSign EOA paths)"
```

---

## Task 4 — `order` + `buildSignatureBlob` (EOA) + `buildExecTransactionArgs`

**Goal:** Strictly-ascending sort + dedup; the EOA blob (65-byte words, `v` set per scheme: `eip712`→27/28 verbatim, `ethSign`→`v+4`); and the `execTransaction` arg tuple. EIP-1271 tails come in Task 5 (the layout hook is built here so Task 5 only fills the dynamic region).

### 4.1 RED — `packages/cosign/test/adapters/safe-order.test.ts`

```ts
import { describe, expect, it } from 'vitest'
import { type Hex, serializeSignature, size, slice, hexToNumber, signatureToHex } from 'viem'
import { privateKeyToAccount, sign, signMessage } from 'viem/accounts'
import { SCHEME, type SignatureRecord } from '../../src/record.js'
import {
  makeSafeAdapter,
  buildSignatureBlob,
  buildExecTransactionArgs,
  type SafePublicClient,
  type SafeTx,
} from '../../src/adapters/safe.js'

const chainId = 369
const safe = '0x1111111111111111111111111111111111111111' as Hex
const digest = `0x${'77'.repeat(32)}` as Hex

// Pick PKs whose addresses we can sort; we assert ascending by recovered address.
const PK_1 = `0x${'11'.repeat(32)}` as Hex
const PK_2 = `0x${'22'.repeat(32)}` as Hex
const PK_3 = `0x${'33'.repeat(32)}` as Hex
const acc1 = privateKeyToAccount(PK_1)
const acc2 = privateKeyToAccount(PK_2)
const acc3 = privateKeyToAccount(PK_3)
const allOwners = [acc1.address, acc2.address, acc3.address] as Hex[]

const fakeClient = (): SafePublicClient => ({
  readContract: async ({ functionName }: { functionName: string }) => {
    if (functionName === 'getOwners') return allOwners
    if (functionName === 'getThreshold') return 3n
    throw new Error(`unexpected: ${functionName}`)
  },
})

async function eip712Rec(pk: Hex, signer: Hex): Promise<SignatureRecord> {
  return {
    digest,
    signer,
    signature: serializeSignature(await sign({ hash: digest, privateKey: pk })),
    scheme: SCHEME.EIP712,
    meta: '0x',
  }
}

async function ethSignRec(pk: Hex, signer: Hex): Promise<SignatureRecord> {
  return {
    digest,
    signer,
    signature: await signMessage({ message: { raw: digest }, privateKey: pk }),
    scheme: SCHEME.ECDSA,
    meta: '0x',
  }
}

describe('order', () => {
  it('sorts records strictly ascending by signer address', async () => {
    const adapter = makeSafeAdapter({ publicClient: fakeClient(), safe, chainId })
    const recs = [
      await eip712Rec(PK_1, acc1.address as Hex),
      await eip712Rec(PK_2, acc2.address as Hex),
      await eip712Rec(PK_3, acc3.address as Hex),
    ]
    const shuffled = [recs[2], recs[0], recs[1]]
    const ordered = adapter.order(shuffled)
    const addrs = ordered.map((r) => BigInt(r.signer))
    for (let i = 1; i < addrs.length; i++) expect(addrs[i] > addrs[i - 1]).toBe(true)
  })

  it('dedups records with the same effective signer (keeps one)', async () => {
    const adapter = makeSafeAdapter({ publicClient: fakeClient(), safe, chainId })
    const r = await eip712Rec(PK_1, acc1.address as Hex)
    const ordered = adapter.order([r, { ...r }])
    expect(ordered).toHaveLength(1)
  })
})

describe('buildSignatureBlob — EOA only', () => {
  it('concatenates one 65-byte word per signer in ascending order', async () => {
    const adapter = makeSafeAdapter({ publicClient: fakeClient(), safe, chainId })
    const recs = [
      await eip712Rec(PK_1, acc1.address as Hex),
      await eip712Rec(PK_2, acc2.address as Hex),
      await eip712Rec(PK_3, acc3.address as Hex),
    ]
    const ordered = adapter.order(recs)
    const blob = buildSignatureBlob(ordered)
    expect(size(blob)).toBe(3 * 65) // pure static region, no tails
    // Each word's v byte (last byte) is 27 or 28 for eip712.
    for (let i = 0; i < 3; i++) {
      const word = slice(blob, i * 65, i * 65 + 65)
      const v = hexToNumber(slice(word, 64, 65))
      expect(v === 27 || v === 28).toBe(true)
    }
  })

  it('sets v = original + 4 for ethSign records (Safe v>30 branch)', async () => {
    const adapter = makeSafeAdapter({ publicClient: fakeClient(), safe, chainId })
    const r = await ethSignRec(PK_1, acc1.address as Hex)
    const blob = buildSignatureBlob(adapter.order([r]))
    expect(size(blob)).toBe(65)
    const v = hexToNumber(slice(blob, 64, 65))
    expect(v === 31 || v === 32).toBe(true) // 27+4 or 28+4
  })

  it('preserves r and s from the original signature for eip712', async () => {
    const adapter = makeSafeAdapter({ publicClient: fakeClient(), safe, chainId })
    const r = await eip712Rec(PK_1, acc1.address as Hex)
    const blob = buildSignatureBlob(adapter.order([r]))
    // r||s (first 64 bytes) must equal the first 64 bytes of the raw signature.
    expect(slice(blob, 0, 64)).toBe(slice(r.signature, 0, 64))
  })
})

describe('buildExecTransactionArgs', () => {
  it('produces the positional execTransaction args with the blob as the last element', async () => {
    const adapter = makeSafeAdapter({ publicClient: fakeClient(), safe, chainId })
    const tx: SafeTx = {
      to: '0x2222222222222222222222222222222222222222',
      value: 5n,
      data: '0xabcd',
      operation: 0,
      safeTxGas: 0n,
      baseGas: 0n,
      gasPrice: 0n,
      gasToken: '0x0000000000000000000000000000000000000000',
      refundReceiver: '0x0000000000000000000000000000000000000000',
      nonce: 0n,
    }
    const ordered = adapter.order([await eip712Rec(PK_1, acc1.address as Hex)])
    const blob = buildSignatureBlob(ordered)
    const args = buildExecTransactionArgs(ordered, tx)
    expect(args).toEqual([
      tx.to,
      tx.value,
      tx.data,
      tx.operation,
      tx.safeTxGas,
      tx.baseGas,
      tx.gasPrice,
      tx.gasToken,
      tx.refundReceiver,
      blob,
    ])
  })
})
```

> The unused `signatureToHex` import in the test above is intentional-free — drop it if your linter flags it; it is listed only to show the viem split helpers available. The asserting imports actually used are `serializeSignature`, `size`, `slice`, `hexToNumber`.

Run — must fail (`order` stub throws; `buildSignatureBlob`/`buildExecTransactionArgs` missing):

```bash
npm run test --workspace=packages/cosign -- safe-order
```

**Expected:** failures from the `order not yet implemented` throw and missing exports (RED).

### 4.2 GREEN — implement `order`, `buildSignatureBlob`, `buildExecTransactionArgs` in `safe.ts`

First, **replace the `order` stub** inside `makeSafeAdapter` with the real sort+dedup:

```ts
  function order(records: SignatureRecord[]): SignatureRecord[] {
    // Compute the effective signer for sorting/dedup. EOA recovery is synchronous-safe via
    // viem's recover* which are async; we precompute here is not possible in a sync `order`,
    // so we recover lazily using the public recoverEffectiveSigner helper at blob-build time.
    // For ordering we rely on the *attached* effective signer cached on the record by
    // attachEffectiveSigners (called below). order() therefore expects records that already
    // carry a resolvable signer: for eip712/ethSign we trust record.signer (verify already
    // asserted recovered === signer); for erc1271 we use record.signer directly.
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

> **Design decision (pinned):** `order` sorts by `record.signer`, **not** by re-recovering. This is sound because `verify` (run by `aggregate` before `order`) already asserts `recovered === record.signer` for EOA records, so `record.signer` IS the effective signer; for `erc1271` records `record.signer` is the contract owner by definition. This keeps `order` pure + synchronous (matching the `CosignAdapter.order` signature `(records) => records`). The design spec §5.2 step 1–2 calls for sorting by the effective signer; post-`verify`, that equals `record.signer`.

Then append the blob builders + the `v`-byte helpers (top-level exports):

```ts
import { pad, concat, toHex, size, slice } from 'viem' // merge into the top viem import

/** Splits a 65-byte ECDSA signature into r (32) ‖ s (32) ‖ v (1). */
function splitSig(sig: Hex): { r: Hex; s: Hex; v: number } {
  if (size(sig) !== 65) throw new Error(`expected 65-byte signature, got ${size(sig)} bytes`)
  return { r: slice(sig, 0, 32), s: slice(sig, 32, 64), v: Number(BigInt(slice(sig, 64, 65))) }
}

/** The 65-byte static word for a single ordered record (EOA paths; erc1271 handled in Task 5). */
function staticWord(record: SignatureRecord): Hex {
  if (record.scheme === SCHEME.EIP712) {
    const { r, s, v } = splitSig(record.signature)
    return concat([r, s, toHex(v, { size: 1 })])
  }
  if (record.scheme === SCHEME.ECDSA) {
    // eth_sign: Safe's v>30 branch does ecrecover(prefixed, v-4). Wallet gives v∈{27,28}, so +4.
    const { r, s, v } = splitSig(record.signature)
    return concat([r, s, toHex(v + 4, { size: 1 })])
  }
  // EIP1271 placeholder word — filled with the real {r=owner}{s=offset}{v=0} in Task 5.
  return erc1271StaticWordPlaceholder(record)
}

/** Placeholder for the erc1271 static word; replaced by the real builder in Task 5. */
function erc1271StaticWordPlaceholder(record: SignatureRecord): Hex {
  void record
  throw new Error('erc1271 blob encoding not yet implemented')
}

/**
 * Builds the final `signatures` blob from records already in strictly-ascending order
 * (the output of `adapter.order`). EOA records contribute one 65-byte static word each.
 * EIP-1271 records (Task 5) additionally append a {uint256 len}{bytes sig} tail and set
 * their static-word `s` to the tail's byte offset.
 */
export function buildSignatureBlob(ordered: SignatureRecord[]): Hex {
  // Task-4 scope: EOA-only. Task 5 replaces this body to interleave the dynamic region.
  const words = ordered.map((r) => staticWord(r))
  return concat(words)
}

/**
 * Produces the positional arguments for `execTransaction(to, value, data, operation,
 * safeTxGas, baseGas, gasPrice, gasToken, refundReceiver, signatures)`. The caller submits.
 */
export function buildExecTransactionArgs(
  ordered: SignatureRecord[],
  safeTx: SafeTx,
): readonly [Hex, bigint, Hex, number, bigint, bigint, bigint, Hex, Hex, Hex] {
  return [
    safeTx.to,
    safeTx.value,
    safeTx.data,
    safeTx.operation,
    safeTx.safeTxGas,
    safeTx.baseGas,
    safeTx.gasPrice,
    safeTx.gasToken,
    safeTx.refundReceiver,
    buildSignatureBlob(ordered),
  ]
}
```

> `pad` is imported for Task 5 (left-padding the owner address into `r`); it's unused in Task 4. If `noUnusedLocals` flags it, add `pad` only when Task 5 needs it. To keep each task green, import `pad` in Task 5's edit, not here. (Adjust the merged import accordingly.)

### 4.3 Run & verify

```bash
npm run test --workspace=packages/cosign -- safe-order
npm run test --workspace=packages/cosign -- safe-verify safe-digest
```

**Expected:** `safe-order.test.ts` green (ascending sort, dedup, 3×65 blob, ethSign v+4, r‖s preserved, exec args tuple); the Task 2/3 suites still green.

### 4.4 Commit

```bash
git add packages/cosign/src/adapters/safe.ts packages/cosign/test/adapters/safe-order.test.ts
git commit -m "feat(cosign/safe): order (ascending+dedup) + buildSignatureBlob (EOA) + buildExecTransactionArgs"
```

---

## Task 5 — The EIP-1271 contract-owner path (`v==0`): verify + offset-tail blob

**Goal:** `verify` for `erc1271` via `isValidSignature(bytes data, bytes contractSignature) → 0x20c13b0b` (the legacy `bytes,bytes` interface, full `data` pre-image — the verified-from-source critical detail); and `buildSignatureBlob` interleaving the dynamic 1271 tails with back-patched `s` offsets. Unit-tested with a fake `publicClient` (stubbed `isValidSignature`) + byte-layout assertions.

### 5.1 RED — `packages/cosign/test/adapters/safe-1271.test.ts`

```ts
import { describe, expect, it, vi } from 'vitest'
import { type Hex, serializeSignature, size, slice, hexToBigInt, encodeAbiParameters, getAddress, pad } from 'viem'
import { privateKeyToAccount, sign } from 'viem/accounts'
import { SCHEME, type SignatureRecord } from '../../src/record.js'
import {
  makeSafeAdapter,
  buildSignatureBlob,
  EIP1271_MAGIC_VALUE,
  encodeSafeMeta,
  safeTransactionData,
  type SafePublicClient,
  type SafeTx,
} from '../../src/adapters/safe.js'

const chainId = 369
const safe = '0x1111111111111111111111111111111111111111' as Hex

const tx: SafeTx = {
  to: '0x2222222222222222222222222222222222222222',
  value: 0n,
  data: '0x',
  operation: 0,
  safeTxGas: 0n,
  baseGas: 0n,
  gasPrice: 0n,
  gasToken: '0x0000000000000000000000000000000000000000',
  refundReceiver: '0x0000000000000000000000000000000000000000',
  nonce: 0n,
}

// A contract owner (lowest address so it sorts first) + an EOA owner.
const contractOwner = '0x0000000000000000000000000000000000000abc' as Hex
const PK_EOA = `0x${'ee'.repeat(32)}` as Hex
const eoa = privateKeyToAccount(PK_EOA)
const digest = `0x${'77'.repeat(32)}` as Hex
const contractSig = '0xdeadbeefdeadbeef' as Hex // the 1271 dynamic tail bytes

const erc1271Rec: SignatureRecord = {
  digest,
  signer: contractOwner,
  signature: contractSig,
  scheme: SCHEME.EIP1271,
  meta: encodeSafeMeta(tx, safe, chainId),
}

/** Fake client: getOwners includes both; isValidSignature returns the magic (or not). */
const fakeClient = (magic: Hex = EIP1271_MAGIC_VALUE): SafePublicClient & { calls: unknown[] } => {
  const calls: unknown[] = []
  return {
    calls,
    readContract: vi.fn(async (args: { functionName: string; address: Hex }) => {
      calls.push(args)
      if (args.functionName === 'getOwners') return [contractOwner, eoa.address]
      if (args.functionName === 'getThreshold') return 2n
      if (args.functionName === 'isValidSignature') {
        // Must be called on the contract owner's address with (data, contractSignature).
        expect(getAddress(args.address)).toBe(getAddress(contractOwner))
        return magic
      }
      throw new Error(`unexpected: ${args.functionName}`)
    }),
  } as SafePublicClient & { calls: unknown[] }
}

describe('verify — erc1271 (v==0)', () => {
  it('accepts when isValidSignature(bytes,bytes) returns 0x20c13b0b', async () => {
    const client = fakeClient()
    const adapter = makeSafeAdapter({ publicClient: client, safe, chainId })
    expect(await adapter.verify(erc1271Rec)).toBe(true)
    // It must have queried isValidSignature with the full data pre-image (keccak == digest).
    const call = (client.readContract as unknown as { mock: { calls: { 0: { functionName: string; args: Hex[] } }[] } })
      .mock.calls.map((c) => c[0])
      .find((a: { functionName: string }) => a.functionName === 'isValidSignature') as
      | { args: [Hex, Hex] }
      | undefined
    expect(call).toBeTruthy()
    expect(call!.args[0]).toBe(safeTransactionData(tx, chainId, safe)) // _data = pre-image
    expect(call!.args[1]).toBe(contractSig) // _signature = contract tail
  })

  it('rejects when isValidSignature returns the wrong magic', async () => {
    const adapter = makeSafeAdapter({ publicClient: fakeClient('0x1626ba7e' as Hex), safe, chainId })
    expect(await adapter.verify(erc1271Rec)).toBe(false)
  })

  it('rejects an erc1271 record whose signer is not an owner', async () => {
    const adapter = makeSafeAdapter({ publicClient: fakeClient(), safe, chainId })
    const notOwner = { ...erc1271Rec, signer: '0x000000000000000000000000000000000000dEaD' as Hex }
    expect(await adapter.verify(notOwner)).toBe(false)
  })
})

describe('buildSignatureBlob — with an erc1271 tail', () => {
  it('lays out [static words] ‖ [tail] and back-patches s to the tail offset', () => {
    // One erc1271 word + one eip712 word; contractOwner < eoa so 1271 word is first.
    const eoaRec: SignatureRecord = {
      digest,
      signer: eoa.address as Hex,
      // deterministic EOA sig (any valid 65-byte sig — its bytes are copied verbatim)
      signature: ('0x' + '11'.repeat(32) + '22'.repeat(32) + '1b') as Hex, // r,s, v=27
      scheme: SCHEME.EIP712,
      meta: '0x',
    }
    // Caller passes ordered records (contractOwner first). buildSignatureBlob does the layout.
    const ordered = [erc1271Rec, eoaRec]
    const blob = buildSignatureBlob(ordered)

    const count = 2
    const staticLen = count * 65
    // Total = static + (32-byte length word + contractSig bytes).
    expect(size(blob)).toBe(staticLen + 32 + size(contractSig))

    // Word 0 (erc1271): r = left-padded contract owner; v = 0; s = offset = staticLen.
    const word0 = slice(blob, 0, 65)
    expect(slice(word0, 0, 32)).toBe(pad(contractOwner, { size: 32 }))
    const sOffset = hexToBigInt(slice(word0, 32, 64))
    expect(sOffset).toBe(BigInt(staticLen))
    expect(hexToBigInt(slice(word0, 64, 65))).toBe(0n) // v == 0

    // Word 1 (eip712): r||s||v copied verbatim, v == 27.
    const word1 = slice(blob, 65, 130)
    expect(slice(word1, 0, 64)).toBe(slice(eoaRec.signature, 0, 64))
    expect(hexToBigInt(slice(word1, 64, 65))).toBe(27n)

    // Dynamic tail at offset staticLen: {uint256 length}{contractSig}.
    const lengthWord = slice(blob, staticLen, staticLen + 32)
    expect(hexToBigInt(lengthWord)).toBe(BigInt(size(contractSig)))
    const tailSig = slice(blob, staticLen + 32, staticLen + 32 + size(contractSig))
    expect(tailSig).toBe(contractSig)
  })

  it('handles two erc1271 tails with cumulative offsets', () => {
    const owner2 = '0x0000000000000000000000000000000000000fff' as Hex
    const sig2 = '0xcafecafecafecafecafe' as Hex
    const rec2: SignatureRecord = {
      digest,
      signer: owner2,
      signature: sig2,
      scheme: SCHEME.EIP1271,
      meta: encodeSafeMeta(tx, safe, chainId),
    }
    // ordered ascending: contractOwner (0x…abc) < owner2 (0x…fff)
    const ordered = [erc1271Rec, rec2]
    const blob = buildSignatureBlob(ordered)
    const staticLen = 2 * 65

    // First tail at staticLen; its length = size(contractSig).
    const s0 = hexToBigInt(slice(slice(blob, 0, 65), 32, 64))
    expect(s0).toBe(BigInt(staticLen))
    // Second tail offset = staticLen + 32 + size(contractSig).
    const expectedSecondOffset = staticLen + 32 + size(contractSig)
    const s1 = hexToBigInt(slice(slice(blob, 65, 130), 32, 64))
    expect(s1).toBe(BigInt(expectedSecondOffset))

    // Verify the second tail bytes.
    const len1 = hexToBigInt(slice(blob, expectedSecondOffset, expectedSecondOffset + 32))
    expect(len1).toBe(BigInt(size(sig2)))
    expect(slice(blob, expectedSecondOffset + 32, expectedSecondOffset + 32 + size(sig2))).toBe(sig2)
  })
})

// silence unused import if linter complains
void encodeAbiParameters
```

Run — must fail (erc1271 verify + blob throw the Task-3/4 placeholders):

```bash
npm run test --workspace=packages/cosign -- safe-1271
```

**Expected:** failures from `erc1271 verify not yet implemented` / `erc1271 blob encoding not yet implemented` (RED).

### 5.2 GREEN — implement the erc1271 verify + tail layout in `safe.ts`

**(a) Replace the `verifyErc1271` stub** inside `makeSafeAdapter` with the real call (it needs the SafeTx from `record.meta` to rebuild the `data` pre-image):

```ts
  async function verifyErc1271(record: SignatureRecord): Promise<boolean> {
    // Membership first (cheap, and a non-owner can never count regardless of the 1271 result).
    if (!(await isOwner(record.signer))) return false
    // Rebuild the exact `data` pre-image Safe passes to isValidSignature(bytes,bytes):
    // 0x19 ‖ 0x01 ‖ domainSeparator ‖ safeTxHash, whose keccak256 == record.digest.
    const { safeTx, safe: metaSafe, chainId: metaChainId } = decodeSafeMeta(record.meta)
    const data = safeTransactionData(safeTx, metaChainId, metaSafe)
    const magic = (await publicClient.readContract({
      address: record.signer,
      abi: ISIGNATURE_VALIDATOR_ABI,
      functionName: 'isValidSignature',
      args: [data, record.signature],
    })) as Hex
    return magic.toLowerCase() === EIP1271_MAGIC_VALUE
  }
```

**(b) Replace `erc1271StaticWordPlaceholder` and `buildSignatureBlob`** with the real offset-tail layout. Delete the placeholder fn and rewrite `buildSignatureBlob` to interleave static words + dynamic tails:

```ts
/**
 * Builds the final `signatures` blob from records already in strictly-ascending order
 * (the output of `adapter.order`). EOA records contribute one 65-byte static word.
 * EIP-1271 records contribute a static word `{r=left-pad32(owner)}{s=offset}{v=0}` plus a
 * dynamic tail `{uint256 len}{contractSignature}`; the static `s` is back-patched to the tail's
 * byte offset from the start of the blob (Safe GS021–GS023 bounds, GS024 validity).
 */
export function buildSignatureBlob(ordered: SignatureRecord[]): Hex {
  const count = ordered.length
  const staticLen = count * 65
  const staticWords: Hex[] = []
  const tails: Hex[] = []
  let tailOffset = staticLen // first tail starts right after the static region

  for (const r of ordered) {
    if (r.scheme === SCHEME.EIP712) {
      const { r: sr, s: ss, v } = splitSig(r.signature)
      staticWords.push(concat([sr, ss, toHex(v, { size: 1 })]))
    } else if (r.scheme === SCHEME.ECDSA) {
      const { r: sr, s: ss, v } = splitSig(r.signature)
      staticWords.push(concat([sr, ss, toHex(v + 4, { size: 1 })]))
    } else {
      // EIP1271: r = left-padded owner, s = current tail offset, v = 0.
      const rField = pad(getAddress(r.signer), { size: 32 })
      const sField = toHex(BigInt(tailOffset), { size: 32 })
      staticWords.push(concat([rField, sField, toHex(0, { size: 1 })]))
      const lenWord = toHex(BigInt(size(r.signature)), { size: 32 })
      tails.push(concat([lenWord, r.signature]))
      tailOffset += 32 + size(r.signature)
    }
  }
  return concat([...staticWords, ...tails])
}
```

Remove the now-dead `staticWord` and `erc1271StaticWordPlaceholder` helpers (their logic is inlined above), and ensure `pad` is in the top-level `viem` import. Keep `splitSig` (used above).

> **Why offsets are computed in one pass:** because every signer (EOA or contract) occupies exactly one 65-byte static word, the static region length is `count*65` regardless of scheme. So the first tail offset is known up front (`count*65`) and each subsequent offset just accumulates the prior tail's `32 + len`. This matches Safe's `require(uint256(s) >= requiredSignatures.mul(65))` (GS021) — the offset always points past the static region.

### 5.3 Run & verify

```bash
npm run test --workspace=packages/cosign -- safe-1271
npm run test --workspace=packages/cosign -- safe-order safe-verify safe-digest
```

**Expected:** `safe-1271.test.ts` green (accept on magic, reject on wrong magic, reject non-owner, single-tail layout with `r`/`s`/`v`/length/bytes assertions, two-tail cumulative offsets); all earlier suites still green (the EOA blob path is unchanged behaviorally — a pure-EOA `ordered` produces no tails, identical bytes to Task 4).

### 5.4 Commit

```bash
git add packages/cosign/src/adapters/safe.ts packages/cosign/test/adapters/safe-1271.test.ts
git commit -m "feat(cosign/safe): EIP-1271 verify (isValidSignature bytes,bytes -> 0x20c13b0b) + offset-tail blob layout"
```

---

## Task 6 — Wire `src/index.ts` re-exports + a unit `aggregate`-through-adapter test

**Goal:** Export the Safe adapter from the package surface, and add one unit test that drives the full cosign `aggregate(records, makeSafeAdapter(...))` path with a fake client (no chain) — proving the adapter plugs into the SDK core exactly as the interface requires.

### 6.1 Edit `packages/cosign/src/index.ts`

Append to the existing re-exports (from the SDK plan):

```ts
export {
  type SafeTx,
  type SafeAdapterConfig,
  type SafePublicClient,
  SAFE_ABI,
  SAFE_TX_TYPEHASH,
  DOMAIN_SEPARATOR_TYPEHASH,
  EIP1271_MAGIC_VALUE,
  safeDomain,
  safeTransactionDigest,
  safeTransactionData,
  encodeSafeMeta,
  decodeSafeMeta,
  makeSafeAdapter,
  buildSignatureBlob,
  buildExecTransactionArgs,
} from './adapters/safe.js'
```

### 6.2 RED — `packages/cosign/test/adapters/safe-aggregate.test.ts`

```ts
import { describe, expect, it } from 'vitest'
import { type Hex, serializeSignature, size } from 'viem'
import { privateKeyToAccount, sign } from 'viem/accounts'
import { SCHEME, type SignatureRecord } from '../../src/record.js'
import { aggregate } from '../../src/client.js'
import { makeSafeAdapter, buildSignatureBlob, type SafePublicClient } from '../../src/adapters/safe.js'

const chainId = 369
const safe = '0x1111111111111111111111111111111111111111' as Hex
const digest = `0x${'77'.repeat(32)}` as Hex

const PK_1 = `0x${'11'.repeat(32)}` as Hex
const PK_2 = `0x${'22'.repeat(32)}` as Hex
const PK_X = `0x${'99'.repeat(32)}` as Hex // non-owner
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
    meta: '0x',
  }
}

describe('aggregate(records, makeSafeAdapter(...))', () => {
  it('drops the non-owner, keeps owners, orders ascending, and yields a 2×65 blob', async () => {
    const adapter = makeSafeAdapter({ publicClient: client, safe, chainId })
    const records = [
      await rec(PK_2, acc2.address as Hex),
      await rec(PK_X, accX.address as Hex), // non-owner — filtered by verify
      await rec(PK_1, acc1.address as Hex),
    ]
    const ordered = await aggregate(records, adapter)
    expect(ordered).toHaveLength(2)
    // ascending by signer
    expect(BigInt(ordered[1].signer) > BigInt(ordered[0].signer)).toBe(true)
    // aggregate returns {signer, signature}[]; reconstruct records to build the blob.
    const orderedRecords = ordered.map((o) => records.find((r) => r.signer === o.signer)!)
    expect(size(buildSignatureBlob(orderedRecords))).toBe(2 * 65)
  })
})
```

Run — must fail until 6.1's re-exports compile / until the test file exists:

```bash
npm run test --workspace=packages/cosign -- safe-aggregate
```

**Expected:** RED if run before 6.1 (import resolution), GREEN after.

### 6.3 GREEN

No new source beyond 6.1's re-exports — the adapter already satisfies `CosignAdapter` and `aggregate` already filters by `verify` + applies `order` (cosign SDK plan, Task 4). The test passes once `index.ts` exports resolve and the package compiles.

### 6.4 Full sweep + typecheck

```bash
cd /Users/michaelmclaughlin/Documents/valve-tech/github/msgboard
npm run test --workspace=packages/cosign
npm run build --workspace=packages/cosign
```

**Expected:**
- vitest: all adapter suites green — `safe-digest`, `safe-verify`, `safe-order`, `safe-1271`, `safe-aggregate` (plus the SDK-plan core suites: keys/record/client/adapter). `Test Files  N passed`.
- `tsc`: clean; `dist/adapters/safe.{js,d.ts}` emitted; `index.d.ts` includes the Safe exports.

### 6.5 Commit

```bash
git add packages/cosign/src/index.ts packages/cosign/test/adapters/safe-aggregate.test.ts
git commit -m "feat(cosign/safe): re-export Safe adapter surface + aggregate-through-adapter unit test"
```

---

## Task 7 — Integration: real Safe v1.4.1 on anvil — blob accepted by `checkNSignatures` + `execTransaction` succeeds

**Goal:** The demoable proof that cosign's board output is a **Safe-accepted** blob. Deploy the published Safe v1.4.1 runtime bytecode (from `@safe-global/safe-deployments`) into a fresh `anvil` (via `prool`), create a real 2-of-3 Safe, have two owners sign the digest, run `aggregate` → `buildSignatureBlob`, and assert:
1. `safeTransactionDigest(...)` (local) == `getTransactionHash(...)` (on-chain) — digest parity.
2. `checkSignatures(digest, data, blob)` does **not** revert.
3. `execTransaction(...args)` succeeds (`ExecutionSuccess` emitted, `nonce` incremented, the target call observed).
4. A wrong-order blob reverts with `GS026`.

This is option (a) from the design spec §10/§11 — self-contained + deterministic. (Fallback option (b), forking a public chain, is sketched at the end of this task in case `anvil` is unavailable on a runner.)

> **anvil availability:** `prool` shells to the local `anvil` binary (Foundry). Confirmed installed on the dev machine (`~/.foundry/bin/anvil`). If a CI runner lacks Foundry, install via `curl -L https://foundry.paradigm.xyz | bash && foundryup` in the CI setup step, or use the documented fork fallback. The test `describe` is guarded so it **skips with a clear message** (not a false pass) if anvil cannot start.

### 7.1 Helper — `packages/cosign/test/adapters/_safe-fixture.ts`

A small, real fixture that deploys Safe artifacts into anvil and creates a Safe. No placeholders — it uses the safe-deployments runtime bytecode + the real factory `createProxyWithNonce` + `setup`.

```ts
import { createServer } from 'prool'
import { anvil } from 'prool/instances'
import {
  type Hex,
  type Address,
  createTestClient,
  createPublicClient,
  createWalletClient,
  http,
  publicActions,
  walletActions,
  encodeFunctionData,
  decodeEventLog,
  parseAbi,
  getContractAddress,
  keccak256,
  encodePacked,
} from 'viem'
import { foundry } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import {
  getSafeSingletonDeployment,
  getProxyFactoryDeployment,
  getCompatibilityFallbackHandlerDeployment,
} from '@safe-global/safe-deployments'

const VERSION = '1.4.1'

export const FACTORY_ABI = parseAbi([
  'function createProxyWithNonce(address singleton, bytes initializer, uint256 saltNonce) returns (address proxy)',
  'event ProxyCreation(address indexed proxy, address singleton)',
])

export const SETUP_ABI = parseAbi([
  'function setup(address[] _owners, uint256 _threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)',
])

export interface SafeFixture {
  rpcUrl: string
  chainId: number
  publicClient: ReturnType<typeof createPublicClient>
  walletClient: ReturnType<typeof createWalletClient>
  safe: Address
  owners: ReturnType<typeof privateKeyToAccount>[]
  threshold: number
  stop: () => Promise<void>
}

/**
 * Boots an anvil instance, sets the Safe v1.4.1 singleton / proxy factory / fallback-handler
 * runtime bytecode at their canonical addresses via setCode, then creates a `threshold`-of-N
 * Safe owned by `ownerPks`. Returns clients + the Safe address.
 */
export async function deploySafeFixture(ownerPks: Hex[], threshold: number): Promise<SafeFixture> {
  const singleton = getSafeSingletonDeployment({ version: VERSION })!
  const factory = getProxyFactoryDeployment({ version: VERSION })!
  const fallback = getCompatibilityFallbackHandlerDeployment({ version: VERSION })!

  const singletonAddr = singleton.defaultAddress as Address
  const factoryAddr = factory.defaultAddress as Address
  const fallbackAddr = fallback.defaultAddress as Address

  // 1) start anvil (port 0 → prool assigns a free port)
  const server = createServer({ instance: anvil(), port: 0 })
  await server.start()
  const { port } = server.address()!
  const rpcUrl = `http://127.0.0.1:${port}/1` // prool pool id 1
  const chain = { ...foundry, id: foundry.id }
  const chainId = chain.id

  const test = createTestClient({ mode: 'anvil', chain, transport: http(rpcUrl) })
    .extend(publicActions)
    .extend(walletActions)
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) })

  // 2) inject the audited runtime bytecode at the canonical addresses
  await test.setCode({ address: singletonAddr, bytecode: singleton.deployedBytecode as Hex })
  await test.setCode({ address: factoryAddr, bytecode: factory.deployedBytecode as Hex })
  await test.setCode({ address: fallbackAddr, bytecode: fallback.deployedBytecode as Hex })

  // 3) a funded deployer (anvil default account 0)
  const deployerPk = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex
  const deployer = privateKeyToAccount(deployerPk)
  const walletClient = createWalletClient({ account: deployer, chain, transport: http(rpcUrl) })

  // 4) build the setup() initializer for our owner set + threshold + fallback handler
  const owners = ownerPks.map((pk) => privateKeyToAccount(pk))
  const ownerAddrs = [...owners].map((o) => o.address).sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1))
  const initializer = encodeFunctionData({
    abi: SETUP_ABI,
    functionName: 'setup',
    args: [
      ownerAddrs,
      BigInt(threshold),
      '0x0000000000000000000000000000000000000000',
      '0x',
      fallbackAddr,
      '0x0000000000000000000000000000000000000000',
      0n,
      '0x0000000000000000000000000000000000000000',
    ],
  })

  // 5) deploy the proxy via the factory
  const saltNonce = 0n
  const hash = await walletClient.writeContract({
    address: factoryAddr,
    abi: FACTORY_ABI,
    functionName: 'createProxyWithNonce',
    args: [singletonAddr, initializer, saltNonce],
  })
  const receipt = await publicClient.waitForTransactionReceipt({ hash })

  // pull the proxy address from the ProxyCreation event
  let safe: Address | undefined
  for (const log of receipt.logs) {
    try {
      const ev = decodeEventLog({ abi: FACTORY_ABI, data: log.data, topics: log.topics })
      if (ev.eventName === 'ProxyCreation') safe = ev.args.proxy as Address
    } catch {
      /* not our event */
    }
  }
  if (!safe) throw new Error('ProxyCreation event not found — Safe proxy deploy failed')

  return {
    rpcUrl,
    chainId,
    publicClient,
    walletClient,
    safe,
    owners,
    threshold,
    stop: async () => {
      await server.stop()
    },
  }
}

// re-export viem bits the test reuses
export {
  privateKeyToAccount,
  encodeFunctionData,
  keccak256,
  encodePacked,
  getContractAddress,
  parseAbi,
}
```

> **`getContractAddress`/`keccak256`/`encodePacked` re-exports** are conveniences; the test mainly needs `deploySafeFixture`. The `rpcUrl` `/1` suffix is `prool`'s pool routing (each pool id is an isolated instance); `port: 0` lets the OS pick a free port to avoid collisions in parallel test files.

### 7.2 RED — `packages/cosign/test/adapters/safe-integration.test.ts`

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type Hex, parseAbi, getAddress } from 'viem'
import { SCHEME, type SignatureRecord } from '../../src/record.js'
import { aggregate, groupByDigest } from '../../src/client.js'
import {
  makeSafeAdapter,
  buildSignatureBlob,
  buildExecTransactionArgs,
  safeTransactionDigest,
  encodeSafeMeta,
  type SafeTx,
} from '../../src/adapters/safe.js'
import { serializeSignature, sign } from 'viem/accounts'
import { deploySafeFixture, type SafeFixture } from './_safe-fixture.js'

const SAFE_READ_ABI = parseAbi([
  'function getTransactionHash(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 _nonce) view returns (bytes32)',
  'function checkSignatures(bytes32 dataHash, bytes data, bytes signatures) view',
  'function nonce() view returns (uint256)',
  'function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address payable refundReceiver,bytes signatures) payable returns (bool)',
  'event ExecutionSuccess(bytes32 indexed txHash, uint256 payment)',
])

// Three owners; 2-of-3.
const PK_1 = `0x${'11'.repeat(32)}` as Hex
const PK_2 = `0x${'22'.repeat(32)}` as Hex
const PK_3 = `0x${'33'.repeat(32)}` as Hex

let fx: SafeFixture | undefined
let anvilAvailable = true

beforeAll(async () => {
  try {
    fx = await deploySafeFixture([PK_1, PK_2, PK_3], 2)
  } catch (err) {
    anvilAvailable = false
    // eslint-disable-next-line no-console
    console.warn('[safe-integration] anvil/prool unavailable — skipping integration test:', err)
  }
}, 60_000)

afterAll(async () => {
  await fx?.stop()
})

describe.runIf(() => anvilAvailable)('Safe v1.4.1 integration (real checkNSignatures + execTransaction)', () => {
  it('local digest equals on-chain getTransactionHash', async () => {
    const f = fx!
    const tx: SafeTx = {
      to: getAddress('0x000000000000000000000000000000000000dEaD'),
      value: 0n,
      data: '0x',
      operation: 0,
      safeTxGas: 0n,
      baseGas: 0n,
      gasPrice: 0n,
      gasToken: '0x0000000000000000000000000000000000000000',
      refundReceiver: '0x0000000000000000000000000000000000000000',
      nonce: 0n,
    }
    const onChain = (await f.publicClient.readContract({
      address: f.safe,
      abi: SAFE_READ_ABI,
      functionName: 'getTransactionHash',
      args: [tx.to, tx.value, tx.data, tx.operation, tx.safeTxGas, tx.baseGas, tx.gasPrice, tx.gasToken, tx.refundReceiver, tx.nonce],
    })) as Hex
    expect(safeTransactionDigest(tx, f.chainId, f.safe)).toBe(onChain)
  })

  it('aggregated blob is accepted by checkSignatures and execTransaction succeeds', async () => {
    const f = fx!
    const tx: SafeTx = {
      to: getAddress('0x000000000000000000000000000000000000dEaD'),
      value: 0n,
      data: '0x',
      operation: 0,
      safeTxGas: 0n,
      baseGas: 0n,
      gasPrice: 0n,
      gasToken: '0x0000000000000000000000000000000000000000',
      refundReceiver: '0x0000000000000000000000000000000000000000',
      nonce: 0n,
    }
    const digest = safeTransactionDigest(tx, f.chainId, f.safe)
    const meta = encodeSafeMeta(tx, f.safe, f.chainId)

    // two of the three owners sign (EIP-712 over the digest)
    const records: SignatureRecord[] = []
    for (const pk of [PK_1, PK_2]) {
      records.push({
        digest,
        signer: getAddress((await import('viem/accounts')).privateKeyToAccount(pk).address),
        signature: serializeSignature(await sign({ hash: digest, privateKey: pk })),
        scheme: SCHEME.EIP712,
        meta,
      })
    }

    const adapter = makeSafeAdapter({ publicClient: f.publicClient as never, safe: f.safe, chainId: f.chainId })

    // sanity: adapter reads match the deployed Safe
    expect((await adapter.owners!()).length).toBe(3)
    expect(await adapter.threshold!()).toBe(2)

    const perDigest = groupByDigest(records).get(digest)!
    const orderedPairs = await aggregate(perDigest, adapter)
    const orderedRecords = orderedPairs.map((p) => perDigest.find((r) => r.signer === p.signer)!)
    const blob = buildSignatureBlob(orderedRecords)

    // 1) checkSignatures must not revert (data pre-image is built by Safe internally for v!=0;
    //    for pure-EOA blobs `data` is unused, but the ABI requires it — pass the pre-image anyway).
    //    We pass the digest as both args; Safe only checks keccak(data)==dataHash when a v==0 word
    //    is present, which this all-EOA blob has none of.
    await expect(
      f.publicClient.readContract({
        address: f.safe,
        abi: SAFE_READ_ABI,
        functionName: 'checkSignatures',
        args: [digest, '0x', blob],
      }),
    ).resolves.toBeUndefined()

    // 2) execTransaction succeeds
    const args = buildExecTransactionArgs(orderedRecords, tx)
    const hash = await f.walletClient.writeContract({
      address: f.safe,
      abi: SAFE_READ_ABI,
      functionName: 'execTransaction',
      args: args as never,
    })
    const receipt = await f.publicClient.waitForTransactionReceipt({ hash })
    expect(receipt.status).toBe('success')

    // 3) nonce incremented
    const nonceAfter = (await f.publicClient.readContract({
      address: f.safe,
      abi: SAFE_READ_ABI,
      functionName: 'nonce',
    })) as bigint
    expect(nonceAfter).toBe(1n)
  })

  it('a wrong-order blob reverts with GS026', async () => {
    const f = fx!
    const tx: SafeTx = {
      to: getAddress('0x000000000000000000000000000000000000dEaD'),
      value: 0n,
      data: '0x',
      operation: 0,
      safeTxGas: 0n,
      baseGas: 0n,
      gasPrice: 0n,
      gasToken: '0x0000000000000000000000000000000000000000',
      refundReceiver: '0x0000000000000000000000000000000000000000',
      nonce: 1n, // nonce advanced by the prior test
    }
    const digest = safeTransactionDigest(tx, f.chainId, f.safe)
    const meta = encodeSafeMeta(tx, f.safe, f.chainId)
    const { privateKeyToAccount } = await import('viem/accounts')
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
    const adapter = makeSafeAdapter({ publicClient: f.publicClient as never, safe: f.safe, chainId: f.chainId })
    const ordered = adapter.order(recs)
    // deliberately reverse to violate strictly-ascending
    const blob = buildSignatureBlob([...ordered].reverse())
    await expect(
      f.publicClient.readContract({
        address: f.safe,
        abi: SAFE_READ_ABI,
        functionName: 'checkSignatures',
        args: [digest, '0x', blob],
      }),
    ).rejects.toThrow(/GS026/)
  })
})
```

Run — must fail until the fixture + adapter are wired and (if anvil is present) the Safe deploys:

```bash
npm run test --workspace=packages/cosign -- safe-integration
```

**Expected (RED):** before the fixture exists, an import error; with the fixture but a regression in the adapter, the digest-parity or `checkSignatures` assertion fails. With everything correct and anvil present, GREEN.

### 7.3 GREEN

No new adapter source — the integration test exercises the code from Tasks 2–6 against a real Safe. GREEN is achieved when:
- digest parity holds (`safeTransactionDigest` == `getTransactionHash`),
- `checkSignatures` accepts the aggregated blob,
- `execTransaction` returns `success` + nonce → 1,
- the reversed blob reverts `GS026`.

If anvil is unavailable, the suite **skips** (via `describe.runIf`) with the warning logged in `beforeAll` — a visible skip, never a false pass.

### 7.4 Run & verify

```bash
npm run test --workspace=packages/cosign -- safe-integration
npm run test --workspace=packages/cosign   # full package sweep
npm run build --workspace=packages/cosign
```

**Expected:**
- `safe-integration.test.ts`: 3 passed (digest parity, exec success, GS026 revert) when anvil is present; or a single skip notice if not.
- Full sweep: every cosign suite green.
- `tsc`: clean.

### 7.5 Commit

```bash
git add packages/cosign/test/adapters/_safe-fixture.ts packages/cosign/test/adapters/safe-integration.test.ts
git commit -m "test(cosign/safe): integration — real Safe v1.4.1 on anvil, blob accepted by checkNSignatures + execTransaction"
```

### 7.6 Fallback (option b) — fork a public chain, if anvil is genuinely unavailable

If a runner cannot run `anvil` at all and the deploy-into-anvil path is impractical there, substitute the fixture with a **fork** of a chain that already has Safe v1.4.1 deployed (PulseChain 369 — `safe-deployments` lists `"369": "canonical"`, so the singleton/factory/fallback are at the canonical addresses there), targeting a **known existing Safe** at a pinned block:

```ts
// prool anvil with --fork-url + --fork-block-number, then read getTransactionHash on a real Safe
const server = createServer({
  instance: anvil({ forkUrl: process.env.FORK_RPC_URL!, forkBlockNumber: PINNED_BLOCK }),
  port: 0,
})
```

Then assert (still against the **real** Safe, not a mock): (1) `safeTransactionDigest` == on-chain `getTransactionHash` for that Safe's current nonce; (2) `checkSignatures` accepts a freshly-signed blob from one of that Safe's owners whose key you control (or use `anvil_impersonateAccount` + `setCode` to install a stub 1271 owner). Keep the deploy-into-anvil path (option a) as the default — it needs no external RPC and no pre-existing controlled Safe. **Do not** reduce the integration test to a pure mock; the whole point is a Safe-accepted blob.

---

## Self-review

### Spec coverage checklist (against `2026-06-13-msgboard-cosign-safe-adapter-design.md`)

- [ ] §3 lives at `src/adapters/safe.ts`; factory `makeSafeAdapter({ publicClient, safe, chainId })` → `CosignAdapter` — Tasks 3–6. (Spec names it `safeAdapter`; this plan exports `makeSafeAdapter` per the prompt's wording — note the alias in §3.)
- [ ] §4.1 `owners()`=`getOwners`, `threshold()`=`getThreshold`; membership via `getOwners` set lookup — Task 3.
- [ ] §4.2 digest: no-name/no-version domain, `SAFE_TX_TYPEHASH`/`DOMAIN_SEPARATOR_TYPEHASH` pinned byte-exact; `safeTransactionDigest` local == on-chain `getTransactionHash` (parity asserted in Task 7) — Tasks 2, 7.
- [ ] §4.3 `v`-byte scheme: `27/28`→ecrecover; `>30`→eth_sign (`v-4` + prefix; emit `v+4`); `0`→EIP-1271 `isValidSignature(bytes,bytes)→0x20c13b0b` with full data pre-image; `1` ignored; `2` out of scope — Tasks 3 (EOA), 5 (1271).
- [ ] §4.3 CRITICAL: legacy `0x20c13b0b` / `bytes,bytes` / full pre-image — **not** `0x1626ba7e` — verified from `ISignatureValidator.sol` source and implemented + tested — Task 5.
- [ ] §4.4 strictly-ascending + dedup (GS026) — Task 4 (`order`), asserted on-chain in Task 7.
- [ ] §4.5 EIP-1271 offset-tail layout: static `{r=owner}{s=offset}{v=0}` + dynamic `{len}{sig}`, back-patched `s`, GS021–GS023 bounds — Task 5.
- [ ] §5.3 `meta` = ABI SafeTx tuple + `safe` + `chainId`; `encodeSafeMeta`/`decodeSafeMeta` round-trip — Task 2.
- [ ] §5.2 `buildSignatureBlob(orderedRecords)` returns the final `Hex`; §5.4 caller flow via `buildExecTransactionArgs` — Tasks 4–5, 7.
- [ ] §9 errors propagate (RPC) vs definitively-invalid → false — Task 3 (propagation test) + verify returns false on bad sig/non-owner.
- [ ] §10 testing: digest parity (Task 7), per-scheme verify (Tasks 3, 5), blob accepted by `checkNSignatures` + negatives revert (Task 7), `owners`/`threshold` (Tasks 3, 7).
- [ ] §11 Plan 1 (EOA core) = Tasks 2–4, 6; the spec's "Plan 2" EIP-1271 path is folded in here as Task 5 (this single plan ships the full Safe adapter: EOA + 1271). The `safe4337` family extension (spec Plan 3) is out of scope.

### Internal consistency (a fn defined in task N used identically in N+1)

- `SafeTx` type (Task 2) is the exact shape consumed by `encodeSafeMeta`/`decodeSafeMeta` (Task 2), `safeTransactionDigest`/`safeTransactionData` (Task 2), `buildExecTransactionArgs` (Task 4), and every test.
- `SafePublicClient` (Task 3) is the one read seam used by `owners`/`threshold`/`verify` (Task 3), `verifyErc1271` (Task 5), and the fakes in Tasks 3–6 + the real viem client in Task 7 (cast via `as never` only at the call boundary where viem's full `PublicClient` is structurally wider).
- `splitSig` (Task 4) is reused unchanged by `buildSignatureBlob`'s EOA branches in Task 5.
- `EIP1271_MAGIC_VALUE = 0x20c13b0b` (Task 3 const) is the exact value `verifyErc1271` compares against (Task 5) and the test stubs return (Task 5).
- `safeTransactionData` (Task 2) builds the `data` pre-image used by `verifyErc1271` (Task 5) and asserted in the Task-5 test.
- `makeSafeAdapter`'s `order` (Task 4) feeds `buildSignatureBlob` (Tasks 4/5) and `aggregate` (Task 6) → `buildExecTransactionArgs` (Task 7) — one pipeline, one set of signatures throughout.
- The `verifyErc1271`/`order`/`erc1271StaticWordPlaceholder` **stubs** in Tasks 3/4 are replaced (not duplicated) by Task 5's real bodies — same names/signatures, so earlier tests keep passing.

### Placeholder scan

Before the final commit:

```bash
grep -rnE 'TODO|FIXME|XXX|\?\?\?|placeholder|not yet implemented' packages/cosign/src/adapters/safe.ts
```

**Expected:** **no** matches in the final `safe.ts` — the `not yet implemented` throws and `erc1271StaticWordPlaceholder` exist only transiently in Tasks 3/4 and are fully replaced by Task 5. (If any remain, Task 5 was not completed.)

### Scheme-mapping decision (pinned, consistent with the SDK codec)

The cosign codec reserves `SCHEME = { ECDSA: 0, EIP1271: 1, EIP712: 2 }` (SDK plan, Task 3). This Safe adapter maps:
- EIP-712 ECDSA (`v∈{27,28}`) → `SCHEME.EIP712` (2),
- `eth_sign` legacy (`v>30`) → `SCHEME.ECDSA` (0), distinguished at blob-build time by emitting `v+4` (no 4th codec scheme is added — resolves the SDK spec §12 / Safe spec §5.3 open item in favor of folding `ethSign` into `ECDSA`),
- EIP-1271 contract owner (`v==0`) → `SCHEME.EIP1271` (1).

This is implemented uniformly in `effectiveSigner`/`verify` (Task 3, 5) and `buildSignatureBlob` (Tasks 4, 5), and round-trips through `record.ts`'s codec unchanged.

### Deviations from the spec (called out)

1. **Factory name** — spec §3 writes `safeAdapter(...)`; the prompt asks for `makeSafeAdapter(...)`. This plan ships `makeSafeAdapter` (and could add `export const safeAdapter = makeSafeAdapter` as an alias if the spec name is preferred — not required).
2. **One plan, both schemes** — the spec decomposes into Plan 1 (EOA) + Plan 2 (EIP-1271). The prompt asks for the complete Safe adapter, so this single plan ships **both** (Task 5 is the EIP-1271 path). No behavior differs from the spec; only the plan boundary.
3. **No Safe detail differed from the design spec.** The design spec already corrected the prompt's `0x1626ba7e` claim to the verified `0x20c13b0b` (legacy `isValidSignature(bytes,bytes)`, full data pre-image). Re-verified from `safe-global/safe-smart-account@v1.4.1` source (`Safe.sol::checkNSignatures` passes `data` not `dataHash`; `ISignatureValidator.sol` defines `EIP1271_MAGIC_VALUE = 0x20c13b0b`). The domain (no name/version, typehash `0x47e7…9218`), `SAFE_TX_TYPEHASH` (`0xbb83…86d8`), the full `v`-byte branch (27/28 ECDSA, >30 eth_sign with `v-4`+prefix, 0 EIP-1271 offset-tail, 1 approveHash ignored), `signatureSplit`'s `{r}{s}{v}` 65-byte word, and GS026 strict-ascending dedup are all confirmed exactly as the spec states.

---

## Execution Handoff

This plan is ready to execute. It DEPENDS on the cosign SDK plan (`2026-06-13-msgboard-cosign-sdk.md`) having been executed first (it adds to the `packages/cosign` package that plan creates). Two options:

- **Subagent-driven (recommended for isolation):** dispatch each task (1→7, in order — sequential by dependency) to a fresh implementer subagent via `superpowers:subagent-driven-development`, with a review checkpoint after each task's commit. Each task is self-contained (its own RED→GREEN→commit) and leaves the suite green.
- **Inline:** execute here, task by task, pausing after each commit per `superpowers:executing-plans`.

Either way: enforce TDD (RED first, watch it fail for the right reason, then GREEN), run the exact commands shown, confirm the expected output before committing, and ensure the placeholder scan is clean before the final commit. The integration test (Task 7) is the headline deliverable — a board-aggregated blob accepted by a **real** Safe's `checkNSignatures` + `execTransaction`; do not weaken it to a mock. If anvil is unavailable on the execution host, install Foundry (`foundryup`) or use the documented fork fallback (option b) — but keep the test real.

Offer to begin execution of Task 1 (add dev deps + artifact smoke test), or to wire the whole sequence under a subagent-driven run.
