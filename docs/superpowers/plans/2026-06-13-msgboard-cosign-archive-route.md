# MsgBoard cosign archive route (v1, stateless) — Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL — `superpowers:test-driven-development`. Every task below is RED → GREEN → REFACTOR. Write the failing test first, run it, watch it fail for the *right reason*, then write the minimum code to pass. Do not skip the RED step. Do not write source before its test.

## Goal

Ship the **v1 stateless cosign archive route** (sub-project 2) as a new cosign-aware endpoint group inside `@msgboard/history`'s `archiveServer`, gated behind an opt-in `cosign?` option. The route is **the cosign SDK's read-side functions wrapped in HTTP and scoped by a registry team-file**: on each request it resolves the rolling categories for `{(namespace, scope)} × {last N UTC days}` via the cosign SDK's `keysForWindow`, fetches those categories from the **board** (live recent window) with a fallback to this same server's **`archive.query()`** (`archive.msgboard.xyz`, the long tail) for older days, decodes each entry via the cosign `decodeRecord` codec (skipping junk that throws), validates each via a `CosignAdapter.verify` (dropping `false`, dropping-with-reason on throw), then `groupByDigest` / `aggregate`s and returns a domain-aware JSON view.

Three endpoints (domain-aware, path shape `/cosign/:namespace/:scope/...`):

- `GET /cosign/:namespace/:scope/signatures?days=7` → all decoded valid records in the window.
- `GET /cosign/:namespace/:scope/digest/:digest` → all signatures for one digest + who signed.
- `GET /cosign/:namespace/:scope/digest/:digest/aggregate` → the **headline** aggregate-ready ordered `{ signer, signature }[]` (dedup-by-signer, ordered by the adapter), plus `count`/`threshold?`/`ready`.

Plus: a **registry team-file** that scopes which `(namespace, scope)` the route serves (reject unknown scopes, clamp the window, select the adapter), and the **board-vs-archive window read logic** (recent days → board; older days → `archive.query()`).

**Source of truth:** `docs/superpowers/specs/2026-06-13-msgboard-cosign-archivist-design.md`. This plan implements exactly the §13 "Plan 1 (v1) — the stateless cosign route", and **nothing** from §11 (the deferred persistent cache).

### Dependencies (read before starting)

- **DEPENDS ON the cosign SDK — already BUILT** at `packages/cosign` (sub-project 1). This plan imports its public surface verbatim and **does not** modify it:
  - `keysForWindow(namespace, scope, days, now?): Hex[]` — today-first, descending, today + prior `days-1` UTC days; throws if `days < 1`.
  - `isoDay(date): string` and `categoryKey(namespace, scope, isoDate): Hex` — for deriving a category's UTC day (board-vs-archive split) and for fixtures.
  - `decodeRecord(data: Hex): SignatureRecord` — **throws** (via viem) on junk; `SignatureRecord = { digest, signer, signature, scheme, meta }` (all `Hex` except `scheme: number`).
  - `groupByDigest(records): Map<Hex, SignatureRecord[]>` and `aggregate(records, adapter): Promise<{ signer, signature }[]>` (the latter keeps only `adapter.verify`-true records, **errors propagate**, then applies `adapter.order`).
  - `BoardClient` interface (`content({ category }): Promise<Content>`, `addMessage({ category, data }): Promise<unknown>`), `postSignature`, `readSignatures` — used by the integration test's post side and as the board seam.
  - `CosignAdapter` interface (`verify` / `order` / `owners?` / `threshold?`). The real Safe adapter lives in `packages/cosign/src/adapters/safe.ts`; this route's tests use **fake / generic** adapters (a `kind: "none"` accept-all adapter and a fake verifying/throwing adapter). The route never builds a concrete multisig adapter itself.
- **MOUNTS ON `@msgboard/history`** — `packages/history/src/server.ts` (`archiveServer`, the `respond()` helper, `/health`, the `127.0.0.1`-default bind + non-loopback-requires-`token` guard + `Authorization: Bearer` check + 10 s `headersTimeout`/`requestTimeout`) and `packages/history/src/archive.ts` (`Archive.query(ArchiveQuery): Promise<ArchivedMessage[]>` for the long-tail fallback). This plan **adds to** `@msgboard/history`; it creates no new package.
- **OUT OF SCOPE (deferred, do NOT build):** the §11 stateful persistent cache — relayer multi-category source, decoding/filtering sink, `sqliteArchiveSink` / `createSqliteArchive`, the prune daemon, cache cold-start hydration. v1 is stateless: no DB, no daemon, no prune, no relayer additions. The route computes everything on the request path.

## Architecture

```
HTTP request: GET /cosign/cosign/wonderland/digest/0xDEAD/aggregate?days=7
   │
   ▼   (inside @msgboard/history's archiveServer createServer handler)
cosign endpoint group  (server.ts: handleCosign(...) dispatched before the 404)
   │
   ├─ matchCosignRoute(pathname) ─► { kind, namespace, scope, digest? }   [src/cosign/router.ts]
   │
   ├─ teamFile.resolve(namespace, scope) ─► TeamEntry | undefined  → 404 'unknown scope'   [src/cosign/team-file.ts]
   │     clamp ?days ≤ teamFile.windowDays
   │
   ├─ resolveCategories(namespace, scope, days, now)                       [src/cosign/categories.ts]
   │     = cosign keysForWindow → [{cat, isoDay}]  (today-first, descending)
   │
   ├─ fetchRecords({ categories, board, archive, boardRetentionDays, adapter, now })  [src/cosign/fetch.ts]
   │     per category:  isoDay within boardRetentionDays → board.content({category})   (source:'board')
   │                    older                            → archive.query({category,…}) (source:'archive')
   │     per entry:     decodeRecord(data)  → throws? SKIP (junk, debug-log)
   │                    adapter.verify(rec) → false? DROP   |  throws? DROP + reason 'verify-errored'
   │     dedupe by keccak256(rawData)  →  CosignRecordView[]  (record + category/category_text/source)
   │
   ├─ groupByDigest / aggregate (cosign SDK)
   │
   ▼
respond(res, 200, body)   (history's JSON helper; try/catch → 502 on fetch error, 500 otherwise)
```

`team-file.ts`, `categories.ts`, `router.ts`, and `fetch.ts` are **pure-ish** (`fetch.ts` takes the board + archive as injected seams, so it is fully testable with fakes). The HTTP wiring lives in `server.ts` behind the `cosign?` option; when the option is absent, `archiveServer` behaves exactly as today (only `/health` + `/messages`).

## Tech Stack

- **Language / module system:** TypeScript, ESM (`"type": "module"`), `module`/`moduleResolution: NodeNext`. **All intra-package imports use explicit `.js` extensions** (NodeNext requirement) — e.g. `import { resolveCategories } from './cosign/categories.js'`. Cross-package imports use the bare specifier: `import { keysForWindow, decodeRecord, groupByDigest, aggregate, type SignatureRecord, type CosignAdapter, type BoardClient } from '@msgboard/cosign'`.
- **Package manager:** **npm workspaces** (root `package.json` `"workspaces": [...]`, `package-lock.json`; there is no pnpm). Install from repo root with `npm install`. Workspace dep versions are pinned `^0.0.31` (current monorepo version), **not** `workspace:*`.
- **New runtime dependency:** add `"@msgboard/cosign": "^0.0.31"` to `packages/history/package.json` `dependencies` (alongside the existing `@msgboard/sdk` and `viem`). `viem` (already a dep) supplies `Hex`, `keccak256`.
- **Build:** `tsc` → `dist/` (declaration + sourcemaps), per the existing `packages/history/tsconfig.json` (`target ESNext`, `module/moduleResolution NodeNext`, `strict`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`, `outDir ./dist`, `exclude: ["dist","node_modules","test"]`).
- **Test runner:** **vitest** (`vitest run`), matching `packages/history`'s existing `test/` dir (`archive.test.ts`, `server.test.ts`) — `"test": "vitest run"` is already in `package.json`. New tests live in `packages/history/test/cosign/`. The HTTP integration test reuses the existing `server.test.ts` pattern (an incrementing `nextPort`, an `open` set closed in `afterEach`, and a `get()` helper that retries on `ECONNREFUSED`).
- **No new infra:** no SQLite, no Postgres, no daemon, no relayer. The long-tail fallback is the in-process `archive.query()` already held by the history server.

### Repo conventions discovered (the plan's code is real, not aspirational)

- `archiveServer` is a factory returning `{ close }`; the request handler is an inline `createServer(async (req, res) => { ... })`. It uses a module-scope `respond(res, status, body)` helper and a `parseQuery(URLSearchParams)` helper. The cosign group is dispatched **inside the same handler**, after `/health` and `/messages`, before the final `return respond(res, 404, ...)`.
- `Content = { [categoryHash: Hex]: RPCMessage[] }` and `RPCMessage = { [K in keyof Message]: Hex }` — so `content[category]` is `RPCMessage[]`, each with a hex `data` field. `ArchivedMessage` (from `archive.query`) has `data: string | null` (a hex string) and `category`/`category_text`/`first_seen_at: string`. The fetch step reads `message.data` from board rows and `row.data` from archive rows; both are hex.
- The cosign SDK's `decodeRecord` throws on junk and `readSignatures` skips it; this plan mirrors that skip in `fetchRecords` (which is `readSignatures` *extended* with the archive fallback + adapter validation, so it does not call `readSignatures` directly — it owns the per-source read).
- Auth/bind/timeout behavior is inherited wholesale by mounting on the same `createServer` handler; cosign endpoints reuse the existing `authorized(req)` closure (same `token` gate as `/messages`).

---

## File structure

```
packages/history/
  package.json                         (MODIFY: add "@msgboard/cosign": "^0.0.31" dependency)
  src/
    cosign/
      team-file.ts        (NEW)  TeamFile types, loadTeamFile(path|object), resolve(ns,scope), clampDays
      categories.ts       (NEW)  resolveCategories(ns, scope, days, now) -> ResolvedCategory[]
      router.ts           (NEW)  matchCosignRoute(pathname) -> CosignRoute | null
      fetch.ts            (NEW)  fetchRecords(args) -> CosignRecordView[]  (board + archive + decode + verify)
      handler.ts          (NEW)  handleCosign(req,res,url,deps) -> boolean  (the endpoint group)
      index.ts            (NEW)  re-exports the cosign surface
    server.ts             (MODIFY: add `cosign?` option, dispatch handleCosign in the handler)
    index.ts              (MODIFY: re-export cosign types + loadTeamFile)
  test/
    cosign/
      team-file.test.ts   (NEW)  load/validate, resolve, unknown-scope, clamp
      categories.test.ts  (NEW)  keysForWindow parity, UTC-day rollover, day>=1
      fetch.test.ts       (NEW)  decode+verify over fake board: junk skipped, invalid dropped,
                                 verify-throw dropped (verify-errored), board-vs-archive split, dedupe
      handler.test.ts     (NEW)  route matching + JSON shapes over fake deps (unit, no socket)
      server.test.ts      (NEW)  HTTP integration: post via cosign SDK -> fake board -> GET aggregate
```

---

## Task 0 — Wire the dependency + an empty cosign module (no behavior yet)

Establishes the package can import `@msgboard/cosign` and builds. No HTTP behavior yet.

### RED

There is nothing to test yet for behavior; the "test" here is that the build resolves the new dependency. Add `packages/history/src/cosign/index.ts` with a single placeholder export and a failing import check by writing the first real test below in Task 1. For Task 0, the gate is: **`npm run build --workspace=packages/history` succeeds with the new dependency present.**

### GREEN

1. Add the dependency to `packages/history/package.json` (inside `"dependencies"`, keep alphabetical-ish with the existing `@msgboard/sdk`):

```jsonc
  "dependencies": {
    "@msgboard/cosign": "^0.0.31",
    "@msgboard/sdk": "^0.0.31",
    "viem": "^2.25.0"
  },
```

2. Create `packages/history/src/cosign/index.ts`:

```ts
/**
 * @msgboard/history cosign route (v1, stateless) — a cosign-aware HTTP endpoint group
 * mounted on the archive server. Decodes/validates/aggregates cosign records fetched
 * live from the board (recent window) + this server's archive.query() (long tail).
 * No store, no daemon, no prune. See docs/superpowers/specs/2026-06-13-msgboard-cosign-archivist-design.md.
 */
export {} // populated by subsequent tasks
```

3. Install from the repo root so the workspace symlink resolves:

```bash
npm install
```

### Verify

```bash
npm install
npm run build --workspace=packages/cosign   # ensure the dependency is built (dist present)
npm run build --workspace=packages/history
```

Expected output: both builds exit `0`; `packages/history/dist/cosign/index.js` exists.

```bash
node -e "import('@msgboard/cosign').then(m => console.log(typeof m.keysForWindow, typeof m.decodeRecord, typeof m.groupByDigest, typeof m.aggregate))"
```

Expected output: `function function function function`.

### Commit

```bash
git add packages/history/package.json packages/history/src/cosign/index.ts package-lock.json
git commit -m "feat(history): add @msgboard/cosign dep + empty cosign module (v1 route scaffold)"
```

---

## Task 1 — The registry team-file (`team-file.ts`)

Load + validate the registry team-file (the scope gate), resolve a `(namespace, scope)` to a served team, clamp `days` to `windowDays`. No `store` block (no store in v1).

### RED — `packages/history/test/cosign/team-file.test.ts`

```ts
import { describe, expect, it } from 'vitest'
import { loadTeamFile, type TeamFile } from '../../src/cosign/team-file.js'

const VALID: TeamFile = {
  version: 1,
  namespace: 'cosign',
  windowDays: 7,
  teams: [
    { scope: 'wonderland', label: 'Wonderland multisig' },
    { scope: '1:0xSAFE', label: 'Safe on mainnet' },
  ],
  adapter: { kind: 'none' },
}

describe('loadTeamFile', () => {
  it('accepts a well-formed team-file object and defaults windowDays to 7 when omitted', () => {
    const tf = loadTeamFile({ ...VALID, windowDays: undefined })
    expect(tf.windowDays).toBe(7)
    expect(tf.namespace).toBe('cosign')
    expect(tf.adapter.kind).toBe('none')
  })

  it('rejects a non-version-1 file', () => {
    expect(() => loadTeamFile({ ...VALID, version: 2 })).toThrow(/version/i)
  })

  it('rejects a file with no teams and no wildcard', () => {
    expect(() => loadTeamFile({ ...VALID, teams: [] })).toThrow(/teams/i)
  })

  describe('resolve', () => {
    it('resolves a listed scope under the matching namespace', () => {
      const tf = loadTeamFile(VALID)
      expect(tf.resolve('cosign', 'wonderland')?.scope).toBe('wonderland')
      expect(tf.resolve('cosign', '1:0xSAFE')?.label).toBe('Safe on mainnet')
    })

    it('returns undefined for an unlisted scope', () => {
      const tf = loadTeamFile(VALID)
      expect(tf.resolve('cosign', 'unknown')).toBeUndefined()
    })

    it('returns undefined for a mismatched namespace', () => {
      const tf = loadTeamFile(VALID)
      expect(tf.resolve('other', 'wonderland')).toBeUndefined()
    })

    it('a "*" team entry matches any scope under the namespace', () => {
      const tf = loadTeamFile({ ...VALID, teams: [{ scope: '*', label: 'all' }] })
      expect(tf.resolve('cosign', 'anything')?.scope).toBe('*')
    })
  })

  describe('clampDays', () => {
    it('clamps days above windowDays down to windowDays', () => {
      const tf = loadTeamFile(VALID)
      expect(tf.clampDays(30)).toBe(7)
    })
    it('keeps a valid days within the window', () => {
      const tf = loadTeamFile(VALID)
      expect(tf.clampDays(3)).toBe(3)
    })
    it('floors days to at least 1 (and defaults when missing/NaN)', () => {
      const tf = loadTeamFile(VALID)
      expect(tf.clampDays(0)).toBe(1)
      expect(tf.clampDays(Number.NaN)).toBe(7)
      expect(tf.clampDays(undefined)).toBe(7)
    })
  })
})

it('loadTeamFile reads from a JSON file path', async () => {
  const { writeFileSync, mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'cosign-tf-'))
  const path = join(dir, 'team.json')
  writeFileSync(path, JSON.stringify({ ...VALID, resolve: undefined, clampDays: undefined }))
  const tf = loadTeamFile(path)
  expect(tf.resolve('cosign', 'wonderland')?.scope).toBe('wonderland')
})
```

Run it — fails because `team-file.ts` does not exist.

### GREEN — `packages/history/src/cosign/team-file.ts`

```ts
import { readFileSync } from 'node:fs'

/** Validation/ordering adapter selector. `kind: "none"` = accept every decodable record. */
export type TeamAdapterConfig = {
  kind: string
  config?: Record<string, unknown>
}

/** A single served team — a cosign `scope` under the file's `namespace`. `"*"` matches any scope. */
export type TeamEntry = {
  scope: string
  label?: string
}

/** The raw on-disk team-file shape (Registry v1). No `store` block — v1 is stateless. */
export type TeamFileInput = {
  version: number
  namespace: string
  /** Default + clamp for the rolling window; defaults to 7 when omitted. */
  windowDays?: number
  teams: TeamEntry[]
  /** Board node to read from (optional here; the server is handed the board client directly). */
  chain?: { chainId?: number; rpcUrl?: string }
  adapter: TeamAdapterConfig
}

/** A loaded, validated team-file with resolution + clamp helpers. */
export type TeamFile = {
  version: number
  namespace: string
  windowDays: number
  teams: TeamEntry[]
  chain?: { chainId?: number; rpcUrl?: string }
  adapter: TeamAdapterConfig
  /** Returns the served team for (namespace, scope), or undefined when unknown. */
  resolve(namespace: string, scope: string): TeamEntry | undefined
  /** Clamps a requested days to [1, windowDays]; NaN/undefined → windowDays. */
  clampDays(days: number | undefined): number
}

const DEFAULT_WINDOW_DAYS = 7

/**
 * Loads + validates a team-file from a JSON path or an in-memory object, returning a
 * {@link TeamFile} with `resolve` / `clampDays`. Throws on a malformed file.
 */
export const loadTeamFile = (source: string | TeamFileInput): TeamFile => {
  const raw: TeamFileInput =
    typeof source === 'string' ? (JSON.parse(readFileSync(source, 'utf8')) as TeamFileInput) : source

  if (raw.version !== 1) throw new Error(`loadTeamFile: unsupported version ${raw.version} (expected 1)`)
  if (typeof raw.namespace !== 'string' || raw.namespace.length === 0)
    throw new Error('loadTeamFile: namespace is required')
  if (!Array.isArray(raw.teams) || raw.teams.length === 0)
    throw new Error('loadTeamFile: at least one team (or a "*" wildcard) is required')
  if (!raw.adapter || typeof raw.adapter.kind !== 'string')
    throw new Error('loadTeamFile: adapter.kind is required')

  const windowDays =
    typeof raw.windowDays === 'number' && Number.isFinite(raw.windowDays) && raw.windowDays >= 1
      ? Math.floor(raw.windowDays)
      : DEFAULT_WINDOW_DAYS

  const teams = raw.teams
  const namespace = raw.namespace

  const resolve = (ns: string, scope: string): TeamEntry | undefined => {
    if (ns !== namespace) return undefined
    return teams.find((t) => t.scope === scope || t.scope === '*')
  }

  const clampDays = (days: number | undefined): number => {
    if (days === undefined || !Number.isFinite(days)) return windowDays
    const floored = Math.floor(days)
    if (floored < 1) return 1
    return Math.min(floored, windowDays)
  }

  return { version: 1, namespace, windowDays, teams, chain: raw.chain, adapter: raw.adapter, resolve, clampDays }
}
```

### Verify

```bash
npx vitest run test/cosign/team-file.test.ts --root packages/history
```

Expected output: all `team-file` tests pass (the `describe` blocks `loadTeamFile`, `resolve`, `clampDays`, plus the JSON-path test) — `Test Files 1 passed`, `Tests <n> passed`.

### Commit

```bash
git add packages/history/src/cosign/team-file.ts packages/history/test/cosign/team-file.test.ts
git commit -m "feat(history): cosign team-file loader — scope gate + window clamp (Registry v1)"
```

---

## Task 2 — Category resolution (`categories.ts`)

Expand `(namespace, scope) × {last N UTC days}` into concrete category hashes via the cosign SDK's `keysForWindow`, tagging each with its `isoDay` (needed for the board-vs-archive split in Task 3).

### RED — `packages/history/test/cosign/categories.test.ts`

```ts
import { describe, expect, it } from 'vitest'
import { categoryKey, isoDay, keysForWindow } from '@msgboard/cosign'
import { resolveCategories } from '../../src/cosign/categories.js'

const NOW = new Date('2026-06-13T12:00:00.000Z')

describe('resolveCategories', () => {
  it('matches the cosign keysForWindow expansion (today-first, descending)', () => {
    const got = resolveCategories('cosign', 'wonderland', 7, NOW)
    const expected = keysForWindow('cosign', 'wonderland', 7, NOW)
    expect(got.map((c) => c.category)).toEqual(expected)
  })

  it('tags each category with its UTC isoDay', () => {
    const got = resolveCategories('cosign', 'wonderland', 3, NOW)
    expect(got.map((c) => c.isoDay)).toEqual(['2026-06-13', '2026-06-12', '2026-06-11'])
    // and the category hash for the tagged day round-trips through categoryKey
    expect(got[0].category).toBe(categoryKey('cosign', 'wonderland', '2026-06-13'))
  })

  it('rolls correctly across a UTC day boundary', () => {
    const justAfterMidnight = new Date('2026-06-13T00:00:01.000Z')
    const got = resolveCategories('cosign', 'wonderland', 2, justAfterMidnight)
    expect(got.map((c) => c.isoDay)).toEqual(['2026-06-13', '2026-06-12'])
    expect(got[0].category).toBe(categoryKey('cosign', 'wonderland', isoDay(justAfterMidnight)))
  })

  it('throws when days < 1 (delegating to keysForWindow)', () => {
    expect(() => resolveCategories('cosign', 'wonderland', 0, NOW)).toThrow(/days >= 1/)
  })
})
```

Run it — fails because `categories.ts` does not exist.

### GREEN — `packages/history/src/cosign/categories.ts`

```ts
import type { Hex } from 'viem'
import { isoDay, keysForWindow } from '@msgboard/cosign'

/** A resolved category: its hash plus the UTC day it buckets (for the board-vs-archive split). */
export type ResolvedCategory = {
  category: Hex
  /** `YYYY-MM-DD` UTC day this category buckets. */
  isoDay: string
}

/**
 * Expands `(namespace, scope) × {today + prior days-1 UTC days}` into concrete category
 * hashes via the cosign SDK's `keysForWindow` (the single source of truth for the key scheme),
 * tagging each with its UTC `isoDay`. Today-first, descending. Throws when `days < 1`.
 */
export const resolveCategories = (
  namespace: string,
  scope: string,
  days: number,
  now: Date = new Date(),
): ResolvedCategory[] => {
  const categories = keysForWindow(namespace, scope, days, now)
  const dayMs = 24 * 60 * 60 * 1000
  const base = now.getTime()
  return categories.map((category, i) => ({ category, isoDay: isoDay(new Date(base - i * dayMs)) }))
}
```

> Note: the `isoDay` re-derivation here is intentionally the same arithmetic `keysForWindow` uses internally (today minus `i` days), so `categories[i].category === categoryKey(namespace, scope, categories[i].isoDay)`. The first test asserts the hash-array parity against `keysForWindow` directly, so any drift fails loudly.

### Verify

```bash
npx vitest run test/cosign/categories.test.ts --root packages/history
```

Expected output: all `resolveCategories` tests pass — `Tests 4 passed`.

### Commit

```bash
git add packages/history/src/cosign/categories.ts packages/history/test/cosign/categories.test.ts
git commit -m "feat(history): cosign category resolution via keysForWindow (day-tagged)"
```

---

## Task 3 — Fetch + decode + validate (`fetch.ts`)

The heart of the route: for the resolved categories, read **recent days from the board** and **older days from `archive.query()`**, decode each entry via `decodeRecord` (skip junk), validate via `adapter.verify` (drop `false`, drop-with-reason on throw), dedupe by `keccak256(rawData)`, and tag provenance.

### RED — `packages/history/test/cosign/fetch.test.ts`

```ts
import { describe, expect, it } from 'vitest'
import { type Hex, keccak256, toHex } from 'viem'
import {
  type BoardClient,
  type CosignAdapter,
  type SignatureRecord,
  categoryKey,
  encodeRecord,
} from '@msgboard/cosign'
import type { Content } from '@msgboard/sdk'
import type { Archive, ArchiveQuery, ArchivedMessage } from '../../src/archive.js'
import { fetchRecords } from '../../src/cosign/fetch.js'
import { resolveCategories } from '../../src/cosign/categories.js'

const NOW = new Date('2026-06-13T12:00:00.000Z')
const addr = (n: number): Hex => `0x${n.toString(16).padStart(40, '0')}` as Hex
const digestA = `0x${'aa'.repeat(32)}` as Hex
const digestB = `0x${'bb'.repeat(32)}` as Hex

const rec = (digest: Hex, signer: Hex): SignatureRecord => ({
  digest,
  signer,
  signature: `0x${'cd'.repeat(65)}` as Hex,
  scheme: 0,
  meta: '0x',
})

/** Wraps encoded records (and raw junk) as RPCMessage-shaped board rows. */
const boardRows = (datas: Hex[]) =>
  datas.map(
    (data, i) =>
      ({
        version: '0x1',
        blockHash: `0x${'00'.repeat(32)}`,
        category: '0x',
        data,
        nonce: '0x0',
        workMultiplier: '0x1',
        workDivisor: '0x1',
        blockNumber: toHex(i),
        hash: keccak256(data),
      }) as unknown,
  )

/** A fake board returning canned content keyed by category. */
const fakeBoard = (byCategory: Record<Hex, Hex[]>): BoardClient => ({
  addMessage: async () => '0x',
  content: async ({ category }) => ({ [category]: boardRows(byCategory[category] ?? []) }) as Content,
})

/** A fake archive returning canned rows keyed by category. */
const fakeArchive = (byCategory: Record<Hex, Hex[]>): Archive => ({
  migrate: async () => {},
  record: async () => {},
  prune: async () => {},
  query: async (q: ArchiveQuery): Promise<ArchivedMessage[]> =>
    (byCategory[q.category as Hex] ?? []).map(
      (data, i) =>
        ({
          hash: keccak256(data),
          chain_id: 943,
          category: q.category ?? null,
          category_text: null,
          data,
          data_text: null,
          block_number: String(i),
          block_hash: null,
          first_seen_at: '2026-06-01T00:00:00.000Z',
        }) as ArchivedMessage,
    ),
})

const acceptAll: CosignAdapter = { verify: async () => true, order: (r) => r }

describe('fetchRecords', () => {
  it('decodes valid records from the board, skips junk, dedupes by raw data', async () => {
    const cats = resolveCategories('cosign', 'wonderland', 1, NOW)
    const cat = cats[0].category
    const valid = encodeRecord(rec(digestA, addr(1)))
    const junk = '0xdeadbeef' as Hex // decodeRecord throws on this
    const board = fakeBoard({ [cat]: [valid, junk, valid] }) // duplicate `valid` → deduped
    const out = await fetchRecords({ categories: cats, board, boardRetentionDays: 30, adapter: acceptAll, now: NOW })
    expect(out).toHaveLength(1)
    expect(out[0].digest).toBe(digestA)
    expect(out[0].source).toBe('board')
  })

  it('drops a record whose adapter.verify returns false', async () => {
    const cats = resolveCategories('cosign', 'wonderland', 1, NOW)
    const cat = cats[0].category
    const good = encodeRecord(rec(digestA, addr(1)))
    const bad = encodeRecord(rec(digestA, addr(2)))
    const board = fakeBoard({ [cat]: [good, bad] })
    const rejectAddr2: CosignAdapter = { verify: async (r) => r.signer !== addr(2), order: (r) => r }
    const out = await fetchRecords({ categories: cats, board, boardRetentionDays: 30, adapter: rejectAddr2, now: NOW })
    expect(out.map((r) => r.signer)).toEqual([addr(1)])
  })

  it('drops a record whose adapter.verify THROWS (verify-errored), without failing the fetch', async () => {
    const cats = resolveCategories('cosign', 'wonderland', 1, NOW)
    const cat = cats[0].category
    const good = encodeRecord(rec(digestA, addr(1)))
    const explodes = encodeRecord(rec(digestB, addr(9)))
    const board = fakeBoard({ [cat]: [good, explodes] })
    const throwsOn9: CosignAdapter = {
      verify: async (r) => {
        if (r.signer === addr(9)) throw new Error('not implemented')
        return true
      },
      order: (r) => r,
    }
    const out = await fetchRecords({ categories: cats, board, boardRetentionDays: 30, adapter: throwsOn9, now: NOW })
    expect(out.map((r) => r.signer)).toEqual([addr(1)]) // the throwing one is dropped, not propagated
  })

  it('skips adapter.verify entirely when no adapter is given (accept-all)', async () => {
    const cats = resolveCategories('cosign', 'wonderland', 1, NOW)
    const cat = cats[0].category
    const board = fakeBoard({ [cat]: [encodeRecord(rec(digestA, addr(1)))] })
    const out = await fetchRecords({ categories: cats, board, boardRetentionDays: 30, now: NOW })
    expect(out).toHaveLength(1)
  })

  it('reads recent days from the board and older days from the archive, tagging source', async () => {
    // window of 5 days; board retention = 2 days → days 0,1 from board; days 2,3,4 from archive.
    const cats = resolveCategories('cosign', 'wonderland', 5, NOW)
    const recentCat = cats[0].category // today → board
    const oldCat = cats[4].category // 4 days ago → archive
    const fromBoard = encodeRecord(rec(digestA, addr(1)))
    const fromArchive = encodeRecord(rec(digestA, addr(2)))
    const board = fakeBoard({ [recentCat]: [fromBoard] })
    const archive = fakeArchive({ [oldCat]: [fromArchive] })
    const out = await fetchRecords({
      categories: cats,
      board,
      archive,
      boardRetentionDays: 2,
      adapter: acceptAll,
      now: NOW,
    })
    const bySigner = Object.fromEntries(out.map((r) => [r.signer, r.source]))
    expect(bySigner[addr(1)]).toBe('board')
    expect(bySigner[addr(2)]).toBe('archive')
  })

  it('throws (does not silently shorten) when a needed source is unavailable', async () => {
    const cats = resolveCategories('cosign', 'wonderland', 1, NOW)
    const board: BoardClient = {
      addMessage: async () => '0x',
      content: async () => {
        throw new Error('rpc down')
      },
    }
    await expect(
      fetchRecords({ categories: cats, board, boardRetentionDays: 30, adapter: acceptAll, now: NOW }),
    ).rejects.toThrow(/rpc down/)
  })

  it('tags category_text using categoryKey inputs (provenance is present)', async () => {
    const cats = resolveCategories('cosign', 'wonderland', 1, NOW)
    const cat = cats[0].category
    expect(cat).toBe(categoryKey('cosign', 'wonderland', cats[0].isoDay))
    const board = fakeBoard({ [cat]: [encodeRecord(rec(digestA, addr(1)))] })
    const out = await fetchRecords({
      categories: cats,
      board,
      boardRetentionDays: 30,
      adapter: acceptAll,
      now: NOW,
      categoryText: (c) => `cosign:wonderland:${c.isoDay}`,
    })
    expect(out[0].category).toBe(cat)
    expect(out[0].category_text).toBe('cosign:wonderland:2026-06-13')
  })
})
```

Run it — fails because `fetch.ts` does not exist.

### GREEN — `packages/history/src/cosign/fetch.ts`

```ts
import { type Hex, keccak256 } from 'viem'
import { type BoardClient, type CosignAdapter, type SignatureRecord, decodeRecord } from '@msgboard/cosign'
import type { Archive } from '../archive.js'
import type { ResolvedCategory } from './categories.js'

/** A decoded, validated record plus provenance — the route's internal row. */
export type CosignRecordView = SignatureRecord & {
  /** The bytes32 category hash this record was fetched under. */
  category: Hex
  /** Optional human-readable category label (`namespace:scope:isoDay`). */
  category_text?: string
  /** Where the record was fetched from. */
  source: 'board' | 'archive'
}

export type FetchRecordsArgs = {
  categories: ResolvedCategory[]
  board: BoardClient
  /** The long-tail fallback; required only if the window reaches past `boardRetentionDays`. */
  archive?: Archive
  /** Days within this many of `now` are read from the board; older days from the archive. */
  boardRetentionDays: number
  /** Validation adapter; when omitted, every decodable record is kept (kind:"none"). */
  adapter?: CosignAdapter
  /** Injectable clock; defaults to now. */
  now?: Date
  /** Optional label builder for `category_text`. */
  categoryText?: (c: ResolvedCategory) => string
}

const dayMs = 24 * 60 * 60 * 1000

/**
 * Reads the resolved categories, splitting recent days (board) from older days (archive),
 * decodes each entry (skipping junk that `decodeRecord` throws on), validates via
 * `adapter.verify` (dropping `false`; dropping-with-reason on a throw), dedupes by
 * `keccak256(rawData)`, and tags provenance. Source errors PROPAGATE (the route fails the
 * request rather than returning a misleadingly-short window — the §9 statelessness trade).
 */
export const fetchRecords = async (args: FetchRecordsArgs): Promise<CosignRecordView[]> => {
  const { categories, board, archive, boardRetentionDays, adapter, now = new Date(), categoryText } = args
  const today = Math.floor(now.getTime() / dayMs)

  const seen = new Set<Hex>()
  const out: CosignRecordView[] = []

  for (const cat of categories) {
    const dayIndex = today - Math.floor(Date.parse(`${cat.isoDay}T00:00:00.000Z`) / dayMs)
    const fromBoard = dayIndex < boardRetentionDays

    // Each row is the hex `data` blob, whatever the source.
    let datas: Hex[]
    if (fromBoard) {
      const content = await board.content({ category: cat.category })
      datas = (content[cat.category] ?? []).map((m) => m.data).filter((d): d is Hex => Boolean(d))
    } else {
      if (!archive) throw new Error(`fetchRecords: archive required for older day ${cat.isoDay} but none provided`)
      const rows = await archive.query({ category: cat.category, limit: 1000 })
      datas = rows.map((r) => r.data).filter((d): d is Hex => Boolean(d)) as Hex[]
    }

    for (const data of datas) {
      const dedupeKey = keccak256(data)
      if (seen.has(dedupeKey)) continue

      let record: SignatureRecord
      try {
        record = decodeRecord(data)
      } catch {
        continue // undecodable junk under an open category — skip (expected; debug-level)
      }

      if (adapter) {
        let ok: boolean
        try {
          ok = await adapter.verify(record)
        } catch {
          continue // verify-errored (e.g. RPC failure / stubbed adapter) — drop with reason, do not crash
        }
        if (!ok) continue // invalid signature — drop
      }

      seen.add(dedupeKey)
      out.push({
        ...record,
        category: cat.category,
        category_text: categoryText?.(cat),
        source: fromBoard ? 'board' : 'archive',
      })
    }
  }

  return out
}
```

> The `dayIndex` is computed from UTC midnight of `cat.isoDay` vs `now`'s UTC day, so it is independent of the time-of-day in `now` (today is index 0). `boardRetentionDays` is the conservative cutoff from §8/§14 — a configured value well inside the board's real retention; the route's default is pinned in Task 5.

### Verify

```bash
npx vitest run test/cosign/fetch.test.ts --root packages/history
```

Expected output: all 8 `fetchRecords` tests pass (junk-skip + dedupe; verify-false drop; verify-throw drop; accept-all; board/archive split; source-unavailable throw; provenance).

### Commit

```bash
git add packages/history/src/cosign/fetch.ts packages/history/test/cosign/fetch.test.ts
git commit -m "feat(history): cosign fetchRecords — board+archive read, decode-skip-junk, verify-drop, dedupe"
```

---

## Task 4 — Route matcher + endpoint handler (`router.ts`, `handler.ts`)

Parse `/cosign/:namespace/:scope/...` into a typed route, then build the endpoint group: validate scope against the team-file, clamp days, fetch, `groupByDigest`/`aggregate`, and shape the JSON per §6. Tested as a unit (no socket) over fake deps.

### RED — `packages/history/test/cosign/handler.test.ts`

```ts
import { describe, expect, it } from 'vitest'
import { type Hex, encodeRecord, keccak256, toHex } from 'viem'
import { type BoardClient, type CosignAdapter, type SignatureRecord } from '@msgboard/cosign'
import type { Content } from '@msgboard/sdk'
import { matchCosignRoute } from '../../src/cosign/router.js'
import { handleCosignRequest, type CosignDeps } from '../../src/cosign/handler.js'
import { loadTeamFile } from '../../src/cosign/team-file.js'

const addr = (n: number): Hex => `0x${n.toString(16).padStart(40, '0')}` as Hex
const digest = `0x${'aa'.repeat(32)}` as Hex
const rec = (signer: Hex): SignatureRecord => ({
  digest,
  signer,
  signature: `0x${'cd'.repeat(65)}` as Hex,
  scheme: 0,
  meta: '0x',
})

describe('matchCosignRoute', () => {
  it('parses the three endpoint shapes and the optional owners passthrough', () => {
    expect(matchCosignRoute('/cosign/cosign/wonderland/signatures')).toEqual({
      kind: 'signatures',
      namespace: 'cosign',
      scope: 'wonderland',
    })
    expect(matchCosignRoute('/cosign/cosign/wonderland/digest/0xdead')).toEqual({
      kind: 'digest',
      namespace: 'cosign',
      scope: 'wonderland',
      digest: '0xdead',
    })
    expect(matchCosignRoute('/cosign/cosign/wonderland/digest/0xdead/aggregate')).toEqual({
      kind: 'aggregate',
      namespace: 'cosign',
      scope: 'wonderland',
      digest: '0xdead',
    })
    expect(matchCosignRoute('/cosign/cosign/wonderland/owners')).toEqual({
      kind: 'owners',
      namespace: 'cosign',
      scope: 'wonderland',
    })
  })

  it('returns null for non-cosign / malformed paths', () => {
    expect(matchCosignRoute('/messages')).toBeNull()
    expect(matchCosignRoute('/cosign/cosign')).toBeNull()
    expect(matchCosignRoute('/cosign/cosign/wonderland/digest')).toBeNull() // missing :digest
  })
})

const NOW = new Date('2026-06-13T12:00:00.000Z')

const boardWith = (datas: Hex[]): BoardClient => ({
  addMessage: async () => '0x',
  content: async ({ category }) =>
    ({
      [category]: datas.map(
        (data, i) =>
          ({
            version: '0x1',
            blockHash: `0x${'00'.repeat(32)}`,
            category: '0x',
            data,
            nonce: '0x0',
            workMultiplier: '0x1',
            workDivisor: '0x1',
            blockNumber: toHex(i),
            hash: keccak256(data),
          }) as unknown,
      ),
    }) as Content,
})

const acceptAll: CosignAdapter = { verify: async () => true, order: (r) => r }

const deps = (board: BoardClient, adapter: CosignAdapter = acceptAll): CosignDeps => ({
  teamFile: loadTeamFile({
    version: 1,
    namespace: 'cosign',
    windowDays: 7,
    teams: [{ scope: 'wonderland' }],
    adapter: { kind: 'none' },
  }),
  board,
  adapter,
  boardRetentionDays: 30,
  now: () => NOW,
})

describe('handleCosignRequest', () => {
  it('signatures: returns decoded valid records in the window', async () => {
    const board = boardWith([encodeRecord(rec(addr(1))), encodeRecord(rec(addr(2)))])
    const route = matchCosignRoute('/cosign/cosign/wonderland/signatures')!
    const r = await handleCosignRequest(route, new URLSearchParams('days=7'), deps(board))
    expect(r.status).toBe(200)
    expect((r.body as { signatures: unknown[] }).signatures).toHaveLength(2)
  })

  it('digest: returns all signatures for a digest + signers', async () => {
    const board = boardWith([encodeRecord(rec(addr(1))), encodeRecord(rec(addr(2)))])
    const route = matchCosignRoute(`/cosign/cosign/wonderland/digest/${digest}`)!
    const r = await handleCosignRequest(route, new URLSearchParams(), deps(board))
    expect(r.status).toBe(200)
    const body = r.body as { digest: Hex; signers: Hex[]; count: number }
    expect(body.digest).toBe(digest)
    expect(body.signers.sort()).toEqual([addr(1), addr(2)].sort())
    expect(body.count).toBe(2)
  })

  it('aggregate: returns the aggregate-ready ordered {signer,signature}[] with ready vs threshold', async () => {
    const board = boardWith([encodeRecord(rec(addr(1))), encodeRecord(rec(addr(2)))])
    const route = matchCosignRoute(`/cosign/cosign/wonderland/digest/${digest}/aggregate`)!
    const r = await handleCosignRequest(route, new URLSearchParams('threshold=2'), deps(board))
    expect(r.status).toBe(200)
    const body = r.body as { signers: { signer: Hex; signature: Hex }[]; count: number; threshold: number; ready: boolean }
    expect(body.count).toBe(2)
    expect(body.threshold).toBe(2)
    expect(body.ready).toBe(true)
    expect(body.signers.map((s) => s.signer).sort()).toEqual([addr(1), addr(2)].sort())
  })

  it('aggregate: ready=false when count < threshold', async () => {
    const board = boardWith([encodeRecord(rec(addr(1)))])
    const route = matchCosignRoute(`/cosign/cosign/wonderland/digest/${digest}/aggregate`)!
    const r = await handleCosignRequest(route, new URLSearchParams('threshold=2'), deps(board))
    expect((r.body as { ready: boolean }).ready).toBe(false)
  })

  it('rejects an unknown scope with 404', async () => {
    const board = boardWith([])
    const route = matchCosignRoute('/cosign/cosign/stranger/signatures')!
    const r = await handleCosignRequest(route, new URLSearchParams(), deps(board))
    expect(r.status).toBe(404)
    expect((r.body as { error: string }).error).toMatch(/unknown scope/)
  })

  it('clamps days over windowDays (does not error)', async () => {
    let askedDays = 0
    const board: BoardClient = {
      addMessage: async () => '0x',
      content: async ({ category }) => {
        askedDays++
        return { [category]: [] } as Content
      },
    }
    const route = matchCosignRoute('/cosign/cosign/wonderland/signatures')!
    const r = await handleCosignRequest(route, new URLSearchParams('days=999'), deps(board))
    expect(r.status).toBe(200)
    expect(askedDays).toBe(7) // clamped to windowDays, so 7 categories fetched
  })

  it('returns 502 when the board fetch fails', async () => {
    const board: BoardClient = {
      addMessage: async () => '0x',
      content: async () => {
        throw new Error('rpc down')
      },
    }
    const route = matchCosignRoute('/cosign/cosign/wonderland/signatures')!
    const r = await handleCosignRequest(route, new URLSearchParams(), deps(board))
    expect(r.status).toBe(502)
    expect((r.body as { error: string }).error).toMatch(/rpc down/)
  })

  it('owners: 501 when the adapter does not implement owners()', async () => {
    const board = boardWith([])
    const route = matchCosignRoute('/cosign/cosign/wonderland/owners')!
    const r = await handleCosignRequest(route, new URLSearchParams(), deps(board))
    expect(r.status).toBe(501)
  })
})
```

Run it — fails because `router.ts` / `handler.ts` do not exist.

### GREEN — `packages/history/src/cosign/router.ts`

```ts
/** A parsed cosign route. */
export type CosignRoute =
  | { kind: 'signatures'; namespace: string; scope: string }
  | { kind: 'digest'; namespace: string; scope: string; digest: string }
  | { kind: 'aggregate'; namespace: string; scope: string; digest: string }
  | { kind: 'owners'; namespace: string; scope: string }

/**
 * Matches `/cosign/:namespace/:scope/...` into a typed route, or null when the path
 * is not a (well-formed) cosign route. Segments are URL-decoded.
 */
export const matchCosignRoute = (pathname: string): CosignRoute | null => {
  const parts = pathname.split('/').filter((s) => s.length > 0).map((s) => decodeURIComponent(s))
  // parts[0] must be 'cosign' (the group prefix)
  if (parts[0] !== 'cosign') return null
  const namespace = parts[1]
  const scope = parts[2]
  if (!namespace || !scope) return null

  // /cosign/:ns/:scope/signatures
  if (parts.length === 4 && parts[3] === 'signatures') return { kind: 'signatures', namespace, scope }
  // /cosign/:ns/:scope/owners
  if (parts.length === 4 && parts[3] === 'owners') return { kind: 'owners', namespace, scope }
  // /cosign/:ns/:scope/digest/:digest
  if (parts.length === 5 && parts[3] === 'digest' && parts[4])
    return { kind: 'digest', namespace, scope, digest: parts[4] }
  // /cosign/:ns/:scope/digest/:digest/aggregate
  if (parts.length === 6 && parts[3] === 'digest' && parts[4] && parts[5] === 'aggregate')
    return { kind: 'aggregate', namespace, scope, digest: parts[4] }

  return null
}
```

### GREEN — `packages/history/src/cosign/handler.ts`

```ts
import type { Hex } from 'viem'
import { type CosignAdapter, aggregate, groupByDigest } from '@msgboard/cosign'
import type { BoardClient } from '@msgboard/cosign'
import type { Archive } from '../archive.js'
import { resolveCategories } from './categories.js'
import { type CosignRecordView, fetchRecords } from './fetch.js'
import type { CosignRoute } from './router.js'
import type { TeamFile } from './team-file.js'

/** Everything the cosign handler needs, injected by the server (and by tests). */
export type CosignDeps = {
  teamFile: TeamFile
  board: BoardClient
  archive?: Archive
  adapter?: CosignAdapter
  /** Conservative board-retention cutoff (days) for the board-vs-archive split (§8/§14). */
  boardRetentionDays: number
  /** Injectable clock; defaults to `() => new Date()`. */
  now?: () => Date
}

/** A handler result the server maps onto `respond(res, status, body)`. */
export type CosignResult = { status: number; body: unknown }

/** Maps a raw record to its JSON view (§6 SignatureRecordView). */
const toView = (r: CosignRecordView) => ({
  digest: r.digest,
  signer: r.signer,
  signature: r.signature,
  scheme: r.scheme,
  meta: r.meta,
  category: r.category,
  category_text: r.category_text,
  source: r.source,
})

const num = (params: URLSearchParams, key: string): number | undefined => {
  const raw = params.get(key)
  if (raw === null || !Number.isFinite(Number(raw))) return undefined
  return Number(raw)
}

/**
 * The cosign endpoint group, transport-agnostic: validates the scope against the team-file,
 * clamps `days`, fetches+decodes+validates over the board (+archive fallback), then
 * `groupByDigest`/`aggregate`s and shapes the §6 JSON. Board/archive errors → 502; the
 * unknown scope → 404; owners-unimplemented → 501; anything else → 500.
 */
export const handleCosignRequest = async (
  route: CosignRoute,
  params: URLSearchParams,
  deps: CosignDeps,
): Promise<CosignResult> => {
  const now = (deps.now ?? (() => new Date()))()

  const team = deps.teamFile.resolve(route.namespace, route.scope)
  if (!team) return { status: 404, body: { ok: false, error: 'unknown scope' } }

  // owners passthrough — independent of fetch
  if (route.kind === 'owners') {
    const adapter = deps.adapter
    if (!adapter?.owners || !adapter?.threshold)
      return { status: 501, body: { ok: false, error: 'owners not supported by adapter' } }
    try {
      const [owners, threshold] = await Promise.all([adapter.owners(), adapter.threshold()])
      return { status: 200, body: { owners, threshold } }
    } catch (error) {
      return { status: 502, body: { ok: false, error: error instanceof Error ? error.message : 'owners failed' } }
    }
  }

  const days = deps.teamFile.clampDays(num(params, 'days'))
  const categories = resolveCategories(route.namespace, route.scope, days, now)

  let records: CosignRecordView[]
  try {
    records = await fetchRecords({
      categories,
      board: deps.board,
      archive: deps.archive,
      boardRetentionDays: deps.boardRetentionDays,
      adapter: deps.adapter,
      now,
      categoryText: (c) => `${route.namespace}:${route.scope}:${c.isoDay}`,
    })
  } catch (error) {
    // Board/archive unavailable at query time — fail loudly (§9), do not return a short window.
    return { status: 502, body: { ok: false, error: error instanceof Error ? error.message : 'fetch failed' } }
  }

  try {
    if (route.kind === 'signatures') {
      return { status: 200, body: { signatures: records.map(toView) } }
    }

    const digest = route.digest as Hex
    const group = groupByDigest(records).get(digest) ?? []

    if (route.kind === 'digest') {
      const signers = group.map((r) => r.signer)
      return {
        status: 200,
        body: { digest, signatures: group.map(toView), signers, count: signers.length },
      }
    }

    // route.kind === 'aggregate' — the headline endpoint
    const ordered = deps.adapter
      ? await aggregate(group, deps.adapter)
      : group.map((r) => ({ signer: r.signer, signature: r.signature }))
    const withScheme = ordered.map((o) => {
      const match = group.find((g) => g.signer === o.signer)
      return { signer: o.signer, signature: o.signature, scheme: match?.scheme ?? 0 }
    })
    const threshold = num(params, 'threshold')
    return {
      status: 200,
      body: {
        digest,
        signers: withScheme,
        count: withScheme.length,
        threshold,
        ready: threshold === undefined ? undefined : withScheme.length >= threshold,
      },
    }
  } catch (error) {
    return { status: 500, body: { ok: false, error: error instanceof Error ? error.message : 'cosign query failed' } }
  }
}
```

> `aggregate` already re-runs `adapter.verify` (errors propagate there) — but `fetchRecords` has *already* dropped verify-false/verify-errored records, so for accept-all/verifying adapters the second pass is a cheap idempotent confirm. When `deps.adapter` is omitted (kind:"none"), we skip `aggregate` and return the group's `{signer,signature}` directly (records are already deduped by raw data; `aggregate`'s dedup-by-signer is the adapter's `order` concern, pinned with the first real adapter per §14).

### Verify

```bash
npx vitest run test/cosign/handler.test.ts --root packages/history
```

Expected output: all `matchCosignRoute` (2) + `handleCosignRequest` (8) tests pass.

### Commit

```bash
git add packages/history/src/cosign/router.ts packages/history/src/cosign/handler.ts packages/history/test/cosign/handler.test.ts
git commit -m "feat(history): cosign route matcher + endpoint handler (signatures/digest/aggregate/owners)"
```

---

## Task 5 — Mount the endpoint group on `archiveServer` (`server.ts`)

Add the opt-in `cosign?` option to `archiveServer` and dispatch the cosign group inside the existing `createServer` handler, reusing `respond`, the `authorized` gate, the bind/`token` guard, and the timeouts. When `cosign` is absent, the server is byte-for-byte unchanged.

### RED — `packages/history/test/cosign/server.test.ts`

```ts
import { afterEach, describe, expect, it } from 'vitest'
import { type Hex, encodeRecord, keccak256, toHex } from 'viem'
import { type BoardClient, type CosignAdapter, type SignatureRecord, postSignature } from '@msgboard/cosign'
import type { Content, RPCMessage } from '@msgboard/sdk'
import { archiveServer, type ArchiveServer } from '../../src/server.js'

const addr = (n: number): Hex => `0x${n.toString(16).padStart(40, '0')}` as Hex
const digest = `0x${'aa'.repeat(32)}` as Hex
const NOW = new Date('2026-06-13T12:00:00.000Z')

const rec = (signer: Hex): SignatureRecord => ({
  digest,
  signer,
  signature: `0x${'cd'.repeat(65)}` as Hex,
  scheme: 0,
  meta: '0x',
})

/** A tiny in-memory board the cosign SDK can post into and the route can read from. */
const memoryBoard = (): BoardClient => {
  const store = new Map<Hex, RPCMessage[]>()
  return {
    addMessage: async ({ category, data }) => {
      const list = store.get(category) ?? []
      list.push({
        version: '0x1',
        blockHash: `0x${'00'.repeat(32)}`,
        category,
        data,
        nonce: '0x0',
        workMultiplier: '0x1',
        workDivisor: '0x1',
        blockNumber: toHex(list.length),
        hash: keccak256(data),
      } as unknown as RPCMessage)
      store.set(category, list)
      return keccak256(data)
    },
    content: async ({ category }) => ({ [category]: store.get(category) ?? [] }) as Content,
  }
}

const stubArchive = () => ({ migrate: async () => {}, record: async () => {}, prune: async () => {}, query: async () => [] })
const acceptAll: CosignAdapter = { verify: async () => true, order: (r) => r }

let nextPort = 34810
const open = new Set<ArchiveServer>()
const get = async (url: string, headers: Record<string, string> = {}): Promise<Response> => {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      return await fetch(url, { headers })
    } catch (err) {
      if (!(err instanceof Error && /ECONNREFUSED|fetch failed/.test(err.message))) throw err
      await new Promise((r) => setTimeout(r, 20))
    }
  }
  throw new Error(`server at ${url} never accepted a connection`)
}
afterEach(async () => {
  await Promise.all([...open].map((s) => s.close()))
  open.clear()
})

const startWithCosign = (board: BoardClient, token?: string) => {
  const port = nextPort++
  const server = archiveServer({
    archive: stubArchive() as never,
    port,
    token,
    cosign: {
      board,
      adapter: acceptAll,
      boardRetentionDays: 30,
      now: () => NOW,
      teamFile: {
        version: 1,
        namespace: 'cosign',
        windowDays: 7,
        teams: [{ scope: 'wonderland' }],
        adapter: { kind: 'none' },
      },
    },
  })
  open.add(server)
  return { base: `http://127.0.0.1:${port}` }
}

describe('archiveServer with cosign option (integration)', () => {
  it('post via cosign SDK → query the route → aggregate-ready set comes back', async () => {
    const board = memoryBoard()
    // post two signatures for the same digest under today's rotating category
    await postSignature(board, { namespace: 'cosign', scope: 'wonderland', record: rec(addr(1)), now: NOW })
    await postSignature(board, { namespace: 'cosign', scope: 'wonderland', record: rec(addr(2)), now: NOW })

    const { base } = startWithCosign(board)
    const res = await get(`${base}/cosign/cosign/wonderland/digest/${digest}/aggregate?days=7&threshold=2`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.count).toBe(2)
    expect(body.ready).toBe(true)
    expect(body.signers.map((s: { signer: Hex }) => s.signer).sort()).toEqual([addr(1), addr(2)].sort())
  })

  it('signatures endpoint returns the decoded window', async () => {
    const board = memoryBoard()
    await postSignature(board, { namespace: 'cosign', scope: 'wonderland', record: rec(addr(1)), now: NOW })
    const { base } = startWithCosign(board)
    const res = await get(`${base}/cosign/cosign/wonderland/signatures?days=7`)
    expect((await res.json()).signatures).toHaveLength(1)
  })

  it('unknown scope → 404 through the server', async () => {
    const { base } = startWithCosign(memoryBoard())
    expect((await get(`${base}/cosign/cosign/stranger/signatures`)).status).toBe(404)
  })

  it('shares /health and still serves /messages', async () => {
    const { base } = startWithCosign(memoryBoard())
    expect((await get(`${base}/health`)).status).toBe(200)
    expect((await get(`${base}/messages`)).status).toBe(200)
  })

  it('cosign endpoints honor the bearer token', async () => {
    const { base } = startWithCosign(memoryBoard(), 'secret')
    expect((await get(`${base}/cosign/cosign/wonderland/signatures`)).status).toBe(401)
    expect((await get(`${base}/cosign/cosign/wonderland/signatures`, { Authorization: 'Bearer secret' })).status).toBe(200)
  })
})

it('without the cosign option, /cosign paths 404', async () => {
  const port = nextPort++
  const server = archiveServer({ archive: stubArchive() as never, port })
  open.add(server)
  const res = await get(`http://127.0.0.1:${port}/cosign/cosign/wonderland/signatures`)
  expect(res.status).toBe(404)
})
```

Run it — fails because `archiveServer` has no `cosign` option yet.

### GREEN — modify `packages/history/src/server.ts`

1. Add imports at the top (after the existing imports):

```ts
import { type CosignDeps, handleCosignRequest } from './cosign/handler.js'
import { matchCosignRoute } from './cosign/router.js'
import { loadTeamFile, type TeamFile, type TeamFileInput } from './cosign/team-file.js'
```

2. Extend `ArchiveServerOptions` with the opt-in `cosign?` block. It accepts either a loaded `TeamFile` or a raw `TeamFileInput` / path for the team file:

```ts
export type CosignOption = Omit<CosignDeps, 'teamFile'> & {
  /** The registry team-file: a loaded TeamFile, a raw object, or a JSON path. */
  teamFile: TeamFile | TeamFileInput | string
}

export type ArchiveServerOptions = {
  archive: Archive
  port?: number
  host?: string
  token?: string
  /**
   * Opt-in cosign endpoint group. When present, the same server answers
   * `/cosign/:namespace/:scope/...` (decoded cosign view) alongside `/messages`.
   * Absent → the server is unchanged (only `/health` + `/messages`).
   */
  cosign?: CosignOption
}
```

3. Inside `archiveServer`, before `createServer`, normalize the cosign deps once:

```ts
  const cosignDeps: CosignDeps | undefined = options.cosign
    ? {
        ...options.cosign,
        archive: options.cosign.archive ?? options.archive, // default the fallback to this server's archive
        teamFile:
          typeof options.cosign.teamFile === 'string' || !('resolve' in options.cosign.teamFile)
            ? loadTeamFile(options.cosign.teamFile as string | TeamFileInput)
            : (options.cosign.teamFile as TeamFile),
      }
    : undefined
```

4. Inside the `createServer` handler, after the `/messages` block and **before** the final `return respond(res, 404, ...)`, dispatch the cosign group:

```ts
    if (cosignDeps && req.method === 'GET') {
      const route = matchCosignRoute(url.pathname)
      if (route) {
        if (!authorized(req)) return respond(res, 401, { ok: false, error: 'unauthorized' })
        try {
          const result = await handleCosignRequest(route, url.searchParams, cosignDeps)
          return respond(res, result.status, result.body)
        } catch (error) {
          return respond(res, 500, {
            ok: false,
            error: error instanceof Error ? error.message : 'cosign query failed',
          })
        }
      }
    }
```

5. Re-export the cosign surface from `packages/history/src/index.ts` (append):

```ts
export { loadTeamFile } from './cosign/team-file.js'
export type { TeamFile, TeamFileInput, TeamEntry } from './cosign/team-file.js'
export type { CosignDeps, CosignResult } from './cosign/handler.js'
export type { CosignOption } from './server.js'
export type { CosignRecordView } from './cosign/fetch.js'
```

6. Populate `packages/history/src/cosign/index.ts` (replace the placeholder) so the group is importable as a unit:

```ts
export { loadTeamFile } from './team-file.js'
export type { TeamFile, TeamFileInput, TeamEntry, TeamAdapterConfig } from './team-file.js'
export { resolveCategories } from './categories.js'
export type { ResolvedCategory } from './categories.js'
export { matchCosignRoute } from './router.js'
export type { CosignRoute } from './router.js'
export { fetchRecords } from './fetch.js'
export type { CosignRecordView, FetchRecordsArgs } from './fetch.js'
export { handleCosignRequest } from './handler.js'
export type { CosignDeps, CosignResult } from './handler.js'
```

### Verify

```bash
npx vitest run test/cosign/server.test.ts --root packages/history
npm run build --workspace=packages/history
```

Expected output: all integration tests pass (`post via cosign SDK → aggregate-ready`, signatures, unknown-scope 404, /health+/messages still served, token gate, and the no-cosign-option 404); `tsc` build exits `0`.

### Commit

```bash
git add packages/history/src/server.ts packages/history/src/index.ts packages/history/src/cosign/index.ts packages/history/test/cosign/server.test.ts
git commit -m "feat(history): mount opt-in cosign endpoint group on archiveServer (v1 stateless route)"
```

---

## Task 6 — Full suite + lint green

Run the whole package's tests (existing archive/server tests must still pass — the cosign option is purely additive) and lint.

### Verify

```bash
npm run build --workspace=packages/cosign
npm run build --workspace=packages/history
npx vitest run --root packages/history
npm run lint --workspace=packages/history
```

Expected output:
- builds exit `0`;
- vitest: all files pass — the existing `archive.test.ts` and `server.test.ts` (unchanged behavior, cosign absent), plus the five new `test/cosign/*.test.ts` files;
- `prettier --check .` exits `0` (run `npx prettier --write .` inside `packages/history` first if it flags formatting, then re-commit).

### Commit (only if lint required formatting changes)

```bash
git add -A packages/history
git commit -m "chore(history): prettier formatting for cosign route"
```

---

## Self-review

- **No placeholders** — every task ships complete, real TypeScript (types, helpers, error paths) and complete test files. No `TODO`/`TBD`/`<...>`.
- **Stateless, per the spec** — there is no DB, no daemon, no prune, no relayer dependency, no `store` block in the team-file. The long-tail fallback is the in-process `archive.query()` the history server already holds (`fetch.ts` takes `Archive` as a seam). The §11 stateful cache (multi-category source, decoding sink, `sqliteArchiveSink`/`createSqliteArchive`, prune daemon, cold-start) is **explicitly out of scope** and not referenced by any task.
- **Route home matches the spec §4.1** — a cosign endpoint group **inside `@msgboard/history`'s `server.ts`**, gated by an opt-in `cosign?` option; **not** a new package. The deferred `@msgboard/cosign-archive` extraction is noted only as the spec's later option; the boundary (`src/cosign/*` modules + a transport-agnostic `handleCosignRequest`) is drawn cleanly enough to extract later.
- **Grounded in real APIs** — `keysForWindow`/`isoDay`/`categoryKey`/`decodeRecord`/`groupByDigest`/`aggregate`/`BoardClient`/`CosignAdapter`/`postSignature` are imported from the built `@msgboard/cosign` with their actual signatures; `Content = { [cat]: RPCMessage[] }` (hex `data`) and `ArchivedMessage` (hex `data` string) read shapes match `@msgboard/sdk`/`@msgboard/history`; `respond`/`authorized`/bind+token guard/10 s timeouts are reused by mounting on the same `createServer` handler; the new test files mirror the existing `server.test.ts` harness (`nextPort`, `open` set, retrying `get`).
- **All spec endpoints + error policy** — `/cosign/:ns/:scope/signatures`, `/digest/:digest`, `/digest/:digest/aggregate`, optional `/owners` (501 when unimplemented); unknown scope → 404; `days` clamped to `windowDays`; junk skipped (decode throw); invalid dropped (`verify` false); verify-throw dropped (verify-errored) without crashing; board/archive fetch failure → 502 (fail loud, never a short window); `/health` shared; cosign endpoints honor the bearer token.
- **Tests cover every required case** — unit: category resolution from the team-file + UTC rollover; decode+validate+aggregate over a **fake board** with a **junk entry skipped** and an **invalid-sig record dropped by the adapter** (plus verify-throw); board-vs-archive **fallback selection** with `source` tagging; route matching + JSON shapes. Integration: **post a cosign record into a fake board, hit the route, get the aggregate-ready set back** — proving the codec is the single source of truth post-side and route-side.
- **Repo conventions** — npm workspaces (`npm install` from root, `^0.0.31` pins, no pnpm/`workspace:*`); NodeNext `.js` import extensions; `tsc` build; vitest in `test/`. The dependency `@msgboard/cosign` is added to `packages/history/package.json`.
- **Dependency stated** — the plan declares up front it DEPENDS on the already-built cosign SDK and that the stateful cache is deferred (out of scope).

---

## Execution Handoff

- **Branch:** create a feature branch off `master` (e.g. `feat/cosign-archive-route`) before Task 0. Do not push or open a PR unless asked.
- **Order:** Tasks are sequential (0 → 6); each ends with its own commit. Task 0 must run `npm install` from the **repo root** so the `@msgboard/cosign` workspace symlink resolves, and must build `packages/cosign` first (it is a built dependency — `dist/` must exist).
- **TDD discipline:** for every task, write the test file, run it, confirm it fails for the *right reason* (module/symbol missing — not a typo), then write the source to green. Run the single test file during a task; run the whole `packages/history` suite at Task 6.
- **Run a single test file:** `npx vitest run test/cosign/<file>.test.ts --root packages/history` (or `cd packages/history && npx vitest run test/cosign/<file>.test.ts`). Run all: `npx vitest run --root packages/history`.
- **Done when:** Task 6's full suite + build + lint are green, and the existing `archive.test.ts`/`server.test.ts` still pass unchanged (the cosign option is additive).
- **Out of scope (do NOT build):** the §11 persistent cache (sqlite/postgres sink, prune daemon, cache reads, cold-start), on-board team discovery, in-flight encryption, multi-tenant control plane, on-chain execution, and extracting a standalone `@msgboard/cosign-archive` package. Open items from spec §14 (board-retention boundary derivation from board `status`, partial-failure `warnings` mode, adapter `order` when `kind:"none"`, adapter-kind→instance resolution) are intentionally deferred — v1 pins a conservative `boardRetentionDays` config value and uses the injected adapter directly.
```
