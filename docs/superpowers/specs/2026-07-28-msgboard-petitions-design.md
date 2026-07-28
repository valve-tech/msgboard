# MsgBoard Petitions — Design

**Date:** 2026-07-28
**Status:** Approved (brainstorm) — pending spec review
**Scope:** One spec, build in parallel where possible. Chains: **369 = real users/data, 943 = bots/testing/demo**.

## Summary

A **petition** is a public statement anyone can co-sign. MsgBoard Petitions is a standalone,
board-native app where:

1. A creator posts a petition statement to the board.
2. Anyone signs it with their wallet (an EIP-712 signature, no gas). The signature is PoW-stamped
   to the board and, once confirmed present in the archive, is **captured**.
3. Any user can then permissionlessly **settle** outstanding (captured-but-not-yet-on-chain)
   signatures to a minimal on-chain verifier contract, giving them hard finality.

The board is the cheap, instant, verifiable source of truth for capture; the chain is an opt-in
finality/composability layer that *any* participant can push to. Signatures are self-verifying:
because the signed EIP-712 digest binds `(petitionId, statement)`, both a board reader and the
contract recompute the same digest and recover the same signer — you cannot forge a count or settle
a signature for a statement that differs from what was signed.

This reuses the machinery already running in production: the `@msgboard/cosign` `SignatureRecord`
codec + rotating category keys, the `@msgboard/history` archivist read-side, the generic board→
Postgres archive indexer, the Ponder on-chain indexer (`games/indexer`), the Foundry contract
home + deploy pattern (`games/contracts`), and the `cosign-web` UI template.

### The signature lifecycle (the spine)

```
SIGNED     wallet signs the petition's EIP-712 digest              (no gas, no post yet)
 → POSTED  PoW-stamped SignatureRecord to petition:<id> category   (off-main-thread worker)
 → CAPTURED frontend confirms it landed in the archive             (counts toward the board tally)
 → SETTLED  any user's submitBatch tx → contract verifies+records  (counts toward the on-chain tally)
```

**Outstanding = CAPTURED − SETTLED.** The settle button submits the outstanding set.

### The three tracking layers ("2 indexers, 3 with the archive")

1. **Archive** (existing, unchanged) — the generic board→Postgres `message_archive` indexer. Every
   board message, including petition categories, is recorded here. This is what "captured" is
   confirmed against.
2. **Capture read-side** (board side) — `@msgboard/history` petition routes serving the petition
   **directory** and per-petition **captured** tallies (deduped by signer), unioning live board +
   archive. Reuses the cosign handler pattern.
3. **Settlement indexer** (chain side) — a Ponder handler watching the verifier contract's `Signed`
   events on 369 + 943, recording `(petitionId, signer, tx, block, chainId)`. Reconciled against the
   capture read-side to compute the outstanding set.

## Components

### 1. `@msgboard/petition` (new core package — pure board + crypto)

Mirrors `@msgboard/cosign`: zero chain writes, no UI, fully unit-testable. Depends on
`@msgboard/cosign` (for `SignatureRecord`, `encodeRecord`/`decodeRecord`, `keysForWindow`,
`categoryKey`) and `viem`.

**Petition descriptor**
```ts
interface Petition {
  id: Hex            // petitionId
  statement: string  // the exact text signers endorse
  creator: Hex       // creator address
  createdAt: number  // unix seconds (client-stamped)
  chainId: number    // 369 | 943 — the settlement chain this petition targets
  salt: Hex          // random bytes32, so identical text ≠ same petition
}
```
`derivePetitionId(statement, creator, salt) = keccak256(abi.encode(string, address, bytes32))`.
The descriptor is ABI-encoded (`encodePetition`/`decodePetition`) and posted to the **registry
category**.

**Categories** (via cosign key scheme `namespace:scope:isoDay`):
- Registry/directory: `namespace="petition"`, `scope="index"` — creation descriptors land here.
- Per-petition signatures: `namespace="petition"`, `scope=petitionId` (hex) — `SignatureRecord`s land here.

Day-bucketed; readers sweep an N-day window via `keysForWindow`. A petition's `createdAt` bounds how
far back the window must sweep for a complete tally.

**EIP-712 digest** (the exact preimage the contract recomputes):
- Domain: `{ name: "MsgBoard Petition", version: "1", chainId, verifyingContract }` where
  `verifyingContract` is the `PetitionSignatures` address on that chain.
- Type: `Petition(bytes32 petitionId,string statement)`.
- `petitionDigest(petition, verifyingContract)` returns the EIP-712 hash. **Chain-scoped**: a 943
  signature cannot validate on 369 and vice versa (domain differs) — bot traffic on 943 cannot
  pollute the 369 real tally.

**Functions**
- `derivePetitionId`, `encodePetition`/`decodePetition`, `petitionDigest`.
- `createPetition(board, petition)` — post the descriptor to `petition:index`.
- `signPetition(board, petition, walletSign)` — build the digest, get the wallet signature, post a
  `SignatureRecord` (scheme `EIP712`) to `petition:<id>`.
- `readPetitions(source, days)` — decode the directory from the registry category.
- `readSignatures(source, id, days)` + `tally(records)` — dedup by signer (latest wins), count.
- `verifySignature(petition, record, verifyingContract)` — recompute digest, recover signer, assert
  equality. Tamper → reject.
- Contract helpers: `PETITION_SIGNATURES_ABI`, `buildSubmitArgs`, `buildSubmitBatchArgs`.

`source` is a small interface (`{ readCategory(hash): Promise<Message[]> }`) so the same functions
run against a live board client, the archivist read-side, or a test fixture.

### 2. `PetitionSignatures` contract (Solidity, `games/contracts/contracts/`)

Deliberately minimal, permissionless, ownerless, holds no funds — so any funded EOA (valve_deployer)
can deploy it, like `StealthMessenger`.

```solidity
// EIP-712 domain: name "MsgBoard Petition", version "1"; chainId + address(this) via _hashTypedDataV4.
// Type: Petition(bytes32 petitionId,string statement)
mapping(bytes32 => mapping(address => bool)) public signed;   // petitionId => signer => recorded
mapping(bytes32 => uint256) public count;                     // petitionId => distinct signer count

event Signed(bytes32 indexed petitionId, address indexed signer);

function submit(bytes32 petitionId, string calldata statement, address signer, bytes calldata signature) public;
function submitBatch(bytes32 petitionId, string calldata statement, address[] calldata signers, bytes[] calldata signatures) external;
```

- `submit` recomputes `digest = _hashTypedDataV4(hashStruct(petitionId, statement))`, `ECDSA.recover`s
  it, requires the recovered address `== signer`. On success and if not already `signed`, sets
  `signed[petitionId][signer] = true`, `count[petitionId]++`, emits `Signed`.
- Because the digest binds `(petitionId, statement)`, a mismatched statement recovers to a different
  address → the `== signer` check reverts. Self-verifying.
- `submitBatch` loops; **skips** already-signed pairs (no revert) so a partially-settled batch still
  makes progress and is safe to retry; verifies + records the rest.
- Uses OpenZeppelin `EIP712` + `ECDSA` (already vendored for the games contracts).
- **Deploy order matters**: deploy on each chain *first*, then the `@msgboard/petition` EIP-712 domain
  uses the resulting address — so board-side signing and on-chain verification share one digest.
- Deploy script `games/contracts/scripts/deploy-petition.ts` mirrors `deploy-stealth.ts`
  (Foundry artifact bytecode, 943/369 base-fee + tip legacy-fee pattern, `DEPLOY_EXECUTE` gate,
  `PRIVATE_KEY=valve_deployer` or `MNEMONIC`). Deployed addresses recorded in a committed
  `deployments` map consumed by the core package + indexer + UIs.

**EIP-1271 (smart-contract wallets)** is out of scope for the MVP (EOA/ECDSA only); the `signer`
param + scheme field leave room to add it later.

### 3. `packages/petition-web` (standalone React + Vite + Tailwind app)

Mirrors `cosign-web` plumbing: `seams/worker-board.ts` (board client that runs PoW in a Web Worker —
**PoW never on the main thread**, per the enforced guard), `worker/pow-worker.ts`, `hooks/useWallet.ts`
(injected EIP-1193), `lib/archive.ts` (archivist read-side client), `components/Menu.tsx` + `ui.tsx`
(house components — **no native form controls**).

**Flows**
- **Directory** — petitions from the read-side: statement, creator, `captured` / `on-chain` counts,
  createdAt. Chain selector (369 default; 943 for the bot/demo view). Dynamic batching for large
  counts (see below).
- **Create** — statement text → generate `salt`, derive `id` → post descriptor (PoW) → poll archive
  until captured → petition appears.
- **Detail** —
  - Live tally: **captured / on-chain / outstanding**.
  - Signer list, **virtualized**, rendered in **dynamic batches** (see below).
  - **Sign** → wallet signs the EIP-712 digest → post `SignatureRecord` (PoW) → poll the read-side
    until the signer appears → `captured ✓`.
  - **Settle outstanding on-chain** → fetch outstanding (captured − settled) → `buildSubmitBatchArgs`
    → send `submitBatch` tx via wallet (explicit EIP-1559 fees) → follow the settlement indexer until
    the on-chain count catches up.
  - **Verify** panel → recompute the digest from the displayed statement, recover each signer, dedup,
    count — entirely client-side, independent of the index. Proves the tally.
- **Threshold = purely presentational.** No indexer coupling. Visual tiers/milestones as counts grow.

**Dynamic batching (the "hundreds / thousands" requirement).** Signature rendering and fetching must
scale: the read-side returns counts + paginated pages; the UI virtualizes the signer list and renders
in incremental batches (e.g. reveal in blocks of N, aggregate tiers like "1.2K signed" past a
threshold), so a petition with thousands of signatures stays responsive and milestones read visually.
Batching is a UI concern only.

### 4. `@msgboard/history` petition read-side (capture indexer / query)

New route group mirroring the cosign router/handler/categories/fetch modules:
- `GET /petition/index?days=N` → directory (decode descriptors from `petition:index`, board ∪ archive).
- `GET /petition/:id/signatures?days=N` → captured `SignatureRecord`s (reuse cosign fetch with
  `namespace=petition`, `scope=id`), with pagination for large sets.
- `GET /petition/:id/tally?days=N` → deduped signer count (+ optional page of signers).

Served by the same archive server the cosign archivist uses. **No change to the generic archive
write-side** — it already records petition categories.

### 5. Settlement indexer (chain side — Ponder)

A new `games/indexer/src/petition.ts` handler + `ponder.schema.ts` rows + `ponder.config.ts`
registration for `PetitionSignatures` on **369 and 943**:
```
on('PetitionSignatures:Signed', ...) → insert { id: `${chainId}-${petitionId}-${signer}`,
  chainId, petitionId, signer, blockNumber, txHash }  (onConflictDoNothing → idempotent)
```
Exposes a GraphQL/HTTP read of settled `(petitionId, signer)` pairs + counts per chain. The UI (and a
combined read-side endpoint, if convenient) reconcile: **outstanding = captured − settled**.

### 6. Petition bot actor (943 — fleet service)

Mirrors `landing-house` / `chip-faucet` (`games/e2e` actor + ansible fleet service). On 943 it:
- creates one or more demo petitions (posted to `petition:index`),
- signs them from a set of mnemonic-indexed bot keys (each key = one signer; drives capture),
- periodically settles outstanding signatures via `submitBatch` (explicit fees).

This proves the full capture→settle→index loop end-to-end and seeds live demo data on 943 without
waiting on real people. Bot keys, chain, target petitions, and cadence are env-configured. Real
petitions on 369 are untouched by this (separate chain + domain).

### 7. msgboard.xyz Petitions widget (`packages/ui`)

A new tab in the landing app alongside **Channel / ZK Chat / Mechanics** (in `TryIt.tsx`) and
**Arcade**: a compact **browse-and-sign-inline** widget. Reuses `@msgboard/petition` core + the worker
board + wallet helper already bundled in `packages/ui` (the app already bundles the games engine and
ZK assets, so adding the light petition core is consistent). Shows a featured/curated petition or a
small directory, signs inline (PoW off-thread), links out to the full `petition.msgboard.xyz` app.

### 8. Ecosystem / use-cases entry (`packages/ui`)

Add **Petitions** to the ecosystem/use-cases presentation (`Ecosystem.tsx` / `ProtocolComparison.tsx`)
— a card describing petitions as a board use case (co-signed public statements, verifiable tally,
permissionless on-chain finality). Also advances the standing "abilities list" TODO by showing another
live use case.

### 9. Deployment (ansible)

Mirror `deploy-cosign.yml`:
- `petition-web` service (same monorepo image, `npm run start -w packages/petition-web` → vite
  preview) + Caddy block for **`petition.msgboard.xyz`** (origin cert; safe reload + non-empty-body
  smoke, per the `valve-caddy-config` skill and the "brand-new host block" caddy-restart learning).
- Settlement indexer wired into the existing `games/indexer` Ponder deployment (add the contract +
  chain config).
- Petition read-side enabled on the archive server (same box as the cosign archivist).
- Petition bot actor added to the games-actors fleet (943).
- Contract deploy on 943 + 369 via valve_deployer (per the deployer rule: never gibs; base-fee gas).
- `packages/ui` rebuild (widget + ecosystem) via `deploy-msgboard-ui.yml`.

## Data flow

- **Create**: statement → `salt`,`id` → descriptor to `petition:index` (PoW) → archived → directory.
- **Sign**: wallet signs EIP-712`(id, statement)` → `SignatureRecord` to `petition:<id>` (PoW) →
  archived → *captured*; UI polls read-side until the signer appears.
- **Settle**: any user reads outstanding → `submitBatch` on the petition's chain → contract
  verifies/records/emits `Signed` → settlement indexer ingests → *on-chain* count rises.
- **Verify**: client recomputes digest from statement, recovers each signer, dedups, counts —
  trustless, index-independent.

## Error handling

- **Board-write flakiness** (known valve.city `msgboard_addMessage` quirk: returns an internal error
  but the message usually lands): retry + poll-regardless; treat capture as confirmed by archive
  presence, not by the write RPC's response.
- **Capture confirmation**: poll the read-side with a timeout; distinguish `pending` vs `captured`.
- **Gas / fees**: explicit EIP-1559 (or legacy base-fee + tip) on 943 **and** 369 — never the node's
  ~100k-gwei `eth_gasPrice` suggestion. Base ~7 wei + ~0.5–2 gwei tip (the faucet/house gas lesson).
- **Duplicate settle**: contract skips already-signed pairs → safe to re-run `submitBatch`; the batch
  makes forward progress on the rest.
- **Statement / id mismatch**: signature fails verification on the board (`verifySignature` rejects)
  *and* reverts on-chain — fail-loud on both sides.
- **Signer dedup**: by address, latest wins; signing twice = one captured signature.
- **Sybil (known MVP limitation)**: dedup-by-address + PoW anti-spam only; a determined actor can make
  many addresses. Documented; the ZK-anon membership path (Semaphore, like ZK Chat) is the future
  anti-Sybil answer and the record's `scheme`/`meta` fields leave room for it.

## Testing

- **`@msgboard/petition`**: units for `derivePetitionId`, `petitionDigest`, descriptor + record codec
  round-trips, `tally` dedup, `verifySignature` (tamper → reject).
- **Digest parity** (critical): the core `petitionDigest` equals the contract's `_hashTypedDataV4` for
  the same inputs (cross-check a fixture in the contract test suite and the core test suite against the
  same expected hash).
- **Contract** (`games/contracts/test/PetitionSignatures.test.ts`): valid signature records + emits;
  wrong statement reverts; wrong signer reverts; duplicate skipped (no revert, no double-count); batch
  with a mix of new/duplicate; permissionless (arbitrary `msg.sender`).
- **Cross-consistency**: a signature produced by `@msgboard/petition` validates on-chain (drive the
  contract test with a core-generated signature) — guarantees the two halves agree.
- **Read-side** (`@msgboard/history`): petition directory + tally routes, board ∪ archive union,
  pagination.
- **Settlement indexer**: event ingestion + idempotent keys + reconciliation (outstanding math).
- **petition-web**: create / sign→capture / settle / verify flow tests (mirroring cosign-web), plus
  the **PoW-never-main-thread** guard test.
- **Bot actor**: a dry-run/e2e that creates → signs → settles against a local/testnet deployment.

## Build parallelization (sonnet subagents)

Pin the **shared interface first** (single small task): EIP-712 domain + `Petition` type,
`derivePetitionId`, `SignatureRecord` usage, `PETITION_SIGNATURES_ABI`, category scheme, and the
`deployments` address map shape. Everything below consumes only that interface, so they fan out:

- **A** — `@msgboard/petition` core + tests.
- **B** — `PetitionSignatures` contract + deploy script + contract tests.
- **C** — `@msgboard/history` petition read-side + tests.
- **D** — settlement indexer (Ponder handler + schema + config) + tests.
- **E** — `packages/petition-web` app (mocked seams against the interface until A lands).
- **F** — petition bot actor + ansible fleet wiring.
- **G** — `packages/ui` widget + ecosystem/use-cases entry.
- **H** — ansible: `petition-web` service + `petition.msgboard.xyz` Caddy block + indexer/read-side wiring.

A and B must agree on the digest (digest-parity test gates their merge). C/D/E can proceed against the
interface and the `deployments` map; E and G share petition-core UI patterns. H and the contract
deploy come last (after A/B/C/D are green).

## Open items

- **Subdomain**: `petition.msgboard.xyz` (default). Alternative: `sign.msgboard.xyz`.
- **369 real deploy**: gated on user confirmation to deploy the verifier on mainnet (943 first with
  bots to prove the flow, then 369 for real users).
