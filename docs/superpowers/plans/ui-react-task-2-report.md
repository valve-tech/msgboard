# UI React Migration — Task 2 Report (PoW Web Worker seam)

**Date:** 2026-06-24
**Branch:** `feat/ui-react`
**Scope:** Task 2 only — port the PoW Web Worker seam (`makeWorkerBoard`) into
`packages/ui-react`, proving the grind runs in a dedicated ES-module `Worker` and NEVER on
the main thread. No other tasks touched; `packages/ui` (live Svelte) untouched; no push/deploy.

---

## What was built (the seam)

Three source files + two tests, all under `packages/ui-react/`:

| File | Role |
| --- | --- |
| `src/worker/types.ts` | Worker message protocol. `StartWorkReq` now carries `chainId: number` + stringified `workMultiplier`/`workDivisor` (structured-clone-safe), plus `Log/Progress/Complete/Error` responses. Types reuse `@msgboard/sdk` `WorkStats`/`WorkResult` (matches the live Svelte worker's `types.ts`). |
| `src/worker/pow-worker.ts` | The PoW grind, in a **dedicated-worker** shape (`self as DedicatedWorkerGlobalScope`, `ctx.postMessage`). Grind logic is **identical to the live Svelte worker**: `new MsgBoardClient(provider, { difficultyFactors, breakInterval: 10_000n, logger, progress })` → `await doPoW(category, data)` → guard `result.stats.isValid` → `await addMessage(result.message)` → `post({type:'complete', result})`. Honors `{type:'cancel'}` → `boardClient.cancel()`. |
| `src/seams/worker-board.ts` | `makeWorkerBoard(opts)` — adopted from cosign-web. Injectable `workerFactory`; one worker per `addMessage`; `content()` via a read-only `MsgBoardClient` on the main thread; default factory `new Worker(new URL('../worker/pow-worker.ts', import.meta.url), {type:'module'})`. |
| `test/worker-board.test.ts` | Seam message-protocol test via a `FakeWorker` stub (3 cases). |
| `test/worker-shape.test.ts` | Off-main-thread source-level tripwire (memory rule #9). |

### How the worker is wired

`makeWorkerBoard({ rpc, chainId, workMultiplier, workDivisor, onProgress, workerFactory? })`
returns a `BoardClient` with `addMessage` + `content`:

- `addMessage({category, data})` spawns a `Worker` (default = the ES-module PoW worker),
  posts `{type:'work', rpc, chainId, category, data, workMultiplier, workDivisor}`, and
  resolves on `complete` / rejects `{kind:'pow', message}` on `error`. `progress` messages
  forward to `onProgress`. The worker is `terminate()`-d on settle (cleanup).
- The grind (`doPoW`) + the post (`addMessage`) both run **inside the worker** — the main
  thread only marshals messages.
- `content({category})` reads via a main-thread read-only `MsgBoardClient` (no PoW).

### Off-main-thread proof (separate Worker chunk)

The default factory is `new Worker(new URL('../worker/pow-worker.ts', import.meta.url),
{type:'module'})` and `vite.config.ts` already sets `worker.format: 'es'`. A throwaway
fixture entry that imports the seam was built with the workspace Vite; the output contained
a **separate worker chunk**:

```
.worker-proof-dist/assets/pow-worker-qRrVn4O0.js   929.72 kB   ← the grind, its own chunk
.worker-proof-dist/assets/.worker-proof-CtOCZ7vo.js  932.14 kB ← the main entry (no grind inline)
```

The worker chunk hash (`pow-worker-qRrVn4O0.js`) is **byte-identical to cosign-web's**
shipped `dist/assets/pow-worker-qRrVn4O0.js`, confirming the same off-thread bundling. The
fixture/config were removed after the proof (no stray files). The default `npm run build`
does NOT yet emit the chunk because nothing in the app graph imports the seam yet — that
wiring lands in Task 4 (`Interactive.tsx`); the fixture proves the bundler behavior in
isolation for Task 2.

---

## Deviations from the live Svelte worker (all per the plan's documented decisions)

1. **`addMessage` folded INTO the worker.** The Svelte `Interactive` flow ran `doWork()`
   (grind) then a **separate main-thread** `send()`/`addMessage()`. The adopted cosign-web
   seam grinds AND posts in the worker (a single `work` request). User-visible outcome is
   identical (a posted message + reloaded feed). Recorded as a Task-4 parity-diff item.
2. **`chainId` generalized.** The live Svelte worker hard-codes `pulsechainV4`. The seam +
   worker now take `chainId` and select via `chainFor(chainId)` (mainnet/pulsechain/
   pulsechainV4 → default 943). Callers pass `chain.chain?.id` (wired in Task 4).
3. **Dedicated-worker shape.** `ServiceWorkerGlobalScope` + `source.postMessage` →
   `DedicatedWorkerGlobalScope` + `ctx.postMessage`; the old `setTimeout(...)` wrapper is
   dropped (the dedicated worker is already off-thread).
4. **No `@msgboard/cosign-core` dependency.** cosign-web imported its `BoardClient`/`Content`
   from `@msgboard/cosign-core`. ui-react has no cosign dep, so `BoardClient` is defined
   **locally** in `worker-board.ts` over `@msgboard/sdk` types (`Content` is re-exported from
   the sdk via `export * from '@msgboard/core'`). The seam logic is otherwise verbatim.

---

## Tests (TDD: RED → GREEN)

- **RED:** both tests written first; `worker-board.test.ts` failed to import the missing
  seam, `worker-shape.test.ts` failed reading the not-yet-existent source.
- **GREEN:** after implementing the three source files, **4/4 Task-2 tests pass** (full
  `ui-react` suite **6/6** incl. the Task-1 smoke test). `tsc --noEmit` exits 0.

```
test/worker-board.test.ts  (3) ✓   posts {type:work} + resolves on complete; forwards progress; rejects {kind:pow} on error
test/worker-shape.test.ts  (1) ✓   default factory = `new Worker(new URL('../worker/pow-worker.ts'), {type:'module'})`;
                                    worker uses DedicatedWorkerGlobalScope, not a service worker; `.doPoW(` lives in the
                                    worker module, NOT the seam (main thread)
```

### Tripwire note (genuine off-main-thread assertion)

`worker-shape.test.ts` reads the source on disk (anchored to `__dirname`, since
`import.meta.url` is an http URL under jsdom) and asserts: (a) the seam's default factory
constructs a dedicated ES-module `Worker` from the `pow-worker.ts` URL, (b) the worker runs
in a `DedicatedWorkerGlobalScope` and not a service-worker scope, and (c) the grind call
`.doPoW(` appears in the **worker** module but **NOT** in the seam — i.e. the grind cannot
be inlined onto the main thread without breaking the test. The authoritative behavioral proof
(main thread responsive during a real grind) is the Task-6 Playwright assertion.

---

## Concerns / follow-ups

- **The worker chunk only ships once the app imports the seam.** Verified the chunk emerges
  via a fixture build; the real `dist` chunk appears in Task 4 when `Interactive.tsx` calls
  `makeWorkerBoard`. Re-confirm `dist/assets/*pow-worker*` after Task 4.
- **`chainId` plumbing.** `Interactive`/callers must pass `chain.chain?.id ?? 943` (Task 4).
- **`@msgboard/sdk` `MsgBoardClient` provider cast.** Same `as unknown as msgboard.Provider`
  cast the live Svelte worker uses — carried over verbatim.
- Worker chunk is ~930 kB (the SDK + viem); Vite's >500 kB warning is expected and matches
  cosign-web. Not a regression for Task 2.
