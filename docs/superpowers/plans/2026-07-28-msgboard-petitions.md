# MsgBoard Petitions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A board-native petitions app: anyone posts a statement, anyone co-signs it with an EIP-712 wallet signature (PoW-stamped to the board = *captured*), and any user can permissionlessly settle captured signatures to a minimal on-chain verifier contract (= *on-chain*).

**Architecture:** Board is the cheap verifiable source of truth for capture; a minimal `PetitionSignatures` EIP-712 verifier contract gives permissionless on-chain finality. One signed digest binds `(petitionId, statement)` and validates identically board-side and on-chain. Reuses `@msgboard/cosign` (SignatureRecord + rotating category keys), `@msgboard/history` (archivist read-side), the Ponder on-chain indexer (`games/indexer`), the Foundry contract home (`games/contracts`), and the `cosign-web` UI template.

**Tech Stack:** TypeScript, viem, vitest, React + Vite + Tailwind, Solidity (Foundry, OpenZeppelin EIP712 + ECDSA), Ponder, ansible.

## Global Constraints

- **Chains:** 369 = real users/data; 943 = bots/testing/demo. EIP-712 domain includes `chainId` + `verifyingContract`, so signatures are chain-scoped (943 bot traffic cannot pollute 369).
- **PoW NEVER on the browser main thread** — always via a Web Worker (enforced by a guard in `board.ts`; mirror `cosign-web/src/seams/worker-board.ts`).
- **Gas on 943 AND 369:** match the base fee (~7 wei) + a tiny tip (0.5–2 gwei); NEVER the node's ~100k-gwei `eth_gasPrice` suggestion. Use legacy `gasPrice = baseFee + tip` for deploys (PulseChain prefers type-0), explicit EIP-1559 for the settle tx.
- **Deployer:** valve_deployer (`PRIVATE_KEY` = `op://valve/valve_deployer/pk`), never gibs.
- **No native form controls** anywhere in UI — use the house `Menu`/`Toggle`/`ui.tsx` components (mirror `cosign-web/src/components/`).
- **ESM:** all `@msgboard/*` packages are `"type": "module"`; import with `.js` extensions in source (e.g. `./record.js`), like `@msgboard/cosign`.
- **Deploys go through the ansible runbook** (`ansible/`), never ad-hoc ssh/scp.
- **Board-write flakiness:** valve.city `msgboard_addMessage` may return an internal error but the message usually lands — retry + poll the archive regardless; treat capture as confirmed by archive presence, not by the write RPC response.

---

## File Structure

**New package `@msgboard/petition`** (`packages/petition/`):
- `src/descriptor.ts` — `Petition` type, `derivePetitionId`, `encodePetition`/`decodePetition`.
- `src/digest.ts` — EIP-712 domain/types, `petitionDigest`.
- `src/categories.ts` — namespace/scope helpers (`PETITION_NS`, `indexScope`, `signScope`).
- `src/petition.ts` — `createPetition`, `signPetition`, `readPetitions`, `readSignatures`, `tally`, `verifySignature`.
- `src/contract.ts` — `PETITION_SIGNATURES_ABI`, `buildSubmitArgs`, `buildSubmitBatchArgs`, `deployments` map.
- `src/index.ts` — barrel.
- `src/*.test.ts` — colocated vitest.

**Contract** (`games/contracts/`):
- `contracts/PetitionSignatures.sol`
- `scripts/deploy-petition.ts`
- `test/PetitionSignatures.test.ts`

**Read-side** (`packages/history/src/petition/`): `router.ts`, `categories.ts`, `handler.ts`, `fetch.ts`, `index.ts` (mirror `src/cosign/`), wired into `server.ts`.

**Settlement indexer** (`games/indexer/`): `src/petition.ts`, rows in `ponder.schema.ts`, contract+chain registration in `ponder.config.ts`.

**Standalone app** (`packages/petition-web/`): mirror `packages/cosign-web/` structure.

**Bot actor** (`games/e2e/scripts/petition-bot.ts`) + ansible fleet wiring.

**Landing app** (`packages/ui/`): `src/components/Petitions.tsx` (widget) + edits to `TryIt.tsx` and `Ecosystem.tsx`/`ProtocolComparison.tsx`.

**Deploy** (`ansible/`): `deploy-petition.yml` + `docker-compose.petition.yml` (mirror cosign).

---

## Task 0: Shared interface (the gate)

Everything consumes this. Land it first; A and B must agree on the digest.

**Files:**
- Create: `packages/petition/package.json`, `packages/petition/tsconfig.json`, `packages/petition/vitest.config.ts`
- Create: `packages/petition/src/descriptor.ts`, `src/digest.ts`, `src/categories.ts`, `src/contract.ts`, `src/index.ts`
- Modify: root `package.json` workspaces (add `packages/petition`)

**Interfaces (Produces — every other task relies on these exact names/types):**
```ts
// descriptor.ts
export interface Petition {
  id: Hex; statement: string; creator: Hex; createdAt: number; chainId: number; salt: Hex
}
export function derivePetitionId(statement: string, creator: Hex, salt: Hex): Hex
export function encodePetition(p: Petition): Hex
export function decodePetition(data: Hex): Petition

// digest.ts
export const PETITION_DOMAIN_NAME = 'MsgBoard Petition'
export const PETITION_DOMAIN_VERSION = '1'
export const PETITION_TYPES = { Petition: [ {name:'petitionId',type:'bytes32'}, {name:'statement',type:'string'} ] } as const
export function petitionDigest(p: Pick<Petition,'id'|'statement'|'chainId'>, verifyingContract: Hex): Hex

// categories.ts
export const PETITION_NS = 'petition'
export const INDEX_SCOPE = 'index'
export function signScope(petitionId: Hex): string   // returns petitionId (lowercased hex string)

// contract.ts
export const PETITION_SIGNATURES_ABI: Abi
export function buildSubmitArgs(p: Petition, signer: Hex, signature: Hex): readonly [Hex,string,Hex,Hex]
export function buildSubmitBatchArgs(p: Petition, signers: Hex[], signatures: Hex[]): readonly [Hex,string,Hex[],Hex[]]
export interface Deployment { chainId: number; address: Hex; deployBlock: number }
export const deployments: Record<number, Deployment>   // filled after deploy; starts {}
```

- [ ] **Step 1: Scaffold the package.** Copy `packages/cosign/package.json` → `packages/petition/package.json`; rename to `@msgboard/petition`; deps: `@msgboard/cosign`, `@msgboard/sdk`, `viem`; devDeps `vitest`, `typescript`. Copy `tsconfig.json` + `vitest.config.ts` from `packages/cosign`. Add `"packages/petition"` to root `package.json` `workspaces`. Run `npm install`.

- [ ] **Step 2: Write failing test for `derivePetitionId` + descriptor codec** — `src/descriptor.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { derivePetitionId, encodePetition, decodePetition, type Petition } from './descriptor.js'
const salt = ('0x'+'11'.repeat(32)) as `0x${string}`
const creator = '0x1111111111111111111111111111111111111111'
it('petitionId is deterministic and binds inputs', () => {
  const a = derivePetitionId('Save the park', creator, salt)
  const b = derivePetitionId('Save the park', creator, salt)
  const c = derivePetitionId('Save the park', creator, ('0x'+'22'.repeat(32)) as any)
  expect(a).toEqual(b); expect(a).not.toEqual(c)
})
it('descriptor round-trips', () => {
  const p: Petition = { id: derivePetitionId('S', creator, salt), statement:'S', creator, createdAt:1730000000, chainId:369, salt }
  expect(decodePetition(encodePetition(p))).toEqual(p)
})
```

- [ ] **Step 3: Run — expect FAIL** (`npx vitest run packages/petition/src/descriptor.test.ts`), module not found.

- [ ] **Step 4: Implement `descriptor.ts`.** `derivePetitionId = keccak256(encodeAbiParameters([{type:'string'},{type:'address'},{type:'bytes32'}], [statement, creator, salt]))`. `encodePetition`/`decodePetition` via `encodeAbiParameters`/`decodeAbiParameters` over ABI `[bytes32 id, string statement, address creator, uint64 createdAt, uint32 chainId, bytes32 salt]` (convert `createdAt`/`chainId` to/from BigInt/Number at the boundary).

- [ ] **Step 5: Run — expect PASS.**

- [ ] **Step 6: Write failing digest test** — `src/digest.test.ts`: assert `petitionDigest` equals a hardcoded expected hash for a fixed fixture (compute once via viem `hashTypedData` in the test and pin it), and that changing `chainId` or `verifyingContract` changes the digest.
```ts
import { hashTypedData } from 'viem'
import { petitionDigest, PETITION_DOMAIN_NAME, PETITION_DOMAIN_VERSION, PETITION_TYPES } from './digest.js'
const vc = '0x2222222222222222222222222222222222222222'
const p = { id: ('0x'+'ab'.repeat(32)) as any, statement:'Save the park', chainId:369 }
it('matches viem hashTypedData', () => {
  const expected = hashTypedData({ domain:{ name:PETITION_DOMAIN_NAME, version:PETITION_DOMAIN_VERSION, chainId:369, verifyingContract:vc }, types:PETITION_TYPES, primaryType:'Petition', message:{ petitionId:p.id, statement:p.statement } })
  expect(petitionDigest(p, vc)).toEqual(expected)
})
it('is chain-scoped', () => { expect(petitionDigest(p, vc)).not.toEqual(petitionDigest({...p, chainId:943}, vc)) })
```

- [ ] **Step 7: Run — expect FAIL.**

- [ ] **Step 8: Implement `digest.ts`** using viem `hashTypedData` with the domain/types above.

- [ ] **Step 9: Run — expect PASS.**

- [ ] **Step 10: Implement `categories.ts` + `contract.ts` + `index.ts`.** `contract.ts` holds the hand-written `PETITION_SIGNATURES_ABI` (matching Task B's contract: `submit`, `submitBatch`, `signed`, `count`, `Signed` event), the two `buildSubmit*Args` helpers (return tuples in ABI arg order, `statement` as-is), and `deployments = {}` (populated by Task B's deploy). `index.ts` re-exports all modules.

- [ ] **Step 11: Run full package test + typecheck** (`npx vitest run packages/petition`, `npx tsc -p packages/petition --noEmit`), then **Commit**: `feat(petition): shared interface — descriptor, EIP-712 digest, categories, contract ABI`.

---

## Task A: `@msgboard/petition` core (board + crypto)

**Files:** Create `packages/petition/src/petition.ts` + `src/petition.test.ts`. **Consumes:** Task 0. **Produces:**
```ts
export function createPetition(board: BoardClient, p: Petition, now?: Date): Promise<unknown>
export function signPetition(board: BoardClient, p: Petition, verifyingContract: Hex,
  sign: (digest: Hex) => Promise<Hex>, now?: Date): Promise<SignatureRecord>
export function readPetitions(board: BoardClient, days: number, now?: Date): Promise<Petition[]>
export function readPetitionSignatures(board: BoardClient, id: Hex, days: number, now?: Date): Promise<SignatureRecord[]>
export function tally(records: SignatureRecord[]): { count: number; signers: Hex[] }
export function verifySignature(p: Petition, record: SignatureRecord, verifyingContract: Hex): boolean
```
(`BoardClient` imported from `@msgboard/cosign`.)

- [ ] **Step 1: Failing test** — `src/petition.test.ts` with a fake `BoardClient` (in-memory `Map<category, {data}[]>`, mirroring `packages/cosign/src/client.test.ts` fake):
  - `signPetition` posts a decodable `SignatureRecord` whose `verifySignature` is `true`; tampering the statement makes it `false`.
  - `tally` dedups a signer who signed twice → count 1.
  - `readPetitions` returns descriptors posted via `createPetition`.
  Use a viem local account (`privateKeyToAccount`) to produce the signature: `sign = (d)=>account.sign({hash:d})`.

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement `petition.ts`.** `createPetition` posts `encodePetition(p)` to `categoryKey(PETITION_NS, INDEX_SCOPE, isoDay(now))`. `signPetition` computes `petitionDigest`, calls `sign`, builds `SignatureRecord {digest, signer:p.creatorOrRecovered, signature, scheme:SCHEME.EIP712, meta:'0x'}` — recover the signer from the signature (viem `recoverAddress`) to fill `signer` — and posts via cosign `postSignature({namespace:PETITION_NS, scope:signScope(p.id), record, now})`. `readPetitions` sweeps `keysForWindow(PETITION_NS, INDEX_SCOPE, days, now)` and `decodePetition` (skip undecodable). `readPetitionSignatures` delegates to cosign `readSignatures`. `tally` dedups by `signer` (lowercased). `verifySignature` recomputes `petitionDigest`, `recoverAddress({hash, signature})`, compares to `record.signer` AND asserts `record.digest === digest`.

- [ ] **Step 4: Run — expect PASS.**

- [ ] **Step 5: Typecheck + commit** — `feat(petition): create/sign/read/tally/verify over the board`.

---

## Task B: `PetitionSignatures` contract + deploy + tests

**Files:** Create `games/contracts/contracts/PetitionSignatures.sol`, `games/contracts/scripts/deploy-petition.ts`, `games/contracts/test/PetitionSignatures.test.ts`. **Consumes:** the digest definition from Task 0 (must match). **Produces:** deployed addresses → fill `deployments` in `packages/petition/src/contract.ts`.

- [ ] **Step 1: Write the contract.** `pragma solidity ^0.8.20;` import `@openzeppelin/contracts/utils/cryptography/EIP712.sol` + `ECDSA.sol`. `contract PetitionSignatures is EIP712 { constructor() EIP712("MsgBoard Petition","1") {}` with the storage, events, `_TYPEHASH = keccak256("Petition(bytes32 petitionId,string statement)")`, `submit`, and `submitBatch` from the spec. `submit` builds `bytes32 structHash = keccak256(abi.encode(_TYPEHASH, petitionId, keccak256(bytes(statement))))`, `digest = _hashTypedDataV4(structHash)`, `require(ECDSA.recover(digest, signature) == signer)`, then record-if-new + emit.

- [ ] **Step 2: Write failing tests** — `test/PetitionSignatures.test.ts` (mirror an existing hardhat+viem test like `test/CoinFlip.test.ts` for harness setup): valid signature records + `count==1` + `Signed` emitted; wrong statement reverts; wrong signer reverts; duplicate submit → no revert, `count` stays 1; `submitBatch` with [new, duplicate] → count increments once; arbitrary `msg.sender` (permissionless) works. **Cross-consistency:** produce the signature with `@msgboard/petition`'s `petitionDigest` + a viem account and assert it validates on-chain (import from the built core or replicate the domain with the deployed test address).

- [ ] **Step 3: Run — expect FAIL** (`cd games/contracts && npx hardhat test test/PetitionSignatures.test.ts` — first `forge build` if the deploy script reads `forge-out`).

- [ ] **Step 4: Iterate contract to green.**

- [ ] **Step 5: Write `deploy-petition.ts`** mirroring `deploy-stealth.ts` (no constructor args, base-fee+tip legacy gas, `DEPLOY_EXECUTE` gate, `PRIVATE_KEY`|`MNEMONIC`, reads `forge-out/PetitionSignatures.sol/PetitionSignatures.json`). Print the address + deploy block.

- [ ] **Step 6: Run tests — expect PASS. Commit** — `feat(contracts): PetitionSignatures EIP-712 verifier + deploy script`.

- [ ] **Step 7 (deploy — gated on user + secrets, do at integration time):** dry-run then `DEPLOY_EXECUTE=1 CHAIN_ID=943` (bots) and `369` (real, on user confirmation); record `{chainId, address, deployBlock}` into `packages/petition/src/contract.ts` `deployments`; commit `chore(petition): record 943/369 deployments`.

---

## Task C: `@msgboard/history` petition read-side

**Files:** Create `packages/history/src/petition/{router,categories,handler,fetch,index}.ts` + tests; Modify `packages/history/src/server.ts` to mount the group. **Consumes:** Task 0 (categories), Task A (`decodePetition`, `tally`). **Produces:** HTTP routes `GET /petition/index?days=N`, `/petition/:id/signatures?days=N`, `/petition/:id/tally?days=N`.

- [ ] **Step 1: Failing router test** — mirror `src/cosign/` tests: `matchPetitionRoute('/petition/index')`, `/petition/:id/signatures`, `/petition/:id/tally` parse correctly; junk → null.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement `router.ts` + `categories.ts`** (categories reuse `resolveCategories` with `PETITION_NS`; index uses `INDEX_SCOPE`, signatures use the id scope).
- [ ] **Step 4: Failing handler test** with a fake archive+board source: `/petition/index` returns decoded descriptors; `/petition/:id/tally` returns a deduped count over board∪archive.
- [ ] **Step 5: Implement `handler.ts` + `fetch.ts`** (reuse the cosign board-vs-archive split + decode; index decodes `decodePetition`, signatures decode `decodeRecord`, tally via `@msgboard/petition` `tally`). Add pagination params (`?offset`/`?limit`) to the signatures route.
- [ ] **Step 6: Mount in `server.ts`** behind the same opt-in group mechanism as cosign; add a `petition` endpoint-group flag.
- [ ] **Step 7: Run all history tests + typecheck — PASS. Commit** — `feat(history): petition read-side (directory, signatures, tally)`.

---

## Task D: Settlement indexer (Ponder)

**Files:** Create `games/indexer/src/petition.ts`; Modify `games/indexer/ponder.schema.ts` (add `petitionSignature` table), `games/indexer/ponder.config.ts` (register `PetitionSignatures` on 369+943 with `deployBlock`). **Consumes:** Task B ABI + addresses. **Produces:** indexed `Signed` events queryable per `(chainId, petitionId, signer)`.

- [ ] **Step 1: Add schema row** in `ponder.schema.ts`: `petitionSignature` with `id` (`${chainId}-${petitionId}-${signer}`), `chainId`, `petitionId`, `signer`, `blockNumber`, `txHash`.
- [ ] **Step 2: Register contract** in `ponder.config.ts` (mirror the sudoku/coinflip registration): `PetitionSignatures` ABI, address per chain (from `@msgboard/petition` `deployments`), `startBlock: deployBlock`, networks 369 + 943.
- [ ] **Step 3: Implement `src/petition.ts`** mirroring `src/sudoku.ts`: `on('PetitionSignatures:Signed', ...)` insert with `onConflictDoNothing()`.
- [ ] **Step 4: Test** — if the indexer has a test harness, add an idempotency test (same event twice → one row); otherwise add a unit test for the id-keying helper. Verify `ponder codegen`/typecheck passes.
- [ ] **Step 5: Commit** — `feat(indexer): index PetitionSignatures.Signed on 369+943`.

---

## Task E: `packages/petition-web` standalone app

**Files:** Scaffold `packages/petition-web/` from `packages/cosign-web/` (copy `vite.config`, `tsconfig`, `package.json`→rename, `src/main.tsx`, `src/app.css`, `src/seams/worker-board.ts`, `src/worker/*`, `src/hooks/useWallet.ts`, `src/lib/{board,archive,config,eip1193}.ts`, `src/components/{Menu,ui}.tsx`). Then author petition-specific `src/App.tsx`, `src/lib/petition-client.ts` (wraps `@msgboard/petition` over the worker board + archivist), `src/lib/reconcile.ts` (outstanding = captured − settled via indexer read), `src/components/{Directory,CreatePetition,PetitionDetail,SignerList,VerifyPanel,Tally}.tsx`. **Consumes:** Tasks 0, A, C, D. Add `@msgboard/petition` to deps.

- [ ] **Step 1: Scaffold + boot** — copy cosign-web, rename to `@msgboard/petition-web`, `npm install`, confirm `npm run dev` serves a blank shell; register workspace.
- [ ] **Step 2: `reconcile.ts` failing test** — pure function `outstanding(captured: Hex[], settled: Hex[]): Hex[]` (set difference, address-normalized). Implement, PASS.
- [ ] **Step 3: `petition-client.ts`** — `createPetition`, `signPetition` (wallet `sign`), `listPetitions`, `getPetition` (statement + captured tally from read-side + on-chain tally from indexer), `settle` (build `submitBatch`, send via wallet with explicit EIP-1559 fees), `verifyAll`. PoW via the worker board seam (never main thread).
- [ ] **Step 4: `VerifyPanel` failing test** — given a petition + records, recompute + recover client-side and render captured count; tamper → shows mismatch. Implement, PASS.
- [ ] **Step 5: `SignerList` with dynamic batching** — virtualized/incremental reveal in blocks of N, aggregate tier label past a threshold (test: renders first batch, "load more" reveals next; a 2,000-signer fixture mounts without rendering all rows).
- [ ] **Step 6: Wire `Directory` + `CreatePetition` + `PetitionDetail`** (Sign → post → poll archive until captured ✓; Settle → tx → follow indexer). House `Menu`/`Toggle` only. Chain selector defaults 369, 943 for demo.
- [ ] **Step 7: `npm run build` + component tests green + PoW-main-thread guard test. Commit** — `feat(petition-web): create/sign/capture/settle/verify app`.

---

## Task F: Petition bot actor (943)

**Files:** Create `games/e2e/scripts/petition-bot.ts` (mirror the chip-faucet/landing-house actor). **Consumes:** Tasks 0, A, B. **Produces:** a fleet service that seeds + drives 943.

- [ ] **Step 1:** Actor reads env: `MNEMONIC` (bot keys), `RPC_URL`/`CHAIN_ID=943`, `PETITION_STATEMENTS` (JSON list), `SIGNER_COUNT`, `SETTLE_INTERVAL_MS`, verifier address (from `deployments`). On start: ensure each configured petition exists (create if absent via idx-0 key), then have `SIGNER_COUNT` mnemonic-indexed keys `signPetition` (capture), and on a timer read outstanding and `submitBatch` (explicit fees).
- [ ] **Step 2:** Add a `--dry-run` that logs actions without posting/sending; a small unit test for the "which petitions need creating / which signers are outstanding" pure helpers.
- [ ] **Step 3:** Commit — `feat(e2e): petition bot actor seeds + drives 943`. (Fleet ansible wiring lands in Task H.)

---

## Task G: msgboard.xyz widget + ecosystem entry

**Files:** Create `packages/ui/src/components/Petitions.tsx`; Modify `packages/ui/src/components/TryIt.tsx` (add a "Petitions" tab next to Channel/ZK Chat/Mechanics), `packages/ui/src/components/Ecosystem.tsx` (+ `ProtocolComparison.tsx` if that's where the use-cases render). **Consumes:** Tasks 0, A, C. Add `@msgboard/petition` to `packages/ui` deps (light, board+crypto only).

- [ ] **Step 1:** `Petitions.tsx` — compact widget: featured petition(s) from the read-side + sign-inline (reuse the packages/ui worker board + wallet helper; PoW off-thread), with a link to `petition.msgboard.xyz`. Follow the existing tab component patterns in `TryIt.tsx`.
- [ ] **Step 2:** Add the tab to `TryIt.tsx`; add a Petitions card to the ecosystem/use-cases surface describing the use case (co-signed public statements, verifiable tally, permissionless on-chain finality).
- [ ] **Step 3:** `packages/ui` tests + `npx tsc` clean; `npm run build`. Commit — `feat(ui): petitions landing widget + ecosystem entry`.

---

## Task H: Deployment (ansible)

**Files:** Create `ansible/deploy-petition.yml` + `docker-compose.petition.yml` (mirror `deploy-cosign.yml`/`docker-compose.cosign.yml`); Modify games-actors compose/playbook to add the `petition-bot` fleet service; enable the `petition` read-side group on the archive server; register the indexer contract config on the box. **Consumes:** all prior tasks + recorded deployments.

- [ ] **Step 1:** `petition-web` service (monorepo image, vite preview) + `petition.msgboard.xyz` Caddy block (origin cert), SAFE reload per the `valve-caddy-config` skill (backup → `caddy adapt` → reload → **non-empty-body** smoke → `docker restart caddy` fallback for a brand-new host block → re-smoke), rescue/rollback.
- [ ] **Step 2:** Add `petition-bot` to `games-actors-compose.yml` + `deploy-games-actors.yml` (943, MNEMONIC + verifier addr).
- [ ] **Step 3:** Enable the petition read-side group on the cosign-archive/history service; add the `PetitionSignatures` contract+chains to the Ponder indexer deployment.
- [ ] **Step 4:** `--syntax-check` all playbooks; commit — `chore(deploy): petition-web + subdomain + bot + read-side + indexer wiring`. (Actual apply is user-run on VPN, per the connectivity constraints.)

---

## Self-Review

**Spec coverage:** (1) core → Task A ✓; (2) contract → Task B ✓; (3) petition-web → Task E ✓; (4) read-side → Task C ✓; (5) settlement indexer → Task D ✓; (6) bot actor → Task F ✓; (7) landing widget → Task G ✓; (8) ecosystem entry → Task G ✓; (9) deploy → Task H ✓; digest parity → Task 0 + Task B cross-consistency ✓; dynamic batching → Task E Step 5 ✓; error handling (flakiness/gas/dedup/sybil) → Global Constraints + Tasks A/B/E ✓.

**Type consistency:** `Petition`, `derivePetitionId`, `petitionDigest`, `PETITION_SIGNATURES_ABI`, `buildSubmitBatchArgs`, `deployments`, `tally`, `verifySignature`, `readPetitions`/`readPetitionSignatures` are defined once in Tasks 0/A and consumed by the same names in C/D/E/F/G.

**Parallelization:** Task 0 first (gate). Then A, C parallel; B parallel (must match Task 0 digest — gated by the cross-consistency test); D after B (needs ABI/addresses); E after 0/A/C (mock the indexer read until D); F after A/B; G after 0/A/C; H last. 369 mainnet deploy gated on explicit user confirmation.

**Open items:** subdomain default `petition.msgboard.xyz`; 369 deploy user-gated.
