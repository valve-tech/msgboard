# MsgBoard cosign archive — Stateless Decoded Query Route over Board + archive.msgboard.xyz (Design Spec)

Date: 2026-06-13
Status: Draft for review

Related:
- **`@msgboard/cosign` SDK** — `docs/superpowers/specs/2026-06-13-msgboard-cosign-sdk-design.md` (sub-project 1). The route is **essentially the SDK's read-side functions wrapped in HTTP.** It imports `keys` (`keysForWindow(namespace, scope, days, now?)`, `currentKey`), `record` (the `SignatureRecord` ABI codec `(bytes32 digest, address signer, bytes signature, uint8 scheme, bytes meta)` with `decodeRecord` that **throws** on junk), and the client helpers `readSignatures(board, {namespace, scope, days, now?})`, `groupByDigest(records)`, and `aggregate(records, adapter)`. A `CosignAdapter` (`verify` / `order` / `owners?` / `threshold?`) supplies validation + ordering.
- **`packages/history`** — `archive.ts` (`createArchive` → `Archive.query(filter)`, the `archive.msgboard.xyz` storage core) and `server.ts` (`archiveServer` → the public read-only HTTP server, `/health` + `/messages`). The cosign route is **added to this history server** as a new cosign-aware endpoint group; the long-tail fallback reads the existing archive's `query()`.
- **msgboard two-store model** — chain = sybil-resistant + permanent; board = zero-cost PoW-gated broadcast; *cryptography is king, independent of the store*. A co-signature is self-authenticating, so it lives on the ephemeral board. **The board (live recent traffic) + `archive.msgboard.xyz` (long tail) ARE the storage.** This route is a decoded, validated, aggregated **VIEW** over that data — not a new store.

---

## 1. Summary

The **cosign archive** is a **stateless query route**, not a service. It owns no database, runs no daemon, prunes nothing, and adds nothing to the relayer. On each request it: resolves the target rotating categories for `{team(s)} × {last N days}` (from a registry team-file, via the cosign `keysForWindow`), **fetches** those categories from the board (live recent) with fallback to `archive.msgboard.xyz` (`history`'s `query()`) for older days, **decodes** each entry via the cosign `record` codec (skipping junk), **validates** via a `CosignAdapter.verify` (dropping invalid), then `groupByDigest` / `aggregate`s and returns.

The board already holds the last ~N days of traffic live, and `archive.msgboard.xyz` holds the long tail — so a stateless route can serve everything by fetching on demand. The route is therefore "the cosign SDK's `readSignatures` / `groupByDigest` / `aggregate`, wrapped in HTTP and scoped by a team-file." No dedicated DB, no daemon, no prune, no SQLite, no relayer additions in v1.

The heavy **stateful filtered-archive** of the prior design (relayer pipeline + filtering/decoding sink + SQLite/Postgres sink + prune daemon) is **deferred** to an optional persistent cache (§11) that you add only if per-query fetch+decode proves too slow, or you need offline/air-gapped operation, very large windows, or multi-tenant persistence. That cache would materialize exactly the same decoded rows this route computes on the fly.

## 2. Goals / non-goals

**Goals**
- **Stateless** — serve cosign queries with no local store, no daemon, no prune. The board + `archive.msgboard.xyz` are the storage.
- **A decoded, validated, aggregated VIEW** — wrap the cosign SDK's `readSignatures` / `groupByDigest` / `aggregate` in a domain-aware HTTP API: signatures-for-a-digest, owners-who-signed, and the headline **aggregate-ready** ordered `{signer,signature}[]`.
- **Scoped by a registry team-file** — the hosted route serves a known `(namespace, scope)` set so it can validate and bound requests; self-hosters point it at their own scope.
- **Co-located with `archive.msgboard.xyz`** — mounted on the existing `history` server, reusing its conventions (`/health`, JSON, loopback-default bind, `token`-gated non-loopback, 10 s timeouts) and its `query()` for the long-tail fallback.

**Non-goals (this spec)**
- **A stateful filtered-archive cache** — relayer pipeline, filtering/decoding sink, SQLite/Postgres sink, prune daemon. **Deferred** (§11).
- **Cold-start hydration** — moot; there is no local DB to cold-start. The relevant trade is the route's dependency on board/archive availability *at query time* (§9).
- **On-board discovery of unknown teams** — Registry v1 is an explicit team-file. Deferred.
- **Encryption of in-flight records** — board records are public by the two-store model. Deferred.
- **Multi-tenant control plane** — tenant registry, provisioning. Deferred.
- **On-chain execution / aggregation submission** — handled by the SDK's consumers, out of scope.

## 3. Why a route, not a service

The prior design built a standalone stateful service: a relayer that polled the registry categories, a filtering/decoding sink that validated and enriched, a SQLite/Postgres archive that stored the decoded rows, a prune daemon on a 7-day window, and an HTTP server querying that DB. That is a lot of moving parts to maintain a *copy* of data that already exists in two places.

**The board + `archive.msgboard.xyz` already are the store.** By the two-store model, a co-signature is binding because of the signature, not where it sits, and cosign records broadcast to the board at ~zero reader cost. The board node holds the recent rolling window live (it serves `msgboard_content` per category), and `archive.msgboard.xyz` mirrors the long tail (it serves `Archive.query`). Between them, every cosign record in any reasonable window is already retrievable on demand.

So the v1 archive is best expressed as a **stateless VIEW**: fetch the relevant categories, decode them through the cosign codec, validate through the adapter, aggregate, return. This is precisely what the cosign SDK's `readSignatures` → `groupByDigest` → `aggregate` already do in-process; the route is those calls behind HTTP, scoped by a team-file, with an archive fallback for older days.

**Cost / benefit vs a cache.** A stateless route trades a small per-request fetch+decode cost for the elimination of an entire stateful subsystem (no DB to provision, migrate, back up; no daemon to keep alive; no prune to tune; no cold-start; no drift between the cache and the source of truth). The common case — a 7-day window for one team, a handful of rotating categories, each a small set of small records — is cheap to fetch and decode per request, especially with the board covering the recent window without touching the archive at all. You pay the route's cost only on the request path, and only for the categories actually asked for, rather than continuously polling and storing everything in the team-file. The cache (§11) buys back the per-request cost *if and when* it actually bites (large windows, offline operation, hot multi-tenant load) — and when it does, it materializes the very same decoded rows this route computes, so adding it is additive, not a rewrite.

YAGNI: v1 ships the route; everything stateful is deferred until a concrete need appears.

## 4. Architecture & components

### 4.1 Proposed home: a cosign endpoint group on the `@msgboard/history` server

**Decision: add the cosign route as a new endpoint group inside `@msgboard/history`'s `server.ts`, behind an opt-in `cosign` option on `archiveServer` — not a separate package, in v1.**

Rationale:
- The long-tail fallback reads `archive.query()` — the very `Archive` the history server already holds. Co-locating means the fallback is a direct in-process call, no second deployment, no cross-service hop.
- The route reuses the history server's exact conventions wholesale: `respond()` JSON helper, `/health`, the `127.0.0.1`-default bind, the non-loopback-requires-`token` guard, the `Authorization: Bearer` check, and the 10 s `headersTimeout` / `requestTimeout`. Mounting on the same `createServer` handler inherits all of it for free.
- It is genuinely small: a category resolver + a board client + the cosign SDK + an adapter. It does not warrant its own package, deployment, or release cadence in v1.

The route is gated by a `cosign?` option so the plain `archive.msgboard.xyz` deployment is unchanged when the option is absent. When present, the same server answers both `/messages` (raw archive) and `/cosign/...` (decoded cosign view).

**Deferred alternative.** If the route later needs to ship and version independently of the history server (e.g. self-hosters who don't run the full archive), it can be extracted into a thin **`@msgboard/cosign-archive`** package that exports a request handler mountable on any `node:http` server — including the history server. The §11 cache, if built, would naturally live in that package too. v1 does not do this; it is noted only so the endpoint-group boundary is drawn cleanly enough to extract later.

### 4.2 What the route depends on

- **`@msgboard/cosign`** — `keysForWindow` (category resolution), `decodeRecord` (decode), `readSignatures` / `groupByDigest` / `aggregate` (the read-side helpers), and the `CosignAdapter` type. This is the single source of truth for the key scheme and the record codec.
- **A board client** (`@msgboard/sdk`'s `MsgBoardClient`, or the cosign SDK's minimal `BoardClient`) — `content({ category })` per resolved category, for the live recent window.
- **The history `Archive`** — `archive.query({ category, since, until, ... })` for the long-tail fallback (older days).
- **A `CosignAdapter`** — for `verify` (validation) and `order` / `threshold?` (aggregate ordering + readiness). `kind: "none"` accepts every decodable record (no chain reads).

The route does **not** depend on `@msgboard/relayer`. There is no source, sink, condition, daemon, or prune in v1.

### 4.3 Component modules (within the history server's cosign group)

These are functions, not a package tree — small enough to live in one or two files (`server.ts` plus a `cosign-route.ts` helper) inside `@msgboard/history`:

- **`teamFile`** — load + validate the registry team-file JSON (§5); default `windowDays`, resolve adapter selector. `loadTeamFile(path): TeamFile`.
- **`resolveCategories`** — given the team-file (or a single `(namespace, scope)`) and `now`, expand `{teams} × {last N UTC days}` into concrete category hashes via the cosign `keysForWindow`. Computed per request (cheap; no caching needed, but cacheable by isoDay if profiling demands).
- **`fetchRecords`** — for the resolved categories, read from the board (recent) with `archive.query()` fallback for older days (§8), decode each entry via `decodeRecord` (skip throws), validate via `adapter.verify` (drop false, drop+log on throw). Returns `SignatureRecord[]` with provenance. This is effectively `readSignatures` extended with the archive fallback and adapter-validation at fetch time.
- **the cosign request handler** — parse `:namespace` / `:scope` / `:digest` / `?days`, call the above, `groupByDigest` / `aggregate`, shape the JSON response (§6). Mounted into the history `createServer` handler alongside `/messages`.

## 5. The registry team-file (Registry v1)

A **non-encrypted JSON file** the operator points the route at. It defines which `(namespace, scope)` / teams the hosted route is willing to serve, so the route can scope and validate incoming requests (reject unknown scopes, bound the window, select the adapter). Self-hosters point it at their own scope. It is **the same team-file concept as the prior design**, but it now scopes a stateless route rather than configuring a daemon's coverage — there is no `store` block (no store) and no prune cadence.

```jsonc
{
  "version": 1,
  "namespace": "cosign",          // cosign key namespace (matches how teams post)
  "windowDays": 7,                 // default/clamp for the rolling window; default 7
  "teams": [                       // scopes the route serves; "*" / "multisig:*" = all listed
    { "scope": "wonderland",        "label": "Wonderland multisig" },
    { "scope": "1:0xSAFE...",       "label": "Safe on mainnet" }
  ],
  "chain": {                       // board node to read from
    "chainId": 943,
    "rpcUrl": "https://rpc.testnet.msgboard.xyz"
  },
  "adapter": {                     // validation/ordering adapter selection
    "kind": "wonderland",         // resolves to a CosignAdapter; "none" = accept all decodable
    "config": { "multisig": "0xSAFE...", "chainId": 1 }
  }
}
```

Notes:
- `teams[].scope` is the cosign `scope` (per the SDK, e.g. team name or `${chainId}:${safeAddress}`); paired with `namespace`, it feeds `keysForWindow`. A request for a `(namespace, scope)` not in `teams` (and not covered by a `"*"` entry) is rejected.
- `windowDays` bounds the request `?days` param (a request asking for more is clamped, so the route can't be made to sweep an unbounded window).
- `adapter.kind: "none"` is the unvalidated default for teams without a built adapter (Wonderland ships stubbed in the SDK; a `verify` that throws surfaces as a drop-with-reason, not a crash — see §9).
- The hosted instance ships a broad team-file (all served teams); a self-hoster ships a narrow one (their scope only).

## 6. HTTP API

Mounted on the history server, inheriting its conventions (`/health` → `{ ok: true }`; JSON bodies; `127.0.0.1`-default bind; non-loopback bind **requires** `token`; `Authorization: Bearer <token>` enforced when set; 10 s timeouts). All cosign endpoints are read-only and domain-aware. They follow `history/server.ts`'s style — a `GET` method + pathname match, `URLSearchParams` parsing with unparseable values ignored, the `respond(res, status, body)` helper, try/catch → 500 on failure.

Path shape: `/cosign/:namespace/:scope/...`. The `(namespace, scope)` pair is validated against the team-file (404/403 if unknown).

| Endpoint | Params | Response |
|---|---|---|
| `GET /health` | — | `{ ok: true }` (shared with the archive server) |
| `GET /cosign/:namespace/:scope/signatures` | `days?` (clamped to `windowDays`), `chainId?`, `scheme?`, `limit?`, `offset?` | `{ signatures: SignatureRecordView[] }` — all decoded valid records in the window |
| `GET /cosign/:namespace/:scope/digest/:digest` | `chainId?` | `{ digest, signatures: SignatureRecordView[], signers: Hex[], count }` — all signatures for a digest + who signed |
| `GET /cosign/:namespace/:scope/digest/:digest/aggregate` | `chainId?`, `threshold?` | `{ digest, signers: { signer, signature, scheme }[], count, threshold?, ready }` — the **aggregate-ready** ordered, dedup-by-signer set; `ready = count ≥ threshold` (threshold from the adapter or the param) |
| `GET /cosign/:namespace/:scope/owners` *(optional passthrough)* | — | `{ owners: Hex[], threshold }` — from `adapter.owners?()` / `adapter.threshold?()` when the adapter implements them; 501 when `kind: "none"` or unimplemented |

`SignatureRecordView` (the decoded record + provenance):

```jsonc
{
  "digest": "0x...", "signer": "0x...", "signature": "0x...", "scheme": 0, "meta": "0x...",
  "category": "0x...", "category_text": "cosign:wonderland:2026-06-13",
  "source": "board" | "archive"          // where this record was fetched from
}
```

`/cosign/:ns/:scope/digest/:digest/aggregate` is the **headline endpoint**: it returns exactly what an executor needs — the ordered `{ signer, signature }` set, already decoded, validated, and ordered by the adapter — without the caller re-reading the board or running the codec themselves. It is `groupByDigest(records).get(digest)` → `aggregate(thatGroup, adapter)` behind one GET.

## 7. Data flow

```
request: GET /cosign/cosign/wonderland/digest/0xDEAD/aggregate?days=7
  │
  ▼
validate (namespace, scope) against team-file; clamp days ≤ windowDays   [§5]
  │
  ▼
resolveCategories(namespace, scope, days, now)                          [§4.3]
  │   = keysForWindow → {scope} × {today + prior days-1 UTC days} hashes
  ▼
fetchRecords(categories)                                                [§4.3, §8]
  │   for each category:
  │     recent days → board.content({ category })            (live)
  │     older days  → archive.query({ category, since, until })  (fallback)
  │   for each entry:
  │     decodeRecord(data) → throws? SKIP (junk)
  │     adapter.verify()   → false?  DROP (invalid)
  │                          throws? DROP+LOG (verify-errored)
  ▼
groupByDigest(records).get(digest)                                      [cosign SDK]
  │
  ▼
aggregate(group, adapter)  → ordered, dedup-by-signer { signer, signature }[]
  │
  ▼
respond 200 { digest, signers, count, threshold?, ready }              [§6]
```

Everything happens on the request path; nothing is stored. When the UTC day rolls, `keysForWindow` simply yields today's new category and drops the oldest — no prune, because nothing persists.

## 8. Reading from board vs `archive.msgboard.xyz`

The resolved category set spans `windowDays` UTC days. The split:

- **Recent days → the board.** The board node holds the live rolling window and serves `content({ category })` per category. **For the common 7-day window, the board alone covers it** — a board's retention comfortably exceeds a week — so a typical request never touches the archive at all.
- **Older days → `archive.msgboard.xyz` (the history `query()`).** Only when the requested window reaches past the board's live retention does the route fall back to `archive.query({ category, since, until })` for those older days. Because the route is co-located with the archive (§4.1), this is an in-process call.

Window logic: derive each category's UTC day from the `keysForWindow` expansion; for days within the board's known retention, read from the board; for days older than that, read from the archive. The board's retention boundary is a configured value (conservative default well under the board's actual retention, so we never miss records by trusting the board too long). Records fetched from each source are tagged `source: "board" | "archive"` in the response. A digest's signatures may legitimately span both sources; they're merged before `groupByDigest`.

Make the fallback explicit but note it is the exception, not the rule: the headline 7-day-window case is board-only.

## 9. Error handling

- **Board unreachable / RPC error during fetch** — surfaces per-category. The route can either fail the request (`502`, `{ ok: false, error }`) or, for a multi-category fetch, return partial results with a `warnings` field naming the categories that failed; **v1 fails the request with a clear error** (a partial aggregate could mislead an executor into thinking a digest lacks signatures it actually has). This is the central trade vs a cache: the stateless route depends on board/archive availability *at query time*, where a cache would have served the last-known rows. Noted as the explicit cost of statelessness (§3).
- **Archive unreachable (fallback path)** — same handling; if older days can't be fetched, fail with an error naming the unavailable source rather than silently returning a short window.
- **Malformed `data` (junk under a category)** — `decodeRecord` **throws**; the fetch step catches and **skips** the entry (`undecodable`). The open board guarantees junk under any category, so this is expected and silent-at-info-level (logged, not surfaced).
- **Invalid signature** — `adapter.verify` returns false → the record is **dropped**. The response holds only valid artifacts.
- **Adapter `verify` *error*** (RPC failure, or the stubbed Wonderland adapter throwing `not implemented`) — distinguished from a clean `false`. Per the SDK's stance (verify errors *propagate*, not silently "invalid"), the route drops the record with a distinct reason (`verify-errored`) and logs it, and does not crash the request. With `adapter.kind: "none"`, verify is skipped and every decodable record is kept.
- **Unknown `(namespace, scope)`** — not in the team-file → `404`/`403` (`{ ok: false, error: 'unknown scope' }`).
- **`days` over `windowDays`** — clamped to `windowDays` (not an error), so the route can't be driven to sweep an unbounded window.
- **Bad `digest` / params** — coerced like `history/server.ts` (`URLSearchParams`, unparseable ignored); a missing required `:digest` → `404` route miss.

## 10. Testing

**Unit** (no live chain, no DB):
- *Category resolution* — `resolveCategories(namespace, scope, days, now)` returns `{scope} × {days}` hashes matching the cosign `keysForWindow`; rolls correctly across a UTC day boundary; honors the `windowDays` clamp; rejects scopes absent from the team-file.
- *Fetch + decode + validate + aggregate over a fake board* — a fake board client returns fixtures for the resolved categories **including junk** (an entry whose `data` makes `decodeRecord` throw) **and an invalid record** (one whose `adapter.verify` returns false), plus several valid records across two digests. Assert: junk is skipped; the invalid record is dropped; a `verify` that *throws* is dropped (`verify-errored`) without failing the request; valid records survive; `groupByDigest` groups them; `aggregate` returns the ordered dedup-by-signer set; `ready` is correct vs the threshold.
- *Board-vs-archive window split* — with a fake board (recent days) and a fake `Archive.query` (older days), a window straddling the board-retention boundary fetches recent days from the board and older days from the archive, merges, and tags `source` correctly.
- *HTTP shape* — `/health`; `/cosign/:ns/:scope/signatures`, `/digest/:digest`, `/digest/:digest/aggregate`, optional `/owners`; auth (401 without token on non-loopback); param coercion; unknown-scope 404; `days` clamp.

**Integration:**
- *Post via cosign → query the route → get aggregate-ready back* — post one or more cosign signatures through the SDK (`postSignature`) onto a fake/local board under today's rotating category for a known team; stand up the history server with the `cosign` option pointed at that board + a `kind: "none"` (or fake) adapter and a team-file containing the team; `GET /cosign/cosign/<team>/digest/<digest>/aggregate` and assert the response is the aggregate-ready ordered `{signer,signature}[]`. This confirms the cosign codec is the single source of truth (post-side and route-side decode agree) end to end, with no store in the loop.

## 11. Deferred: optional persistent cache

The prior design's stateful subsystem is **deferred**, not deleted — it becomes an optional cache you add only when the stateless route's per-request cost actually bites. **When you'd add it:**

- **Per-query fetch+decode is too slow** — very hot endpoints, or large fan-out across many teams, where re-fetching and re-decoding on every request dominates latency.
- **Offline / air-gapped operation** — a deployment that must answer cosign queries without reaching the board or `archive.msgboard.xyz` at request time (the §9 availability trade made unacceptable).
- **Very large windows** — windows far past the board's live retention, where the archive-fallback fan-out per request is expensive enough to be worth materializing once.
- **Multi-tenant persistence** — a hosted instance serving many teams that wants durable, indexed, cross-restart state rather than recomputing per request.

**What it would be** — exactly the prior design, demoted to an optional layer behind the same route:
- The three reusable relayer/history additions move here (out of v1): a **multi-category source** (`categories?: string[]` on `msgboardContentSource`), a **filtering/decoding sink** (`decodingSink` — decode + `adapter.verify`, keep/enrich or drop, before delegating to an inner store; honoring that the relayer's `sink.record` runs unconditionally before `condition`, so filtering must live in the sink, not the `condition` hook), and a **`sqliteArchiveSink`** mirroring `postgresArchiveSink` (likely via a new `createSqliteArchive` next to `createArchive`, since `archive.ts` SQL is Postgres-specific: `TIMESTAMPTZ`, `now() - INTERVAL`, `ILIKE`, `DO $$`).
- A daemon (relayer in `observe`/noop mode, prune on the `windowDays` cadence) that polls the registry categories, decodes + validates through the sink, and writes the decoded rows into the cache store.
- **The cache materializes the same decoded rows the route computes on the fly** (`digest`, `signer`, `signature`, `scheme`, `meta`, plus provenance) — so the HTTP route's handlers serve from the cache when present and fall back to live fetch when not. Adding the cache is therefore additive: same endpoints, same response shapes, same codec; the route just reads materialized rows instead of recomputing.
- Cold-start is then a real concern for the cache (an empty cache replays the window's categories through the same decoding path to hydrate) — but it is *the cache's* concern, not v1's.

Also deferred (unchanged): on-board discovery of unknown teams (registry v2); encryption of in-flight records; multi-tenant control plane (tenant registry, provisioning).

## 12. Differentiation vs `archive.msgboard.xyz`

The cosign archive is now a **decoded, cosign-aware VIEW/route on top of the same data** the archive serves — not a separate store. The table contrasts the *raw archive* with the *cosign route over it*:

| Axis | `archive.msgboard.xyz` (`@msgboard/history`, `/messages`) | cosign route (`/cosign/...` on the same server) |
|---|---|---|
| **What it is** | a store — durable Postgres mirror of board traffic | a **stateless VIEW** — no store; fetches board + archive per request |
| **Coverage** | catch-everything (all categories) | selective — team-file `(namespace, scope)` × window, resolved per request |
| **Source of data** | its own Postgres table | the **board** (recent) + this same archive's `query()` (long tail) |
| **Decode** | UTF-8 text → `data_text` (`tryDecodeText`) | structured — cosign codec → `digest`/`signer`/`signature`/`scheme`/`meta` |
| **Query** | raw rows + substring `contains` (`/messages`) | domain-aware — `/signatures`, `/digest/:digest`, `/digest/:digest/aggregate`, `/owners` |
| **Validation** | stores verbatim (junk and all) | drops junk (codec) + invalid (adapter `verify`) at read time |
| **State** | stateful (table, prune, retention) | **stateless** (computed per request; optional cache deferred, §11) |

They are complementary: the archive is the durable substrate; the cosign route is a decoded, validated, aggregated lens onto the board + that substrate, sharing the `history` server and its `query()`.

## 13. Decomposition into sequenced plans

**Plan 1 (v1) — The stateless cosign route** (in `@msgboard/history`)
- `teamFile` (load/validate; no store block), `resolveCategories` (via cosign `keysForWindow`), `fetchRecords` (board read + `archive.query()` fallback + `decodeRecord` skip-junk + `adapter.verify` drop-invalid), and the cosign request handler.
- Mount the cosign endpoint group on `archiveServer` behind a `cosign?` option, reusing `respond`, the bind/`token` guard, and the timeouts.
- Unit tests (category resolution; fetch+decode+validate+aggregate over a fake board with junk + invalid fixtures; board-vs-archive window split; HTTP shape) + the post-via-cosign → query-the-route integration test.

**Deferred — the optional persistent cache** (§11; its own follow-up spec/plan when triggered)
- The three reusable relayer/history additions (multi-category source, decoding/filtering sink, `sqliteArchiveSink` / `createSqliteArchive`).
- The cache daemon (relayer in observe/noop + prune) and route-reads-from-cache wiring.
- Cache cold-start hydration.

## 14. Open items

- **Board retention boundary** — the configured cutoff that decides "recent (board) vs older (archive)" per day (§8). Pin a conservative default (well inside the board's real retention) in Plan 1; ideally derive it from the board's `status` rather than hard-coding.
- **Partial-failure policy** — v1 fails the whole request when any category fetch errors (§9). Confirm whether a `warnings`-with-partial-results mode is ever wanted for the multi-team `signatures` endpoint (it is not for `aggregate`).
- **Ordering in `aggregate`** — whether to apply `adapter.order` (needs a built adapter) or return signer-sorted when adapter is `"none"`. Pin with the first real adapter.
- **Adapter resolution** — how `adapter.kind` strings map to `CosignAdapter` instances; Wonderland is stubbed in the SDK, so `"wonderland"` resolves to the stub and every record drops as `verify-errored` until the real adapter lands. `"none"` is the working default.
- **`scope` / `namespace` convention** — must match exactly how teams post via the SDK (`('cosign', team)` vs `('multisig', '${chainId}:${safeAddress}')`); inherited as an open item from the SDK spec §9.
- **Extract-to-package threshold** — when (if ever) to pull the route into a standalone `@msgboard/cosign-archive` (§4.1 deferred alternative). Not in v1.

---

### Self-review

- *Placeholder scan* — no TODO/TBD/`<...>` placeholders left in the body; the title subtitle is concrete. Path/route names are real (`/cosign/:namespace/:scope/...`, `/messages`, `/health`).
- *Architecture consistency* — the "stateless route, board+archive are the store" thesis is stated once in §1/§3 and reflected throughout: no store in §4 (deps exclude `@msgboard/relayer`), no `store` block in §5, computed-per-request in §6/§7, board-vs-archive split in §8, statelessness as the §9 availability trade and the §12 "State" row, and the demoted stateful design isolated in §11. The headline `aggregate` endpoint is consistent across §1, §6, §7, §10, §12.
- *Scope / YAGNI* — v1 is the route only (§13 Plan 1); every stateful piece (relayer source/sink, SQLite, prune, daemon, cold-start) is in §11/§13-deferred, not v1. Discovery, encryption, multi-tenant remain deferred.
- *Grounding* — real interfaces quoted/referenced: `archiveServer` conventions and the `respond`/`parseQuery`/`/health`/`/messages` style + bind/token guard + 10 s timeouts (`history/server.ts`); `Archive.query(ArchiveQuery)` and the Postgres-specific SQL that motivates a separate SQLite path (`history/archive.ts`); the cosign SDK's `readSignatures(board, {namespace, scope, days})` / `groupByDigest` / `aggregate(records, adapter)` / `keysForWindow` / `decodeRecord` (throws on junk) and the `CosignAdapter` seam (cosign SDK spec §4); board `content({ category })` (`@msgboard/sdk`).
- *Ambiguity* — the one real architectural fork (endpoint-group-on-history-server vs standalone package) is resolved inline in §4.1 (group on the history server for v1, because the archive fallback is in-process and the conventions are inherited) and surfaced again as Open Item §14 (extract threshold). The board-retention boundary is the other knob, resolved as a conservative configured default in §8 and pinned in §14. No other unresolved forks remain.
