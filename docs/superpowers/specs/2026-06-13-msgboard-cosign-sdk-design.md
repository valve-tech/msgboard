# MsgBoard cosign — Generic Signature-Share SDK over Rotating Category Keys (Design Spec)

Date: 2026-06-13
Status: Draft for review

Related:
- The msgboard **two-store** model (chain = sybil-resistant + permanent; board = zero-cost PoW-gated broadcast; **cryptography is king, independent of the store**). `@msgboard/cosign` is a pure board+crypto play: a co-signature is self-authenticating, so it lives entirely on the ephemeral board at ~zero reader cost; the chain is touched only by an adapter optionally reading owner-set/threshold to verify.
- `packages/history` / `archive.msgboard.xyz` and the relayer **archivist**. The **cosign archivist** (a separate sub-project, §8) is a filtered, structured, short-window, self-hostable archive built on that lineage; it imports this SDK's key scheme + record codec.

## 1. Summary

`@msgboard/cosign` is a small SDK for sharing **co-signature artifacts** — generic `(digest, signer, signature)` records — over MsgBoard, bucketed under **rotating, time-bucketed category keys** so a working set stays small and self-pruning. It is app-agnostic; a pluggable **adapter** encodes a specific multisig's verification + ordering rules. We are **not** building our own multisig: cosign is a coordination/aggregation layer for the **existing** multisig tools that use off-chain signature aggregation. This package ships the generic signature-share **core** plus the pluggable **`CosignAdapter` interface** AND **concrete adapters** that target that off-chain-signature-aggregation multisig family — they **ship in `@msgboard/cosign`'s `src/adapters/`** (since these are external tools we don't own). The first real adapter is the **Gnosis Safe adapter** (own spec: `2026-06-13-msgboard-cosign-safe-adapter-design.md`); the full prioritized roadmap (Safe first, then Safe4337Module, Rhinestone OwnableValidator, ZeroDev Kernel WeightedValidator, Ambire) plus the documented non-fits is in §9. No on-chain execution; adapters may make read-only chain calls to verify owners/threshold.

This is the foundation layer (**sub-project 1**). Two consumers build on it: a team's own tooling (post/read/aggregate signatures), and the **cosign archivist** service (sub-project 2) which imports cosign's key scheme + record codec to maintain a tight, structured, queryable archive.

## 2. Goals / non-goals

**Goals**
- Deterministic **rotating category keys**: `keccak256('namespace:scope:isoDate')`, day-granular UTC, plus a rolling-window helper.
- A canonical, ABI-encoded **`SignatureRecord` codec** — the single source of truth shared by posters, readers, and the archivist.
- **post / read / aggregate** over any `@msgboard/sdk` board client.
- A pluggable **adapter** seam — the `CosignAdapter` **interface** (verify / order / owner-reads) so multisig backends plug in — plus **concrete adapters** that target the **off-chain-signature-aggregation multisig family**. Because those are external tools we don't own, the concrete adapters **ship in this package's `src/adapters/`** (the first being the Gnosis Safe adapter; roadmap + non-fits in §9).
- Zero chain writes; pure board + crypto. The core (keys/record/client) stays dependency-light; adapters add `viem` contract-read logic.

**Non-goals (this spec)**
- On-chain execution (building/submitting the multisig tx) — out of scope; aggregated sigs are handed to existing tooling.
- The archivist service, its HTTP query API, and the SQLite/filtering sink — **sub-project 2** (§8).
- Discovery of unknown teams; encryption of in-flight records — later.
- **Building our own multisig.** Out of scope by decision — cosign targets the **existing** off-chain-signature-aggregation multisig tools via concrete adapters. (The earlier "build a minimal Multisigner" idea is shelved — see `2026-06-13-msgboard-multisigner-design.md`.)

## 3. The two-store fit (why this is board-only)

A co-signature is binding because of the signature, not where it sits. So cosign records live entirely on the ephemeral board: zero reader cost, only PoW sender cost; each participant retains what it needs; nothing requires the chain except an adapter optionally reading owner-set/threshold to verify. This is the msgboard **incentive bridge** — reveal/share a signature at ~zero cost so counterparties can act — applied to multisig coordination.

## 4. Components / units

New package **`packages/cosign`** in the msgboard repo, name `@msgboard/cosign`. Deps: `@msgboard/sdk` (workspace — board `addMessage`/`content`/`categoryHash`), `viem` (ABI encode/decode, keccak, ecrecover, read-only contract calls in adapters). Dev: `vitest`, `typescript`, `@types/node`. ESM, `src/index.ts` entry, tests in `test/`. Mirror the conventions of the existing msgboard packages (`packages/sdk`, `packages/relayer`).

Small, focused files:

- **`src/keys.ts`** — the rotating-key scheme.
  - `isoDay(date: Date): string` → UTC `YYYY-MM-DD`.
  - `categoryKey(namespace: string, scope: string, isoDate: string): Hex` = `keccak256(toBytes(\`${namespace}:${scope}:${isoDate}\`))`.
  - `currentKey(namespace, scope, now?: Date): Hex`.
  - `keysForWindow(namespace, scope, days: number, now?: Date): Hex[]` → today + the prior `days-1` UTC days (the rolling set readers and the archivist share). `days >= 1`.
  - `namespace`/`scope` are caller-chosen: e.g. `('cosign', teamName)` or `('multisig', \`${chainId}:${safeAddress}\`)`. Pinned per-adapter in §10.

- **`src/record.ts`** — the canonical artifact + ABI codec (single source of truth; the archivist imports this).
  - `interface SignatureRecord { digest: Hex /*bytes32*/; signer: Hex /*address*/; signature: Hex /*bytes*/; scheme: number /*uint8*/; meta: Hex /*bytes*/ }`.
  - `const SCHEME = { ECDSA: 0, EIP1271: 1, EIP712: 2 } as const`.
  - Canonical ABI tuple (order is law — both archivist and readers depend on it): `(bytes32 digest, address signer, bytes signature, uint8 scheme, bytes meta)`.
  - `encodeRecord(r: SignatureRecord): Hex` (abi-encode the tuple); `decodeRecord(data: Hex): SignatureRecord` (abi-decode; **throws** on malformed).

- **`src/client.ts`** — post/read/aggregate over a board client (a minimal `BoardClient` interface: `addMessage({category, data})`, `content({category?})` — mirrors the shape `@gibs/msgboard-games`'s `MsgBoardTransport` uses, so it stays testable with a fake).
  - `postSignature(board, { namespace, scope, record, now? }): Promise<unknown>` — `currentKey` → `encodeRecord` → `board.addMessage`.
  - `readSignatures(board, { namespace, scope, days, now? }): Promise<SignatureRecord[]>` — for each key in `keysForWindow` → `board.content({category})` → `decodeRecord` each entry (**skip** undecodable junk; the board is open, junk under a category is expected) → dedupe by `keccak256(data)`.
  - `groupByDigest(records: SignatureRecord[]): Map<Hex, SignatureRecord[]>`.
  - `aggregate(records, adapter): Promise<{ signer: Hex; signature: Hex }[]>` — keep records where `await adapter.verify(record)` is true, then `adapter.order(...)`.

- **`src/adapters/`** — the adapter seam **plus** the concrete adapters.
  - `src/adapters/adapter.ts` — the interface: `interface CosignAdapter { verify(record: SignatureRecord): Promise<boolean>; order(records: SignatureRecord[]): SignatureRecord[]; owners?(): Promise<Hex[]>; threshold?(): Promise<number> }`.
  - Concrete adapters import this interface and **ship in this same directory** (they target external off-chain-sig multisigs we don't own, so they live in cosign, not with their targets): `safe.ts` **first** (the flagship — own spec `2026-06-13-msgboard-cosign-safe-adapter-design.md`), then `safe4337.ts`, `rhinestone.ts`, etc. per the §9 roadmap. The core stays dependency-light; each adapter adds `viem` contract-read logic only.

- **`src/index.ts`** — re-exports `keys`, `record`, `client`, `adapters/adapter` (the interface), **and the concrete adapters that ship** (the Safe adapter first; further roadmap adapters as they land).

## 5. Data flow

Signer's tooling → `postSignature(board, { namespace:'cosign', scope:team, record:{ digest:safeTxHash, signer, signature, scheme } })` → posted under today's rotating category. Other owners / the archivist → `readSignatures({ window:7 })` → `groupByDigest` → `aggregate(forDigest, adapter)` → ordered `{signer,signature}[]` → handed to the team's existing execute path (out of scope here).

## 6. Error handling

- `decodeRecord` throws on malformed input; `readSignatures` **skips** undecodable board entries (open board → junk under a category is expected) but never silently drops a well-formed record — validity is the adapter's `verify` job at `aggregate` time.
- `keysForWindow` requires `days >= 1` (throws otherwise).
- `postSignature` surfaces board/PoW errors to the caller.
- `adapter.verify` failures (e.g. RPC error) **propagate** — they are not silently treated as "invalid signature"; the caller decides.

## 7. Testing

- **keys**: determinism; UTC day rotation across a date boundary; window-set length + contents; namespace/scope sensitivity.
- **record**: encode/decode round-trip for each `scheme` incl. empty `meta`; `decodeRecord` throws on garbage.
- **client**: `postSignature` calls `addMessage` under `currentKey` with the encoded data (fake board); `readSignatures` fetches the window categories, decodes, and dedupes (fake board returning fixtures incl. one junk entry that is skipped); `groupByDigest` groups; `aggregate` filters by a fake adapter's `verify` and applies its `order`.
- **adapter**: a fake adapter (satisfying the `CosignAdapter` interface) drives `aggregate` — filtering by its `verify` and applying its `order`. The interface itself is exercised at the type level / via the fake.

No chain needed for the core. Concrete adapters that ship in `src/adapters/` (the Safe adapter first, per §9) carry their own contract-read tests (mock/anvil/fork), specified in the per-adapter spec (e.g. the Safe adapter spec `2026-06-13-msgboard-cosign-safe-adapter-design.md`).

## 8. Relationship to the cosign archivist (sub-project 2 — separate spec)

The archivist is **not** a competitor to `archive.msgboard.xyz`; it sits at the opposite end of a scope/retention/structure spectrum and uses the same `history`/`relayer` lineage:

| Axis | `archive.msgboard.xyz` | cosign archivist |
|---|---|---|
| Coverage | catch-everything (all categories) | selective — tracked registry + decoded-param filters |
| Retention | ~365 days (long-tail mirror) | 7-day rolling working set (falls back to archive.msgboard.xyz — deferred) |
| Decode | UTF-8 text → `data_text` | structured — cosign codec → columns (`digest`, `signer`, `signature`, `scheme`) |
| Query | raw rows + substring `contains` | domain-aware (sigs-for-digest, owners-who-signed, aggregate-ready) |
| Validation | stores verbatim | drops invalid at ingest (adapter `verify`) |
| Host | one public Postgres, queried remotely | SQLite, self-hostable, tight; working set local |

The archivist imports `keys.ts` (the rolling tracked-category set, registry-enumerated: `{teams} × {last 7 days}`) and `record.ts` (the decoder), is deployed as a hosted server **like `archive.msgboard.xyz`** with an HTTP query API, and pulls in reusable relayer/history additions (multi-category source, filtering/decoding sink, `sqliteArchiveSink`). Architecturally it is "the history server parameterized by a filter + decoder + tight retention + a domain query API." Its full design + decomposition is a follow-up spec.

## 9. Supported multisig tools (adapter roadmap)

cosign does **not** build a multisig — it is a coordination/aggregation layer for **existing** multisig tools that use **off-chain signature aggregation** (collect owner signatures off-chain, then submit the aggregated blob in one tx). Concrete adapters for that family ship in `src/adapters/`. Prioritized by adoption × feasibility:

1. **Gnosis Safe (v1.3.0 / v1.4.1) — the flagship, build first.** The dominant off-chain-sig multisig; `checkNSignatures` / concatenated 65-byte sigs are exactly cosign's aggregation model. Own spec: `2026-06-13-msgboard-cosign-safe-adapter-design.md` → `src/adapters/safe.ts`.
2. **Safe4337Module** — reuses the Safe owner-set/threshold under ERC-4337; the Safe adapter's owner reads carry over.
3. **Rhinestone OwnableValidator (ERC-7579)** — modular-account validator with an owner set + threshold over off-chain sigs.
4. **ZeroDev Kernel WeightedValidator** — weighted thresholds (stretch; weights extend the simple count model).
5. **Ambire** — opportunistic; revisit as the account model stabilizes.

**Documented non-fits (won't build):**

- **Coinbase Smart Wallet** — no threshold (single-owner-equivalent / passkey); nothing to aggregate.
- **Legacy Gnosis MultiSigWallet** — **on-chain** `confirmTransaction` per owner; not off-chain aggregation.
- **CanonGuard / Wonderland** — **on-chain `approveHash`** approvals (not off-chain signature aggregation); **set aside**. Revisitable later **only as a *coordination* adapter** (broadcasting that an owner has approved), **not** as an aggregation adapter.
- **Argent** — StarkNet multisig / EVM single-owner-plus-guardians; not the EVM off-chain-threshold model.
- **Plain single-signer ERC-4337** — no threshold; no aggregation.
- **thirdweb managed** — managed/custodial signing; no off-chain owner-sig blob to aggregate.

## 10. Open items (carried to the spec/plan)

- **CanonGuard/Wonderland is a documented non-fit (on-chain approvals), set aside; revisitable later only as a coordination adapter.** (See §9 non-fits.)
- **exact PulseChain (369/943) Safe singleton/factory addresses to verify for the Safe adapter** — needed by the Safe adapter's owner-set/threshold reads.
- **`scope` convention for multisig** — team name vs `${chainId}:${safeAddress}`; pinned when the first concrete adapter (Safe) is built.
- **`meta` schema per scheme** — pinned with the first real adapter (Safe).
- **Discovery (on-board umbrella) + archive.msgboard.xyz cold-start fallback** — deferred; the key scheme is designed so both are additive.
