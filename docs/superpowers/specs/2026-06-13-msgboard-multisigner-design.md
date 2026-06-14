# MsgBoard Multisigner — Minimal Bootstrap Multisig + Easy-Button Deploy + cosign Adapter (Design Spec)

> **STATUS: SHELVED (2026-06-13).** Superseded by the decision to NOT build our own multisig and instead support existing off-chain-signature-aggregation multisig tools via cosign adapters (see the cosign SDK spec's adapter roadmap and the Safe adapter spec `2026-06-13-msgboard-cosign-safe-adapter-design.md`). Retained for reference (the EIP-712 multisig + adapter patterns here are useful if we ever revisit), but NOT a current deliverable.

Date: 2026-06-13
Status: Shelved

Related:
- `docs/superpowers/specs/2026-06-13-msgboard-cosign-sdk-design.md` — the `@msgboard/cosign` SDK. That package ships the generic core + the `CosignAdapter` **interface** only (no concrete adapter); concrete adapters are separate deliverables. Multisigner is **one** concrete `CosignAdapter` (the Wonderland adapter — a real, first-class adapter — is another, in its own spec), and Multisigner's EIP-712 transaction digest **is** the `SignatureRecord.digest` that cosign shares and aggregates.
- The msgboard **contract toolchain**: `packages/foundry/` — Foundry (forge build/test/script), Solidity `^0.8.20`–`0.8.24`, minimal deps (libs via `forge install`, no OZ/solady vendored). The existing examples (`PoWGate.sol`, `PoWMint.sol`) set the convention: small, single-file, self-contained contracts with `forge` tests. `packages/hardhat/` is a **TS Hardhat plugin** (not a contracts home); `Multisigner.sol` belongs under Foundry.
- The msgboard **two-store** model (chain = sybil-resistant value/finality; board = zero-cost PoW-gated coordination). Multisigner is the on-chain authority; cosign shares owner signatures off-chain over the board; execution happens on-chain once threshold is met.

---

## 1. Summary

cosign is **integration-only** for teams that already run a multisig (they bring their own `CosignAdapter`). But a team with **no** multisig has nothing to integrate. **Multisigner** is the easy button: a deliberately minimal, cosign-compatible multisig contract plus a one-command deploy, so any team can bootstrap a real on-chain authority and use cosign end-to-end. As a bonus it gives cosign its **first concrete adapter** (cosign itself ships only the `CosignAdapter` interface), making the whole flow demoable.

Three pieces, each minimal:

1. **`Multisigner.sol`** — an owners set + threshold; a canonical **EIP-712 transaction digest** (the value owners sign and cosign shares); self-authorized owner management; and an `execTransaction` verify-and-execute path with a replay nonce. Foundry.
2. **Easy-button deploy** — one command: given `owners[]`, `threshold`, and a chain/RPC, deploy a Multisigner and print its address. "Run at least one multisigner."
3. **`multisignerAdapter`** — the first real `CosignAdapter` in `@msgboard/cosign`: `verify` recovers the owner from the EIP-712 digest and checks owner-set membership; `order` sorts ascending by signer; `owners()`/`threshold()` read the contract. This is what makes `aggregate(records, multisignerAdapter)` produce signatures `execTransaction` accepts.

This is explicitly **not** a Safe competitor (§2). It is the smallest contract that is a correct threshold multisig *and* speaks the cosign digest.

## 2. Goals / non-goals

**Goals**
- A minimal threshold multisig: "at least 1 signer," then owners + threshold, deployable and able to hold funds/permissions.
- A canonical EIP-712 transaction digest, domain-bound to `chainId` + contract address, that doubles as `SignatureRecord.digest`.
- `execTransaction`: verify aggregated owner signatures `≥ threshold`, in ascending-signer order, with a nonce replay guard, then run the call exactly once.
- Self-authorized owner management (add/remove owner, change threshold — the multisig is its own admin).
- A one-command easy-button deploy that prints the address.
- The first real `CosignAdapter` wiring Multisigner into cosign's `aggregate`.

**Non-goals**
- **Competing with Safe / being a full-featured multisig.** No modules, guards, fallback handler, delegatecall library, batched multiSend, gas-refund/relayer-payment accounting, or paymaster. Teams that want those run Safe (or their own) and write their own adapter. Multisigner is a *minimal bootstrap* for teams that have nothing.
- **Custody / asset features beyond `execTransaction`.** No token allow-lists, spending policies, time-locks, social recovery. It can receive and send value via an arbitrary call; that is all.
- **On-chain signature aggregation.** Aggregation is cosign's job off-chain (board); the contract only *verifies* the already-aggregated bytes.
- **EIP-1271 / smart-contract owners** (open item §11) — v1 owners are EOAs (ECDSA recover). The digest/codec already reserve a scheme byte for it.
- **A deploy UI.** The easy button is a CLI/script (§6); a route/UI is deferred (§11).

## 3. The three components

| # | Component | Home | Responsibility | Interface (external surface) |
|---|---|---|---|---|
| 1 | **Multisigner contract** | `packages/foundry/src/Multisigner.sol` | On-chain authority: owners/threshold, the canonical tx digest, verify-and-execute, self-admin. | `getTransactionHash(...) → bytes32`; `execTransaction(to,value,data,nonce,signatures)`; `getOwners() → address[]`; `isOwner(address)`; `threshold()`; `nonce()`; `addOwner`/`removeOwner`/`changeThreshold` (self-call only). |
| 2 | **Easy-button deploy** | `packages/foundry/script/DeployMultisigner.s.sol` (+ a thin TS wrapper if a non-Foundry user is targeted, §6) | Deploy one Multisigner from `owners[]` + `threshold`, print address. | `forge script ... --broadcast` reading `OWNERS` / `THRESHOLD` env (or a viem `deployContract` CLI). Output: deployed address. |
| 3 | **cosign Multisigner adapter** | `packages/cosign/src/adapters/multisigner.ts` | The first real `CosignAdapter`: recover+membership `verify`, ascending `order`, contract reads for `owners`/`threshold`. | `multisignerAdapter(config): CosignAdapter` — `verify(record)`, `order(records)`, `owners()`, `threshold()`. |

The three are independent units with a single shared contract between them: the **EIP-712 transaction digest**. The contract *defines* it (`getTransactionHash`), the adapter *recovers against* it (the digest carried in `SignatureRecord.digest`), and `execTransaction` *re-derives and checks* it. If the three ever disagree on the typed-struct, aggregation produces signatures `execTransaction` rejects — so the struct is pinned once, in §4, and cross-referenced everywhere.

## 4. The Multisigner contract

`packages/foundry/src/Multisigner.sol`, Solidity `^0.8.20` (matches the existing examples; `^0.8.x` gives checked arithmetic for free). No external lib dependency required for v1 — ECDSA recover is `ecrecover`, EIP-712 hashing is `keccak256`/`abi.encode`. (If a vendored helper is wanted later, `forge install` Solady or OZ; not needed for the minimal cut.)

### 4.1 State

```
address[] private _owners;        // canonical owner list (enumerable)
mapping(address => bool) public isOwner;
uint256 public threshold;         // 1 <= threshold <= _owners.length
uint256 public nonce;             // monotonic replay guard, starts at 0
```

`getOwners() → address[]` returns `_owners` (the adapter reads this). Invariants enforced at all mutation points: no zero/duplicate owners, at least one owner, `1 <= threshold <= owners.length`.

### 4.2 EIP-712 domain

```
EIP712Domain(string name, string version, uint256 chainId, address verifyingContract)
name    = "Multisigner"
version = "1"
chainId = block.chainid
verifyingContract = address(this)
```

`chainId` and `verifyingContract` bind every digest to **this** contract on **this** chain — a signature for one Multisigner cannot be replayed against another, or across a fork (§8). The domain separator is computed at the bound chainid (recomputed if `block.chainid` changes, i.e. not cached as `immutable`, to stay correct across a chain split — cheap and minimal).

### 4.3 The canonical transaction-digest typed struct (pinned)

Minimal field set — `to / value / data / nonce`:

```
MultisignerTx(address to,uint256 value,bytes data,uint256 nonce)
```

- `to` — target of the call.
- `value` — wei to send.
- `data` — calldata (empty for a plain ETH transfer; for owner-management, `to == address(this)` and `data` is the encoded `addOwner`/`removeOwner`/`changeThreshold` call — see §4.5).
- `nonce` — must equal the contract's current `nonce` at execution; the replay guard.

The struct hash and the final digest:

```
structHash = keccak256(abi.encode(
    keccak256("MultisignerTx(address to,uint256 value,bytes data,uint256 nonce)"),
    to, value, keccak256(data), nonce
));
digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
```

`getTransactionHash(address to, uint256 value, bytes calldata data, uint256 nonce) → bytes32` returns exactly this `digest`. **This bytes32 is the value owners sign and the value cosign carries as `SignatureRecord.digest`** (cosign codec: `(bytes32 digest, address signer, bytes signature, uint8 scheme, bytes meta)`). `scheme = EIP712 (2)` per the cosign `SCHEME` map; `meta` unused in v1 (`0x`).

> Cross-ref: cosign aggregates by grouping on `record.digest`. All owners must compute the **same** digest for a given `(to,value,data,nonce)`, which they get by calling `getTransactionHash` (or recomputing the struct identically). The adapter's `verify` recovers against `record.digest` directly — it does not re-derive the struct (it trusts the digest as the signed message and only checks signer membership; §5, §8).

### 4.4 `execTransaction`

```
function execTransaction(
    address to,
    uint256 value,
    bytes calldata data,
    uint256 txNonce,
    bytes calldata signatures   // aggregated, ascending-signer-concatenated 65-byte sigs
) external returns (bool success)
```

Steps:
1. `require(txNonce == nonce)` — replay guard.
2. `digest = getTransactionHash(to, value, data, txNonce)`.
3. Walk `signatures` in 65-byte chunks; for each, `ecrecover(digest, v, r, s) → signer`. Enforce **strictly ascending** `signer` across chunks (`signer > lastSigner`) — this both fixes a canonical order and **dedups** in one check (equal/descending reverts), and require `isOwner[signer]`. Count valid owner sigs.
4. `require(count >= threshold)`.
5. `nonce++` **before** the external call (checks-effects-interactions; the nonce is consumed even if the call reverts on a non-reverting path — but see note: we revert on call failure, so the increment + call are atomic; the point is no re-entrant reuse of the same nonce).
6. `(success, ) = to.call{value: value}(data); require(success)`.
7. `emit Executed(digest, to, value, txNonce)`.

Minimal-cut decisions: only `CALL` (no `delegatecall` operation byte — Safe's `Enum.Operation` is omitted); signature payload is plain concatenated 65-byte ECDSA sigs (no EIP-1271 contract-signature `v==0` packed-data path in v1, §11); no `safeTxGas`/`baseGas`/`gasPrice`/`refundReceiver`. The aggregated `signatures` blob is exactly what cosign's `aggregate(records, multisignerAdapter)` yields, concatenated in adapter `order` (ascending signer).

### 4.5 Owner management (self-authorized)

```
function addOwner(address owner, uint256 newThreshold) external onlySelf;
function removeOwner(address owner, uint256 newThreshold) external onlySelf;
function changeThreshold(uint256 newThreshold) external onlySelf;
```

`onlySelf = require(msg.sender == address(this))`. The **only** way to call these is *through* `execTransaction` with `to == address(this)` and `data` = the encoded admin call — i.e. owner changes themselves require a threshold of owner signatures over a `MultisignerTx`. This keeps a single authority path (no separate admin role) and is the minimal correct design: the multisig governs itself. Each mutation re-checks the §4.1 invariants. Changing the owner set **invalidates in-flight digests for unrelated txs only via the nonce, not directly** — see §8 for the membership-change hazard and the mitigation (removed owners' signatures stop counting because `isOwner` is read at exec time).

### 4.6 Constructor

```
constructor(address[] memory owners_, uint256 threshold_)
```

Validates: `owners_.length >= 1`, no zero/duplicate, `1 <= threshold_ <= owners_.length`. Sets state. Emits `Setup(owners_, threshold_)`. This is what the easy-button deploy (§6) calls. "At least 1 signer" is the floor (`owners_.length >= 1`, `threshold_ >= 1`) — a 1/1 Multisigner is valid and is the smallest possible bootstrap.

### 4.7 Receiving value

A `receive() external payable {}` so the Multisigner can hold ETH (it is an on-chain authority that owns funds). No ERC-20 hooks needed — tokens are moved by `execTransaction` calling `transfer` on the token (arbitrary call covers it).

## 5. The cosign adapter for Multisigner

`packages/cosign/src/adapters/multisigner.ts`, implementing the cosign `CosignAdapter` interface (`verify` / `order` / `owners` / `threshold`) from the cosign SDK spec §4.

```ts
multisignerAdapter(config: {
  multisig: Hex;          // deployed Multisigner address
  chainId: number;        // for scope + sanity (digest is already domain-bound on-chain)
  publicClient: PublicClient;  // viem read-only client
}): CosignAdapter
```

Mapping to contract reads + ECDSA recovery:

- **`verify(record)`** — recover the signer from the signed digest and confirm owner-set membership:
  1. `recovered = recoverAddress({ hash: record.digest, signature: record.signature })` (viem; `record.digest` is the EIP-712 digest produced by `getTransactionHash`, so the recovered address is the EOA that signed that digest).
  2. `recovered === record.signer` (the record's claimed signer matches the recovery — reject mismatches rather than trusting `record.signer`).
  3. `isOwner = await publicClient.readContract({ address: multisig, abi, functionName: 'getOwners' })` then membership-check (or call `isOwner(recovered)` directly — `getOwners()` is specified by the prompt and lets `owners()` reuse the same read). Return `true` iff `recovered` is in the owner set.
  - Errors (RPC failure) **propagate** per cosign §6 — not silently `false`.
  - v1 handles `scheme === ECDSA`/`EIP712` (both recover via `ecrecover` over the digest); `EIP1271` records are rejected/deferred (§11).
- **`order(records)`** — sort **ascending by `signer`** (compare as lowercased hex / bigint). This is the standard multisig concat order and is exactly what `execTransaction` requires (strictly-ascending walk, §4.4). cosign's `aggregate` returns `{signer, signature}[]` in this order; the caller concatenates `signature` bytes to form the `execTransaction` `signatures` arg.
- **`owners()`** — `readContract getOwners() → Hex[]`.
- **`threshold()`** — `readContract threshold() → number`.

Plugging into cosign: `aggregate(records, multisignerAdapter(config))` (cosign §4 `client.ts`) keeps records where `verify` is true, then applies `order`. The result, concatenated, is the `signatures` blob for `execTransaction`. The cosign **scope** convention for this adapter is pinned as `('multisig', \`${chainId}:${multisig}\`)` (resolving cosign open-item §9) so the rotating category key is per-deployment.

The adapter ships a minimal ABI fragment (`getOwners`, `isOwner`, `threshold`, `getTransactionHash`) — it does not import Foundry artifacts; it declares the four read signatures inline (viem `abi` array), matching how cosign keeps adapters dependency-light.

## 6. Easy-button deploy

**Inputs:** `owners[]` (addresses), `threshold` (uint), chain/RPC (+ a deployer key). **Output:** the deployed Multisigner address (printed; "run at least one multisigner").

**Primary path — Foundry forge script** (matches the repo's existing `script/PostMessage.s.sol` convention):

`packages/foundry/script/DeployMultisigner.s.sol`:
- Reads `OWNERS` (comma-separated) and `THRESHOLD` from env (`vm.envAddress`/`vm.envUint` array forms), broadcasts `new Multisigner(owners, threshold)`, and `console2.log`s the address.

```sh
OWNERS=0xabc...,0xdef... THRESHOLD=2 \
  forge script script/DeployMultisigner.s.sol \
  --rpc-url "$RPC_URL" --private-key "$PK" --broadcast -vvv
```

That single command **is** the easy button for a Foundry user.

**Optional TS wrapper (deferred unless a non-Foundry consumer needs it):** a tiny CLI in `packages/cosign` (or a `packages/multisigner-cli`) using `viem` `deployContract` with the compiled `Multisigner` bytecode/ABI — so a team using only the TS SDK can `npx multisigner deploy --owners a,b,c --threshold 2 --rpc <url>` without installing Foundry. Decision: **ship the forge script first** (zero new package, reuses the contract's own toolchain), add the viem CLI only if demand from TS-only users appears (YAGNI). Both paths call the same constructor (§4.6); neither adds contract surface.

**UI / route — out of scope (§11).** The easy button is a command, not a page. A deploy route in `packages/ui` is a later, additive nicety; the CLI/script is sufficient to "run at least one multisigner."

## 7. End-to-end data flow

```
1. DEPLOY     forge script DeployMultisigner  → Multisigner @ 0xMS (owners O1..On, threshold t)
                 (one command — §6)
2. PROPOSE    someone picks (to, value, data, nonce=current); computes
                 digest = Multisigner.getTransactionHash(to,value,data,nonce)   (§4.3)
3. SIGN       each owner Oi signs `digest` (EIP-712) and
                 cosign.postSignature(board, { namespace:'cosign'|'multisig',
                    scope:`${chainId}:0xMS`, record:{ digest, signer:Oi, signature, scheme:EIP712 } })
                 → posted under today's rotating category key (cosign §4 keys.ts)
4. COLLECT    anyone: records = cosign.readSignatures(board,{ scope, days:7 })   (§4 client.ts)
                 perDigest = groupByDigest(records).get(digest)
5. AGGREGATE  ordered = await cosign.aggregate(perDigest, multisignerAdapter({multisig:0xMS,...}))
                 → [{signer,signature}] ascending; verify() recovered each owner from `digest`
                    and confirmed membership via getOwners() (§5)
6. EXECUTE    sigBlob = concat(ordered.map(o => o.signature))
                 Multisigner.execTransaction(to,value,data,nonce,sigBlob)  on-chain  (§4.4)
                 → checks count>=threshold, ascending owners, nonce, runs the call, nonce++
```

Two-store fit: steps 3–5 are **board-only** (cosign, ~zero reader cost, PoW sender cost; the signature is self-authenticating). Steps 1, 2, 6 touch the **chain** (deploy, read-for-digest, execute) — value/finality. cosign never writes the chain; the chain is read in step 2 (digest) and step 5 (owner-set, by the adapter), written only in step 6.

## 8. Security

- **Threshold enforcement** — `execTransaction` reverts unless `count(valid owner sigs) >= threshold`. `count` only increments for `isOwner[recovered]` signers; non-owner sigs don't count.
- **Ascending-signer order + dedup in one check** — the strictly-ascending walk (`signer > lastSigner`) rejects duplicate signatures (same owner signing twice can't inflate the count) and fixes a canonical order. The adapter's `order` (§5) produces exactly this order, so honest aggregation always passes the on-chain check; a malformed/reordered blob reverts.
- **Nonce replay** — `txNonce == nonce` required, `nonce++` on execute. A given `(to,value,data,nonce)` digest is executable exactly once; replaying the same signatures reverts (nonce moved). Owners signing the *next* tx must use the incremented nonce, so a stale aggregated blob is dead.
- **Owner-set change invalidating in-flight digests** — the subtle case. Owner-management changes the *owner set* and the *nonce* (it executes via `execTransaction`). After an owner is removed: (a) any digest with the old `nonce` is dead (nonce moved); (b) even if a new tx reuses a removed owner's previously-collected signature, `isOwner` is read **at exec time**, so the removed owner no longer counts toward threshold. After an owner is added: in-flight digests already at the (now consumed) nonce are dead; new digests at the new nonce naturally admit the new owner. There is no path where a stale signature from a no-longer-owner satisfies threshold — membership is evaluated live, never snapshotted into the digest.
- **EIP-712 domain binding** — `chainId` + `verifyingContract` in the domain (§4.2) mean a signature for Multisigner A on chain X cannot satisfy Multisigner B or chain Y. Domain separator is recomputed against `block.chainid` (not cached immutable) so a post-fork chain split doesn't let mainnet signatures execute on the fork.
- **Self-authorized admin** — owner-management is reachable **only** via `address(this)` (`onlySelf`), i.e. only through a threshold-approved `execTransaction`. No EOA admin, no upgrade hatch (the contract is non-upgradeable — minimal, no proxy).
- **Reentrancy** — checks-effects-interactions: `nonce++` and all owner checks happen before the external `call`. A reentrant call would see the incremented nonce and a fresh digest requirement, not a reusable one.
- **`ecrecover` malleability / `v` handling** — accept canonical `v ∈ {27,28}`; reject `s` in the upper half (EIP-2 low-s) to avoid signature malleability double-counting, since the ascending-signer dedup keys on recovered address (malleated sigs recover the same address, so they'd be caught by the ascending check anyway, but low-s is enforced for cleanliness).
- **Non-goal hardening** — no module/guard/delegatecall attack surface exists because those features are absent (§2). The arbitrary `call` in `execTransaction` is the intended power of a multisig; it is gated entirely by threshold.

## 9. Testing

**Contract (Foundry — `packages/foundry/test/Multisigner.t.sol`, deterministic CI like the existing example tests):**
- `constructor` validation: rejects empty owners, zero owner, duplicate owner, `threshold==0`, `threshold>owners`. Accepts 1/1.
- `getTransactionHash` matches a hand-computed EIP-712 digest fixture (and is stable across calls).
- `execTransaction` happy path: t valid ascending sigs → call runs, nonce increments, `Executed` emitted, target observed the call (deploy a tiny `Target` test contract).
- Threshold: `t-1` sigs revert; `t` sigs pass; extra (`t+1`) sigs pass.
- Order/dedup: descending or duplicate signer reverts; same owner twice reverts.
- Non-owner signature: doesn't count toward threshold (revert if it was needed).
- Nonce replay: re-submitting an executed `(…,nonce)` reverts; correct next-nonce passes.
- Owner management via `execTransaction`: `addOwner`/`removeOwner`/`changeThreshold` succeed only through a threshold-signed self-call; direct external call reverts (`onlySelf`); a removed owner's signature stops counting on the next tx.
- Value: `receive()` accepts ETH; `execTransaction` sends `value`.
- Use forge's `vm.sign` with deterministic test keys to build ascending sig blobs.

**Adapter (`packages/cosign/test/multisigner.test.ts`, vitest, mirroring cosign's adapter tests):**
- `verify`: a correctly-signed record for a known owner → `true`; non-owner signer → `false`; `record.signer` mismatching the recovery → `false`; RPC error propagates (not silent `false`).
- `order`: shuffled records sorted strictly ascending by signer; output order equals the on-chain-required order.
- `owners()`/`threshold()`: return the deployed values.
- Drive against a **deployed Multisigner on a local chain** (anvil) or a fork — viem `publicClient` reads `getOwners`/`threshold`; or, for the pure-unit cut, a mocked `publicClient` returning fixed `getOwners`/`threshold` so `verify`/`order` are testable without a node (matches cosign's "fake board" testability philosophy).

**End-to-end (`packages/cosign/test/e2e.multisigner.test.ts` or a Foundry+TS harness):**
- Full §7 flow on anvil: deploy → `getTransactionHash` → owners `postSignature` to a **fake board** (cosign's fake transport) → `readSignatures` → `aggregate(records, multisignerAdapter)` → `concat` → `execTransaction` succeeds and the target call ran. This is the demoable proof that cosign + Multisigner close the loop.

## 10. Decomposition into sequenced plans

- **Plan 1 — `Multisigner.sol` + Foundry tests.** The contract (state, EIP-712 domain + `MultisignerTx` digest, `execTransaction`, owner-management, constructor, `receive`) and the full §9 contract test suite. Self-contained; no TS dependency. Lands the canonical digest the other two plans depend on. **Do first** (it pins the digest contract).
- **Plan 2 — `multisignerAdapter` in `@msgboard/cosign`.** The first real `CosignAdapter` (§5) + adapter unit tests (mocked client) + an anvil/fork integration test. Depends on Plan 1's digest scheme + ABI. Makes `aggregate` produce `execTransaction`-ready sigs.
- **Plan 3 — Easy-button deploy + e2e.** `DeployMultisigner.s.sol` forge script (§6) and the §9 end-to-end test wiring deploy → cosign → exec. Depends on Plans 1 and 2. (Optional viem-CLI wrapper deferred to a follow-up unless a TS-only consumer needs it.)

Plans 2 and 3 could be combined if Plan 1 lands cleanly, but keeping the adapter (pure cosign concern) separate from deploy/e2e (integration concern) keeps each reviewable. Plan 1 is strictly first.

## 11. Open items

- **EIP-1271 / smart-contract owners.** v1 owners are EOAs (ECDSA recover). Supporting contract owners means a packed-signature/contract-signature path in `execTransaction` (Safe-style `v==0` data sigs) and an `isValidSignature` call in the adapter. The cosign codec already reserves `scheme = EIP1271 (1)`; the on-chain + adapter support is deferred. Decide before any team needs a Safe-as-owner.
- **Gas / relaying of `execTransaction`.** v1 has no gas refund or relayer-payment accounting (a non-goal, §2). Whoever submits `execTransaction` pays gas. If meta-tx/relay is wanted, it's an additive layer (e.g. the msgboard relayer or a paymaster), not a contract change for v1.
- **Wonderland is its own real, first-class adapter (separate spec, pending their contract details).** This spec adds `multisignerAdapter`; it does **not** implement Wonderland (cosign §9 open item). The Multisigner adapter specced here is one concrete `CosignAdapter`, the Wonderland adapter is another — both implement the same interface. Multisigner is the reference implementation a future Wonderland adapter can mirror.
- **`scope`/`namespace` convention.** Pinned here as `('multisig', \`${chainId}:${multisigAddress}\`)` for the Multisigner adapter (resolves cosign §9). Confirm this matches whatever the cosign archivist registry expects.
- **viem deploy CLI.** Whether to ship the TS `npx multisigner deploy` wrapper (§6) now or defer. Defaulting to defer (forge script suffices); revisit if TS-only users ask.
- **Where the TS adapter lives if cosign isn't the right home.** Assumed `packages/cosign/src/adapters/multisigner.ts` (importing cosign's `CosignAdapter` interface; cosign ships no concrete adapter of its own). If adapters should be their own packages later, this moves; for the minimal cut it ships inside cosign.

---

### Self-review

- **Placeholder scan** — no `TODO`/`TBD`/`???`/`FIXME` left; every "deferred" item is named in §11 with a default decision, not an open blank.
- **Consistency with cosign spec** — `SignatureRecord` tuple `(bytes32 digest, address signer, bytes signature, uint8 scheme, bytes meta)`, `SCHEME.EIP712 = 2`, `CosignAdapter` (`verify`/`order`/`owners`/`threshold`), `aggregate(records, adapter)`, error-propagation rule, and `scope`/`namespace` keying all referenced as defined there; Multisigner's `getTransactionHash` digest is explicitly the `record.digest`. The adapter is positioned as the first concrete adapter (cosign ships the interface only); the Wonderland adapter is its own real, first-class adapter in a separate spec — matches cosign §1/§9.
- **Consistency with the repo toolchain** — contract + deploy script under `packages/foundry/` (Foundry, `^0.8.20`, `forge script` convention from `PostMessage.s.sol`, no OZ/solady dependency); adapter under `packages/cosign` (viem, vitest) — matches existing package conventions. Noted that `packages/hardhat` is a TS plugin, not a contracts home, and that `packages/cosign` is the not-yet-built SDK from the related spec.
- **Scope / YAGNI** — explicit non-goals (no Safe feature set, no custody, no on-chain aggregation, no UI, EIP-1271/relay deferred); contract is the minimal correct threshold multisig (CALL-only, concat ECDSA sigs, single self-admin path); deploy is one command; the viem CLI is deferred. "At least 1 signer" floor stated (1/1 valid).
- **Ambiguity** — the digest is pinned once (§4.3) and the three components are explicitly tied to it (§3); the owner-set-change-vs-stale-signature hazard is resolved (membership read live at exec, §8); execution/board boundary is explicit (§7 two-store note).
- **Decomposition** — three sequenced plans, Plan 1 (contract+digest) strictly first; merge guidance given.
