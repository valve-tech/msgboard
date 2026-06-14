# MsgBoard cosign Safe adapter — Off-chain Safe signature aggregation over the board (Design Spec)

Date: 2026-06-13
Status: Draft for review

Related:
- `docs/superpowers/specs/2026-06-13-msgboard-cosign-sdk-design.md` — the `@msgboard/cosign` SDK. That package ships the generic signature-share core + the `CosignAdapter` **interface** only (no concrete adapter). The Safe adapter specced here is **the first real, fully-working concrete `CosignAdapter`** (the Multisigner adapter is the minimal-bootstrap reference; the Wonderland adapter is another — each its own deliverable). The Safe `SafeTx` EIP-712 digest **is** the `SignatureRecord.digest` that cosign shares and aggregates.
- `docs/superpowers/specs/2026-06-13-msgboard-multisigner-design.md` — the minimal cosign-native multisig + its adapter. The Safe adapter mirrors Multisigner's adapter shape (`verify`/`order`/`owners`/`threshold`) but targets the dominant production multisig instead of a bootstrap contract, and adds the EIP-1271 + `v`-byte scheme handling Multisigner v1 deliberately omits.
- `safe-global/safe-smart-account` — the canonical Gnosis Safe contracts. **All Safe details below are quoted from source at tag `v1.4.1`** (and cross-checked against `v1.3.0`). The repo now redirects to `safe-fndn/safe-smart-account`; raw paths used: `contracts/Safe.sol`, `contracts/base/OwnerManager.sol`, `contracts/common/SignatureDecoder.sol`, `contracts/interfaces/ISignatureValidator.sol`.

---

## 1. Summary

Gnosis Safe is **the flagship off-chain-signature-aggregation multisig** — the dominant smart-account wallet by TVL and deployments across EVM chains. Its security model is exactly the one cosign was built to serve: owners sign a transaction digest off-chain (no per-signer on-chain tx), the signatures are collected somewhere, and a single submitter concatenates them into one `signatures` blob that `execTransaction` verifies and executes. Today that "collected somewhere" is the Safe Transaction Service (a hosted, centralized off-chain backend). **cosign's board replaces that transport** — owners broadcast their signatures over MsgBoard at ~zero reader cost, and any owner can read, verify, order, and submit. That substitution is the whole point of this adapter, and it makes Safe the first end-to-end-real `CosignAdapter`.

This is **true aggregation**, not coordination theater: the integration point is the real `execTransaction(... signatures)` call on a live Safe. The adapter:
- reads `getOwners()` / `getThreshold()` to expose the owner set (`owners()`, `threshold()`),
- `verify(record)` — recovers/validates a single owner's signature over the `SafeTx` digest per the Safe `v`-byte scheme (ECDSA `v∈{27,28}`, `eth_sign` `v>30`, EIP-1271 contract-owner `v==0`) and confirms owner-set membership,
- `order(records)` — sorts owners **strictly ascending by recovered address** and produces the exact concatenated 65-byte-word blob (with EIP-1271 dynamic tails appended and `s`-offsets fixed) that Safe's `checkNSignatures` accepts.

The adapter only **verifies + orders**. Building and submitting `execTransaction` is the caller's job; the adapter hands back the ordered `signatures` blob plus enough `meta` to construct the call.

## 2. Goals / non-goals

**Goals**
- A concrete `CosignAdapter` for Gnosis Safe `v1.3.0` and `v1.4.1` (identical for everything cosign touches — §8) that produces an `execTransaction`-ready `signatures` blob from board-shared signature records.
- Correct `SafeTx` EIP-712 digest handling: obtain the digest canonically via `getTransactionHash(...)` (an on-chain read) so it is byte-exact to what Safe re-derives.
- Full `v`-byte scheme support in both `verify` and `order`: standard ECDSA (`27/28`), `eth_sign` legacy (`v>30`), and EIP-1271 contract owners (`v==0`) including **nested Safes** (a Safe that is an owner of another Safe).
- Strictly-ascending-by-signer ordering with dedup, matching Safe's `checkNSignatures` invariant (it reverts `GS026` otherwise).
- Chain-agnostic operation: the digest binds `chainId` + Safe address, so one adapter instance works on any chain a Safe is deployed to (incl. PulseChain, with the address caveat in §8).

**Non-goals**
- **Building or submitting the `execTransaction` transaction.** The adapter returns `{signer, signature}[]` (cosign `aggregate`'s contract) and the caller concatenates + submits. cosign writes nothing on-chain.
- **Running a Safe Transaction Service.** cosign's board **is** the off-chain transport — that substitution is the differentiator, not a feature we reimplement. No hosted indexer, no REST API.
- **The on-chain `approveHash` path (`v==1`).** That is the *on-chain* confirmation route (an owner sends a tx to mark a hash approved). cosign is the *off-chain* path; the adapter **ignores `v==1`** for aggregation (it may *report* on-chain approvals for hybrid visibility — §6 — but never emits a `v==1` word into the blob).
- **Passkey / secp256r1 (`v==2`) signatures.** Newer Safe modules add a WebAuthn/passkey verifier path. Out of scope / future (§12).
- **Owner-set mutation, modules, guards, the gas-refund accounting (`safeTxGas`/`baseGas`/`gasPrice`/`gasToken`/`refundReceiver`).** The adapter neither sets nor interprets those beyond carrying them in `meta` so the caller can reconstruct the exact signed tuple. The refund fields are part of the signed digest and must round-trip verbatim.
- **A deploy/UI flow.** Safe deployment is the user's existing concern.

## 3. Where it lives

`@msgboard/cosign/src/adapters/safe.ts` — a concrete adapter **shipped inside cosign** (cosign ships the interface plus, now, real adapters in `src/adapters/`). It implements the `CosignAdapter` interface from the cosign SDK spec §4 (`verify` / `order` / `owners?` / `threshold?`).

```ts
safeAdapter(config: {
  safe: Hex;                  // the Safe (proxy) address — also the EIP-712 verifyingContract
  chainId: number;            // for scope keying + the digest's domain binding (sanity)
  publicClient: PublicClient; // viem read-only client: getOwners/getThreshold/getTransactionHash, EIP-1271 isValidSignature
}): CosignAdapter
```

**Deps:** `viem` only (already a cosign dep) — `recoverAddress` / `recoverMessageAddress` for ECDSA + `eth_sign`, `readContract` for `getOwners` / `getThreshold` / `getTransactionHash`, and `readContract`/`call` for EIP-1271 `isValidSignature`. The adapter declares a minimal inline ABI fragment (the handful of read functions it calls) — it does **not** import Safe build artifacts, matching how cosign keeps adapters dependency-light (the Multisigner adapter spec §5 sets this convention).

The adapter is the first member of a broader **adapter family** sharing `src/adapters/`: a future `safe4337.ts` (the Safe 4337 module variant — same digest/aggregation, different submission entrypoint, §11 plan 3), `rhinestone.ts`, etc. They reuse this file's `verify`/`order` core where the digest scheme matches.

## 4. The Safe signing model (verified from source)

### 4.1 Owner-set and threshold reads (`OwnerManager.sol`, identical v1.3.0/v1.4.1)

Owners are stored as a linked list (sentinel `address(0x1)`), not an array. The reads cosign uses:

```solidity
function getOwners() public view returns (address[] memory)            // walks the linked list
function getThreshold() public view returns (uint256)                  // returns `threshold`
function isOwner(address owner) public view returns (bool)             // owner != SENTINEL && owners[owner] != 0
```

`getOwners()` is the source of truth for `owners()`; `getThreshold()` for `threshold()`. For membership the adapter can use either `getOwners()` + local check or `isOwner(addr)` directly; preferring a single `getOwners()` read lets `verify` and `owners()` share one cached call (membership check is a local set lookup).

### 4.2 The `SafeTx` EIP-712 digest

The domain typehash (verified byte-exact at both versions — `Safe.sol` line 49–52 in v1.4.1, lines 36–38 in v1.3.0):

```solidity
// keccak256("EIP712Domain(uint256 chainId,address verifyingContract)");
bytes32 private constant DOMAIN_SEPARATOR_TYPEHASH = 0x47e79534a245952e8b16893a336b85a3d9ea9fa8c573f3d803afb92a79469218;
```

**There is NO `name` and NO `version` in the Safe domain** — only `chainId` and `verifyingContract`. The domain separator:

```solidity
function domainSeparator() public view returns (bytes32) {
    return keccak256(abi.encode(DOMAIN_SEPARATOR_TYPEHASH, getChainId(), this));
}
```

`this` is the Safe (proxy) address. So `verifyingContract` = the Safe address, and the domain binds both **chainId** and **Safe**. The `SafeTx` typehash (verified byte-exact at both versions):

```solidity
// keccak256("SafeTx(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 nonce)");
bytes32 private constant SAFE_TX_TYPEHASH = 0xbb8310d486368db6bd6f849402fdd73ad53d316b5a4b2644ad6efe0f941286d8;
```

The pre-image and final hash (`encodeTransactionData` / `getTransactionHash`, `Safe.sol`):

```solidity
function encodeTransactionData(...) public view returns (bytes memory) {
    bytes32 safeTxHash = keccak256(abi.encode(
        SAFE_TX_TYPEHASH, to, value, keccak256(data), operation,
        safeTxGas, baseGas, gasPrice, gasToken, refundReceiver, _nonce
    ));
    return abi.encodePacked(bytes1(0x19), bytes1(0x01), domainSeparator(), safeTxHash);
}
function getTransactionHash(...) public view returns (bytes32) {
    return keccak256(encodeTransactionData(...));
}
```

**The digest is nonce-bound** (the Safe's current `nonce` is the 10th field) and **chain+Safe specific** (via the domain). **The adapter obtains the digest by calling `getTransactionHash(...)` on the Safe**, not by reconstructing it locally — reconstruction is allowed only if it mirrors the above abi.encode exactly (used in tests for parity, §10). This is `SignatureRecord.digest`.

> Note: `execTransaction` reads `nonce` and increments it *before* `checkSignatures` (`Safe.sol` line 170: `nonce++;` then `txHash = keccak256(txHashData)` was computed at the *pre-increment* nonce via `encodeTransactionData(..., nonce)` captured on line 167). The digest owners sign uses the nonce **as it is when the tx executes**. So a digest collected for nonce N is only valid while the Safe's on-chain nonce is still N (§9 replay).

### 4.3 The `v`-byte signature scheme (`Safe.sol::checkNSignatures`, verified)

Signatures are passed to `execTransaction` as a single `bytes signatures` = **concatenated 65-byte words**, each `{bytes32 r}{bytes32 s}{uint8 v}` (compact `v`, see `SignatureDecoder.sol::signatureSplit`). `checkNSignatures` walks them in order and, per word, branches on `v`:

```solidity
(v, r, s) = signatureSplit(signatures, i);
if (v == 0) {
    // EIP-1271 contract signature
    require(keccak256(data) == dataHash, "GS027");
    currentOwner = address(uint160(uint256(r)));                 // r = the contract-owner address
    require(uint256(s) >= requiredSignatures.mul(65), "GS021");  // s = offset into the blob, past the static part
    require(uint256(s).add(32) <= signatures.length, "GS022");
    // contractSignatureLen := mload(signatures + s + 0x20); bounds-checked GS023
    // contractSignature := signatures + s + 0x20  (the {length}{bytes} dynamic tail)
    require(ISignatureValidator(currentOwner).isValidSignature(data, contractSignature) == EIP1271_MAGIC_VALUE, "GS024");
} else if (v == 1) {
    // approved hash (on-chain path) — r = approver address; msg.sender==owner OR approvedHashes[owner][hash]!=0
    currentOwner = address(uint160(uint256(r)));
    require(msg.sender == currentOwner || approvedHashes[currentOwner][dataHash] != 0, "GS025");
} else if (v > 30) {
    // eth_sign legacy: v-4, with the personal-message prefix
    currentOwner = ecrecover(keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", dataHash)), v - 4, r, s);
} else {
    // standard EIP-712 ECDSA (v == 27 or 28)
    currentOwner = ecrecover(dataHash, v, r, s);
}
require(currentOwner > lastOwner && owners[currentOwner] != address(0) && currentOwner != SENTINEL_OWNERS, "GS026");
lastOwner = currentOwner;
```

The branches, mapped to cosign:

| `v` | Scheme | How the adapter verifies | cosign `scheme` |
|---|---|---|---|
| `27` / `28` | Standard EIP-712 ECDSA | `ecrecover(digest, v, r, s)` directly (viem `recoverAddress`) | `eip712` |
| `> 30` | `eth_sign` legacy | `ecrecover(keccak256("\x19Ethereum Signed Message:\n32" ‖ digest), v-4, r, s)` (viem `recoverMessageAddress` over the 32-byte digest, then map v) | `ethSign` |
| `0` | EIP-1271 contract owner | `r` = owner address; call `isValidSignature` on it with the dynamic tail | `erc1271` |
| `1` | approved hash (on-chain) | **ignored by cosign** — never aggregated (§2) | — |
| `2` | secp256r1 / passkey (newer Safe) | **out of scope / future** (§12) | — |

**Critical EIP-1271 interface detail (verified — differs from the prompt's stated fact):** Safe's *contract-level* `checkNSignatures` calls the **legacy** Safe `ISignatureValidator` interface — `isValidSignature(bytes _data, bytes _signature)` returning magic **`0x20c13b0b`** (`ISignatureValidator.sol`: `bytes4 internal constant EIP1271_MAGIC_VALUE = 0x20c13b0b;` = `bytes4(keccak256("isValidSignature(bytes,bytes)"))`), and it passes the **full `data` pre-image** (the `encodeTransactionData` bytes), not the 32-byte hash. The newer EIP-1271 standard interface `isValidSignature(bytes32, bytes)` → `0x1626ba7e` is what Safe's *CompatibilityFallbackHandler* exposes when a Safe is *queried as* a 1271 signer by third parties — but the on-chain aggregation path `execTransaction → checkNSignatures` uses the **`bytes,bytes` / `0x20c13b0b`** form. **The adapter MUST mirror the on-chain path: to verify a `v==0` contract owner it calls `isValidSignature(bytes data, bytes contractSignature) → 0x20c13b0b`, passing the same `data` pre-image Safe would.** (For a nested Safe owner, that contract's own fallback handler implements the `bytes,bytes` form by re-hashing `data` and running its own `checkSignatures` over its own owners.) This discrepancy is called out explicitly so the implementer does not wire the wrong magic value/interface — it is the single most error-prone part of the adapter. See §9 and the test in §10.

### 4.4 Strictly-ascending order + dedup

`require(currentOwner > lastOwner ...)` (GS026) means signers in the blob must be in **strictly ascending order by recovered/owner address**, starting from `lastOwner = address(0)`. Strict `>` simultaneously:
- fixes a canonical order, and
- **dedups** — the same owner cannot appear twice (equal addresses fail `>`), so a single owner's signature cannot be double-counted toward threshold.

`order(records)` must therefore sort ascending by the *recovered/effective* signer address and emit at most one word per signer.

### 4.5 EIP-1271 offset-tail encoding (the `v==0` layout)

For contract-owner signatures the blob has two regions:
1. **Static region** — the threshold-count of 65-byte words (one per signer, in ascending order). For a contract owner, its word is `{r = left-padded owner address}{s = byte-offset}{v = 0}`.
2. **Dynamic region** — appended *after* all static words: for each contract owner, a `{uint256 length}{bytes signature}` tail. The owner's static-word `s` holds the **byte offset, measured from the start of the `signatures` blob**, to that tail's length word.

Safe's bounds checks (GS021–GS023) require `s >= requiredSignatures*65` (tail is past the static part) and `s+32+len <= signatures.length`. `order` builds the static words first (so the total static size is known = `count*65`), then appends tails and back-patches each contract owner's `s` to point at its tail. **Nested Safes** are just contract owners whose `isValidSignature` is itself a Safe — same layout, no special case in `order`; `verify` confirms them by the `isValidSignature` call.

### 4.6 Version notes (v1.3.0 vs v1.4.1 vs legacy)

- **v1.3.0 and v1.4.1 are byte-identical** for everything cosign touches: `DOMAIN_SEPARATOR_TYPEHASH`, `SAFE_TX_TYPEHASH`, `domainSeparator()`, `encodeTransactionData`/`getTransactionHash`, the entire `v`-byte branch logic in `checkNSignatures`, and `getOwners`/`getThreshold`/`isOwner`. (The contract was renamed `GnosisSafe` → `Safe` in v1.4.0, and `checkNSignatures` gained no semantic change cosign depends on; both expose it as `public view`.) **So the adapter is version-agnostic across 1.3.0/1.4.1.**
- **Pre-1.3.0 legacy edge (v1.0.0/1.1.1):** the domain was `EIP712Domain(address verifyingContract)` only — **no `chainId`**. A Safe at that version produces a different `domainSeparator`. The adapter relies on `getTransactionHash` for the digest, so it stays correct *as long as it reads the digest from the Safe* rather than reconstructing — but the *reconstruction* path (tests, and any local digest builder) must special-case the legacy domain. Flagged as an open item (§12); v1 targets 1.3.0/1.4.1.

## 5. The adapter mapping

| `CosignAdapter` method | Safe implementation |
|---|---|
| `owners()` | `readContract getOwners() → Hex[]` |
| `threshold()` | `readContract getThreshold() → number` |
| `verify(record)` | branch on `record.scheme` / recovered `v`; recover or `isValidSignature`; confirm membership |
| `order(records)` | sort ascending by effective signer; concat 65-byte words; append EIP-1271 tails; fix `s` offsets |

### 5.1 `verify(record)`

`record.signature` is the owner's raw signature; `record.scheme ∈ {eip712, ethSign, erc1271}` selects the path (and is mirrored by the `v` byte of the 65-byte word the adapter will emit). The `record.digest` is the `SafeTx` digest from `getTransactionHash`.

1. **`eip712` (ECDSA `v∈{27,28}`):** `recovered = recoverAddress({ hash: record.digest, signature: record.signature })`. Require `recovered === record.signer` (reject mismatch — never trust the claimed signer over the recovery). Require membership (`isOwner`/in `getOwners()`).
2. **`ethSign` (`v>30`):** the signed payload is `keccak256("\x19Ethereum Signed Message:\n32" ‖ digest)`. Recover with viem's message-recovery over the **raw 32-byte digest** (`recoverMessageAddress({ message: { raw: digest }, signature })`), which applies that exact prefix. Require `recovered === record.signer` and membership. The emitted word uses `v' = v + 4` (Safe expects `v>30`; a wallet `eth_sign` yields `v∈{27,28}` over the prefixed hash, so the adapter adds 4 — Safe subtracts 4 before ecrecover).
3. **`erc1271` (`v==0`, contract owner):** `record.signer` is the contract-owner address; `record.signature` is the dynamic-tail bytes (`contractSignature`). Verify by calling `isValidSignature(bytes data, bytes contractSignature)` on `record.signer` and requiring the **`0x20c13b0b`** magic (§4.3). `data` is the `encodeTransactionData` pre-image — carried in `meta` (§5.3) or re-derived from the SafeTx tuple. Require `record.signer ∈ getOwners()`. Supports nested Safes transparently (the call recurses into the inner Safe's own `checkSignatures`).

Errors (RPC failure, malformed signature) **propagate** per cosign SDK §6 — they are *not* silently mapped to `false`. Only a definitively-invalid signature or non-owner returns `false`.

### 5.2 `order(records)`

Pure, no chain reads. Input: verified records for one digest. Output: cosign's `{signer, signature}[]` — but Safe's blob is not a naive concat of `record.signature`, so the adapter's `order` returns records whose `signature` field is the **65-byte word** to concatenate, and (for EIP-1271) carries the tail so the caller's concat yields the full blob. Concretely the adapter exposes a small helper used by `order` and re-exported for the caller:

1. Compute each record's **effective signer address** (recovered EOA for `eip712`/`ethSign`; `record.signer` for `erc1271`).
2. Sort records **strictly ascending** by that address (lowercased-hex / bigint compare); drop duplicates (defensive — `verify` + ascending already prevent double-count).
3. Build the **static region**: for each record in order, a 65-byte word:
   - `eip712`: `{r}{s}{v}` from `record.signature` (v 27/28).
   - `ethSign`: `{r}{s}{v+4}` (v>30).
   - `erc1271`: `{r = left-pad(signer,32)}{s = offset}{v = 0}` with `s` filled in step 4.
4. Build the **dynamic region**: for each `erc1271` record (in the same ascending order), append `{uint256 length}{contractSignature bytes}`; set that record's static-word `s` to the byte offset (from blob start) of its length word. First tail offset = `count*65`; subsequent offsets accumulate `32 + len` of the prior tail.
5. The concatenation `static ‖ dynamic` is the `execTransaction` `signatures` arg.

cosign's `aggregate(records, safeAdapter)` (SDK §4 `client.ts`) keeps records where `verify` is true, then applies `order`; the caller concatenates the resulting `signature` fields (which, with the appended tail bytes carried alongside, form the blob). To keep cosign's `{signer,signature}[]` contract clean, the adapter also exports `buildSignatureBlob(orderedRecords): Hex` that performs steps 3–5 and returns the final blob directly — the recommended path for callers.

### 5.3 `SignatureRecord` field usage

- `digest` = `getTransactionHash(to, value, data, operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver, nonce)` — the on-chain read result.
- `signer` = the owner address (EOA for ECDSA/eth_sign; contract address for EIP-1271).
- `signature` = the raw signature bytes (65-byte ECDSA, or the EIP-1271 `contractSignature` dynamic bytes).
- `scheme` ∈ `{eip712, ethSign, erc1271}` (cosign `SCHEME` map: `EIP712=2`, `ECDSA=0`, `EIP1271=1` — the adapter maps `eip712→EIP712`, `ethSign→ECDSA`-but-prefixed; pin the exact numeric mapping in plan 1 to match the codec, noting cosign reserves only three scheme numbers — `ethSign` is represented as `ECDSA` with the `v>30` byte carrying the distinction, or a 4th scheme number is added to the codec, decided in plan 1).
- `meta` = ABI-encoded **full `SafeTx` tuple** so the caller can build `execTransaction` without re-querying: `(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 nonce, address safe, uint256 chainId)`. The `safe` + `chainId` make the record self-describing for the archivist and for cross-checking the digest.

### 5.4 Caller flow: record → aggregate → execTransaction

```ts
const adapter = safeAdapter({ safe, chainId, publicClient });
const records = await readSignatures(board, { namespace: 'cosign', scope: `${chainId}:${safe}`, days: 7 });
const perDigest = groupByDigest(records).get(digest)!;          // cosign client.ts
const ordered = await aggregate(perDigest, adapter);            // verify + order
const signatures = buildSignatureBlob(ordered);                 // adapter helper (§5.2)
const { to, value, data, operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver, nonce }
  = decodeSafeMeta(perDigest[0].meta);                          // adapter helper
// caller submits (NOT the adapter's job):
await walletClient.writeContract({
  address: safe, abi: SAFE_ABI, functionName: 'execTransaction',
  args: [to, value, data, operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver, signatures],
});
```

## 6. Reading on-chain vs off-chain (hybrid visibility)

cosign's path is the **off-chain `v`-byte signatures** broadcast over the board. But a Safe can *also* accumulate confirmations on-chain via `approveHash` (`Safe.sol::approveHash` sets `approvedHashes[msg.sender][hash]=1`, emits `ApproveHash`). For visibility — "who has already signed, anywhere?" — the adapter MAY offer a read-only helper:

```ts
adapter.onChainApprovals(digest): Promise<Hex[]>   // owners with approvedHashes[owner][digest] != 0
```

implemented by reading `approvedHashes(owner, digest)` for each `owner ∈ getOwners()` (the public mapping getter). This is purely informational (e.g. a UI showing "3 off-board + 1 on-chain approval"). It is **never** folded into the aggregated blob — those owners would need a `v==1` word, which is the on-chain path cosign ignores (§2). If a caller wants to combine on-chain approvals with off-board sigs they build that blob themselves; the adapter draws the line at off-chain aggregation.

## 7. Data flow end-to-end

```
1. PROPOSE   someone picks the SafeTx tuple (to,value,data,operation,gas...,gasToken,refundReceiver)
                and reads nonce = Safe.nonce(); computes
                digest = Safe.getTransactionHash(...tuple..., nonce)              (§4.2)
2. SIGN      each owner signs `digest` in their wallet — EIP-712 (v27/28), or eth_sign (v>30),
                or, for a contract owner, produces an EIP-1271 contractSignature.
                cosign.postSignature(board, { namespace:'cosign', scope:`${chainId}:${safe}`,
                   record:{ digest, signer, signature, scheme, meta:encodeSafeMeta(tuple,safe,chainId) } })
                → posted under today's rotating category key (cosign keys.ts)
3. COLLECT   anyone: records = cosign.readSignatures(board, { scope, days:7 })
                perDigest = groupByDigest(records).get(digest)
4. AGGREGATE ordered = await cosign.aggregate(perDigest, safeAdapter({ safe, chainId, publicClient }))
                → verify() recovered/validated each owner from `digest` + confirmed membership;
                  order() sorted ascending and prepared the words/tails
5. EXECUTE   signatures = buildSignatureBlob(ordered)
                Safe.execTransaction(...tuple..., signatures)   on-chain
                → checkSignatures → checkNSignatures verifies count>=threshold, ascending owners,
                  per-v scheme; runs the call; nonce++.
```

Two-store fit: steps 2–4 are **board-only** (cosign, ~zero reader cost, PoW sender cost; each signature self-authenticating). Steps 1, 5 read/write the **chain** (digest read, execute). cosign never writes the chain; the adapter reads it (`getOwners`/`getThreshold`/`getTransactionHash`/`isValidSignature`/`approvedHashes`), the caller writes it (`execTransaction`).

## 8. Multi-version + multi-chain handling

- **Versions:** 1.3.0 and 1.4.1 are identical for cosign (§4.6) → one code path. The adapter reads the digest from the Safe (`getTransactionHash`), so even minor internal differences can't desync the signed value. Legacy pre-1.3.0 domain (no chainId) is an open item (§12); reconstruction-based tooling must branch on it.
- **Chains:** the adapter is **chain-agnostic** because the `SafeTx` digest binds `chainId` (domain) + `safe` (verifyingContract). One `safeAdapter` instance is pinned to one `(chainId, safe)` via config; the digest it verifies against can only have been produced for that Safe on that chain. cosign's `scope = `${chainId}:${safe}`` keys the rotating board category per-deployment (resolving cosign SDK open-item §9 / matching the Multisigner adapter's `('multisig', `${chainId}:${address}`)` convention).
- **PulseChain (369 / 943):** Safe is available on PulseChain via community deployments (e.g. pulsechainsafe.com; tooling like pulsedomains / safe-pls-py). The adapter logic is unchanged — but the **canonical singleton / proxyFactory / fallbackHandler addresses on 369/943 MUST be verified against a known-good source before shipping**, because a wrong fallback handler breaks the EIP-1271 query path and a wrong singleton means the bytecode isn't the audited Safe. **Flagged:** do not assume the Ethereum-mainnet canonical addresses hold on PulseChain; confirm on-chain (`getStorageAt` the proxy's singleton slot; check `VERSION()`), and pin the verified addresses in plan 2 before any PulseChain EIP-1271 case ships. (§12 open item for the exact addresses.)

## 9. Security

- **Ascending-order + dedup enforced** — `order` sorts strictly ascending by effective signer and drops duplicates; this is exactly Safe's `GS026` invariant, so an honestly-aggregated blob passes and a reordered/duplicated blob reverts on-chain. A single owner cannot inflate the count.
- **EIP-1271 validation mirrors the on-chain path** — `verify` calls the **`isValidSignature(bytes,bytes) → 0x20c13b0b`** legacy interface with the same `data` pre-image Safe uses (§4.3), so a record that `verify` accepts is one `checkNSignatures` will also accept. Using the wrong (`bytes32` / `0x1626ba7e`) interface would make the adapter accept signatures the Safe rejects (or vice-versa) — this is the headline correctness risk and is pinned + tested (§10).
- **Digest nonce-binding prevents cross-nonce replay** — the digest includes the Safe's `nonce`; once `execTransaction` runs `nonce++`, a blob collected for nonce N is dead (the re-derived digest at N+1 differs, so `checkNSignatures` recovers wrong/non-owner addresses and reverts). Stale board records for an executed nonce simply don't aggregate to a valid blob.
- **Domain binds chainId + Safe → no cross-safe / cross-chain replay** — `EIP712Domain(uint256 chainId,address verifyingContract)` with `verifyingContract = the Safe`. A signature for Safe A on chain X cannot satisfy Safe B or chain Y; the recovered address won't be an owner of the wrong Safe, and the digest won't match across chains.
- **`eth_sign` vs `eip712` `v`-handling** — the adapter recovers each per its scheme and emits the correct `v` byte (27/28 vs +4). A record mislabeling its scheme fails `recovered === record.signer` in `verify` and is dropped, so a mislabeled record can't sneak a wrong-prefix recovery into the blob.
- **Malleability is benign** — like the Multisigner adapter and ZkTable, the blob dedups by **recovered/effective address**, not by signature bytes. A malleated ECDSA signature (`s` flipped) recovers the **same** owner address, so the ascending-by-address dedup catches it — two encodings of one owner's signature can't both count. The adapter therefore does not need to canonicalize low-`s` for correctness (it MAY for cleanliness). EIP-1271 has no ecrecover malleability surface (the owner contract decides validity).
- **Open-board junk** — cosign's `readSignatures` skips undecodable entries; `verify` is the gate for well-formed-but-invalid records (non-owner, bad sig, failed 1271). Non-owner or invalid records return `false` and are filtered before `order`.
- **EIP-1271 reentrancy note** — Safe's own comment warns `checkNSignatures` does an external call for `v==0`. The adapter's `verify` 1271 call is a read-only `eth_call` (no state change), so no reentrancy concern on the off-chain side; the on-chain concern is Safe's, unchanged by cosign.

## 10. Testing

**Unit (vitest, viem; fork or mocked client):**
- **Digest parity** — construct the `SafeTx` digest locally (mirroring `encodeTransactionData`'s `abi.encode`) and assert it equals `getTransactionHash(...)` read from a real Safe on a fork, for several tuples incl. non-empty `data` and non-zero gas fields. Guards against any desync between the carried digest and Safe's re-derivation.
- **`verify` per scheme** — for a known owner: (a) a `v∈{27,28}` EIP-712 sig → `true`; (b) an `eth_sign` `v>30` sig → `true`; (c) a **contract-owner EIP-1271** case (deploy a stub 1271 validator and/or a nested Safe as owner) → `true` via the `0x20c13b0b` path. Negative: wrong-digest sig → `false`; non-owner signer → `false`; `record.signer` ≠ recovery → `false`; RPC error → **propagates** (not silent `false`).
- **`order` / blob acceptance** — shuffled records → strictly-ascending blob; feed the blob to a real Safe's `checkSignatures` / `checkNSignatures` on a fork and assert it does **not** revert (positive), and assert wrong-order / duplicate / non-owner / wrong-digest blobs **do** revert with the expected `GS0xx` codes (GS026/GS024/GS020). Include a mixed blob (ECDSA + eth_sign + one EIP-1271 contract owner with a correctly-offset tail) to exercise the §5.2 layout end-to-end against `checkNSignatures`.
- **`owners()` / `threshold()`** — return the Safe's deployed values.

**Integration (local fork — anvil):**
- Deploy a Safe (singleton + proxy factory) with N EOA owners + threshold t; owners sign a real `SafeTx` digest; post to cosign's **fake board** transport; `readSignatures` → `aggregate(records, safeAdapter)` → `buildSignatureBlob` → `execTransaction(...)` **succeeds** and the target observed the call, Safe `nonce` incremented, `ExecutionSuccess` emitted. This is the demoable proof that cosign's board replaces the Tx Service for true Safe aggregation.
- A nested-Safe variant: an inner Safe is an owner of the outer Safe; inner Safe's owners sign, the inner sig is packaged as a `v==0` EIP-1271 tail, outer `execTransaction` succeeds — proves the offset-tail + 1271 path against a live nested Safe.

## 11. Decomposition into plans

- **Plan 1 — Safe digest + `verify`/`order` pure-core + fork tests (EOA only).** The digest read/parity, `verify` for `eip712` + `ethSign`, `order` + `buildSignatureBlob` for 65-byte words, `owners`/`threshold` reads, `meta` codec. Fork tests: digest parity, per-scheme verify, blob accepted by `checkNSignatures`, negatives revert. Pins the `scheme` numeric mapping against the cosign codec. Lands the working EOA Safe adapter. **Do first.**
- **Plan 2 — the EIP-1271 contract-owner path.** `verify` via `isValidSignature(bytes,bytes)→0x20c13b0b`; `order`/`buildSignatureBlob` offset-tail encoding for `v==0`; nested-Safe support; the PulseChain address verification (§8). Fork tests with a stub validator + a nested Safe. Depends on Plan 1.
- **Plan 3 — `safe4337` module variant.** A sibling adapter (`src/adapters/safe4337.ts`) reusing Plan 1/2's digest + `verify`/`order` core, differing only at the submission entrypoint (the 4337 module / EntryPoint `handleOps` instead of `execTransaction`). Depends on Plans 1–2. (Out of scope for the first cut; listed so the core is factored to be reusable.)

Plans 1 and 2 are the shippable Safe adapter; Plan 3 is the family extension.

## 12. Open items

- **Pre-1.3.0 legacy domain (v1.0.0 / v1.1.1).** `EIP712Domain(address verifyingContract)` (no chainId). Reading the digest from `getTransactionHash` stays correct, but local reconstruction must branch. Add support only if a team runs a legacy Safe; default: target 1.3.0/1.4.1.
- **Passkey / secp256r1 (`v==2`).** Newer Safe WebAuthn signer modules. Needs a P-256 verification path in `verify` and the corresponding word encoding in `order`. Deferred; scoped when a passkey-Safe consumer appears.
- **Exact PulseChain (369/943) Safe addresses.** Canonical singleton / proxyFactory / fallbackHandler must be verified on-chain and pinned (§8) before the EIP-1271 path ships on PulseChain (the fallback handler is what answers `isValidSignature`).
- **`scheme` numeric mapping for `ethSign`.** cosign's codec reserves three scheme numbers (`ECDSA=0`, `EIP1271=1`, `EIP712=2`). `ethSign` is either folded into `ECDSA` (distinguished by the emitted `v>30` byte) or a 4th codec scheme is added. Decided in plan 1 in lockstep with the codec owner so the archivist decodes it correctly.
- **On-chain approvals in the aggregated blob.** §6 reports them but never aggregates them. If a hybrid (off-board + on-chain `approveHash`) blob is ever wanted, that's an additive caller-side concern (build `v==1` words), explicitly not the adapter's job today.

---

### Self-review

- **Placeholder scan** — no `TODO`/`TBD`/`???`/`FIXME`/`XXX` left; every deferred item is named in §12 with a default decision, not a blank.
- **Source fidelity** — every Safe detail is quoted from `safe-global/safe-smart-account` at **v1.4.1** and cross-checked at **v1.3.0** (both verified byte-identical on the domain typehash `0x47e7...9218`, the SafeTx typehash `0xbb83...86d8`, `domainSeparator`, `encodeTransactionData`/`getTransactionHash`, and the full `checkNSignatures` `v`-byte branch). **One correction to the prompt's stated facts is called out explicitly (§4.3, §9):** the on-chain aggregation path (`checkNSignatures`) uses the **legacy** EIP-1271 interface `isValidSignature(bytes,bytes) → 0x20c13b0b` with the full `data` pre-image — **not** the newer `isValidSignature(bytes32,bytes) → 0x1626ba7e` the prompt listed (that magic belongs to the standard 1271 / Safe's fallback handler when a Safe is queried *as* a signer). The adapter mirrors the on-chain path. The domain (no name/version), SafeTx typehash, v-byte scheme (27/28 ECDSA, >30 eth_sign with v-4 + prefix, 0 EIP-1271 offset-tail, 1 approveHash ignored, 2 passkey future), strictly-ascending GS026 dedup, and nonce-binding were all confirmed exactly as stated.
- **Consistency with cosign + Multisigner specs** — `SignatureRecord` tuple `(digest, signer, signature, scheme, meta)`, `aggregate(records, adapter)`, `CosignAdapter` (`verify`/`order`/`owners`/`threshold`), error-propagation rule, `scope = `${chainId}:${address}`` keying, and the "first concrete adapter" framing all match the related specs; positioned as the first *fully-working* concrete adapter alongside Multisigner (bootstrap reference) and Wonderland (separate).
- **Scope / non-goals** — adapter only verifies + orders; building/submitting `execTransaction` is the caller's (§2, §5.4); Tx Service not reimplemented (the board *is* the transport — the differentiator); `v==1` on-chain approveHash ignored for aggregation (reported only, §6); `v==2` passkey deferred; gas-refund/owner-mgmt/modules/guards untouched beyond carrying the tuple in `meta`.
- **Ambiguity** — the digest is pinned once (§4.2, read via `getTransactionHash`); the `v`-byte scheme table and the EIP-1271 offset-tail layout are spelled out (§4.3–4.5); the on-chain-vs-off-chain line is explicit (§2, §6); the `ethSign` scheme-number question is surfaced as a plan-1 decision rather than left implicit.
- **Decomposition** — three plans, Plan 1 (EOA core) strictly first, Plan 2 (EIP-1271 + PulseChain), Plan 3 (safe4337 family), with the core factored for reuse.
