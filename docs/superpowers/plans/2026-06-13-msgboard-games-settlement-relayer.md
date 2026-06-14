# msgboard-games Plan 3: Async Settlement Relayer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the **async, untrusted, anyone-can-run settlement worker** of the games design (§7) as a composition over `@msgboard/relayer`. OFF the play critical path it (a) detects settle-ready sessions and lands their settlement by building calldata via the Plan 2 `OptimisticSettlement`/`EscrowedSettlement.buildSettle(transcriptJson)` builders and submitting it (viem simulate → writeContract), (b) **replace-by-fee + nonce window** — bumps underpriced/stuck settle txs and pipelines multiple settlements per a bounded nonce window so they don't head-of-line block (this is the relayer spec's deferred §13 repricing feature, added here as a *generic engine primitive*), (c) **nudges, never gates** — surfaces "sign the next state / top up gas" reminders to the UI without ever forging or withholding, and (d) settles **parallel sessions** independently. Its only power is *when* settlement lands, never *whether* or *what* — every test asserts that.

**Architecture:** Plan 3 of `2026-06-13-msgboard-games-design.md` (§13 plan 3; implements §7, bound by §10 error-handling + §12 testing). The work splits across **both repos**, by the split-of-concern rule of spec §9 ("broadcast + async settlement relayer → msgboard `packages/relayer`"):

- **Generic repricing / nonce-window primitive → msgboard `packages/relayer`.** This is exactly the "nonce-window / repricing `Action` wrapper for high-throughput live relayers" the relayer spec deferred to its §13 — it is game-agnostic (it knows nothing about games, settlement, or transcripts; it only knows viem txs, nonces, and fees), so it belongs to the engine, where any relayer composition can reuse it. It ships as a new `RelayerAction` *wrapper* (`repricingAction`) plus a small `PendingTxTracker` store, added to `@msgboard/relayer`'s public surface and published in the next `@msgboard/*` version bump.
- **Games settlement worker composition → random repo `examples/games/msgboard-settle-relayer` (`@gibs/msgboard-settle-relayer`).** The worker is a *composition* that wires three things the engine cannot know about: the games `Settlement` builders (`@gibs/msgboard-settle`, Plan 2), the retained `Transcript`/`SessionState` types (`@gibs/msgboard-games`, Plan 1), and the published engine (`@msgboard/relayer`). It defines a `settleReadySource` (a `RelayerSource` yielding settle-ready sessions), a `settleAction` (a `RelayerAction` that calls `buildSettle` then submits via viem, wrapped by the engine's `repricingAction`), and a `nudge` emitter. It cannot live in `packages/relayer` because that package must not depend on the games packages (it is a generic, published engine); and it consumes published `@msgboard/relayer` exactly as `@gibs/msgboard-games` already consumes published `@msgboard/sdk ^0.0.31` (confirmed: `examples/games/msgboard-games/package.json` and `examples/games/e2e/package.json` both depend on `@msgboard/sdk: ^0.0.31`). So the composition lives beside the rest of the games off-chain code (spec §9: "Off-chain session engine … → `examples/games`"), and depends on `@msgboard/relayer: ^0.0.31` (workspace consumes the published version, same mechanism).

Why the split and not "all in the worker": the repricing/nonce-window logic is reusable by *any* live relayer (the cross-chain mirror, a sponsor, a future settler), is the literal item the relayer spec promised, and contains zero games knowledge. Keeping it in the engine avoids every future relayer re-implementing fee bumping, and keeps the engine's safety story (observe-by-default, action-level dedup) intact. The worker is the thin, games-aware glue. (If the engine version bump is not yet published when Plan 3 starts, Task 1 documents the fallback: a local path/file dep or a temporary copy of the primitive in the worker, flagged for removal once `@msgboard/relayer` republishes — see Task 1.)

**Tech Stack:**
- msgboard repo (`packages/relayer`): TypeScript (ESM, `"type": "module"`, `module`/`moduleResolution` `NodeNext`, so **relative imports carry the `.js` extension**), viem ^2.25 (wallet/public client, `sendTransaction`, `replacementTransactionUnderpriced` handling, `getTransactionCount`, EIP-1559 fees), **vitest ^3.1** (the relayer package pins vitest 3; tests live in `test/**/*.test.ts`, import from `../src/...`). TS ^5.8.
- random repo (`examples/games/msgboard-settle-relayer`): TypeScript (ESM, `"type": "module"`), viem ^2.25, **vitest ^2.1** (matches the surrounding `examples/games/*` packages — confirmed `@gibs/msgboard-settle` and `@gibs/msgboard-games` both pin `vitest: ^2.1.0`; tests in `test/`, import from `../src/...`). Deps: `@msgboard/relayer ^0.0.31`, `@gibs/msgboard-settle workspace:*`, `@gibs/msgboard-games workspace:*`, `viem ^2.25`. TS ~5.8.

**Where the code lives / git:**
- **Engine primitive** → msgboard repo (`~/Documents/valve-tech/github/msgboard`), `packages/relayer/src/actions/repricing.ts` + `packages/relayer/src/stores/pending-tx.ts`, exported from `packages/relayer/src/index.ts`; tests in `packages/relayer/test/`. npm workspaces (not pnpm) — run `npm test -w @msgboard/relayer` or `cd packages/relayer && npm test`. Branch: this repo's working branch (`master`). Commits are made by the controller — **do NOT git add or git commit in this plan's execution unless the controller's workflow says to**; each task below lists a commit message for the controller to use.
- **Worker composition** → random repo (`~/Documents/gibs-finance/random`), `examples/games/msgboard-settle-relayer/`. pnpm workspace; run `cd examples/games/msgboard-settle-relayer && pnpm test` / `pnpm typecheck`. After creating the package, run `pnpm install` from the random repo root once to link it. Branch `games-platform`. Commits unsigned, NO Co-Authored-By trailers. Push (only when asked) with `git push ssh://git@ssh.github.com:443/gibsfinance/random.git games-platform`; on rejection `git fetch && git rebase origin/games-platform`.
- `progress.txt` in the msgboard repo is the shared cross-repo worklog.

**Conventions that bite:**
- **Two repos, two test runners, two module styles.** `packages/relayer` is **vitest 3 + NodeNext** → relative imports MUST end in `.js` (e.g. `import { x } from '../types.js'`), mirror the existing `src/actions/*.ts`. `examples/games/msgboard-settle-relayer` is **vitest 2 + bundler-style** (the games packages omit extensions on relative imports — copy `msgboard-settle/tsconfig.json`). Do not cross the styles.
- **Safety is the product.** The engine is observe-by-default (`mode: 'observe'` performs no outbound effect — `actOnItem` only `describe`s). Every new action keeps that contract: `describe()` is pure, `execute()` is the only side effect. The worker NEVER constructs a `SessionState`, never signs, never mutates a transcript — it only reads a transcript it was given and calls `buildSettle`, which itself re-verifies every signature and throws on tamper (`replaySession` throws on any chain/sig/outcome mismatch). The safety tests (Task 9) assert these by construction.
- **viem simulate → write.** Submitting the settle tx uses the `@gibs/games-core operator.ts` pattern Plan 2 documents: `publicClient.simulateContract({ address, abi, functionName, args, account })` → `walletClient.writeContract(request)`. The `TxRequest` from `buildSettle` is `{ address, abi, functionName, args }` — exactly `simulateContract`'s shape minus `account`.
- **Nonce window ≠ dedup store.** The engine already has an action-level dedup `store` (`has`/`remember`, keyed by `config.key(item)`). The new `PendingTxTracker` is a *separate* concern: it tracks in-flight txs *by nonce* for fee bumping, independent of dedup. Do not overload the dedup store for it.
- **No real chain in unit tests.** Every Task tests against **fakes** (fake `PublicClient`/`WalletClient`, fake `Settlement`, in-memory transcripts) and drives the engine via `relayer.runOnce()` — the exact pattern in `packages/relayer/test/relayer.test.ts` (`source.poll` returns a fixed array; `action.execute` is a `vi.fn`). No anvil, no RPC.

## Numeric codes / shapes pinned by upstream plans (do not redefine)

These are consumed, not defined, by Plan 3 — they are fixed by Plans 1–2 and the `@msgboard/relayer` engine:

- **`TxRequest`** (`@gibs/msgboard-settle`): `{ address: Hex; abi: unknown; functionName: string; args: readonly unknown[] }`.
- **`Settlement.buildSettle(transcriptJson: string): Promise<TxRequest>`** — `OptimisticSettlement` builds a `HouseBankroll.settle(open, final, openSigP, openSigH, finalSigP, finalSigH)` call; `EscrowedSettlement` builds a `HouseChannel.settle(final, finalSigP, finalSigH)` call (and exposes `buildDispute`/`buildOpen`). Both call `replaySession`, which **throws** unless the transcript's chain links, every EIP-712 co-signature, the server-seed reveal chain, and every recomputed outcome verify. The worker treats a throw as "not settle-ready / refuse to submit" — it never papers over it.
- **`Transcript`** (`@gibs/msgboard-games`): `toJSON()`/`fromJSON()`; `entries` are `Envelope{tableId, seq, prev, kind, body, from, sig}`; `kind` is `'OPEN'`/`'ROUND'`. Settle-readiness is read from the transcript shape (≥1 `ROUND` after the `OPEN`).
- **Engine seams** (`@msgboard/relayer`, all from `types.ts`): `RelayerSource<T>{poll(ctx)}`, `RelayerAction<T>{describe(item,ctx), execute(item,ctx):Promise<ActionResult>}`, `RelayerStore<T>{has,remember,prune?}`, `RelayerSink<T>{record,prune?}`, `RelayerCondition<T>`, `RelayerConfig<T>`, `RelayerContext{node,mode,chain,publicClient,client,logger}`, `ActionResult{ok,ref?,meta?}`, `TickReport`. `Relayer.runOnce()` returns a `TickReport`. `mode:'observe'` (default) never executes.

---

## File structure

### msgboard repo — `packages/relayer/` (generic engine primitive)

```
packages/relayer/
  src/
    stores/
      pending-tx.ts        NEW  PendingTxTracker: per-nonce in-flight tx state for fee bumping
    actions/
      repricing.ts         NEW  repricingAction<T>: wraps a submit fn with nonce-window + replace-by-fee
    index.ts               MODIFY: export repricingAction, PendingTxTracker, their types
  test/
    stores/
      pending-tx.test.ts   NEW  tracker: claim nonce, mark mined, detect stale, bump fee math
    actions/
      repricing.test.ts    NEW  wrapper: first submit, RBF bump on staleness, nonce window pipelines two
```

### random repo — `examples/games/msgboard-settle-relayer/` (games worker composition)

```
examples/games/msgboard-settle-relayer/
  package.json             @gibs/msgboard-settle-relayer; deps @msgboard/relayer ^0.0.31,
                           @gibs/msgboard-settle workspace:*, @gibs/msgboard-games workspace:*, viem ^2.25
  tsconfig.json            copy of ../msgboard-settle/tsconfig.json
  src/
    index.ts               public surface (re-exports)
    types.ts               SettleReadySession, SettleJob, Nudge, WorkerConfig
    settleReadySource.ts   RelayerSource<SettleJob>: turns retained sessions into settle jobs
    settleAction.ts        RelayerAction<SettleJob>: buildSettle -> simulate -> write (RBF-wrapped)
    nudges.ts              nudge detection (stalled signature / low gas) -> Nudge[] for the UI
    worker.ts              makeSettlementRelayer(cfg): assembles a Relayer<SettleJob>
  test/
    settleReadySource.test.ts   yields only settle-ready sessions; parallel sessions independent
    settleAction.test.ts        builds correct settle calldata + submits (simulate->write) against fakes
    nudges.test.ts              nudge fires on a stalled signature / low gas; never forges/withholds
    safety.test.ts              observe-by-default; refuses tampered transcript; only power is WHEN
    worker.test.ts              runOnce end-to-end against fakes: lands a session; pipelines two; bumps a stuck tx
  README.md                what it is, why untrusted, how to run your own
```

---

### Task 1: Add the games-worker package skeleton + confirm the `@msgboard/relayer` dependency path

**This task makes the cross-repo dependency real and is the gate for everything in the random repo.** It creates the `@gibs/msgboard-settle-relayer` package and pins how it consumes the engine.

First confirm the published engine version the random repo can depend on:

```bash
cd ~/Documents/valve-tech/github/msgboard/packages/relayer && node -e "console.log(require('./package.json').version)"
# expected: 0.0.31  (the current published @msgboard/relayer; same line as @msgboard/sdk ^0.0.31 the games pkgs already use)
npm view @msgboard/relayer version 2>/dev/null || echo "(offline: assume published 0.0.31; matches the @msgboard/sdk dep the games repo already resolves)"
```

Create `examples/games/msgboard-settle-relayer/package.json`:

```json
{
  "name": "@gibs/msgboard-settle-relayer",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@gibs/msgboard-games": "workspace:*",
    "@gibs/msgboard-settle": "workspace:*",
    "@msgboard/relayer": "^0.0.31",
    "viem": "^2.25.0"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "typescript": "~5.8.3",
    "vitest": "^2.1.0"
  }
}
```

> **Fallback if `@msgboard/relayer ^0.0.31` does not yet export `repricingAction`** (because the engine bump in Tasks 2–3 hasn't been published when you run the random repo): the worker still imports the engine's `Relayer`, `RelayerAction`, etc. from the published `^0.0.31` (those exist today). For `repricingAction`/`PendingTxTracker`, until the engine republishes, add a thin local re-implementation in `src/repricing-local.ts` flagged `// TODO(plan3): delete once @msgboard/relayer republishes with repricingAction` and import from there; the worker's public API (`makeSettlementRelayer`) is identical either way. Tasks 2–3 build the canonical version in the engine; this fallback only unblocks the random repo if versions lag. Note this choice in `progress.txt`.

Copy `tsconfig.json` from `../msgboard-settle/tsconfig.json` verbatim.

Create `examples/games/msgboard-settle-relayer/src/index.ts` as a placeholder:

```ts
export const PACKAGE = '@gibs/msgboard-settle-relayer'
```

Link the workspace:

```bash
cd ~/Documents/gibs-finance/random && pnpm install
```

**Verify:**

```bash
cd ~/Documents/gibs-finance/random/examples/games/msgboard-settle-relayer && pnpm typecheck
```

Expected output: no errors (exit 0). `pnpm install` prints the new package in the workspace link summary.

**Commit (controller):** `feat(msgboard-settle-relayer): scaffold @gibs/msgboard-settle-relayer package (plan 3 task 1)`

---

### Task 2: Engine — `PendingTxTracker` store (per-nonce in-flight state)

**Repo: msgboard `packages/relayer`.** TDD: write the test first.

Create `packages/relayer/test/stores/pending-tx.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { createPendingTxTracker } from '../../src/stores/pending-tx.js'

describe('PendingTxTracker', () => {
  it('claims sequential nonces within a bounded window and refuses past it', () => {
    const t = createPendingTxTracker({ windowSize: 2, baseNonce: 10 })
    expect(t.claim()).toBe(10)
    expect(t.claim()).toBe(11)
    // window full (2 in flight): no nonce until one frees
    expect(t.claim()).toBeUndefined()
  })

  it('frees a nonce when its tx mines, opening the window', () => {
    const t = createPendingTxTracker({ windowSize: 1, baseNonce: 0 })
    const n = t.claim()!
    expect(n).toBe(0)
    expect(t.claim()).toBeUndefined()
    t.markMined(n)
    expect(t.claim()).toBe(1) // window advanced
  })

  it('records the submitted hash + fee + time and reports staleness past the threshold', () => {
    let now = 1_000
    const t = createPendingTxTracker({ windowSize: 4, baseNonce: 0, now: () => now })
    const n = t.claim()!
    t.recordSubmission(n, { hash: '0xaaa', maxFeePerGas: 100n, maxPriorityFeePerGas: 2n })
    expect(t.isStale(n, 5_000)).toBe(false) // 0ms elapsed
    now = 1_000 + 6_000
    expect(t.isStale(n, 5_000)).toBe(true) // 6s elapsed > 5s threshold
  })

  it('computes a replace-by-fee bump that clears the +12.5% RBF floor', () => {
    const t = createPendingTxTracker({ windowSize: 4, baseNonce: 0 })
    const n = t.claim()!
    t.recordSubmission(n, { hash: '0xaaa', maxFeePerGas: 100n, maxPriorityFeePerGas: 10n })
    const bumped = t.bumpFees(n)
    // strictly greater than +12.5% on BOTH fields (viem/geth reject < 10%; we use 12.5% for margin)
    expect(bumped.maxFeePerGas).toBeGreaterThanOrEqual(113n) // ceil(100 * 1.125)
    expect(bumped.maxPriorityFeePerGas).toBeGreaterThanOrEqual(12n) // ceil(10 * 1.125)
  })

  it('keeps independent per-nonce fee state (parallel pipelined txs do not collide)', () => {
    const t = createPendingTxTracker({ windowSize: 4, baseNonce: 0 })
    const a = t.claim()!
    const b = t.claim()!
    t.recordSubmission(a, { hash: '0xa', maxFeePerGas: 100n, maxPriorityFeePerGas: 5n })
    t.recordSubmission(b, { hash: '0xb', maxFeePerGas: 200n, maxPriorityFeePerGas: 9n })
    expect(t.bumpFees(a).maxFeePerGas).toBeLessThan(t.bumpFees(b).maxFeePerGas)
  })
})
```

Run it (red):

```bash
cd ~/Documents/valve-tech/github/msgboard/packages/relayer && npx vitest run test/stores/pending-tx.test.ts
```

Expected: fails to resolve `../../src/stores/pending-tx.js` (module not found).

Create `packages/relayer/src/stores/pending-tx.ts`:

```ts
/** Fee fields for an EIP-1559 settle tx, in wei. */
export type TxFees = {
  maxFeePerGas: bigint
  maxPriorityFeePerGas: bigint
}

/** What we retain about one in-flight tx, keyed by its nonce. */
export type PendingTx = {
  nonce: number
  hash: string
  fees: TxFees
  submittedAt: number
}

export type PendingTxTrackerOptions = {
  /** Max number of nonces in flight at once (the pipeline depth). */
  windowSize: number
  /** First nonce this worker owns (from `getTransactionCount(account, 'pending')`). */
  baseNonce: number
  /** Injectable clock for tests. Defaults to Date.now. */
  now?: () => number
  /** RBF bump numerator/denominator. Defaults to 1125/1000 (+12.5%, above geth's 10% floor). */
  bumpNum?: bigint
  bumpDen?: bigint
}

/**
 * Tracks settle txs by nonce so multiple settlements pipeline (a bounded window)
 * and stuck ones can be replaced-by-fee. Knows nothing about games or settlement —
 * a generic engine primitive (the relayer spec §13 deferred item). Process-local.
 */
export type PendingTxTracker = {
  /** Reserve the next nonce, or undefined if the window is full. */
  claim(): number | undefined
  /** Record the tx hash + fees we submitted for a claimed nonce. */
  recordSubmission(nonce: number, tx: { hash: string } & TxFees): void
  /** True if the tx for `nonce` was submitted longer than `staleMs` ago and is still pending. */
  isStale(nonce: number, staleMs: number): boolean
  /** Compute strictly-higher fees for a replace-by-fee resubmission of `nonce`. */
  bumpFees(nonce: number): TxFees
  /** Mark a nonce's tx mined; frees the slot and advances the window. */
  markMined(nonce: number): void
  /** Current pending entries, for observability. */
  pending(): readonly PendingTx[]
}

const ceilMul = (v: bigint, num: bigint, den: bigint): bigint => (v * num + den - 1n) / den

export const createPendingTxTracker = (opts: PendingTxTrackerOptions): PendingTxTracker => {
  const now = opts.now ?? (() => Date.now())
  const bumpNum = opts.bumpNum ?? 1125n
  const bumpDen = opts.bumpDen ?? 1000n
  const inFlight = new Map<number, PendingTx | null>() // null = claimed, not yet submitted
  let nextNonce = opts.baseNonce

  const liveCount = (): number => inFlight.size

  return {
    claim: () => {
      if (liveCount() >= opts.windowSize) return undefined
      const nonce = nextNonce
      nextNonce += 1
      inFlight.set(nonce, null)
      return nonce
    },
    recordSubmission: (nonce, tx) => {
      inFlight.set(nonce, {
        nonce,
        hash: tx.hash,
        fees: { maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas },
        submittedAt: now(),
      })
    },
    isStale: (nonce, staleMs) => {
      const e = inFlight.get(nonce)
      if (!e) return false
      return now() - e.submittedAt > staleMs
    },
    bumpFees: (nonce) => {
      const e = inFlight.get(nonce)
      if (!e) throw new Error(`pending-tx: no submission recorded for nonce ${nonce}`)
      return {
        maxFeePerGas: ceilMul(e.fees.maxFeePerGas, bumpNum, bumpDen),
        maxPriorityFeePerGas: ceilMul(e.fees.maxPriorityFeePerGas, bumpNum, bumpDen),
      }
    },
    markMined: (nonce) => {
      inFlight.delete(nonce)
    },
    pending: () => [...inFlight.values()].filter((e): e is PendingTx => e !== null),
  }
}
```

Run it (green):

```bash
cd ~/Documents/valve-tech/github/msgboard/packages/relayer && npx vitest run test/stores/pending-tx.test.ts
```

Expected: `Test Files  1 passed`, `Tests  5 passed`.

**Commit (controller):** `feat(relayer): PendingTxTracker — per-nonce in-flight state for RBF + nonce window (plan 3 task 2)`

---

### Task 3: Engine — `repricingAction` wrapper (nonce window + replace-by-fee)

**Repo: msgboard `packages/relayer`.** A `RelayerAction<T>` wrapper: it owns nonce assignment and fee bumping, delegating the actual "build + send one tx at this nonce/fee" to a caller-supplied `submit` function. Generic — it never imports games code.

Write the test first. Create `packages/relayer/test/actions/repricing.test.ts`:

```ts
import { http } from 'viem'
import { pulsechainV4 } from 'viem/chains'
import { describe, expect, it, vi } from 'vitest'
import { Relayer } from '../../src/relayer.js'
import { repricingAction } from '../../src/actions/repricing.js'
import { createPendingTxTracker } from '../../src/stores/pending-tx.js'
import type { RelayerConfig } from '../../src/types.js'

type Job = { id: string }

const ctxNode = { transport: http('http://localhost:8545'), chain: pulsechainV4 }

const baseConfig = (over: Partial<RelayerConfig<Job>>): RelayerConfig<Job> => ({
  node: ctxNode,
  source: { poll: async () => [{ id: 'a' }] },
  action: { describe: () => 'x', execute: async () => ({ ok: true }) },
  key: (j) => j.id,
  logger: () => {},
  ...over,
})

describe('repricingAction', () => {
  it('describe is pure and never submits (observe-mode safe)', async () => {
    const submit = vi.fn()
    const action = repricingAction<Job>({
      tracker: createPendingTxTracker({ windowSize: 4, baseNonce: 0 }),
      describe: (j) => `settle ${j.id}`,
      submit,
      initialFees: async () => ({ maxFeePerGas: 100n, maxPriorityFeePerGas: 2n }),
      staleMs: 5_000,
    })
    expect(action.describe({ id: 'a' }, {} as never)).toBe('settle a')
    expect(submit).not.toHaveBeenCalled()
  })

  it('first execute claims a nonce and submits once at the initial fee', async () => {
    const submit = vi.fn(async () => ({ hash: '0xfeed' }))
    const tracker = createPendingTxTracker({ windowSize: 4, baseNonce: 7 })
    const action = repricingAction<Job>({
      tracker,
      describe: () => 'x',
      submit,
      initialFees: async () => ({ maxFeePerGas: 100n, maxPriorityFeePerGas: 2n }),
      staleMs: 5_000,
    })
    const relayer = new Relayer(baseConfig({ mode: 'live', action }))
    const report = await relayer.runOnce()
    expect(report.executed).toBe(1)
    expect(submit).toHaveBeenCalledTimes(1)
    expect(submit.mock.calls[0][0]).toMatchObject({ nonce: 7, fees: { maxFeePerGas: 100n } })
  })

  it('replace-by-fee: a stale pending nonce is resubmitted at a higher fee', async () => {
    let now = 0
    const submit = vi.fn(async () => ({ hash: '0x1' }))
    const tracker = createPendingTxTracker({ windowSize: 4, baseNonce: 0, now: () => now })
    const action = repricingAction<Job>({
      tracker, describe: () => 'x', submit,
      initialFees: async () => ({ maxFeePerGas: 100n, maxPriorityFeePerGas: 10n }),
      staleMs: 5_000, now: () => now,
    })
    const relayer = new Relayer(baseConfig({
      mode: 'live', action,
      // same job id twice => same logical settlement; dedup off so we can re-tick it
      source: { poll: async () => [{ id: 'a' }] },
    }))
    await relayer.runOnce()                 // first submit @100
    now = 6_000                             // make it stale
    await relayer.runOnce()                 // should RBF the SAME nonce, higher fee
    expect(submit).toHaveBeenCalledTimes(2)
    const first = submit.mock.calls[0][0]
    const second = submit.mock.calls[1][0]
    expect(second.nonce).toBe(first.nonce)  // same nonce — a replacement, not a new tx
    expect(second.fees.maxFeePerGas).toBeGreaterThan(first.fees.maxFeePerGas)
  })

  it('nonce window pipelines two distinct settlements at consecutive nonces', async () => {
    const submit = vi.fn(async (req: { nonce: number }) => ({ hash: `0x${req.nonce}` }))
    const tracker = createPendingTxTracker({ windowSize: 4, baseNonce: 0 })
    const action = repricingAction<{ id: string }>({
      tracker, describe: () => 'x', submit,
      initialFees: async () => ({ maxFeePerGas: 100n, maxPriorityFeePerGas: 2n }),
      staleMs: 999_999,
    })
    const relayer = new Relayer(baseConfig({
      mode: 'live', action,
      source: { poll: async () => [{ id: 'a' }, { id: 'b' }] },
    }))
    const report = await relayer.runOnce()
    expect(report.executed).toBe(2)
    const nonces = submit.mock.calls.map((c) => c[0].nonce).sort()
    expect(nonces).toEqual([0, 1]) // pipelined, not head-of-line blocked
  })

  it('window full: a new settlement is deferred (ActionResult ok:false, reason queued) not dropped', async () => {
    const submit = vi.fn(async () => ({ hash: '0x1' }))
    const tracker = createPendingTxTracker({ windowSize: 1, baseNonce: 0 })
    const action = repricingAction<{ id: string }>({
      tracker, describe: () => 'x', submit,
      initialFees: async () => ({ maxFeePerGas: 100n, maxPriorityFeePerGas: 2n }),
      staleMs: 999_999,
    })
    const relayer = new Relayer(baseConfig({
      mode: 'live', action,
      source: { poll: async () => [{ id: 'a' }, { id: 'b' }] },
    }))
    await relayer.runOnce()
    expect(submit).toHaveBeenCalledTimes(1) // only one fits the window
  })
})
```

Run it (red): `npx vitest run test/actions/repricing.test.ts` — fails (module not found).

Create `packages/relayer/src/actions/repricing.ts`:

```ts
import type { RelayerAction, RelayerContext } from '../types.js'
import type { PendingTxTracker, TxFees } from '../stores/pending-tx.js'

/** What the caller's submit fn is handed: the nonce + fees to use, the item, and the runtime ctx. */
export type SubmitRequest<T> = {
  item: T
  nonce: number
  fees: TxFees
  context: RelayerContext
  /** True when this is a replace-by-fee resubmission of an already-pending nonce. */
  replacement: boolean
}

export type RepricingActionOptions<T> = {
  /** Tracks in-flight txs by nonce (window + RBF state). */
  tracker: PendingTxTracker
  /** Pure description for observe-mode logging. */
  describe: (item: T, context: RelayerContext) => string
  /** Build + send ONE tx at the given nonce/fees. Returns the tx hash. */
  submit: (req: SubmitRequest<T>) => Promise<{ hash: string }>
  /** Initial EIP-1559 fees for a fresh settlement (e.g. read from the chain). */
  initialFees: (item: T, context: RelayerContext) => Promise<TxFees>
  /** A pending tx older than this is replaced-by-fee. */
  staleMs: number
  /** Stable per-item key so a re-tick of the same settlement reuses its nonce. Defaults to JSON. */
  itemKey?: (item: T) => string
  /** Injectable clock (tests). */
  now?: () => number
}

/**
 * Wraps a single-tx submit fn with a nonce window (pipeline multiple settlements)
 * and replace-by-fee (bump a stuck tx). Generic — the relayer spec §13 deferred
 * "nonce-window / repricing Action wrapper". Knows nothing about games.
 *
 * Safety: `describe` is pure (observe mode never submits). A submitted nonce is
 * remembered; a re-tick of the same item before it mines RBFs the SAME nonce
 * (never a second tx, never a forged state — it only re-sends the same calldata
 * at a higher fee). When the window is full a new item is a no-op this tick.
 */
export const repricingAction = <T>(options: RepricingActionOptions<T>): RelayerAction<T> => {
  const key = options.itemKey ?? ((item: T) => JSON.stringify(item))
  // item-key -> the nonce we assigned it, so a re-tick reuses it for RBF
  const nonceOf = new Map<string, number>()

  return {
    describe: (item, context) => options.describe(item, context),
    execute: async (item, context) => {
      const k = key(item)
      const existing = nonceOf.get(k)

      // Already in flight: replace-by-fee iff stale, else leave it.
      if (existing !== undefined) {
        if (!options.tracker.isStale(existing, options.staleMs)) {
          return { ok: true, ref: `nonce:${existing}`, meta: { skipped: 'still-pending' } }
        }
        const fees = options.tracker.bumpFees(existing)
        const { hash } = await options.submit({ item, nonce: existing, fees, context, replacement: true })
        options.tracker.recordSubmission(existing, { hash, ...fees })
        return { ok: true, ref: hash, meta: { replacement: true, nonce: existing } }
      }

      // New settlement: claim a nonce from the window.
      const nonce = options.tracker.claim()
      if (nonce === undefined) {
        return { ok: false, meta: { deferred: 'nonce-window-full' } }
      }
      const fees = await options.initialFees(item, context)
      const { hash } = await options.submit({ item, nonce, fees, context, replacement: false })
      nonceOf.set(k, nonce)
      options.tracker.recordSubmission(nonce, { hash, ...fees })
      return { ok: true, ref: hash, meta: { nonce } }
    },
  }
}
```

Run it (green): `npx vitest run test/actions/repricing.test.ts` — expect `Tests  6 passed`.

Then add exports to `packages/relayer/src/index.ts` (after the existing `submitMessageAction`/store exports):

```ts
export { repricingAction } from './actions/repricing.js'
export type { RepricingActionOptions, SubmitRequest } from './actions/repricing.js'
export { createPendingTxTracker } from './stores/pending-tx.js'
export type { PendingTxTracker, PendingTx, PendingTxTrackerOptions, TxFees } from './stores/pending-tx.js'
```

**Verify the whole engine package still builds + passes:**

```bash
cd ~/Documents/valve-tech/github/msgboard/packages/relayer && npm test && npm run build
```

Expected: all existing + new test files pass; `tsc` build emits `dist/` with no errors.

**Commit (controller):** `feat(relayer): repricingAction wrapper — nonce window + replace-by-fee (relayer spec §13; plan 3 task 3)`

---

### Task 4: Worker — shared types

**Repo: random `examples/games/msgboard-settle-relayer`.** No new logic; pin the data shapes the source/action/nudges share. (Bundler module style — no `.js` on relative imports.)

Create `src/types.ts`:

```ts
import type { Hex } from 'viem'
import type { Settlement } from '@gibs/msgboard-settle'

/**
 * A session the worker has been GIVEN or watches: the retained transcript JSON plus
 * the metadata needed to settle it. The worker never owns the play state — a party
 * (or the house) hands it the transcript it already holds (spec §2 retention rule).
 */
export interface SettleReadySession {
  /** bytes32 table/session id. */
  tableId: Hex
  /** Retained transcript JSON (Transcript.toJSON()). */
  transcriptJson: string
  /** The backend that builds this session's settle calldata (optimistic or escrowed). */
  settlement: Settlement
  /** Why this is settle-ready: cooperative final, batch threshold, or player closing out. */
  trigger: 'cooperative-final' | 'batch-threshold' | 'player-closeout'
  /** Wall-clock ms when the latest co-signed state was observed (for nudge staleness). */
  observedAt: number
  /** Optional: the player address awaiting a signature/gas, for nudges. */
  player?: Hex
}

/** One settlement job flowing through the relayer pipeline. Carries the built calldata lazily. */
export interface SettleJob {
  session: SettleReadySession
}

/** A reminder surfaced to the UI. The worker NEVER acts on these — it only emits them. */
export interface Nudge {
  tableId: Hex
  kind: 'sign-next-state' | 'top-up-gas'
  /** Who the nudge is for. */
  target?: Hex
  /** Human-readable, shown inline in the UI (spec §8). */
  message: string
}

/** How a deployer parameterizes the worker. */
export interface WorkerConfig {
  /** A pending-state-stall threshold (ms) past which a sign-next-state nudge fires. */
  signStaleMs: number
  /** Minimum gas balance (wei) below which a top-up-gas nudge fires. */
  minGasWei: bigint
  /** Pipeline depth: how many settlements may be in flight at once. */
  windowSize: number
  /** RBF staleness threshold (ms) for a stuck settle tx. */
  rbfStaleMs: number
}
```

Add to `src/index.ts`:

```ts
export const PACKAGE = '@gibs/msgboard-settle-relayer'
export * from './types'
```

**Verify:** `cd ~/Documents/gibs-finance/random/examples/games/msgboard-settle-relayer && pnpm typecheck` → exit 0.

**Commit (controller):** `feat(msgboard-settle-relayer): worker data types (SettleReadySession/SettleJob/Nudge) (plan 3 task 4)`

---

### Task 5: Worker — `settleReadySource` (detect settle-ready sessions; parallel-safe)

**Repo: random `examples/games/msgboard-settle-relayer`.** A `RelayerSource<SettleJob>` whose `poll` returns one job per session a provider reports as settle-ready. The provider is injected (in production it watches the board / a co-signed-final feed; in tests it's a fake), so the source itself is pure and parallel-session-safe (each session is an independent job).

Write the test first. Create `test/settleReadySource.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { type Hex } from 'viem'
import { HouseSession, dice, makeDomain } from '@gibs/msgboard-games'
import { OptimisticSettlement } from '@gibs/msgboard-settle'
import { settleReadySource } from '../src/settleReadySource'
import type { SettleReadySession } from '../src/types'

const player = privateKeyToAccount(`0x${'11'.repeat(32)}`)
const house = privateKeyToAccount(`0x${'22'.repeat(32)}`)
const bankroll = '0x00000000000000000000000000000000000ba111' as Hex

async function buildSession(tableId: Hex, rounds: number): Promise<SettleReadySession> {
  const domain = makeDomain(31337, bankroll)
  const s = new HouseSession({
    domain, tableId, game: dice, player, house,
    seedTip: `0x${'77'.repeat(32)}` as Hex, chainLength: 16,
    openBalances: { player: 1000n, house: 1000n }, settlementMode: 0,
  })
  await s.open()
  for (let i = 0; i < rounds; i++) {
    await s.playRound({ stake: 100n, params: { targetX100: 5000n }, clientSeed: `0x${'33'.repeat(32)}` })
  }
  const settlement = new OptimisticSettlement({
    parties: { player: player.address, house: house.address }, commit: s.chain.commit,
    game: dice, domain, settlementMode: 0, bankroll,
  })
  return { tableId, transcriptJson: s.transcript.toJSON(), settlement, trigger: 'cooperative-final', observedAt: 0 }
}

describe('settleReadySource', () => {
  it('yields one SettleJob per settle-ready session reported by the provider', async () => {
    const a = await buildSession(`0x${'aa'.repeat(32)}`, 3)
    const b = await buildSession(`0x${'bb'.repeat(32)}`, 5)
    const source = settleReadySource({ provider: async () => [a, b] })
    const jobs = await source.poll({} as never)
    expect(jobs.map((j) => j.session.tableId)).toEqual([a.tableId, b.tableId])
  })

  it('parallel sessions are independent jobs (no shared state, no ordering coupling)', async () => {
    const a = await buildSession(`0x${'aa'.repeat(32)}`, 2)
    const b = await buildSession(`0x${'bb'.repeat(32)}`, 7)
    const source = settleReadySource({ provider: async () => [b, a] }) // reversed
    const jobs = await source.poll({} as never)
    expect(jobs).toHaveLength(2)
    expect(jobs[0].session).toBe(b)
    expect(jobs[1].session).toBe(a)
  })

  it('drops a session whose transcript has no settle-ready rounds (OPEN only)', async () => {
    const domain = makeDomain(31337, bankroll)
    const s = new HouseSession({
      domain, tableId: `0x${'cc'.repeat(32)}`, game: dice, player, house,
      seedTip: `0x${'77'.repeat(32)}` as Hex, chainLength: 8,
      openBalances: { player: 1000n, house: 1000n }, settlementMode: 0,
    })
    await s.open() // no rounds
    const settlement = new OptimisticSettlement({
      parties: { player: player.address, house: house.address }, commit: s.chain.commit,
      game: dice, domain, settlementMode: 0, bankroll,
    })
    const open: SettleReadySession = {
      tableId: `0x${'cc'.repeat(32)}`, transcriptJson: s.transcript.toJSON(),
      settlement, trigger: 'player-closeout', observedAt: 0,
    }
    const source = settleReadySource({ provider: async () => [open] })
    const jobs = await source.poll({} as never)
    expect(jobs).toHaveLength(0) // nothing to settle yet
  })
})
```

Run (red): `pnpm exec vitest run test/settleReadySource.test.ts` → module not found.

Create `src/settleReadySource.ts`:

```ts
import { Transcript } from '@gibs/msgboard-games'
import type { RelayerSource } from '@msgboard/relayer'
import type { SettleJob, SettleReadySession } from './types'

export interface SettleReadySourceOptions {
  /** Reports the sessions the worker should consider settling this tick (watches the
   *  board / a co-signed-final feed / an explicit close-out queue). Injected so the
   *  source stays pure and testable; production wires the real watcher here. */
  provider: () => Promise<readonly SettleReadySession[]>
}

/** True iff the retained transcript has at least one co-signed ROUND after the OPEN —
 *  i.e. there is a net delta to land. An OPEN-only session is not settle-ready. */
const hasSettleableRounds = (transcriptJson: string): boolean => {
  try {
    const t = Transcript.fromJSON(transcriptJson)
    return t.entries.some((e) => e.kind === 'ROUND')
  } catch {
    return false // malformed transcript is never settle-ready
  }
}

/**
 * A RelayerSource that turns the provider's reported sessions into settle jobs,
 * dropping any that are not yet settle-ready. Each session is an independent job —
 * parallel sessions never serialize (spec §7).
 */
export const settleReadySource = (options: SettleReadySourceOptions): RelayerSource<SettleJob> => ({
  poll: async () => {
    const sessions = await options.provider()
    return sessions
      .filter((s) => hasSettleableRounds(s.transcriptJson))
      .map((session) => ({ session }))
  },
})
```

Add `export * from './settleReadySource'` to `src/index.ts`.

Run (green): `pnpm exec vitest run test/settleReadySource.test.ts` → `Tests  3 passed`.

**Commit (controller):** `feat(msgboard-settle-relayer): settleReadySource — settle-ready detection, parallel-safe (plan 3 task 5)`

---

### Task 6: Worker — `settleAction` (buildSettle → simulate → write, RBF-wrapped)

**Repo: random `examples/games/msgboard-settle-relayer`.** The games-aware action: per job, call `session.settlement.buildSettle(transcriptJson)` (which re-verifies the transcript and throws on tamper), then submit the resulting `TxRequest` via viem simulate → write — wrapped by the engine's `repricingAction` so it gets the nonce window + RBF for free. Submission is injected (a `submitTx` fn) so unit tests use fakes; production passes the real viem path.

Write the test first. Create `test/settleAction.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { type Hex } from 'viem'
import { HouseSession, dice, makeDomain } from '@gibs/msgboard-games'
import { OptimisticSettlement } from '@gibs/msgboard-settle'
import { createPendingTxTracker } from '@msgboard/relayer'
import { makeSettleAction } from '../src/settleAction'
import type { SettleJob, SettleReadySession } from '../src/types'

const player = privateKeyToAccount(`0x${'11'.repeat(32)}`)
const house = privateKeyToAccount(`0x${'22'.repeat(32)}`)
const bankroll = '0x00000000000000000000000000000000000ba111' as Hex
const domain = makeDomain(31337, bankroll)

async function job(tableId: Hex, rounds: number): Promise<SettleJob> {
  const s = new HouseSession({
    domain, tableId, game: dice, player, house,
    seedTip: `0x${'77'.repeat(32)}` as Hex, chainLength: 16,
    openBalances: { player: 1000n, house: 1000n }, settlementMode: 0,
  })
  await s.open()
  for (let i = 0; i < rounds; i++) {
    await s.playRound({ stake: 100n, params: { targetX100: 5000n }, clientSeed: `0x${'33'.repeat(32)}` })
  }
  const settlement = new OptimisticSettlement({
    parties: { player: player.address, house: house.address }, commit: s.chain.commit,
    game: dice, domain, settlementMode: 0, bankroll,
  })
  const session: SettleReadySession = {
    tableId, transcriptJson: s.transcript.toJSON(), settlement, trigger: 'cooperative-final', observedAt: 0,
  }
  return { session }
}

describe('settleAction', () => {
  it('builds the correct settle calldata and submits it (simulate->write)', async () => {
    const submitTx = vi.fn(async () => ({ hash: '0xdead' as Hex }))
    const action = makeSettleAction({
      tracker: createPendingTxTracker({ windowSize: 4, baseNonce: 0 }),
      submitTx,
      initialFees: async () => ({ maxFeePerGas: 100n, maxPriorityFeePerGas: 2n }),
      staleMs: 999_999,
    })
    const j = await job(`0x${'aa'.repeat(32)}`, 4)
    const result = await action.execute(j, {} as never)
    expect(result.ok).toBe(true)
    expect(submitTx).toHaveBeenCalledTimes(1)
    const req = submitTx.mock.calls[0][0]
    // the TxRequest came from OptimisticSettlement.buildSettle
    expect(req.tx.address).toBe(bankroll)
    expect(req.tx.functionName).toBe('settle')
    expect(req.tx.args).toHaveLength(6) // open, final, 4 sigs
    expect((req.tx.args[1] as { nonce: bigint }).nonce).toBe(4n) // final state nonce
    expect(req.nonce).toBe(0)
    expect(req.fees.maxFeePerGas).toBe(100n)
  })

  it('describe is pure and submits nothing (observe-mode safe)', async () => {
    const submitTx = vi.fn(async () => ({ hash: '0x0' as Hex }))
    const action = makeSettleAction({
      tracker: createPendingTxTracker({ windowSize: 4, baseNonce: 0 }),
      submitTx,
      initialFees: async () => ({ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }),
      staleMs: 1,
    })
    const j = await job(`0x${'bb'.repeat(32)}`, 1)
    const text = action.describe(j, {} as never)
    expect(text).toContain('settle')
    expect(text).toContain('0xbb'.slice(0, 6))
    expect(submitTx).not.toHaveBeenCalled()
  })

  it('refuses to submit a tampered transcript (buildSettle throws -> ok:false, nothing sent)', async () => {
    const submitTx = vi.fn(async () => ({ hash: '0x0' as Hex }))
    const action = makeSettleAction({
      tracker: createPendingTxTracker({ windowSize: 4, baseNonce: 0 }),
      submitTx,
      initialFees: async () => ({ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }),
      staleMs: 999_999,
    })
    const j = await job(`0x${'cc'.repeat(32)}`, 3)
    // tamper: flip a byte in the transcript JSON so chain/sig verify fails
    const tampered = { ...j, session: { ...j.session, transcriptJson: j.session.transcriptJson.replace('1000', '9999') } }
    const result = await action.execute(tampered, {} as never)
    expect(result.ok).toBe(false)
    expect(submitTx).not.toHaveBeenCalled() // never submits forged/altered state
  })
})
```

Run (red): module not found.

Create `src/settleAction.ts`:

```ts
import type { Hex } from 'viem'
import type { TxRequest } from '@gibs/msgboard-settle'
import {
  repricingAction,
  type PendingTxTracker,
  type RelayerAction,
  type RelayerContext,
  type TxFees,
} from '@msgboard/relayer'
import type { SettleJob } from './types'

/** What a submitter is handed: the viem-ready TxRequest plus the nonce/fees the engine chose. */
export interface SettleSubmitRequest {
  tx: TxRequest
  nonce: number
  fees: TxFees
  replacement: boolean
  context: RelayerContext
}

export interface SettleActionOptions {
  /** Nonce-window + RBF state, shared across this worker's jobs. */
  tracker: PendingTxTracker
  /** Build + send ONE settle tx (production: simulate -> writeContract). Returns the hash. */
  submitTx: (req: SettleSubmitRequest) => Promise<{ hash: Hex }>
  /** Initial EIP-1559 fees for a fresh settle tx. */
  initialFees: (job: SettleJob, context: RelayerContext) => Promise<TxFees>
  /** RBF staleness threshold (ms). */
  staleMs: number
}

/**
 * The games-aware settle action: per job, build the settle calldata from the retained
 * transcript (OptimisticSettlement / EscrowedSettlement.buildSettle, which re-verifies
 * every signature and THROWS on any tamper), then submit it via the injected submitter,
 * wrapped by the engine's repricingAction for the nonce window + replace-by-fee.
 *
 * Safety: the action never builds a SessionState, never signs, never mutates a transcript.
 * buildSettle's throw on a bad transcript becomes ok:false with nothing submitted — the
 * worker's only power is WHEN a valid, fully-signed settlement lands, never WHAT it says.
 */
export const makeSettleAction = (options: SettleActionOptions): RelayerAction<SettleJob> =>
  repricingAction<SettleJob>({
    tracker: options.tracker,
    itemKey: (job) => job.session.tableId, // one nonce per session, so RBF re-sends the same settle
    describe: (job) => `settle session ${job.session.tableId.slice(0, 6)}… (${job.session.trigger})`,
    initialFees: options.initialFees,
    staleMs: options.staleMs,
    submit: async ({ item, nonce, fees, context, replacement }) => {
      // buildSettle re-verifies the retained transcript; it throws on any chain/sig/outcome mismatch.
      // Let it throw: repricingAction's execute propagates, the Relayer isolates it (no remember,
      // executed not incremented), so a tampered/un-ready session never produces a tx.
      const tx = await item.session.settlement.buildSettle(item.session.transcriptJson)
      const { hash } = await options.submitTx({ tx, nonce, fees, replacement, context })
      return { hash }
    },
  })
```

> **Note on the `ok:false` test:** `repricingAction.execute` awaits `submit`, which awaits `buildSettle`. A throw propagates out of `execute`. In the unit test we call `action.execute(...)` directly, so wrap the expectation accordingly — the action must surface a tampered transcript as a non-submitting outcome. To make the contract explicit (and keep the engine's "isolate and continue" behavior when run inside `Relayer`), `makeSettleAction` catches the build error and returns `{ ok: false }` itself rather than throwing. Adjust `submit` to:
>
> ```ts
> submit: async ({ item, nonce, fees, context, replacement }) => {
>   let tx: TxRequest
>   try {
>     tx = await item.session.settlement.buildSettle(item.session.transcriptJson)
>   } catch (err) {
>     // a tampered/un-ready transcript: refuse, do not submit (safety invariant)
>     throw new Error(`settle: refused to build calldata: ${err instanceof Error ? err.message : err}`)
>   }
>   const { hash } = await options.submitTx({ tx, nonce, fees, replacement, context })
>   return { hash }
> },
> ```
>
> and have `makeSettleAction` wrap `repricingAction` so the build-throw becomes `ok:false`:
>
> ```ts
> const inner = repricingAction<SettleJob>({ /* …as above… */ })
> return {
>   describe: inner.describe,
>   execute: async (item, ctx) => {
>     try {
>       return await inner.execute(item, ctx)
>     } catch {
>       return { ok: false, meta: { refused: 'invalid-transcript' } }
>     }
>   },
> }
> ```
>
> Implement `makeSettleAction` with this wrapper so the test's `result.ok === false` + `submitTx not called` both hold, AND the `Relayer` still isolates it cleanly in live mode.

Add `export * from './settleAction'` to `src/index.ts`.

Run (green): `pnpm exec vitest run test/settleAction.test.ts` → `Tests  3 passed`.

**Commit (controller):** `feat(msgboard-settle-relayer): settleAction — buildSettle->submit, RBF-wrapped, refuses tampered transcripts (plan 3 task 6)`

---

### Task 7: Worker — `nudges` (sign-next-state / top-up-gas; emit only, never act)

**Repo: random `examples/games/msgboard-settle-relayer`.** Pure functions that turn observed staleness / low gas into `Nudge[]`. No side effects, no chain writes — the worker only *surfaces* these to the UI (spec §7 "Nudge, don't gate"; §8 "Relayer nudges shown inline").

Write the test first. Create `test/nudges.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { type Hex } from 'viem'
import { detectNudges } from '../src/nudges'
import type { SettleReadySession } from '../src/types'

const player = '0x00000000000000000000000000000000000a1ace' as Hex
const session = (over: Partial<SettleReadySession>): SettleReadySession => ({
  tableId: `0x${'aa'.repeat(32)}`,
  transcriptJson: '{}',
  settlement: {} as never,
  trigger: 'cooperative-final',
  observedAt: 0,
  player,
  ...over,
})

describe('detectNudges', () => {
  it('fires sign-next-state when a session has stalled past signStaleMs', () => {
    const nudges = detectNudges({
      sessions: [session({ observedAt: 0 })],
      gasByAddress: new Map(),
      now: 10_000,
      config: { signStaleMs: 5_000, minGasWei: 0n, windowSize: 4, rbfStaleMs: 5_000 },
    })
    expect(nudges).toHaveLength(1)
    expect(nudges[0].kind).toBe('sign-next-state')
    expect(nudges[0].target).toBe(player)
  })

  it('does NOT fire sign-next-state before the stall threshold', () => {
    const nudges = detectNudges({
      sessions: [session({ observedAt: 8_000 })],
      gasByAddress: new Map(),
      now: 10_000,
      config: { signStaleMs: 5_000, minGasWei: 0n, windowSize: 4, rbfStaleMs: 5_000 },
    })
    expect(nudges.filter((n) => n.kind === 'sign-next-state')).toHaveLength(0)
  })

  it('fires top-up-gas when the player gas balance is below minGasWei', () => {
    const nudges = detectNudges({
      sessions: [session({ observedAt: 9_999 })],
      gasByAddress: new Map([[player.toLowerCase(), 5n]]),
      now: 10_000,
      config: { signStaleMs: 5_000, minGasWei: 1_000n, windowSize: 4, rbfStaleMs: 5_000 },
    })
    expect(nudges.some((n) => n.kind === 'top-up-gas' && n.target === player)).toBe(true)
  })

  it('emits only — returns reminders, performs no side effect (no signer, no tx in scope)', () => {
    // detectNudges is a pure function: same inputs -> same output, no external calls.
    const args = {
      sessions: [session({ observedAt: 0 })],
      gasByAddress: new Map<string, bigint>(),
      now: 10_000,
      config: { signStaleMs: 5_000, minGasWei: 0n, windowSize: 4, rbfStaleMs: 5_000 },
    }
    expect(detectNudges(args)).toEqual(detectNudges(args))
  })
})
```

Run (red): module not found.

Create `src/nudges.ts`:

```ts
import type { Nudge, SettleReadySession, WorkerConfig } from './types'

export interface DetectNudgesArgs {
  /** Sessions currently in progress / awaiting settlement. */
  sessions: readonly SettleReadySession[]
  /** Native-gas balance (wei) by lowercased address, for top-up reminders. */
  gasByAddress: ReadonlyMap<string, bigint>
  /** Current wall-clock ms. */
  now: number
  config: WorkerConfig
}

/**
 * Pure: turn observed staleness / low gas into reminders for the UI. The worker
 * SURFACES these and does nothing else (spec §7 "nudge, don't gate") — it never
 * signs on a participant's behalf, never withholds settlement, never moves funds.
 */
export const detectNudges = (args: DetectNudgesArgs): Nudge[] => {
  const out: Nudge[] = []
  for (const s of args.sessions) {
    if (args.now - s.observedAt > args.config.signStaleMs) {
      out.push({
        tableId: s.tableId,
        kind: 'sign-next-state',
        target: s.player,
        message: `Session ${s.tableId.slice(0, 6)}… is waiting on the next co-signed state. Sign to continue or close out.`,
      })
    }
    if (s.player) {
      const bal = args.gasByAddress.get(s.player.toLowerCase())
      if (bal !== undefined && bal < args.config.minGasWei) {
        out.push({
          tableId: s.tableId,
          kind: 'top-up-gas',
          target: s.player,
          message: `Low gas for ${s.player.slice(0, 6)}… — top up to self-settle session ${s.tableId.slice(0, 6)}….`,
        })
      }
    }
  }
  return out
}
```

Add `export * from './nudges'` to `src/index.ts`.

Run (green): `pnpm exec vitest run test/nudges.test.ts` → `Tests  4 passed`.

**Commit (controller):** `feat(msgboard-settle-relayer): nudges — sign-next-state / top-up-gas, emit-only (plan 3 task 7)`

---

### Task 8: Worker — `makeSettlementRelayer` (assemble the Relayer + a viem submitter)

**Repo: random `examples/games/msgboard-settle-relayer`.** Wire source + action + tracker into a `Relayer<SettleJob>`, and supply the production viem submitter (simulate → write). Tests drive it via `runOnce()` against fakes (the engine's own test pattern).

Write the test first. Create `test/worker.test.ts`:

```ts
import { http } from 'viem'
import { pulsechainV4 } from 'viem/chains'
import { describe, expect, it, vi } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { type Hex } from 'viem'
import { HouseSession, dice, makeDomain } from '@gibs/msgboard-games'
import { OptimisticSettlement } from '@gibs/msgboard-settle'
import { makeSettlementRelayer } from '../src/worker'
import type { SettleReadySession } from '../src/types'

const player = privateKeyToAccount(`0x${'11'.repeat(32)}`)
const house = privateKeyToAccount(`0x${'22'.repeat(32)}`)
const bankroll = '0x00000000000000000000000000000000000ba111' as Hex
const domain = makeDomain(31337, bankroll)

async function readySession(tableId: Hex, rounds: number): Promise<SettleReadySession> {
  const s = new HouseSession({
    domain, tableId, game: dice, player, house,
    seedTip: `0x${'77'.repeat(32)}` as Hex, chainLength: 16,
    openBalances: { player: 1000n, house: 1000n }, settlementMode: 0,
  })
  await s.open()
  for (let i = 0; i < rounds; i++) {
    await s.playRound({ stake: 100n, params: { targetX100: 5000n }, clientSeed: `0x${'33'.repeat(32)}` })
  }
  const settlement = new OptimisticSettlement({
    parties: { player: player.address, house: house.address }, commit: s.chain.commit,
    game: dice, domain, settlementMode: 0, bankroll,
  })
  return { tableId, transcriptJson: s.transcript.toJSON(), settlement, trigger: 'cooperative-final', observedAt: 0 }
}

const node = { transport: http('http://localhost:8545'), chain: pulsechainV4 }

describe('makeSettlementRelayer', () => {
  it('observe mode (default) lands nothing — describes only', async () => {
    const submitTx = vi.fn(async () => ({ hash: '0x0' as Hex }))
    const s = await readySession(`0x${'aa'.repeat(32)}`, 3)
    const relayer = makeSettlementRelayer({
      node, provider: async () => [s], submitTx,
      initialFees: async () => ({ maxFeePerGas: 100n, maxPriorityFeePerGas: 2n }),
      config: { signStaleMs: 5_000, minGasWei: 0n, windowSize: 4, rbfStaleMs: 5_000 },
    })
    const report = await relayer.runOnce()
    expect(report.described).toBe(1)
    expect(report.executed).toBe(0)
    expect(submitTx).not.toHaveBeenCalled()
  })

  it('live mode lands a settle-ready session (right calldata submitted)', async () => {
    const submitTx = vi.fn(async () => ({ hash: '0xbeef' as Hex }))
    const s = await readySession(`0x${'aa'.repeat(32)}`, 4)
    const relayer = makeSettlementRelayer({
      node, mode: 'live', provider: async () => [s], submitTx,
      initialFees: async () => ({ maxFeePerGas: 100n, maxPriorityFeePerGas: 2n }),
      config: { signStaleMs: 5_000, minGasWei: 0n, windowSize: 4, rbfStaleMs: 5_000 },
    })
    const report = await relayer.runOnce()
    expect(report.executed).toBe(1)
    const req = submitTx.mock.calls[0][0]
    expect(req.tx.functionName).toBe('settle')
    expect((req.tx.args[1] as { nonce: bigint }).nonce).toBe(4n)
  })

  it('nonce window pipelines two parallel sessions in one tick', async () => {
    const submitTx = vi.fn(async (r: { nonce: number }) => ({ hash: `0x${r.nonce}` as Hex }))
    const a = await readySession(`0x${'aa'.repeat(32)}`, 2)
    const b = await readySession(`0x${'bb'.repeat(32)}`, 3)
    const relayer = makeSettlementRelayer({
      node, mode: 'live', provider: async () => [a, b], submitTx,
      initialFees: async () => ({ maxFeePerGas: 100n, maxPriorityFeePerGas: 2n }),
      config: { signStaleMs: 5_000, minGasWei: 0n, windowSize: 4, rbfStaleMs: 999_999 },
    })
    const report = await relayer.runOnce()
    expect(report.executed).toBe(2)
    expect(submitTx.mock.calls.map((c) => c[0].nonce).sort()).toEqual([0, 1])
  })

  it('replace-by-fee bumps a stuck settle tx on a later tick', async () => {
    let now = 0
    const submitTx = vi.fn(async () => ({ hash: '0xstuck' as Hex }))
    const s = await readySession(`0x${'aa'.repeat(32)}`, 2)
    const relayer = makeSettlementRelayer({
      node, mode: 'live', provider: async () => [s], submitTx,
      initialFees: async () => ({ maxFeePerGas: 100n, maxPriorityFeePerGas: 10n }),
      config: { signStaleMs: 999_999, minGasWei: 0n, windowSize: 4, rbfStaleMs: 5_000 },
      now: () => now,
    })
    await relayer.runOnce()           // submit @100
    now = 6_000                        // stale
    await relayer.runOnce()            // RBF same nonce, higher fee
    expect(submitTx).toHaveBeenCalledTimes(2)
    const [first, second] = submitTx.mock.calls.map((c) => c[0])
    expect(second.nonce).toBe(first.nonce)
    expect(second.fees.maxFeePerGas).toBeGreaterThan(first.fees.maxFeePerGas)
  })
})
```

Run (red): module not found.

Create `src/worker.ts`:

```ts
import {
  createPublicClient,
  createWalletClient,
  type Account,
  type Hex,
  type WalletClient,
} from 'viem'
import {
  Relayer,
  createPendingTxTracker,
  type PendingTxTracker,
  type RelayerMode,
  type RelayerNode,
  type TxFees,
} from '@msgboard/relayer'
import { settleReadySource } from './settleReadySource'
import { makeSettleAction, type SettleSubmitRequest } from './settleAction'
import type { SettleJob, SettleReadySession, WorkerConfig } from './types'

export interface SettlementRelayerOptions {
  node: RelayerNode
  /** Defaults to 'observe' (engine default) — lands nothing until set to 'live'. */
  mode?: RelayerMode
  /** Reports settle-ready sessions each tick (watcher / close-out queue). */
  provider: () => Promise<readonly SettleReadySession[]>
  /** Build + send one settle tx. Defaults to the viem simulate->write submitter when `account` given. */
  submitTx?: (req: SettleSubmitRequest) => Promise<{ hash: Hex }>
  /** Funding account for the default viem submitter (ignored if `submitTx` supplied). */
  account?: Account
  /** Initial EIP-1559 fees for a fresh settle tx. */
  initialFees: (job: SettleJob, context: unknown) => Promise<TxFees>
  config: WorkerConfig
  /** Injectable clock (tests). */
  now?: () => number
  /** First nonce; defaults to 0 (production reads getTransactionCount before start). */
  baseNonce?: number
  /** Override the tracker (tests). */
  tracker?: PendingTxTracker
}

/**
 * The default production submitter: viem simulate -> writeContract at the engine-chosen
 * nonce + fees (the @gibs/games-core operator.ts pattern, spec §6 / Plan 2). RBF resubmits
 * reuse the same nonce, so a replacement overrides the stuck tx.
 */
const viemSubmitter =
  (account: Account) =>
  async (req: SettleSubmitRequest): Promise<{ hash: Hex }> => {
    const { tx, nonce, fees, context } = req
    const ctx = context as { publicClient: ReturnType<typeof createPublicClient>; chain: any; node: RelayerNode }
    const wallet: WalletClient = createWalletClient({
      account,
      chain: ctx.chain,
      transport: ctx.node.transport,
    })
    const { request } = await ctx.publicClient.simulateContract({
      account,
      address: tx.address,
      abi: tx.abi as any,
      functionName: tx.functionName,
      args: tx.args as any,
      nonce,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    })
    const hash = await wallet.writeContract(request)
    return { hash }
  }

/** Assemble the async settlement worker as a Relayer<SettleJob>. Untrusted, anyone-can-run. */
export const makeSettlementRelayer = (options: SettlementRelayerOptions): Relayer<SettleJob> => {
  const tracker =
    options.tracker ??
    createPendingTxTracker({
      windowSize: options.config.windowSize,
      baseNonce: options.baseNonce ?? 0,
      now: options.now,
    })

  const submitTx =
    options.submitTx ??
    (() => {
      if (!options.account) throw new Error('worker: pass either submitTx or account')
      return viemSubmitter(options.account)
    })()

  const action = makeSettleAction({
    tracker,
    submitTx,
    initialFees: (job, ctx) => options.initialFees(job, ctx),
    staleMs: options.config.rbfStaleMs,
  })

  return new Relayer<SettleJob>({
    node: options.node,
    mode: options.mode ?? 'observe',
    source: settleReadySource({ provider: options.provider }),
    action,
    key: (job) => job.session.tableId,
  })
}
```

Add `export * from './worker'` to `src/index.ts`.

Run (green): `pnpm exec vitest run test/worker.test.ts` → `Tests  4 passed`.

> If `simulateContract`'s typing on the fake context is awkward, the unit tests inject `submitTx` directly (they do), so the `viemSubmitter` path is only exercised in production / the e2e plan. Keep `viemSubmitter` `any`-cast at the abi boundary exactly as Plan 2's operator pattern does.

**Commit (controller):** `feat(msgboard-settle-relayer): makeSettlementRelayer — assemble Relayer + viem submitter (plan 3 task 8)`

---

### Task 9: Safety suite (the load-bearing tests — never forges, never withholds, only WHEN)

**Repo: random `examples/games/msgboard-settle-relayer`.** Consolidate the safety invariants of §7/§10 into one explicit suite. These are the tests that justify "untrusted, anyone-can-run."

Create `test/safety.test.ts`:

```ts
import { http } from 'viem'
import { pulsechainV4 } from 'viem/chains'
import { describe, expect, it, vi } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { type Hex } from 'viem'
import { HouseSession, dice, makeDomain, verifySessionStateSig } from '@gibs/msgboard-games'
import { OptimisticSettlement } from '@gibs/msgboard-settle'
import { makeSettlementRelayer } from '../src/worker'
import type { SettleReadySession } from '../src/types'

const player = privateKeyToAccount(`0x${'11'.repeat(32)}`)
const house = privateKeyToAccount(`0x${'22'.repeat(32)}`)
const bankroll = '0x00000000000000000000000000000000000ba111' as Hex
const domain = makeDomain(31337, bankroll)
const node = { transport: http('http://localhost:8545'), chain: pulsechainV4 }

async function ready(tableId: Hex, rounds: number): Promise<SettleReadySession> {
  const s = new HouseSession({
    domain, tableId, game: dice, player, house,
    seedTip: `0x${'77'.repeat(32)}` as Hex, chainLength: 16,
    openBalances: { player: 1000n, house: 1000n }, settlementMode: 0,
  })
  await s.open()
  for (let i = 0; i < rounds; i++) {
    await s.playRound({ stake: 100n, params: { targetX100: 5000n }, clientSeed: `0x${'33'.repeat(32)}` })
  }
  const settlement = new OptimisticSettlement({
    parties: { player: player.address, house: house.address }, commit: s.chain.commit,
    game: dice, domain, settlementMode: 0, bankroll,
  })
  return { tableId, transcriptJson: s.transcript.toJSON(), settlement, trigger: 'cooperative-final', observedAt: 0 }
}

const baseFees = async () => ({ maxFeePerGas: 100n, maxPriorityFeePerGas: 2n })
const cfg = { signStaleMs: 5_000, minGasWei: 0n, windowSize: 4, rbfStaleMs: 5_000 }

describe('worker safety invariants (spec §7 / §10)', () => {
  it('NEVER acts in observe mode — its default is to do nothing', async () => {
    const submitTx = vi.fn(async () => ({ hash: '0x0' as Hex }))
    const r = makeSettlementRelayer({ node, provider: async () => [await ready(`0x${'aa'.repeat(32)}`, 3)], submitTx, initialFees: baseFees, config: cfg })
    await r.runOnce()
    expect(submitTx).not.toHaveBeenCalled()
  })

  it('NEVER forges: it only submits a transcript it was given, and only what the SIGNATURES say', async () => {
    const submitTx = vi.fn(async () => ({ hash: '0xok' as Hex }))
    const s = await ready(`0x${'aa'.repeat(32)}`, 4)
    const r = makeSettlementRelayer({ node, mode: 'live', provider: async () => [s], submitTx, initialFees: baseFees, config: cfg })
    await r.runOnce()
    const req = submitTx.mock.calls[0][0]
    const [openState, finalState, openSigP, openSigH, finalSigP, finalSigH] = req.tx.args as any[]
    // every submitted state carries BOTH real co-signatures — the worker added nothing of its own
    expect(await verifySessionStateSig(player.address, domain, openState, openSigP)).toBe(true)
    expect(await verifySessionStateSig(house.address, domain, openState, openSigH)).toBe(true)
    expect(await verifySessionStateSig(player.address, domain, finalState, finalSigP)).toBe(true)
    expect(await verifySessionStateSig(house.address, domain, finalState, finalSigH)).toBe(true)
  })

  it('NEVER lands a tampered/forged payout: a flipped balance makes buildSettle reject -> no tx', async () => {
    const submitTx = vi.fn(async () => ({ hash: '0x0' as Hex }))
    const s = await ready(`0x${'aa'.repeat(32)}`, 3)
    const forged: SettleReadySession = { ...s, transcriptJson: s.transcriptJson.replace('1000', '999999') }
    const r = makeSettlementRelayer({ node, mode: 'live', provider: async () => [forged], submitTx, initialFees: baseFees, config: cfg })
    const report = await r.runOnce()
    expect(submitTx).not.toHaveBeenCalled()
    expect(report.executed).toBe(0)
  })

  it('NEVER withholds: an absent/failing submitter delays but cannot censor — a later tick re-lands it', async () => {
    let fail = true
    const submitTx = vi.fn(async () => {
      if (fail) throw new Error('rpc down')
      return { hash: '0xlanded' as Hex }
    })
    const s = await ready(`0x${'aa'.repeat(32)}`, 2)
    const r = makeSettlementRelayer({ node, mode: 'live', provider: async () => [s], submitTx, initialFees: baseFees, config: cfg })
    await r.runOnce()                 // submitter throws -> nothing remembered, isolated by the engine
    fail = false
    const report = await r.runOnce()  // same session re-offered; now it lands
    expect(report.executed).toBe(1)
    expect(submitTx).toHaveBeenCalledTimes(2)
  })

  it('its ONLY power is WHEN: two workers offered the same session both build identical calldata', async () => {
    const calls: any[] = []
    const submitTx = vi.fn(async (r: any) => { calls.push(r.tx); return { hash: '0x0' as Hex } })
    const s = await ready(`0x${'aa'.repeat(32)}`, 4)
    const w1 = makeSettlementRelayer({ node, mode: 'live', provider: async () => [s], submitTx, initialFees: baseFees, config: cfg })
    const w2 = makeSettlementRelayer({ node, mode: 'live', provider: async () => [s], submitTx, initialFees: baseFees, config: cfg })
    await w1.runOnce()
    await w2.runOnce()
    // identical calldata regardless of which worker runs — the worker contributes no degrees of freedom to WHAT settles
    expect(JSON.stringify(calls[0].args, bigintReplacer)).toBe(JSON.stringify(calls[1].args, bigintReplacer))
  })
})

const bigintReplacer = (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)
```

Run: `pnpm exec vitest run test/safety.test.ts` → `Tests  5 passed`.

Then run the whole worker package:

```bash
cd ~/Documents/gibs-finance/random/examples/games/msgboard-settle-relayer && pnpm test && pnpm typecheck
```

Expected: all five test files pass; typecheck exit 0.

**Commit (controller):** `test(msgboard-settle-relayer): safety suite — never forges/withholds, only WHEN (spec §7/§10; plan 3 task 9)`

---

### Task 10: README + progress + cross-repo verification

**Repo: random `examples/games/msgboard-settle-relayer` + msgboard `progress.txt`.**

Create `examples/games/msgboard-settle-relayer/README.md` covering: what the worker is (async, off-critical-path settlement landing over `@msgboard/relayer`), **why it is untrusted** (its only power is *when* settlement lands — bound by the retained signatures + the Plan 2 contracts; cannot forge, cannot censor, cannot alter a payout), how anyone can run their own (or self-settle by calling `buildSettle` + submitting directly), the nonce-window/RBF behavior (the relayer spec §13 feature now in `@msgboard/relayer`), and where each piece lives across the two repos. Document the Task 1 dependency-path decision (published `@msgboard/relayer ^0.0.31`, fallback if the engine bump lags).

Append a Plan 3 section to the msgboard `progress.txt` worklog: the engine primitive landed in `packages/relayer` (`repricingAction` + `PendingTxTracker`, the deferred relayer §13 item), the worker composition landed in random `examples/games/msgboard-settle-relayer`, the placement justification (generic primitive in the engine, games glue in the worker), and the open items carried forward (real board-watching `provider` wiring + the on-chain e2e land/RBF test belong to the §13-plan-6 web/e2e work; the unilateral/ZK settle path is §13 plan 5).

**Full cross-repo verification (run both):**

```bash
# engine
cd ~/Documents/valve-tech/github/msgboard/packages/relayer && npm test && npm run build
# worker
cd ~/Documents/gibs-finance/random/examples/games/msgboard-settle-relayer && pnpm test && pnpm typecheck
```

Expected: engine — all relayer test files pass (existing + `pending-tx` + `repricing`), `dist/` builds clean. Worker — `settleReadySource`, `settleAction`, `nudges`, `worker`, `safety` all pass; typecheck clean.

**Commit (controller):** `docs(msgboard-settle-relayer): README + progress.txt — plan 3 settlement relayer complete (plan 3 task 10)`

---

## Self-review

Before declaring Plan 3 done, confirm each against the spec and the code read:

- [ ] **§7 land settlements** — `settleReadySource` detects settle-ready sessions (≥1 co-signed ROUND), `settleAction` builds calldata via the real `OptimisticSettlement`/`EscrowedSettlement.buildSettle(transcriptJson)` and submits via viem simulate→write. Verified the builder signature + the `settle` arg shape against `msgboard-settle/src/optimistic.ts` (6 args: open, final, 4 sigs) and `escrowed.ts` (3 args).
- [ ] **§7 replace-by-fee + nonce window** — `repricingAction` + `PendingTxTracker` in the *engine* (the relayer spec §13 deferred item), reused by the worker's `settleAction`. Tests assert: RBF bumps the SAME nonce at a higher fee on staleness; a nonce window pipelines two settlements; a full window defers (never drops).
- [ ] **§7 nudge, don't gate** — `detectNudges` is pure, emit-only; tests assert it returns reminders and performs no side effect; no signer/tx in its scope.
- [ ] **§7 parallel sessions** — each session is an independent `SettleJob`; the source preserves order-independence; the window pipelines them.
- [ ] **§7/§10 untrusted** — the safety suite asserts: observe-by-default does nothing; only signed states are submitted (both co-sigs verify); a tampered transcript is refused (no tx); an absent/failing worker delays but a later tick re-lands (no censorship); two workers produce identical calldata (only power is WHEN).
- [ ] **Placement justified** — generic repricing/nonce-window in `packages/relayer` (engine, reusable, the §13 item); games glue in `examples/games/msgboard-settle-relayer` (consumes published `@msgboard/relayer ^0.0.31` + workspace `@gibs/msgboard-settle`/`@gibs/msgboard-games`, exactly as the games pkgs consume published `@msgboard/sdk ^0.0.31`). Both READMEs/progress state the split.
- [ ] **Two test runners honored** — engine uses **vitest 3 + NodeNext (`.js` imports)**; worker uses **vitest 2 + bundler style (no extensions)**.
- [ ] **No new contract / no on-chain settlement code** — Plan 3 is purely the off-chain worker; the contracts are Plan 2's. The real on-chain land/RBF e2e is deferred to the web/e2e plan (§13 plan 6); noted in progress.
- [ ] **Builder API matched exactly** — `buildSettle(transcriptJson: string)`, `TxRequest{address,abi,functionName,args}`, `replaySession` throws on tamper (so the worker's refuse-on-throw path is real, not invented).

## Execution Handoff

- **Order:** Engine first (Tasks 2–3 in `packages/relayer`) so the worker can depend on the published primitive; then the worker (Tasks 4–9 in the random repo); then docs (Task 10). Task 1 (scaffold + dependency-path decision) gates the random-repo work and records the fallback if the engine bump hasn't published yet.
- **Two repos:** every Task names its repo. Engine = npm workspaces, `npm test`, vitest 3, `.js` imports. Worker = pnpm workspace, `pnpm test`/`pnpm typecheck`, vitest 2, no-extension imports. Run `pnpm install` from the random root after Task 1.
- **Commits:** the **controller** commits, one per task with the message given. **Do NOT git add or git commit during execution.**
- **Fakes only:** no anvil / no RPC in any unit test — drive everything through `Relayer.runOnce()` against fake providers/submitters/transcripts, the engine's own test idiom. The on-chain land is verified later (§13 plan 6 e2e).
- **Safety is the acceptance bar:** Task 9 is non-negotiable — if any safety invariant fails, the worker is not "untrusted by construction" and the plan is not done.
