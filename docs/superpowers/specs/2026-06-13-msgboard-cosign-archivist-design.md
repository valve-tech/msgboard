# MsgBoard cosign archivist — Selective, Decoded, Short-Window Signature Archive (Design Spec)

Date: 2026-06-13
Status: Draft for review

Related:
- **`@msgboard/cosign` SDK** — `docs/superpowers/specs/2026-06-13-msgboard-cosign-sdk-design.md` (sub-project 1). The archivist **imports** the SDK's `keys` (rotating day-bucketed category keys `keccak256('namespace:scope:isoDate')`, `keysForWindow`) and `record` (the canonical `SignatureRecord` ABI codec `(bytes32 digest, address signer, bytes signature, uint8 scheme, bytes meta)`) as the single source of truth, and uses a `CosignAdapter` for ingest validation.
- **msgboard two-store model** — see the cosign games design spec §2 (chain = sybil-resistant + permanent; board = zero-cost PoW-gated broadcast; *cryptography is king, independent of the store*). A co-signature is self-authenticating, so it lives on the ephemeral board; the archivist is a **structured read-side index** over that board traffic.
- **`packages/history`** (`archive.ts`, `server.ts`) and **`packages/relayer`** (`relayer.ts`, `types.ts`, `sinks/postgres-archive.ts`, `sources/msgboard-content.ts`, `examples/archivist.ts`) — the existing archive core, the `archive.msgboard.xyz` HTTP server, and the relayer pipeline this service is built on.

---

## 1. Summary

The **cosign archivist** is a standalone, hosted service — `cosign-archive.msgboard.xyz` in spirit, deployed exactly like `archive.msgboard.xyz` — that maintains a **tight, decoded, queryable index of co-signature artifacts** broadcast on the board. It is not a catch-all mirror: it tracks only a **registry-enumerated set of teams**, expanded into concrete rotating category hashes over a **7-day window**, decodes each message's `data` through the cosign `SignatureRecord` codec into queryable columns, **drops invalid records at ingest**, and serves a **domain-aware HTTP query API** (signatures-for-a-digest, owners-who-signed, aggregate-ready set).

Architecturally it is **"the history server parameterized by a filter + a decoder + tight retention + a domain query API."** It reuses the `history`/`relayer` lineage wholesale, contributing three small reusable additions back to the relayer (a multi-category source, a filtering/decoding sink wrapper, and a SQLite sink) plus a thin service package that wires the team-file registry, daemon, and query server together.

You run it globally for users (broad team-file); users self-host their own (narrow team-file, SQLite, tiny footprint). `archive.msgboard.xyz` remains the long-tail catch-all; this is the **hot working-set index** for active multisig coordination.

## 2. Goals / non-goals

**Goals**
- **Selective coverage** — track only categories enumerated by a registry (team-file × rolling window), not all board traffic.
- **Reduce + enrich** — decode `data` via the cosign codec into `digest`/`signer`/`signature`/`scheme` columns, and drop non-matching / invalid records at ingest.
- **Tight rolling retention** — 7-day working set, self-pruning, mirroring the cosign key window.
- **Pluggable store** — SQLite (default; self-host) + Postgres (scale), mirroring the existing `history`/`postgresArchiveSink` shape.
- **Domain-aware HTTP query API** — beyond by-category/since/until: sigs-for-digest, owners-who-signed, aggregate-ready set.
- **Reusable relayer/history additions** that stand alone and are independently tested.

**Non-goals (this spec)**
- **On-board discovery of unknown teams** — Registry v1 is an explicit team-file. Deferred.
- **Cold-start hydration fallback** to `archive.msgboard.xyz` when the local DB is empty/stale. Deferred.
- **Encryption of in-flight records.** Deferred (board records are public by the two-store model).
- **Multi-tenant control plane** (tenant registry, provisioning). v1 is one config-driven service (one team-file → one DB namespace); the control plane is an additive later layer.
- **On-chain execution / aggregation submission** — handled by the SDK's consumers, out of scope.

## 3. The two-store fit & the key architectural constraint

### 3.1 Two-store fit
Co-signatures live on the **board** (zero reader cost, PoW sender cost only); they are binding because of the signature, not the store. The archivist never writes to the board or chain — it is a **pure read-side index** that watches board traffic, decodes it, and answers structured queries. The chain is touched only indirectly: the `CosignAdapter.verify` may make read-only owner-set/threshold calls during ingest validation.

### 3.2 The key architectural constraint: filter at the SOURCE/SINK layer, NOT the `condition` hook

This is the load-bearing design decision and the reason for two of the three reusable additions.

In the relayer tick pipeline (`relayer.ts`, `handleItem`), **the sink records UNCONDITIONALLY, before `condition` runs**:

```ts
private async handleItem(item: T, report: TickReport, ctx: RelayerContext): Promise<void> {
  await this.recordItem(item, report, ctx)        // sink.record — ALWAYS, first
  const eligible = await this.isEligible(item, ctx) // condition + dedup — AFTER
  if (!eligible.proceed) { ... return }
  report.eligible += 1
  await this.actOnItem(item, report, ctx)         // action — gated
}
```

`RelayerSink` confirms this in its own contract:

```ts
/** Unconditional recording for history/observability. Long retention. Runs in BOTH modes. */
export type RelayerSink<T> = {
  record(item: T, context: RelayerContext): Promise<void>
  prune?(): Promise<void>
}
```

and `RelayerCondition` gates only the **action**, not the archive:

```ts
/** Decides whether a candidate should be acted on, beyond dedup. */
export type RelayerCondition<T> = (item: T, context: RelayerContext) => boolean | Promise<boolean>
```

The `moderation-flagger.ts` example documents the same gotcha in prose: *"sink.record runs before the condition in the standard tick pipeline."*

**Consequence:** we cannot use `condition` to keep the archive clean — by the time `condition` runs, the row is already written. Filtering and enrichment must therefore happen **upstream of (or inside) the sink**:

1. **At the source** — only poll the registry-enumerated categories, so most off-topic traffic never enters the pipeline (`categories?: string[]` on `msgboardContentSource`).
2. **Inside the sink** — a `filteringSink` / `decodingSink` wrapper that decodes + `verify`s each item and either writes an **enriched** row or **drops** it, before delegating to the underlying store.

The `condition` hook stays unused by the archivist (its action is a `noopAction`); all selectivity lives in the source + sink.

## 4. Components & units

A new service package plus three reusable additions to existing packages.

**Proposed package name: `@msgboard/cosign-archivist`** at `packages/cosign-archivist`. Deps: `@msgboard/cosign` (keys + record + adapter seam), `@msgboard/relayer` (pipeline + the new source/sink), `@msgboard/history` (storage core), `@msgboard/sdk` (`RPCMessage`, board client), `viem`. Optional: `better-sqlite3` (or `node:sqlite`) for the SQLite store; `pg` for Postgres. Dev: `vitest`, `typescript`, `@types/node`. ESM, `src/index.ts` entry, tests in `test/`. Mirrors existing package conventions.

### 4.1 Reusable additions to `@msgboard/relayer` (Plan 1)

**(a) Multi-category source — `categories?: string[]` on `msgboardContentSource`.**
Today the source supports exactly one category or all:

```ts
export type MsgboardContentSourceOptions = {
  /** A category name (zero-padded to bytes32) or bytes32 hex. Omit to watch all categories. */
  category?: string
}
```

Responsibility: poll a *set* of explicit category hashes (the registry-expanded `{teams} × {7 days}`). New shape (additive, backward-compatible):

```ts
export type MsgboardContentSourceOptions = {
  category?: string          // unchanged — single category
  categories?: string[]      // NEW — explicit set of category names/hexes
  // category + categories are mutually exclusive; omit both to watch all
}
```

Behavior: when `categories` is set, normalize each via the existing `toCategoryHex` and poll each (`client.content({ category })` per hash), flattening results. The set is **supplied per tick by the registry** (it changes as the UTC day rolls), so the source accepts a `categories` resolver as well as a static array — see §4.2 registry. Single-category and all-categories paths are unchanged.

**(b) `filteringSink` / `decodingSink` — gate + enrich before the underlying store.**
A `RelayerSink<RPCMessage>` wrapper. Responsibility: for each item, run a **decode + validate** step that returns either an enriched payload (write it) or a drop signal (skip it), then delegate to an inner sink. Interface:

```ts
export type DecodeResult<Row> = { keep: true; row: Row } | { keep: false; reason: string }

export type DecodingSinkOptions<Row> = {
  decode(message: RPCMessage, ctx: RelayerContext): Promise<DecodeResult<Row>> | DecodeResult<Row>
  inner: RelayerSink<Row>   // receives only kept, enriched rows
}

export const decodingSink = <Row>(opts: DecodingSinkOptions<Row>): RelayerSink<RPCMessage> => ({
  record: async (message, ctx) => {
    const r = await opts.decode(message, ctx)
    if (!r.keep) { ctx.logger('archivist: drop (%s)', r.reason); return }
    await opts.inner.record(r.row, ctx)
  },
  prune: opts.inner.prune,
})
```

This is the place the cosign codec + adapter `verify` plug in. It honors the §3.2 constraint: filtering happens **inside the sink's `record`**, so a dropped item is never written. `prune` passes straight through to the inner store. Generic over `Row` so it is reusable beyond cosign.

**(c) `sqliteArchiveSink` — a SQLite mirror of `postgresArchiveSink`.**
A `RelayerSink` backed by a SQLite-flavored archive, mirroring the Postgres one:

```ts
export const postgresArchiveSink = (options): RelayerSink<RPCMessage> & {
  migrate(): Promise<void>
  query(filter: ArchiveQuery): Promise<ArchivedMessage[]>
} => { ... }
```

`sqliteArchiveSink` exposes the same `migrate`/`prune`/`query`/`record` surface against a SQLite file (or `:memory:`). It can either (i) take a SQLite-backed `Queryable` and reuse `createArchive` from `@msgboard/history` if its SQL is dialect-portable, or (ii) ship a thin `createSqliteArchive` in `@msgboard/history` mirroring `createArchive` with SQLite DDL (`AUTOINCREMENT`-free PK, `INTEGER` timestamps, `julianday`/epoch-based prune instead of `now() - INTERVAL`). Given `archive.ts` uses Postgres-specific SQL (`TIMESTAMPTZ`, `now() - INTERVAL`, `ILIKE`, `DO $$`), **(ii) is the cleaner path**: add `createSqliteArchive` next to `createArchive`, sharing the `Archive` type and `tryDecodeText`, with SQLite DDL/prune. The cosign-specific columns (§7) are added by the decoding sink's row shape, not by the base archive.

### 4.2 The `@msgboard/cosign-archivist` service package (Plans 2 & 3)

- **`src/team-file.ts`** — load + validate the registry team-file JSON (§5). Responsibility: parse, default `windowDays = 7`, validate store/chain/adapter selectors. Exposes `loadTeamFile(path): TeamFile`.
- **`src/registry.ts`** — registry expansion. Responsibility: given a `TeamFile` and `now`, expand `{teams} × {last windowDays UTC days}` into concrete category hashes via the cosign `keysForWindow(namespace, scope, days, now)`. Exposes `expandCategories(teamFile, now?): Hex[]`, regenerated as the UTC day rolls (recomputed each tick, or cached by isoDay). Handles the `multisig:*` wildcard ("all teams in my file") as "expand every listed team."
- **`src/decode.ts`** — the cosign decode/verify step wired into `decodingSink`. Responsibility: `decodeRecord(message.data)` (skip on throw), run `adapter.verify(record)` (drop on false), map to the enriched archive row (`digest`, `signer`, `signature`, `scheme`, `meta`, plus base `hash`/`category`/`chain_id`/`first_seen_at`). Exposes `cosignDecode(adapter): DecodeResult-producer`.
- **`src/store.ts`** — store selection. Responsibility: from `store.kind`, build `sqliteArchiveSink` or `postgresArchiveSink` with cosign columns + 7-day retention. Returns the chosen sink + its `query` surface.
- **`src/daemon.ts`** — daemon wiring. Responsibility: build the `Relayer<RPCMessage>` with `mode: 'observe'` (an archivist never acts), `source = msgboardContentSource({ categories: () => registry.expandCategories(teamFile) })`, `sink = decodingSink({ decode: cosignDecode(adapter), inner: chosenArchiveSink })`, `action = noopAction()`, `key = (m) => m.hash`, and a `pruneEveryTicks` tuned to the 7-day window. Calls `migrate()` once, then `relayer.start()`.
- **`src/query.ts`** — the domain query layer over the store (§6). Responsibility: `signaturesForDigest`, `ownersWhoSigned`, `aggregateReady`, plus generic `byCategory`. Pure SQL over the cosign columns.
- **`src/server.ts`** — the HTTP domain query server (§6), modeled on `history/server.ts` (`/health`, JSON responses, loopback-default bind, `token`-gated non-loopback, 10 s timeouts) but with cosign endpoints.
- **`src/index.ts`** — re-exports the service entry + the query/server builders.

## 5. The team-file JSON (Registry v1)

A **non-encrypted JSON file** the operator points the service at. The global instance's file lists all served teams; self-hosters use a narrower file. Schema:

```jsonc
{
  "version": 1,
  "namespace": "cosign",          // cosign key namespace (matches how teams post)
  "windowDays": 7,                 // rolling window; default 7
  "teams": [                       // scopes to expand; "*" / "multisig:*" = all listed
    { "scope": "wonderland",        "label": "Wonderland multisig" },
    { "scope": "1:0xSAFE...",       "label": "Safe on mainnet" }
  ],
  "chain": {                       // board node to watch
    "chainId": 943,
    "rpcUrl": "https://rpc.testnet.msgboard.xyz"
  },
  "store": {                       // pluggable store
    "kind": "sqlite",             // "sqlite" | "postgres"
    "sqlite": { "path": "./cosign-archive.db" },
    "postgres": { "connectionString": "postgres://..." }  // when kind=postgres
  },
  "adapter": {                     // ingest-validation adapter selection
    "kind": "wonderland",         // resolves to a CosignAdapter; "none" = accept all decodable
    "config": { "multisig": "0xSAFE...", "chainId": 1 }
  }
}
```

Notes:
- `teams[].scope` is the cosign `scope` (per the SDK, e.g. team name or `${chainId}:${safeAddress}`); paired with `namespace`, it feeds `keysForWindow`.
- `windowDays` ties retention (§8) to coverage — they are the same number.
- `adapter.kind: "none"` is the unvalidated default for teams without a built adapter (Wonderland ships stubbed in the SDK; `verify` throwing surfaces as a drop-with-reason, not a crash — see §9).
- One team-file → one DB namespace = one service instance (single-tenant v1).

## 6. HTTP domain query API

Modeled on `history/server.ts` conventions: `GET /health` → `{ ok: true }`; JSON bodies; binds `127.0.0.1` by default; a non-loopback bind **requires** `token` (else refuses to start); `Authorization: Bearer <token>` enforced when set; 10 s header/request timeouts. Domain endpoints (all read-only, scoped to the 7-day window):

| Endpoint | Params | Response |
|---|---|---|
| `GET /health` | — | `{ ok: true }` |
| `GET /signatures` | `digest` (bytes32, required), `chainId?`, `scheme?`, `limit?`, `offset?` | `{ signatures: SignatureRow[] }` — all records for a digest |
| `GET /owners` | `digest` (required), `chainId?` | `{ owners: Hex[], count: number }` — distinct signers for a digest |
| `GET /aggregate-ready` | `digest` (required), `chainId?`, `threshold?` | `{ digest, signers: {signer,signature,scheme}[], count, threshold?, ready: boolean }` — ordered, dedup-by-signer set; `ready` = count ≥ threshold (threshold from adapter or param) |
| `GET /records` | generic: `category?` (hex/decoded), `chainId?`, `signer?`, `since?`, `until?`, `limit?` (≤1000), `offset?` | `{ records: SignatureRow[] }` — by-category/signer/time, newest first |

`SignatureRow` response shape (mirrors `ArchivedMessage` + cosign columns):

```jsonc
{
  "hash": "0x...", "chain_id": 943,
  "category": "0x...", "category_text": "cosign:wonderland:2026-06-13",
  "digest": "0x...", "signer": "0x...", "signature": "0x...", "scheme": 0,
  "meta": "0x...", "first_seen_at": "2026-06-13T12:00:00Z"
}
```

`/aggregate-ready` is the headline endpoint: it returns exactly what an executor needs (ordered `{signer,signature}` set) without the caller re-reading the board — the archivist has already decoded, validated, and (optionally) ordered via the adapter.

## 7. Database schema

Mirror `message_archive` (base provenance columns) **plus** the cosign-decoded columns. One table, e.g. `cosign_signature`:

| Column | Source | Notes |
|---|---|---|
| `hash` | `RPCMessage.hash` | part of PK |
| `chain_id` | tick context `chain.id` | part of PK |
| `category` | `RPCMessage.category` | the rotating bytes32 hash |
| `category_text` | `tryDecodeText(category)` | e.g. `cosign:wonderland:2026-06-13` |
| `digest` | `record.digest` | **indexed** — bytes32 the signature covers |
| `signer` | `record.signer` | **indexed** — address |
| `signature` | `record.signature` | the signature bytes |
| `scheme` | `record.scheme` | uint8 (ECDSA/EIP1271/EIP712) |
| `meta` | `record.meta` | bytes |
| `first_seen_at` | insert time | **indexed** — drives prune + time queries |

PK `(hash, chain_id)` (idempotent on re-ingest, matching the existing archive). Indexes for the domain queries:
- `(digest, chain_id)` — `/signatures`, `/owners`, `/aggregate-ready`.
- `(signer)` — `/records?signer=`.
- `(first_seen_at)` and `(chain_id, first_seen_at)` — prune + time-range.
- `(category)` — `/records?category=`.

The base provenance columns and `tryDecodeText` come straight from `@msgboard/history`; the cosign columns are added by the decoding sink's row shape. SQLite uses `INTEGER`/epoch timestamps; Postgres uses `TIMESTAMPTZ` — same logical schema, dialect-specific DDL.

## 8. Data flow

```
board (rotating cosign categories)
  │  registry.expandCategories(teamFile, now)   ← {teams} × {last 7 UTC days} via keysForWindow
  ▼
msgboardContentSource({ categories })           ← polls ONLY the enumerated hashes  [§4.1a]
  │  RPCMessage[]
  ▼
Relayer tick (mode: observe, action: noop)
  │  sink.record() runs UNCONDITIONALLY          ← so filtering lives in the sink  [§3.2]
  ▼
decodingSink({ decode: cosignDecode(adapter), inner })   [§4.1b]
  │  decodeRecord(data)  → throws? DROP (malformed)
  │  adapter.verify()    → false?  DROP (invalid)        → otherwise enrich row
  ▼
sqliteArchiveSink | postgresArchiveSink          ← store, 7-day prune  [§4.1c, §7]
  ▼
HTTP domain query API                            ← /signatures /owners /aggregate-ready /records  [§6]
```

The registry set is recomputed per tick (cheap; cached by isoDay), so when the UTC day rolls, today's new category enters the polled set automatically and the oldest day ages out of both coverage and retention.

## 9. Retention & prune

- **7-day rolling window**, equal to `windowDays`. Pruning reuses the relayer cadence: `pruneEveryTicks` (default 30 in `relayer.ts`) triggers `sink.prune()`, which deletes rows older than the window. With a 15 s interval, prune runs roughly every ~7.5 min — fine for a 7-day window.
- SQLite prune: `DELETE FROM cosign_signature WHERE first_seen_at < :cutoff` (epoch cutoff = `now − windowDays`). Postgres prune mirrors `archive.ts`: `DELETE ... WHERE first_seen_at < now() - INTERVAL '<windowDays> days'`.
- Coverage and retention share the same number: a row's category leaves the polled set and its age crosses the prune threshold together, so the index never holds rows for categories it no longer watches.

## 10. Error handling & recovery

- **Board outage / RPC error during poll** — the relayer loop already catches per-tick errors (`loop()` logs `tick failed` and continues); the next tick retries. No special handling needed; the daemon is resilient by inheritance.
- **Malformed `data`** — `decodeRecord` **throws**; the decode step catches and returns `{ keep: false, reason: 'undecodable' }`. The open board guarantees junk under a category, so this is expected and silent-at-info-level (logged via `ctx.logger`).
- **Invalid signature** — `adapter.verify` returns false → `{ keep: false, reason: 'verify-failed' }` → dropped. The DB holds only valid artifacts.
- **Adapter `verify` *error*** (e.g. RPC failure, or the stubbed Wonderland adapter throwing `not implemented`) — distinguished from a clean `false`. Per the SDK's stance (verify errors *propagate*, not silently "invalid"), the decode step treats a thrown error as a **transient drop with a distinct reason** (`verify-errored`) and logs it, rather than recording an unvalidated row. It does **not** crash the tick. (For `adapter.kind: "none"`, verify is skipped and every decodable record is kept.)
- **Store failure on `record`** — propagates out of `sink.record`; the relayer's `runOnce`/`loop` catches it as a tick failure and retries next tick. Idempotent PK `(hash, chain_id)` makes retry safe.
- **Empty / stale DB at startup** — served as empty results. Cold-start hydration from `archive.msgboard.xyz` is **deferred** (§2); the key scheme makes it additive (re-fetch the window's categories, replay through the same decoding sink).

## 11. Testing

**Unit**
- *Registry / source category-expansion* — `expandCategories` returns `{teams} × {windowDays}` hashes matching `keysForWindow`; rolls correctly across a UTC day boundary; `multisig:*` expands all listed teams. `msgboardContentSource({ categories })` polls each hash and flattens; single/all paths unchanged.
- *Decoding/filtering sink keep/drop/enrich* — fake inner sink + fake adapter: a valid record is enriched and forwarded; undecodable junk is dropped (`undecodable`); a record failing `verify` is dropped (`verify-failed`); a `verify` that throws is dropped (`verify-errored`) without crashing; `prune` passes through.
- *SQLite sink record/prune/query* — `:memory:` DB: `record` inserts enriched rows (idempotent on `(hash,chain_id)`); `prune` removes rows older than `windowDays`; `query` filters by digest/signer/category/time, newest first, bounded ≤1000.
- *Domain query endpoints* — over a seeded store: `/signatures?digest=` returns all sigs; `/owners?digest=` returns distinct signers; `/aggregate-ready` returns ordered dedup-by-signer set with correct `ready` vs threshold; `/records` generic filters; `/health`; auth (401 without token on non-loopback); param coercion.

**Integration**
- *End-to-end* — post a cosign signature through the SDK (`postSignature`) onto a fake/local board under today's rotating category; run one archivist tick (`runOnce`) with the real `expandCategories` source + real `decodingSink(cosignDecode(fakeAdapter))` + real `sqliteArchiveSink`; assert the row lands enriched, then query it back via `/signatures` and `/aggregate-ready`. Confirms the codec is the single source of truth (post-side and archive-side decode agree).

No live chain needed for the core; adapter contract-reads are exercised when the real Wonderland adapter is built (fork/mock), per the SDK spec.

## 12. Differentiation vs `archive.msgboard.xyz`

| Axis | `archive.msgboard.xyz` (`@msgboard/history`) | cosign archivist (`@msgboard/cosign-archivist`) |
|---|---|---|
| **Coverage** | catch-everything (`msgboardContentSource()` — all categories) | selective — registry team-file × 7-day window, explicit category set |
| **Retention** | ~365 days (long-tail mirror) | 7-day rolling working set |
| **Decode** | UTF-8 text → `data_text` (`tryDecodeText`) | structured — cosign codec → `digest`/`signer`/`signature`/`scheme`/`meta` columns |
| **Query** | raw rows + substring `contains` (`/messages`) | domain-aware — `/signatures`, `/owners`, `/aggregate-ready`, `/records` |
| **Validation** | stores verbatim (junk and all) | drops invalid at ingest (adapter `verify`); DB holds only valid artifacts |
| **Host** | one public Postgres, queried remotely | SQLite default, self-hostable, tight local footprint (Postgres for scale) |

They are complementary ends of a scope/retention/structure spectrum, sharing the `history`/`relayer` lineage.

## 13. Decomposition into sequenced plans

This is sizable; split into three plans plus deferred work.

**Plan 1 — Reusable relayer/history bits** (`@msgboard/relayer`, `@msgboard/history`)
- `categories?: string[]` (+ resolver form) on `msgboardContentSource`; backward-compatible.
- `decodingSink` / `filteringSink` generic wrapper.
- `createSqliteArchive` in `@msgboard/history` + `sqliteArchiveSink` in `@msgboard/relayer`, mirroring `createArchive` / `postgresArchiveSink`.
- Unit tests for each. These ship value independently of the cosign service.

**Plan 2 — The archivist service** (`@msgboard/cosign-archivist`)
- `team-file.ts` (load/validate), `registry.ts` (expansion via `keysForWindow`), `decode.ts` (cosign decode + adapter verify → row), `store.ts` (store selection + cosign columns + retention), `daemon.ts` (relayer wiring, observe + noop + prune cadence).
- Unit tests (expansion, decode keep/drop/enrich) + the end-to-end integration test into SQLite.

**Plan 3 — The HTTP domain query API** (`@msgboard/cosign-archivist`)
- `query.ts` (domain SQL) + `server.ts` (endpoints, auth, timeouts) modeled on `history/server.ts`.
- Endpoint unit tests.

**Deferred (explicit follow-ups, not in the above plans):**
- Cold-start hydration fallback to `archive.msgboard.xyz` when the local DB is empty/stale.
- On-board discovery of unknown teams (registry v2).
- Encryption of in-flight records.
- Multi-tenant control plane (tenant registry, provisioning) — additive over the single-tenant v1.

## 14. Open items

- **SQLite driver choice** — `better-sqlite3` (sync, mature) vs `node:sqlite` (built-in, newer). Affects the `Queryable` adapter shape for `createSqliteArchive`. Pin in Plan 1.
- **Registry recompute cadence** — per-tick vs isoDay-cached. Leaning isoDay-cached (recompute only when `isoDay(now)` changes); confirm in Plan 2.
- **Adapter resolution** — how `adapter.kind` strings map to `CosignAdapter` instances (registry of built adapters); Wonderland is stubbed in the SDK, so `"wonderland"` resolves to the stub and every record drops as `verify-errored` until the real adapter lands. `"none"` is the working default.
- **Ordering in `/aggregate-ready`** — whether to apply `adapter.order` (needs a built adapter) or return signer-sorted when adapter is `"none"`. Pin with the first real adapter.
- **`scope` / `namespace` convention** — must match exactly how teams post via the SDK (`('cosign', team)` vs `('multisig', '${chainId}:${safeAddress}')`); inherited as an open item from the SDK spec §9.

---

### Self-review

- *Placeholder scan* — no TODO/TBD/`<...>` placeholders left in the body; template angle-brackets in the subtitle line resolved to a concrete subtitle.
- *Internal consistency* — `windowDays` = retention = coverage (7) is stated consistently (§5, §8, §9, §12); the §3.2 "filter at source/sink not condition" constraint is the stated reason for additions (a) and (b) in §4.1 and is reflected in the §8 data-flow note that `sink.record` runs unconditionally; column set in §7 matches the `SignatureRow` response in §6 and the decode mapping in §4.2/§10.
- *Scope* — deferred items (cold-start hydration, discovery, encryption, multi-tenant) are kept out of the three plans and listed once in §2, §10, and §13; YAGNI respected (no speculative features).
- *Grounding* — real interfaces quoted from the codebase: `RelayerSink`, `RelayerCondition` (types.ts), `handleItem` ordering (relayer.ts), `postgresArchiveSink` shape (postgres-archive.ts), `MsgboardContentSourceOptions` (msgboard-content.ts), `message_archive` schema + prune SQL (archive.ts), server conventions (server.ts).
- *Ambiguity* — the one genuinely undecided knob (SQLite via shared `createArchive` vs a new `createSqliteArchive`) is resolved inline in §4.1c (favor `createSqliteArchive` because `archive.ts` SQL is Postgres-specific) and surfaced again as Open Item §14 for the driver choice. No other unresolved forks remain in the design.
