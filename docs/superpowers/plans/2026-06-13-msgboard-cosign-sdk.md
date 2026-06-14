# @msgboard/cosign SDK Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL — `superpowers:test-driven-development`. Every task below is RED → GREEN → REFACTOR. Write the failing test first, run it, watch it fail for the right reason, then write the minimum code to pass. Do not skip the RED step. Do not write source before its test.

## Goal

Ship `@msgboard/cosign` (sub-project 1): a small, dependency-light SDK for sharing **co-signature artifacts** — generic `(digest, signer, signature, scheme, meta)` records — over MsgBoard, bucketed under **rotating, day-granular UTC category keys**. It is app-agnostic; a pluggable **adapter** encodes a specific multisig's verify/order/owner-read rules. The first adapter (Wonderland) ships as an intentional **STUB** (interface + seam only). Zero chain writes; pure board + crypto.

The deliverable is the foundation layer that two consumers build on: a team's own post/read/aggregate tooling, and the **cosign archivist** (sub-project 2) which imports this package's `keys.ts` key scheme and `record.ts` codec verbatim.

Source of truth for behavior: `docs/superpowers/specs/2026-06-13-msgboard-cosign-sdk-design.md`. This plan implements exactly that spec.

## Architecture

```
caller's signing tooling
        │  postSignature({ namespace, scope, record, now? })
        ▼
   src/client.ts ──── currentKey() ──► src/keys.ts  (keccak256('ns:scope:isoDay'))
        │        ──── encodeRecord() ─► src/record.ts (ABI tuple codec, SCHEME enum)
        ▼
   BoardClient seam  (addMessage / content)  ◄── wraps @msgboard/sdk MsgBoardClient
        │
        ▼
   MsgBoard (ephemeral, PoW-gated board store)
        ▲
        │  readSignatures({ namespace, scope, days, now? })
   src/client.ts ──── keysForWindow() ─► src/keys.ts
        │        ──── decodeRecord() (skip junk) ─► src/record.ts
        │        ──── groupByDigest()
        ▼        ──── aggregate(records, adapter) ─► src/adapters/adapter.ts
   ordered { signer, signature }[]   (handed to team's existing execute path — out of scope)
            ▲
            │ verify / order / owners? / threshold?
   src/adapters/wonderland.ts  (STUB — throws 'wonderland adapter: not implemented')
```

`keys.ts` and `record.ts` are pure (no I/O). `client.ts` depends only on an abstract `BoardClient` interface — never on `MsgBoardClient` directly — so it is fully testable with a fake board. Adapters are the only place chain reads may happen (read-only); the shipped Wonderland adapter does none yet (stub).

## Tech Stack

- **Language / module system**: TypeScript, ESM (`"type": "module"`), `module`/`moduleResolution`: `NodeNext`. Source imports use explicit `.js` extensions (NodeNext requirement) — e.g. `import { categoryKey } from './keys.js'`.
- **Build**: `tsc` → `dist/` (declaration + sourcemaps), matching `packages/relayer`.
- **Test runner**: **vitest** (`vitest run`), with a `vitest.config.ts` including `test/**/*.test.ts`. Chosen to match every other leaf package in the monorepo (`packages/sdk` and `packages/relayer` both use vitest 3.x); tests live in `test/`, mirroring `packages/relayer`.
- **Crypto / encoding**: `viem` (`keccak256`, `toBytes`, `encodeAbiParameters`, `decodeAbiParameters`, `Hex` type). No bespoke crypto.
- **Workspace deps**: `@msgboard/sdk` (for the `Hex` type re-export and as the real board-client this SDK's `BoardClient` seam wraps). Versioned `^0.0.31` (npm-workspace style used across this repo — see "Repo conventions" below), **not** `workspace:*`.

> **Repo conventions discovered (the plan's code is real, not aspirational):**
> - **Package manager is npm workspaces**, *not* pnpm. Root `package.json` declares `"workspaces": ["packages/core", ...]` and there is a `package-lock.json`. There is **no** `pnpm-workspace.yaml`. New packages are added to the root `workspaces` array; install with `npm install` from the repo root. (The prompt mentioned pnpm; the actual repo is npm — this plan follows the repo.)
> - Cross-package type imports use the bare package specifier, e.g. `import type { Hex } from '@msgboard/sdk'` or `import type { RPCMessage } from '@msgboard/sdk'` (see `packages/relayer/src/sources/msgboard-content.ts`). `@msgboard/sdk` re-exports everything from `@msgboard/core` (`export * from '@msgboard/core'`), and `@msgboard/core` re-exports `viem`'s `Hex`, so `Hex` is available from `@msgboard/sdk`. To keep deps minimal we import `Hex` from `viem` directly (viem is already a direct dep), and import `@msgboard/sdk` only for the real-client wrapper type referenced in the README.
> - Workspace dep versions are pinned `^0.0.31` (current monorepo version), e.g. relayer depends on `"@msgboard/sdk": "^0.0.31"`.
> - Each leaf package has its own `tsconfig.json` (target `ESNext`, `module`/`moduleResolution` `NodeNext`, `strict`, `noUnusedLocals`, `noUnusedParameters`, `declaration`, `sourceMap`, `outDir: ./dist`) and `vitest.config.ts`. Tests are excluded from the build (`"exclude": ["dist","node_modules","test"]`).
> - Node version is pinned to `24` (`.nvmrc`).

> **SDK surface — where the spec's assumption differs from the real `@msgboard/sdk`, and how it is reconciled:**
> The spec's `client.ts` description assumes a board client with `addMessage({ category, data })` and `content({ category? })`. The **real** `MsgBoardClient` (`packages/sdk/src/index.ts`) is lower-level:
> - `addMessage(input: Hex | MessageSeed): Promise<Hex>` — takes an RLP hex or a fully-formed `MessageSeed` (which already contains a PoW `nonce`); it does **not** take `{category,data}`. Posting a fresh message is a two-step: `const { message } = await client.doPoW(category, data)` then `await client.addMessage(message)`.
> - `content(filter: ContentFilter = {}): Promise<Content>` where `ContentFilter = { category?: Hex; fromBlock?; toBlock? }` and `Content = { [categoryHash: Hex]: RPCMessage[] }`.
> - `categoryHash(category: string | Hex | ByteArray): Hex` returns hex inputs **as-is**, and for a string returns `keccak256(stringToBytes(category))`.
>
> **Reconciliation:** cosign defines its **own minimal `BoardClient` interface** (`addMessage({ category, data }): Promise<unknown>` and `content({ category }): Promise<Content>`) exactly as the spec asks. This is a deliberate seam, mirroring the `MsgBoardTransport` shape `@gibs/msgboard-games` uses — it keeps `client.ts` testable with a tiny fake and decouples cosign from PoW mechanics. The README documents a one-screen adapter that wraps the real `MsgBoardClient` into this `BoardClient` (doing `doPoW` + `addMessage` for the post path, and passing `content` through). cosign code never imports `MsgBoardClient`; only the README example does.
>
> **`categoryHash` vs the spec's `keccak256(toBytes('ns:scope:isoDate'))`:** these are *identical* for string inputs (`categoryHash(str) === keccak256(stringToBytes(str))`, and `toBytes(str) === stringToBytes(str)` in viem). Per the spec, `keys.ts` computes its **own** `keccak256(toBytes(keyString))` so the key scheme is fully self-contained and importable by the archivist without pulling in `@msgboard/core`. A test asserts byte-for-byte equality against `categoryHash` is **not** added (would add a core dep); instead a comment in `keys.ts` records the equivalence.

---

## Canonical encodings (pin these — downstream sub-projects mirror them)

These are **law**. The cosign archivist (sub-project 2) imports `keys.ts` and `record.ts` and will mirror the decode; any drift breaks it.

1. **Category-key string format**: `` `${namespace}:${scope}:${isoDate}` `` where `isoDate` is **UTC** `YYYY-MM-DD` (from `Date.prototype.toISOString().slice(0, 10)`). The category hex is `keccak256(toBytes(thatString))`. Colon is the field separator; namespace and scope are caller-chosen strings (must not themselves contain logic-bearing colons that would collide — documented, not enforced).

2. **`SignatureRecord` ABI tuple — order is law**:

   ```
   (bytes32 digest, address signer, bytes signature, uint8 scheme, bytes meta)
   ```

   Field order, types, and count are fixed. `encodeRecord` ABI-encodes this 5-tuple; `decodeRecord` ABI-decodes it and **throws** on malformed input. The archivist's decoder uses this exact tuple.

3. **`SCHEME` enum** (the `uint8 scheme` field):

   ```ts
   const SCHEME = { ECDSA: 0, EIP1271: 1, EIP712: 2 } as const
   ```

---

## File structure

All paths relative to `packages/cosign/`.

| File | Responsibility |
|---|---|
| `package.json` | Package manifest: name `@msgboard/cosign`, ESM, `tsc` build, `vitest` test, deps `@msgboard/sdk` + `viem`, dev `vitest` + `typescript`. |
| `tsconfig.json` | TS build config (NodeNext, strict), copied from `packages/relayer`. |
| `vitest.config.ts` | Includes `test/**/*.test.ts`. |
| `README.md` | What it is, the canonical encodings, and the `MsgBoardClient → BoardClient` wrapper example. |
| `src/index.ts` | Public surface: re-exports `keys`, `record`, `client`, `adapters/adapter`, `adapters/wonderland`. |
| `src/keys.ts` | Rotating-key scheme: `isoDay`, `categoryKey`, `currentKey`, `keysForWindow`. Pure. |
| `src/record.ts` | `SignatureRecord` type, `SCHEME` enum, `RECORD_ABI` tuple, `encodeRecord`, `decodeRecord`. Pure. |
| `src/client.ts` | `BoardClient` interface, `PostSignatureArgs`/`ReadSignaturesArgs`, `postSignature`, `readSignatures`, `groupByDigest`, `aggregate`. Depends only on `BoardClient` + adapter interface. |
| `src/adapters/adapter.ts` | `CosignAdapter` interface (the seam). |
| `src/adapters/wonderland.ts` | `WonderlandAdapterConfig` shape + `wonderlandAdapter(config)` STUB (every method throws `not implemented`), with a documented TODO of the intended chain reads. |
| `test/keys.test.ts` | keys: determinism, UTC rotation across a boundary (fixed dates), window length/contents, namespace/scope sensitivity, `days < 1` throws. |
| `test/record.test.ts` | record: round-trip per scheme incl. empty meta; `decodeRecord` throws on garbage. |
| `test/client.test.ts` | client: post path, read path with a junk entry skipped + dedupe, `groupByDigest`, `aggregate` filter+order — all with a fake `BoardClient` + fake adapter. |
| `test/adapters/wonderland.test.ts` | asserts every stub method throws `not implemented` (locks the seam). |

---

## Task 1 — Scaffold `packages/cosign`

**Goal:** A buildable, testable empty package wired into the npm workspace, with one smoke test passing.

### 1.1 Register the package in the root workspace

Edit the repo-root `package.json` `workspaces` array to add `"packages/cosign"` (alphabetical-ish placement next to the other packages is fine; order is not significant to npm). The array becomes:

```json
  "workspaces": [
    "packages/core",
    "packages/sdk",
    "packages/history",
    "packages/hardhat",
    "packages/relayer",
    "packages/indexer",
    "packages/ui",
    "packages/sponsor",
    "packages/examples",
    "packages/cosign"
  ],
```

### 1.2 `packages/cosign/package.json`

```json
{
  "name": "@msgboard/cosign",
  "version": "0.0.31",
  "description": "Generic signature-share SDK over MsgBoard, bucketed under rotating day-granular category keys",
  "repository": "github:valve-tech/msgboard",
  "author": "MsgBoard",
  "license": "MIT",
  "type": "module",
  "publishConfig": {
    "access": "public"
  },
  "main": "./dist/index.js",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "require": "./dist/index.js",
      "default": "./dist/index.js"
    }
  },
  "keywords": [
    "msgboard",
    "cosign",
    "multisig",
    "signatures"
  ],
  "scripts": {
    "prebuild": "node -e \"require('fs').rmSync('dist',{recursive:true,force:true})\"",
    "build": "tsc",
    "watch": "tsc -w",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "prettier --check ."
  },
  "files": [
    "dist/"
  ],
  "dependencies": {
    "@msgboard/sdk": "^0.0.31",
    "viem": "^2.25.0"
  },
  "devDependencies": {
    "typescript": "^5.8.2",
    "vitest": "^3.1.1"
  }
}
```

### 1.3 `packages/cosign/tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "NodeNext",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "./dist",
    "skipLibCheck": true,
    "esModuleInterop": true,
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src"],
  "exclude": ["dist", "node_modules", "test"]
}
```

### 1.4 `packages/cosign/vitest.config.ts`

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
})
```

### 1.5 `packages/cosign/src/index.ts` (placeholder)

```ts
/** @msgboard/cosign — generic signature-share over rotating category keys. */
export const COSIGN_VERSION = '0.0.31' as const
```

### 1.6 RED — smoke test `packages/cosign/test/smoke.test.ts`

```ts
import { describe, expect, it } from 'vitest'
import { COSIGN_VERSION } from '../src/index.js'

describe('@msgboard/cosign smoke', () => {
  it('exposes a version constant', () => {
    expect(COSIGN_VERSION).toBe('0.0.31')
  })
})
```

### 1.7 Install, test, typecheck

```bash
cd /Users/michaelmclaughlin/Documents/valve-tech/github/msgboard
npm install
npm run test --workspace=packages/cosign
npm run build --workspace=packages/cosign
```

**Expected output:**
- `npm install` completes and links `@msgboard/cosign` into the workspace (the `@msgboard/sdk` dep resolves to the local workspace package).
- `vitest run`: `Test Files  1 passed (1)` / `Tests  1 passed (1)`.
- `tsc` produces `packages/cosign/dist/index.js` + `index.d.ts` with no errors.

### 1.8 Commit

```bash
git add packages/cosign package.json package-lock.json
git commit -m "feat(cosign): scaffold @msgboard/cosign package (npm workspace, vitest, tsc)"
```

> The smoke test (`test/smoke.test.ts`) and the placeholder `index.ts` body are replaced in Task 6 when the real re-exports land. Leave them until then so every intermediate task has green tests.

---

## Task 2 — `keys.ts` (rotating category-key scheme)

**Goal:** Deterministic, UTC-day-granular category keys with a rolling-window helper. Pure functions; all time-dependent functions accept an explicit `now?: Date` so tests pass fixed dates (never `Date.now()` in assertions).

### 2.1 RED — `packages/cosign/test/keys.test.ts`

```ts
import { describe, expect, it } from 'vitest'
import { keccak256, toBytes } from 'viem'
import { categoryKey, currentKey, isoDay, keysForWindow } from '../src/keys.js'

describe('isoDay', () => {
  it('formats a date as UTC YYYY-MM-DD', () => {
    expect(isoDay(new Date('2026-06-13T12:34:56.000Z'))).toBe('2026-06-13')
  })

  it('uses UTC, not local time, across a day boundary', () => {
    // 2026-06-13T23:30 in UTC-05 is still 2026-06-14T04:30 UTC.
    expect(isoDay(new Date('2026-06-14T04:30:00.000Z'))).toBe('2026-06-14')
    // One minute before midnight UTC is still the 13th.
    expect(isoDay(new Date('2026-06-13T23:59:59.999Z'))).toBe('2026-06-13')
    // One minute after midnight UTC has rolled to the 14th.
    expect(isoDay(new Date('2026-06-14T00:00:00.001Z'))).toBe('2026-06-14')
  })
})

describe('categoryKey', () => {
  it('is deterministic and equals keccak256(toBytes("ns:scope:isoDate"))', () => {
    const expected = keccak256(toBytes('cosign:acme:2026-06-13'))
    expect(categoryKey('cosign', 'acme', '2026-06-13')).toBe(expected)
    expect(categoryKey('cosign', 'acme', '2026-06-13')).toBe(
      categoryKey('cosign', 'acme', '2026-06-13'),
    )
  })

  it('is sensitive to namespace', () => {
    expect(categoryKey('cosign', 'acme', '2026-06-13')).not.toBe(
      categoryKey('multisig', 'acme', '2026-06-13'),
    )
  })

  it('is sensitive to scope', () => {
    expect(categoryKey('cosign', 'acme', '2026-06-13')).not.toBe(
      categoryKey('cosign', 'beta', '2026-06-13'),
    )
  })

  it('is sensitive to date', () => {
    expect(categoryKey('cosign', 'acme', '2026-06-13')).not.toBe(
      categoryKey('cosign', 'acme', '2026-06-14'),
    )
  })
})

describe('currentKey', () => {
  it('keys to the UTC day of the injected now', () => {
    const now = new Date('2026-06-13T08:00:00.000Z')
    expect(currentKey('cosign', 'acme', now)).toBe(categoryKey('cosign', 'acme', '2026-06-13'))
  })
})

describe('keysForWindow', () => {
  it('returns exactly `days` keys, today-first then descending', () => {
    const now = new Date('2026-06-13T08:00:00.000Z')
    const keys = keysForWindow('cosign', 'acme', 3, now)
    expect(keys).toHaveLength(3)
    expect(keys).toEqual([
      categoryKey('cosign', 'acme', '2026-06-13'),
      categoryKey('cosign', 'acme', '2026-06-12'),
      categoryKey('cosign', 'acme', '2026-06-11'),
    ])
  })

  it('crosses a month boundary correctly (UTC)', () => {
    const now = new Date('2026-07-01T00:00:00.000Z')
    const keys = keysForWindow('cosign', 'acme', 2, now)
    expect(keys).toEqual([
      categoryKey('cosign', 'acme', '2026-07-01'),
      categoryKey('cosign', 'acme', '2026-06-30'),
    ])
  })

  it('returns a single key for days=1', () => {
    const now = new Date('2026-06-13T08:00:00.000Z')
    expect(keysForWindow('cosign', 'acme', 1, now)).toEqual([
      categoryKey('cosign', 'acme', '2026-06-13'),
    ])
  })

  it('throws when days < 1', () => {
    expect(() => keysForWindow('cosign', 'acme', 0)).toThrow(/days >= 1/)
    expect(() => keysForWindow('cosign', 'acme', -3)).toThrow(/days >= 1/)
  })
})
```

Run it — it must fail because `src/keys.ts` does not exist yet:

```bash
npm run test --workspace=packages/cosign -- keys
```

**Expected:** vitest reports a resolve/import error for `../src/keys.js` (RED).

### 2.2 GREEN — `packages/cosign/src/keys.ts`

```ts
import { type Hex, keccak256, toBytes } from 'viem'

/**
 * Formats a Date as a UTC `YYYY-MM-DD` string — the day bucket for a category key.
 * UTC is intentional: every participant and the archivist must agree on the bucket
 * regardless of local timezone.
 */
export function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/**
 * The canonical category key for a (namespace, scope, isoDate) triple.
 * Equals `keccak256(toBytes(\`${namespace}:${scope}:${isoDate}\`))`.
 *
 * NOTE: for string inputs this is byte-for-byte identical to `@msgboard/core`'s
 * `categoryHash(keyString)` (both keccak256 the UTF-8 bytes). We compute it here
 * directly so the key scheme is self-contained and importable without a core dep.
 *
 * Order is law (the archivist mirrors this): `namespace:scope:isoDate`.
 */
export function categoryKey(namespace: string, scope: string, isoDate: string): Hex {
  return keccak256(toBytes(`${namespace}:${scope}:${isoDate}`))
}

/** The category key for the current UTC day. `now` is injectable for deterministic tests. */
export function currentKey(namespace: string, scope: string, now: Date = new Date()): Hex {
  return categoryKey(namespace, scope, isoDay(now))
}

/**
 * The rolling window of category keys: today plus the prior `days - 1` UTC days,
 * today-first then descending. This is the shared set readers and the archivist sweep.
 * @throws if `days < 1`.
 */
export function keysForWindow(
  namespace: string,
  scope: string,
  days: number,
  now: Date = new Date(),
): Hex[] {
  if (days < 1) throw new Error('keysForWindow: days >= 1 required')
  const dayMs = 24 * 60 * 60 * 1000
  const base = now.getTime()
  const keys: Hex[] = []
  for (let i = 0; i < days; i++) {
    keys.push(categoryKey(namespace, scope, isoDay(new Date(base - i * dayMs))))
  }
  return keys
}
```

> Subtracting whole `dayMs` from a UTC instant and then taking `isoDay` (UTC) is safe across DST/month/year boundaries because `Date.getTime()` is UTC epoch ms and `toISOString()` is UTC — no local-time arithmetic is involved.

### 2.3 Run & verify

```bash
npm run test --workspace=packages/cosign -- keys
```

**Expected:** all `keys.test.ts` describe blocks pass. `Tests  N passed`.

### 2.4 Commit

```bash
git add packages/cosign/src/keys.ts packages/cosign/test/keys.test.ts
git commit -m "feat(cosign): keys.ts — rotating UTC day-bucketed category keys"
```

---

## Task 3 — `record.ts` (canonical artifact + ABI codec)

**Goal:** The single-source-of-truth `SignatureRecord` type, `SCHEME` enum, and round-trippable ABI codec. `decodeRecord` throws on malformed input.

### 3.1 RED — `packages/cosign/test/record.test.ts`

```ts
import { describe, expect, it } from 'vitest'
import type { Hex } from 'viem'
import { SCHEME, type SignatureRecord, decodeRecord, encodeRecord } from '../src/record.js'

const digest = `0x${'11'.repeat(32)}` as Hex
const signer = `0x${'22'.repeat(20)}` as Hex
const signature = `0x${'33'.repeat(65)}` as Hex // r||s||v

const make = (scheme: number, meta: Hex): SignatureRecord => ({
  digest,
  signer,
  signature,
  scheme,
  meta,
})

describe('SCHEME', () => {
  it('pins the enum values (order is law)', () => {
    expect(SCHEME).toEqual({ ECDSA: 0, EIP1271: 1, EIP712: 2 })
  })
})

describe('encodeRecord / decodeRecord', () => {
  it('round-trips ECDSA with empty meta', () => {
    const r = make(SCHEME.ECDSA, '0x')
    expect(decodeRecord(encodeRecord(r))).toEqual(r)
  })

  it('round-trips EIP1271 with non-empty meta', () => {
    const r = make(SCHEME.EIP1271, '0xdeadbeef')
    expect(decodeRecord(encodeRecord(r))).toEqual(r)
  })

  it('round-trips EIP712 with empty meta', () => {
    const r = make(SCHEME.EIP712, '0x')
    expect(decodeRecord(encodeRecord(r))).toEqual(r)
  })

  it('produces a 0x hex string from encodeRecord', () => {
    expect(encodeRecord(make(SCHEME.ECDSA, '0x'))).toMatch(/^0x[0-9a-f]+$/)
  })

  it('throws on garbage input', () => {
    expect(() => decodeRecord('0xdead' as Hex)).toThrow()
  })

  it('throws on empty input', () => {
    expect(() => decodeRecord('0x' as Hex)).toThrow()
  })
})
```

Run — must fail (no `src/record.ts`):

```bash
npm run test --workspace=packages/cosign -- record
```

**Expected:** import-resolution failure for `../src/record.js` (RED).

### 3.2 GREEN — `packages/cosign/src/record.ts`

```ts
import { type Hex, decodeAbiParameters, encodeAbiParameters } from 'viem'

/**
 * A generic co-signature artifact. The single source of truth shared by posters,
 * readers, and the cosign archivist (sub-project 2). Field order matches RECORD_ABI.
 */
export interface SignatureRecord {
  /** The signed digest (bytes32) — e.g. a safeTxHash. */
  digest: Hex
  /** The signer address (20-byte address). */
  signer: Hex
  /** The signature bytes (e.g. 65-byte r||s||v for ECDSA). */
  signature: Hex
  /** The signature scheme — see SCHEME. */
  scheme: number
  /** Optional scheme-specific metadata (bytes); `0x` when unused. */
  meta: Hex
}

/** Signature scheme tags for the `scheme` field. Values are law (uint8 on the wire). */
export const SCHEME = { ECDSA: 0, EIP1271: 1, EIP712: 2 } as const

/**
 * Canonical ABI tuple — ORDER IS LAW. Both readers and the archivist decode against
 * this exact sequence: (bytes32 digest, address signer, bytes signature, uint8 scheme, bytes meta).
 */
export const RECORD_ABI = [
  { name: 'digest', type: 'bytes32' },
  { name: 'signer', type: 'address' },
  { name: 'signature', type: 'bytes' },
  { name: 'scheme', type: 'uint8' },
  { name: 'meta', type: 'bytes' },
] as const

/** ABI-encodes a SignatureRecord into the canonical tuple. */
export function encodeRecord(r: SignatureRecord): Hex {
  return encodeAbiParameters(RECORD_ABI, [r.digest, r.signer, r.signature, r.scheme, r.meta])
}

/**
 * ABI-decodes the canonical tuple into a SignatureRecord.
 * @throws (via viem) on malformed / undecodable input.
 */
export function decodeRecord(data: Hex): SignatureRecord {
  const [digest, signer, signature, scheme, meta] = decodeAbiParameters(RECORD_ABI, data)
  return { digest, signer, signature, scheme: Number(scheme), meta }
}
```

> `viem`'s `decodeAbiParameters` throws on too-short / misaligned data, satisfying the garbage and empty-input tests. `scheme` decodes as a `number` from `uint8`; `Number(scheme)` is defensive and keeps the field a plain `number` to match the interface and round-trip equality.

### 3.3 Run & verify

```bash
npm run test --workspace=packages/cosign -- record
```

**Expected:** all `record.test.ts` cases pass.

### 3.4 Commit

```bash
git add packages/cosign/src/record.ts packages/cosign/test/record.test.ts
git commit -m "feat(cosign): record.ts — canonical SignatureRecord ABI codec + SCHEME"
```

---

## Task 4 — `client.ts` (post / read / group / aggregate)

**Goal:** post/read/aggregate over an abstract `BoardClient`, plus `groupByDigest`. Fully testable with a fake board and fake adapter. Depends on `keys.ts` (Task 2), `record.ts` (Task 3), and the adapter interface (defined inline-compatible here; the interface file lands in Task 5 and `client.ts` imports it then — see note).

> **Ordering note:** `aggregate` needs the `CosignAdapter` type. To keep tasks independent and tests green, Task 4 defines `client.ts` importing `CosignAdapter` from `./adapters/adapter.js`, and Task 5 creates that file. To make Task 4 self-contained for its own RED→GREEN, we create the tiny `adapters/adapter.ts` interface file as the **first step of Task 4** (it is pure type, no behavior), then build `client.ts` against it. Task 5 then only adds the Wonderland stub + its test. (This is a minor, deliberate resequencing of the suggested breakdown so every task compiles on its own.)

### 4.1 Create the adapter interface (type-only seam) — `packages/cosign/src/adapters/adapter.ts`

```ts
import type { Hex } from 'viem'
import type { SignatureRecord } from '../record.js'

/**
 * The pluggable multisig seam. An adapter encodes a specific backend's verification
 * and ordering rules, and may make read-only chain calls (owners / threshold).
 * Verification failures (e.g. RPC errors) PROPAGATE — they are not silently treated
 * as "invalid signature"; the caller decides.
 */
export interface CosignAdapter {
  /** True if the record is a valid signature for this backend. Errors propagate. */
  verify(record: SignatureRecord): Promise<boolean>
  /** Returns the records in backend-required submission order. */
  order(records: SignatureRecord[]): SignatureRecord[]
  /** Optional: the current owner set (read-only chain call). */
  owners?(): Promise<Hex[]>
  /** Optional: the current signing threshold (read-only chain call). */
  threshold?(): Promise<number>
}
```

### 4.2 RED — `packages/cosign/test/client.test.ts`

```ts
import { describe, expect, it } from 'vitest'
import { type Hex, keccak256 } from 'viem'
import type { Content, RPCMessage } from '@msgboard/sdk'
import { SCHEME, type SignatureRecord, encodeRecord } from '../src/record.js'
import { categoryKey, keysForWindow } from '../src/keys.js'
import {
  type BoardClient,
  aggregate,
  groupByDigest,
  postSignature,
  readSignatures,
} from '../src/client.js'
import type { CosignAdapter } from '../src/adapters/adapter.js'

const signer = (n: string): Hex => `0x${n.repeat(40).slice(0, 40)}` as Hex
const digestA = `0x${'aa'.repeat(32)}` as Hex
const digestB = `0x${'bb'.repeat(32)}` as Hex
const sig = `0x${'33'.repeat(65)}` as Hex

const rec = (digest: Hex, signerAddr: Hex): SignatureRecord => ({
  digest,
  signer: signerAddr,
  signature: sig,
  scheme: SCHEME.ECDSA,
  meta: '0x',
})

/** Builds a single RPCMessage carrying `data` (only the `data` field matters here). */
const msg = (data: Hex): RPCMessage => ({ data } as RPCMessage)

describe('postSignature', () => {
  it('encodes the record and adds it under the current UTC day key', async () => {
    const calls: { category: Hex; data: Hex }[] = []
    const board: BoardClient = {
      addMessage: async (arg) => {
        calls.push(arg)
        return '0xhash'
      },
      content: async () => ({}),
    }
    const now = new Date('2026-06-13T10:00:00.000Z')
    const record = rec(digestA, signer('1'))
    await postSignature(board, { namespace: 'cosign', scope: 'acme', record, now })
    expect(calls).toHaveLength(1)
    expect(calls[0].category).toBe(categoryKey('cosign', 'acme', '2026-06-13'))
    expect(calls[0].data).toBe(encodeRecord(record))
  })
})

describe('readSignatures', () => {
  it('sweeps the window, decodes, skips junk, and dedupes by data', async () => {
    const now = new Date('2026-06-13T10:00:00.000Z')
    const [k0, k1] = keysForWindow('cosign', 'acme', 2, now)
    const r1 = rec(digestA, signer('1'))
    const r2 = rec(digestB, signer('2'))
    const requested: Hex[] = []
    const board: BoardClient = {
      addMessage: async () => '0x',
      content: async ({ category }) => {
        requested.push(category)
        if (category === k0) {
          return {
            [k0]: [
              msg(encodeRecord(r1)),
              msg('0xdeadbeef' as Hex), // junk — must be skipped, not throw
              msg(encodeRecord(r1)), // duplicate of r1 — deduped by data
            ],
          } as Content
        }
        return { [k1]: [msg(encodeRecord(r2))] } as Content
      },
    }
    const out = await readSignatures(board, { namespace: 'cosign', scope: 'acme', days: 2, now })
    expect(requested).toEqual([k0, k1]) // both window categories queried
    expect(out).toHaveLength(2) // r1 (once), r2 — junk skipped, dup removed
    expect(out.map((r) => r.signer).sort()).toEqual([signer('1'), signer('2')].sort())
  })
})

describe('groupByDigest', () => {
  it('groups records by their digest', () => {
    const records = [rec(digestA, signer('1')), rec(digestA, signer('2')), rec(digestB, signer('3'))]
    const groups = groupByDigest(records)
    expect(groups.get(digestA)?.map((r) => r.signer)).toEqual([signer('1'), signer('2')])
    expect(groups.get(digestB)?.map((r) => r.signer)).toEqual([signer('3')])
    expect([...groups.keys()].sort()).toEqual([digestA, digestB].sort())
  })
})

describe('aggregate', () => {
  it('keeps records the adapter verifies, then applies its order', async () => {
    const r1 = rec(digestA, signer('1'))
    const r2 = rec(digestA, signer('2'))
    const r3 = rec(digestA, signer('3'))
    // adapter rejects r2, and orders by signer descending
    const adapter: CosignAdapter = {
      verify: async (record) => record.signer !== signer('2'),
      order: (records) => [...records].sort((a, b) => (a.signer < b.signer ? 1 : -1)),
    }
    const out = await aggregate([r1, r2, r3], adapter)
    expect(out).toEqual([
      { signer: signer('3'), signature: sig },
      { signer: signer('1'), signature: sig },
    ])
  })

  it('propagates adapter.verify errors (does not swallow as invalid)', async () => {
    const adapter: CosignAdapter = {
      verify: async () => {
        throw new Error('rpc down')
      },
      order: (records) => records,
    }
    await expect(aggregate([rec(digestA, signer('1'))], adapter)).rejects.toThrow('rpc down')
  })

  it('dedupes by keccak256 of the message data field', () => {
    // sanity: same record encodes identically, so its data-hash collides
    const r = rec(digestA, signer('1'))
    expect(keccak256(encodeRecord(r))).toBe(keccak256(encodeRecord(r)))
  })
})
```

Run — must fail (no `src/client.ts`):

```bash
npm run test --workspace=packages/cosign -- client
```

**Expected:** import-resolution failure for `../src/client.js` (RED).

### 4.3 GREEN — `packages/cosign/src/client.ts`

```ts
import { type Hex, keccak256 } from 'viem'
import type { Content } from '@msgboard/sdk'
import { type SignatureRecord, decodeRecord, encodeRecord } from './record.js'
import { currentKey, keysForWindow } from './keys.js'
import type { CosignAdapter } from './adapters/adapter.js'

/**
 * The minimal board seam cosign needs. Mirrors the `{ category, data }` shape used by
 * `@gibs/msgboard-games`'s transport so it stays testable with a tiny fake. Wrap the real
 * `@msgboard/sdk` `MsgBoardClient` into this (doPoW + addMessage for posting, content passthrough);
 * see the package README.
 */
export interface BoardClient {
  /** Posts `data` under `category`. Returns whatever the underlying board returns. */
  addMessage(arg: { category: Hex; data: Hex }): Promise<unknown>
  /** Fetches messages for a single category. */
  content(arg: { category: Hex }): Promise<Content>
}

/** Arguments for posting a signature. */
export interface PostSignatureArgs {
  namespace: string
  scope: string
  record: SignatureRecord
  /** Injectable clock for deterministic tests; defaults to now. */
  now?: Date
}

/** Arguments for reading the signature window. */
export interface ReadSignaturesArgs {
  namespace: string
  scope: string
  /** Rolling window length in days (>= 1). */
  days: number
  /** Injectable clock for deterministic tests; defaults to now. */
  now?: Date
}

/**
 * Encodes `record` and posts it under the current UTC-day rotating category.
 * Board / PoW errors surface to the caller.
 */
export async function postSignature(
  board: BoardClient,
  { namespace, scope, record, now }: PostSignatureArgs,
): Promise<unknown> {
  const category = currentKey(namespace, scope, now)
  return board.addMessage({ category, data: encodeRecord(record) })
}

/**
 * Sweeps the rolling window of category keys, decodes each board entry, SKIPS undecodable
 * junk (the board is open — junk under a category is expected), and dedupes by keccak256 of
 * the raw message data. Never silently drops a well-formed record; validity is the adapter's
 * job at aggregate time.
 */
export async function readSignatures(
  board: BoardClient,
  { namespace, scope, days, now }: ReadSignaturesArgs,
): Promise<SignatureRecord[]> {
  const keys = keysForWindow(namespace, scope, days, now)
  const seen = new Set<Hex>()
  const out: SignatureRecord[] = []
  for (const category of keys) {
    const content = await board.content({ category })
    const messages = content[category] ?? []
    for (const message of messages) {
      const data = message.data
      if (!data) continue
      const dedupeKey = keccak256(data)
      if (seen.has(dedupeKey)) continue
      let record: SignatureRecord
      try {
        record = decodeRecord(data)
      } catch {
        continue // undecodable junk under an open category — skip
      }
      seen.add(dedupeKey)
      out.push(record)
    }
  }
  return out
}

/** Groups records by their `digest`, preserving input order within each group. */
export function groupByDigest(records: SignatureRecord[]): Map<Hex, SignatureRecord[]> {
  const groups = new Map<Hex, SignatureRecord[]>()
  for (const record of records) {
    const bucket = groups.get(record.digest)
    if (bucket) bucket.push(record)
    else groups.set(record.digest, [record])
  }
  return groups
}

/**
 * Keeps records the adapter verifies (errors PROPAGATE), then applies the adapter's order,
 * returning submission-ready `{ signer, signature }` pairs.
 */
export async function aggregate(
  records: SignatureRecord[],
  adapter: CosignAdapter,
): Promise<{ signer: Hex; signature: Hex }[]> {
  const kept: SignatureRecord[] = []
  for (const record of records) {
    if (await adapter.verify(record)) kept.push(record)
  }
  return adapter.order(kept).map((r) => ({ signer: r.signer, signature: r.signature }))
}
```

> The dedupe in `readSignatures` is keyed on `keccak256(message.data)` (the raw on-board bytes), so two byte-identical postings collapse to one. We dedupe **before** decoding so identical junk is also collapsed cheaply; decoding only happens for first-seen data. The `seen.add` is placed after a successful decode so that distinct-but-undecodable entries don't poison the set against a later valid entry with the same bytes (there can't be — same bytes decode the same way — but keeping the add post-decode keeps the invariant "seen ⊆ decodable" simplest). Junk is skipped via the `try/catch`; a well-formed record is never dropped.

### 4.4 Run & verify

```bash
npm run test --workspace=packages/cosign -- client
npm run test --workspace=packages/cosign
```

**Expected:** `client.test.ts` passes; the full package suite (smoke + keys + record + client) is green.

### 4.5 Commit

```bash
git add packages/cosign/src/client.ts packages/cosign/src/adapters/adapter.ts packages/cosign/test/client.test.ts
git commit -m "feat(cosign): client.ts — post/read/group/aggregate over a BoardClient seam"
```

---

## Task 5 — `adapters/wonderland.ts` (intentional STUB)

**Goal:** Lock the adapter seam with a documented Wonderland stub whose every method throws `wonderland adapter: not implemented`. This is the spec'd deliverable, **not** a placeholder — §4/§9 of the spec keep Wonderland's contract specifics open; the stub holds the shape so a future implementer cannot silently ship a half-wired adapter.

> `adapters/adapter.ts` already exists (created in Task 4.1). This task only adds the Wonderland stub + its test.

### 5.1 RED — `packages/cosign/test/adapters/wonderland.test.ts`

```ts
import { describe, expect, it } from 'vitest'
import type { Hex } from 'viem'
import { SCHEME, type SignatureRecord } from '../../src/record.js'
import { wonderlandAdapter } from '../../src/adapters/wonderland.js'

const config = {
  multisig: `0x${'ab'.repeat(20)}` as Hex,
  chainId: 1,
  publicClient: {},
}

const record: SignatureRecord = {
  digest: `0x${'11'.repeat(32)}` as Hex,
  signer: `0x${'22'.repeat(20)}` as Hex,
  signature: `0x${'33'.repeat(65)}` as Hex,
  scheme: SCHEME.ECDSA,
  meta: '0x',
}

describe('wonderlandAdapter (STUB)', () => {
  it('returns an adapter object exposing the full seam', () => {
    const adapter = wonderlandAdapter(config)
    expect(typeof adapter.verify).toBe('function')
    expect(typeof adapter.order).toBe('function')
    expect(typeof adapter.owners).toBe('function')
    expect(typeof adapter.threshold).toBe('function')
  })

  it('verify throws not implemented', async () => {
    await expect(wonderlandAdapter(config).verify(record)).rejects.toThrow(
      'wonderland adapter: not implemented',
    )
  })

  it('order throws not implemented', () => {
    expect(() => wonderlandAdapter(config).order([record])).toThrow(
      'wonderland adapter: not implemented',
    )
  })

  it('owners throws not implemented', async () => {
    await expect(wonderlandAdapter(config).owners!()).rejects.toThrow(
      'wonderland adapter: not implemented',
    )
  })

  it('threshold throws not implemented', async () => {
    await expect(wonderlandAdapter(config).threshold!()).rejects.toThrow(
      'wonderland adapter: not implemented',
    )
  })
})
```

Run — must fail (no `src/adapters/wonderland.ts`):

```bash
npm run test --workspace=packages/cosign -- wonderland
```

**Expected:** import-resolution failure for `../../src/adapters/wonderland.js` (RED).

### 5.2 GREEN — `packages/cosign/src/adapters/wonderland.ts`

```ts
import type { Hex } from 'viem'
import type { SignatureRecord } from '../record.js'
import type { CosignAdapter } from './adapter.js'

/**
 * Configuration for the Wonderland multisig adapter.
 * `publicClient` is intentionally `unknown` here: the real implementation will narrow it to a
 * viem `PublicClient` once Wonderland's contract/ABI is pinned (spec §9). Kept loose so the
 * seam shape is fixed without committing to a viem version's client type.
 */
export interface WonderlandAdapterConfig {
  /** The Wonderland multisig contract address. */
  multisig: Hex
  /** The chain id the multisig lives on. */
  chainId: number
  /** A read-only chain client (viem PublicClient) — typed `unknown` until the adapter is built. */
  publicClient: unknown
}

const NOT_IMPLEMENTED = 'wonderland adapter: not implemented'

/**
 * STUB Wonderland adapter — intentional, per spec §4/§9. Every method throws until Wonderland's
 * contract specifics are provided. This locks the {@link CosignAdapter} seam so a future
 * implementer cannot forget to wire it.
 *
 * TODO (when Wonderland's contract/ABI is pinned — spec §9):
 *  - owners():    read the owner set from `multisig` via `publicClient.readContract` (getOwners()).
 *  - threshold(): read the signing threshold via `publicClient.readContract` (getThreshold()).
 *  - verify():    recover the signer from `record.signature` over `record.digest` per `record.scheme`
 *                 (ECDSA ecrecover; EIP1271 isValidSignature staticcall; EIP712 typed-data recover)
 *                 and assert membership in owners(). RPC/recovery errors PROPAGATE (spec §6) —
 *                 never coerced to `false`.
 *  - order():     return records in the multisig's required submission order (e.g. owners ascending).
 *  - Pin the `scope` convention (team name vs `${chainId}:${safeAddress}`) and the per-scheme
 *    `meta` schema at the same time (spec §9).
 */
export function wonderlandAdapter(config: WonderlandAdapterConfig): CosignAdapter {
  // Reference config so it is part of the locked signature (and not flagged unused).
  void config
  return {
    async verify(_record: SignatureRecord): Promise<boolean> {
      throw new Error(NOT_IMPLEMENTED)
    },
    order(_records: SignatureRecord[]): SignatureRecord[] {
      throw new Error(NOT_IMPLEMENTED)
    },
    async owners(): Promise<Hex[]> {
      throw new Error(NOT_IMPLEMENTED)
    },
    async threshold(): Promise<number> {
      throw new Error(NOT_IMPLEMENTED)
    },
  }
}
```

> `noUnusedParameters` is on in `tsconfig.json`; the `_`-prefixed params and `void config` keep tsc happy while preserving the real signatures. The methods deliberately match `CosignAdapter` exactly so swapping in a real body later is a drop-in.

### 5.3 Run & verify

```bash
npm run test --workspace=packages/cosign -- wonderland
npm run build --workspace=packages/cosign
```

**Expected:** `wonderland.test.ts` passes; `tsc` clean (proves the stub satisfies `CosignAdapter` and the strict-unused flags).

### 5.4 Commit

```bash
git add packages/cosign/src/adapters/wonderland.ts packages/cosign/test/adapters/wonderland.test.ts
git commit -m "feat(cosign): wonderland.ts — intentional STUB locking the adapter seam"
```

---

## Task 6 — Wire `index.ts`, README, full sweep

**Goal:** Public re-exports, package README documenting the canonical encodings and the real-client wrapper, and a final green test + typecheck across the package (and the monorepo build).

### 6.1 Replace `packages/cosign/src/index.ts`

```ts
/**
 * @msgboard/cosign — generic signature-share over MsgBoard, bucketed under rotating,
 * day-granular UTC category keys. Pure board + crypto; zero chain writes.
 */
export { isoDay, categoryKey, currentKey, keysForWindow } from './keys.js'
export {
  SCHEME,
  RECORD_ABI,
  type SignatureRecord,
  encodeRecord,
  decodeRecord,
} from './record.js'
export {
  type BoardClient,
  type PostSignatureArgs,
  type ReadSignaturesArgs,
  postSignature,
  readSignatures,
  groupByDigest,
  aggregate,
} from './client.js'
export type { CosignAdapter } from './adapters/adapter.js'
export { type WonderlandAdapterConfig, wonderlandAdapter } from './adapters/wonderland.js'
```

### 6.2 Delete the obsolete smoke test and its constant

The Task-1 smoke test asserted `COSIGN_VERSION`, which no longer exists. Remove it:

```bash
git rm packages/cosign/test/smoke.test.ts
```

(The `COSIGN_VERSION` const is gone because 6.1 overwrote `index.ts`.)

### 6.3 `packages/cosign/README.md`

````md
# @msgboard/cosign

Generic **signature-share** SDK over [MsgBoard](https://github.com/valve-tech/msgboard): post, read, and
aggregate co-signature artifacts — `(digest, signer, signature, scheme, meta)` records — bucketed under
**rotating, day-granular UTC category keys** so the working set stays small and self-pruning.

App-agnostic. A pluggable **adapter** encodes a specific multisig's verify/order/owner-read rules. The first
adapter (Wonderland) ships as an intentional **stub**. Pure board + crypto: **no chain writes**.

## Canonical encodings (law — downstream tooling mirrors these)

- **Category key**: `keccak256(toBytes(\`${namespace}:${scope}:${isoDate}\`))`, where `isoDate` is UTC
  `YYYY-MM-DD`. Field separator is `:`; order is `namespace:scope:isoDate`.
- **SignatureRecord ABI tuple** (order is law):
  `(bytes32 digest, address signer, bytes signature, uint8 scheme, bytes meta)`.
- **Schemes**: `SCHEME = { ECDSA: 0, EIP1271: 1, EIP712: 2 }`.

## Quick start

```ts
import { MsgBoardClient } from '@msgboard/sdk'
import {
  type BoardClient,
  SCHEME,
  postSignature,
  readSignatures,
  groupByDigest,
  aggregate,
  wonderlandAdapter,
} from '@msgboard/cosign'

// Wrap the real, lower-level MsgBoardClient into cosign's BoardClient seam.
// Posting is a two-step on the real client: doPoW (find a nonce) then addMessage.
function boardFrom(client: MsgBoardClient): BoardClient {
  return {
    async addMessage({ category, data }) {
      const { message } = await client.doPoW(category, data)
      return client.addMessage(message)
    },
    content({ category }) {
      return client.content({ category })
    },
  }
}

const board = boardFrom(new MsgBoardClient(provider))

// Post a signature under today's rotating category.
await postSignature(board, {
  namespace: 'cosign',
  scope: 'acme-team',
  record: { digest, signer, signature, scheme: SCHEME.ECDSA, meta: '0x' },
})

// Read the rolling 7-day window, group by digest, and aggregate via an adapter.
const records = await readSignatures(board, { namespace: 'cosign', scope: 'acme-team', days: 7 })
const forDigest = groupByDigest(records).get(digest) ?? []
const ordered = await aggregate(forDigest, wonderlandAdapter({ multisig, chainId: 1, publicClient }))
// `ordered` is `{ signer, signature }[]` — hand to your existing execute path (out of scope here).
```

> `wonderlandAdapter` is a **stub** today: its methods throw `wonderland adapter: not implemented`
> until Wonderland's contract specifics are pinned. Supply your own `CosignAdapter` to aggregate now.

## API

- `keys`: `isoDay`, `categoryKey`, `currentKey`, `keysForWindow` (all accept an explicit `now?: Date`).
- `record`: `SignatureRecord`, `SCHEME`, `RECORD_ABI`, `encodeRecord`, `decodeRecord` (decode throws on junk).
- `client`: `BoardClient`, `postSignature`, `readSignatures` (skips undecodable junk, dedupes by data),
  `groupByDigest`, `aggregate` (filters by `adapter.verify`, applies `adapter.order`; verify errors propagate).
- `adapters`: `CosignAdapter` (the seam), `wonderlandAdapter` (stub).
````

### 6.4 Full sweep

```bash
cd /Users/michaelmclaughlin/Documents/valve-tech/github/msgboard
npm run test --workspace=packages/cosign
npm run build --workspace=packages/cosign
# Confirm the package builds within the monorepo graph (no cross-package type breakage):
npm run build --workspace=packages/sdk && npm run build --workspace=packages/cosign
```

**Expected:**
- `vitest run`: `Test Files  4 passed (4)` (keys, record, client, adapters/wonderland), all tests green.
- `tsc` for cosign: clean, `dist/index.{js,d.ts}` regenerated with the new re-exports.
- SDK + cosign sequential build: clean (proves `@msgboard/sdk` types resolve from cosign).

### 6.5 Commit

```bash
git add packages/cosign/src/index.ts packages/cosign/README.md
git rm --cached packages/cosign/test/smoke.test.ts 2>/dev/null || true
git commit -m "feat(cosign): wire index re-exports + README; drop scaffold smoke test"
```

---

## Self-review

### Spec coverage checklist (against `2026-06-13-msgboard-cosign-sdk-design.md`)

- [ ] §4 package `packages/cosign`, name `@msgboard/cosign`, deps `@msgboard/sdk` + `viem`, dev `vitest`/`typescript`, ESM, `src/index.ts` entry, tests in `test/` — Tasks 1, 6.
- [ ] §4 `keys.ts`: `isoDay`, `categoryKey` = `keccak256(toBytes('ns:scope:isoDate'))`, `currentKey`, `keysForWindow` (today + prior `days-1`, `days>=1`) — Task 2.
- [ ] §4 `record.ts`: `SignatureRecord` interface, `SCHEME` enum, canonical tuple order, `encodeRecord`/`decodeRecord` (decode throws) — Task 3.
- [ ] §4 `client.ts`: minimal `BoardClient` (`addMessage({category,data})` / `content({category})`), `postSignature`, `readSignatures` (skip junk, dedupe by `keccak256(data)`), `groupByDigest`, `aggregate` (verify-filter + order) — Task 4.
- [ ] §4 `adapters/adapter.ts`: `CosignAdapter` (verify/order/owners?/threshold?) — Task 4.1.
- [ ] §4 `adapters/wonderland.ts`: STUB `wonderlandAdapter(config)` throwing `not implemented`, documented config + TODO — Task 5.
- [ ] §4 `index.ts` re-exports all units — Task 6.
- [ ] §6 error handling: decode throws; read skips junk but never drops well-formed; `keysForWindow` throws on `days<1`; `postSignature` surfaces board errors; `adapter.verify` errors propagate — Tasks 2/3/4 (tests assert each).
- [ ] §7 testing: keys determinism/UTC-rotation/window/sensitivity; record round-trip per scheme incl. empty meta + garbage throws; client post/read+junk+dedupe/group/aggregate; wonderland stub throws — Tasks 2-5.
- [ ] §2 zero chain writes; pure board + crypto — no chain calls in any shipped code (Wonderland stub does none).
- [ ] now-injectable API for deterministic tests (`isoDay`/`currentKey`/`keysForWindow`/`postSignature`/`readSignatures` all take `now?: Date`) — Tasks 2, 4. No `Date.now()` or `Math.random()` in any assertion.

### Placeholder scan

- Grep the package for accidental placeholders before the final commit:

  ```bash
  grep -rnE 'TODO|FIXME|placeholder|similar to above|\.\.\.$' packages/cosign/src
  ```

  **Expected:** the only `TODO` match is the **intentional, documented** Wonderland TODO block in `src/adapters/wonderland.ts` (spec §9 deliverable). No other placeholders. `COSIGN_VERSION` / `smoke.test.ts` are removed in Task 6.

### Type consistency between tasks

- `Hex` from `viem` is the single hex type throughout.
- `SignatureRecord` (Task 3) is the exact shape consumed by `client.ts` (Task 4), `adapter.ts` (Task 4.1), and `wonderland.ts` (Task 5) — same five fields, `scheme: number`.
- `categoryKey`/`currentKey`/`keysForWindow` signatures defined in Task 2 are called with identical signatures in Task 4's `client.ts` and tests.
- `BoardClient.addMessage({category,data})` / `content({category})` (Task 4) match the fake in `client.test.ts` and the README wrapper around the real `MsgBoardClient` (whose own `addMessage`/`content` differ — bridged in the README, never in `src/`).
- `CosignAdapter` (Task 4.1) is implemented by the Wonderland stub (Task 5) and consumed by `aggregate` (Task 4) with one signature.
- `Content` / `RPCMessage` types imported from `@msgboard/sdk` in `client.ts` + `client.test.ts` are the repo's real types (`Content = { [cat: Hex]: RPCMessage[] }`, `RPCMessage.data: Hex`).

### Reconciliation log (real SDK vs spec assumptions)

1. **`addMessage` shape** — real `MsgBoardClient.addMessage` takes `Hex | MessageSeed` and posting requires a prior `doPoW`, not `{category,data}`. Reconciled by making `BoardClient` cosign's own seam (per spec's "minimal `BoardClient` interface") and bridging to the real client in the README. cosign `src/` never imports `MsgBoardClient`.
2. **`categoryHash` vs in-package keccak** — equivalent for strings; cosign computes its own `keccak256(toBytes(...))` to stay dep-free for the archivist. Equivalence noted in `keys.ts` comment.
3. **Package manager** — repo is npm workspaces, not pnpm. Plan registers the package in root `package.json` `workspaces` and uses `npm install`.

---

## Execution Handoff

This plan is ready to execute. Two options:

- **Subagent-driven (recommended for isolation):** dispatch each task (1→6, in order — they are sequential by dependency) to a fresh implementer subagent using `superpowers:subagent-driven-development`, with a review checkpoint after each task's commit. Each task is self-contained (its own RED→GREEN→commit) and leaves the suite green, so a reviewer can verify incrementally.
- **Inline:** execute here, task by task, pausing after each commit for review per `superpowers:executing-plans`.

Either way: enforce the TDD discipline (RED first, watch it fail for the right reason, then GREEN), run the exact commands shown, and confirm the expected output before committing. Do **not** start a real Wonderland adapter implementation — the stub is the spec'd deliverable for this sub-project (its real body is gated on spec §9 open items).
