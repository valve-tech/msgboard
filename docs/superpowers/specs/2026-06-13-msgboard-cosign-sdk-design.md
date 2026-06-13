# MsgBoard cosign — Generic Signature-Share SDK over Rotating Category Keys (Design Spec)

Date: 2026-06-13
Status: Draft for review

Related:
- The msgboard **two-store** model (chain = sybil-resistant + permanent; board = zero-cost PoW-gated broadcast; **cryptography is king, independent of the store**). `@msgboard/cosign` is a pure board+crypto play: a co-signature is self-authenticating, so it lives entirely on the ephemeral board at ~zero reader cost; the chain is touched only by an adapter optionally reading owner-set/threshold to verify.
- `packages/history` / `archive.msgboard.xyz` and the relayer **archivist**. The **cosign archivist** (a separate sub-project, §8) is a filtered, structured, short-window, self-hostable archive built on that lineage; it imports this SDK's key scheme + record codec.

## 1. Summary

`@msgboard/cosign` is a small SDK for sharing **co-signature artifacts** — generic `(digest, signer, signature)` records — over MsgBoard, bucketed under **rotating, time-bucketed category keys** so a working set stays small and self-pruning. It is app-agnostic; a pluggable **adapter** encodes a specific multisig's verification + ordering rules. The first adapter targets **Wonderland's multisig** and ships **stubbed** (interface + seam only). No on-chain execution; adapters may make read-only chain calls to verify owners/threshold.

This is the foundation layer (**sub-project 1**). Two consumers build on it: a team's own tooling (post/read/aggregate signatures), and the **cosign archivist** service (sub-project 2) which imports cosign's key scheme + record codec to maintain a tight, structured, queryable archive.

## 2. Goals / non-goals

**Goals**
- Deterministic **rotating category keys**: `keccak256('namespace:scope:isoDate')`, day-granular UTC, plus a rolling-window helper.
- A canonical, ABI-encoded **`SignatureRecord` codec** — the single source of truth shared by posters, readers, and the archivist.
- **post / read / aggregate** over any `@msgboard/sdk` board client.
- A pluggable **adapter** seam (verify / order / owner-reads) so multisig backends plug in; Wonderland stubbed.
- Zero chain writes; pure board + crypto.

**Non-goals (this spec)**
- On-chain execution (building/submitting the multisig tx) — out of scope; aggregated sigs are handed to existing tooling.
- The archivist service, its HTTP query API, and the SQLite/filtering sink — **sub-project 2** (§8).
- Discovery of unknown teams; encryption of in-flight records — later.
- A full Wonderland adapter implementation — **stubbed** here (interface + TODO seam).

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
  - `namespace`/`scope` are caller-chosen: e.g. `('cosign', teamName)` or `('multisig', \`${chainId}:${safeAddress}\`)`. Pinned per-adapter in §9.

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

- **`src/adapters/adapter.ts`** — the seam.
  - `interface CosignAdapter { verify(record: SignatureRecord): Promise<boolean>; order(records: SignatureRecord[]): SignatureRecord[]; owners?(): Promise<Hex[]>; threshold?(): Promise<number> }`.

- **`src/adapters/wonderland.ts`** — **STUB** (intentional). `wonderlandAdapter(config: { multisig: Hex; chainId: number; publicClient: unknown }): CosignAdapter` whose `verify`/`order`/`owners`/`threshold` throw `new Error('wonderland adapter: not implemented')` with a documented TODO describing the intended owner-set/threshold reads and signer-recovery checks. Locks the seam without committing to Wonderland's contract specifics (an open item, §9).

- **`src/index.ts`** — re-exports `keys`, `record`, `client`, `adapters/adapter`, `adapters/wonderland`.

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
- **adapter**: a fake adapter drives `aggregate`; the Wonderland stub asserts each method throws `not implemented` (locks the seam so a future implementer can't forget to replace it).

No chain needed for the core; adapter contract-reads are tested when the real Wonderland adapter is built (fork/mock).

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

## 9. Open items (carried to the spec/plan)

- **Wonderland multisig specifics** — contract/ABI, owner-set + threshold reads, signer-recovery semantics. The adapter is stubbed until these are provided.
- **`scope` convention for multisig** — team name vs `${chainId}:${safeAddress}`; pinned when the Wonderland adapter is built.
- **`meta` schema per scheme** — pinned with the first real adapter.
- **Discovery (on-board umbrella) + archive.msgboard.xyz cold-start fallback** — deferred; the key scheme is designed so both are additive.
