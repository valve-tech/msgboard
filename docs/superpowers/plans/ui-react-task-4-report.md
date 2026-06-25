# UI React Migration — Task 4 Report (MVP vertical slice: core board + post/PoW flow)

**Date:** 2026-06-25
**Branch:** `feat/ui-react`
**Plan:** `docs/superpowers/plans/2026-06-24-ui-react-migration.md` (Task 4 only)
**Status:** DONE

Task 4 only — the MVP vertical slice. Tasks 1–3 (scaffold + rpc-proxy; PoW worker seam;
zustand stores + hash router) were already committed and are reused verbatim as
presentation + wiring substrate. Tasks 5–7 (full landing page + hash-routed pages, parity
gate, cutover) are out of scope and untouched. The live Svelte `packages/ui` was NOT
modified (`git status --short packages/ui` + `git diff --stat packages/ui` both empty).

---

## What was built — the MVP screens, wired end-to-end

The primary flow now works against the real Task-3 stores + the Task-2 worker seam:

> **SelectChain** → **Interactive** (compose a message → grind PoW in the Web Worker seam →
> the worker posts it → reload board content) → **Terminal** + **TreeView** render of board
> content.

### React components ported from Svelte (additive, under `packages/ui-react/src/components/`)

| React component | Svelte source | Notes |
| --- | --- | --- |
| `Interactive.tsx` | `Interactive.svelte` | The MVP driver. Reads chain-store selectors, owns the compose state (text/category/encoding/toggles), dispatches the grind through the worker seam, reloads content, renders the tree. |
| `SelectChain.tsx` | `SelectChain.svelte` | Chain `<select>` (driven by `setChainOption`), custom-url input (commits to `setCustomRpcUrl` on blur/Enter), live `msgboard_` probe dot, proxy/direct toggle (`setForceProxy`). The `<select>` carries `aria-label="chain"`. |
| `Category.tsx` | `Category.svelte` | Category mode (gas-request/input) + encoding (keccak/direct) toggles, hex preview, cancel button. |
| `MessageInput.tsx` | `MessageInput.svelte` | Message textarea, hex preview, gas-request balance/symbol (passed in from `useAccount` rather than reading a global singleton). |
| `PresetButtons.tsx` | `PresetButtons.svelte` | "Work + Send It!" submit button. |
| `Terminal.tsx` | `Terminal.svelte` | Log lines + hash/s from the terminal store; collapse + clear. |
| `TreeView.tsx` | `TreeView.svelte` | Recursive board tree; module-scoped persisted expansion/decode state + `decodeAll` holder + `loadTreeNodeState`/`saveTreeNodeState`/`pruneTreeNodeState`. |
| `Summary.tsx` | `Summary.svelte` | Category/message counts + "decode all" toggle. |
| `RequestSnapshot.tsx` | `RequestSnapshot.svelte` | Frozen request-data box shown while working. |
| `ToggleButton.tsx` / `Info.tsx` / `Copy.tsx` | the same `.svelte` leaves | Presentation leaves (iconify via `@iconify/react`). |

### Store + worker mounting (Task-3 carry-forward, finally wired)

`App.tsx` (was a one-line shell) now:

- Mounts **`startChainPolling()`** and **`initThemeOSListener()`** in a single `useEffect`,
  and **tears both down** in the returned cleanup (they were exported-but-unmounted in
  Task 3 — see the Task-3 report's Deviation #4).
- Renders the `Interactive` MVP screen inside the `#interactive-container` shell.

`Interactive.tsx` mounts the **Task-2 worker board seam** via `makeWorkerBoard(...)`: the
grind is dispatched through `board.addMessage({ category, data })`, which posts a
`{ type: 'work', … }` message to the PoW **Web Worker** and resolves on `complete`. The Task-2
seam folds the post (`send`/`addMessage`) **into** the worker, so the React flow is a single
`addMessage` call rather than the Svelte `doWork()`-then-`send()` pair (documented Task-2
parity diff). Progress messages forward to the terminal store (`printToTerminal` +
`updateProgress`).

### The memoization (Task-3 review carry-forward)

`selectClient` / `selectBoardClient` construct a **new** viem/board client per call, so they
must stay out of hot render paths. In `Interactive.tsx` the worker board is built inside a
`useMemo` keyed on `[transportUrl, chainId, globalWorkMultiplier, globalWorkDivisor,
workerFactory]` — one client per transport change, not per render. Board **content** is read
from the chain store (`s.content` via `selectMessageList()` / `selectCategories` /
`selectMessages`), never by constructing a client in render. The render tree is itself
memoized on `[content, latestBlockNumber, globalWorkMultiplier, globalWorkDivisor]`.

`SelectChain` / `Summary` / `Category` subscribe to the precomputed selectors
(`selectRpcUrl`, `selectIsProxied`, `selectMustProxy`, `selectFaucetIsActive`, …) — no client
construction in any render path.

---

## PoW stays OFF the main thread (the HARD RULE)

- The grind is dispatched **only** through `makeWorkerBoard.addMessage` → a `{type:'work'}`
  message to the dedicated ES-module PoW `Worker`. `Interactive.tsx` contains **no** `doPoW`
  call (asserted by a source-level tripwire in `mvp-flow.test.tsx`).
- `Interactive` accepts an injectable `workerFactory` prop (passed straight to the seam) so
  tests substitute a fake `Worker`; production omits it and the seam spawns
  `new Worker(new URL('../worker/pow-worker.ts', import.meta.url), { type: 'module' })`.

### dist worker chunk — confirmed

Now that the app graph imports the seam (App → Interactive → `makeWorkerBoard`), the default
`vite build` finally emits the worker as its own chunk (Task-2 predicted this would land in
Task 4):

```
dist/assets/pow-worker-qRrVn4O0.js   929.72 kB   ← the grind, its own off-main-thread chunk
dist/assets/index-DQqvsXuc.js      1,132.65 kB   ← main entry (no grind inline)
```

The worker chunk hash `qRrVn4O0` is **byte-identical** to the Task-2 fixture-proof and to
cosign-web's shipped `pow-worker-qRrVn4O0.js` — same off-thread bundling. Build is green
(the >500 kB warning is the SDK+viem size, expected, matches cosign-web).

---

## Tests (TDD: RED → GREEN)

New Task-4 test files (written first, confirmed RED on the missing components, then GREEN):

- **`test/mvp-flow.test.tsx`** (5 tests) — the integration slice with a **fake worker**:
  1. `SelectChain` change updates the chain store (`chainOption === 'pulsechainV4'`).
  2. The Interactive flow dispatches the grind to the **worker seam**: a `{type:'work'}`
     message is posted to the injected fake `Worker`; resolving `complete` settles the seam,
     the flow reloads content, and the worker is `terminate()`-d (cleanup).
  3. **Off-main-thread tripwire**: `Interactive.tsx` source contains **no** `.doPoW(` and
     does route through `makeWorkerBoard`/`workerFactory`/`addMessage`.
  4. `Terminal` renders log lines from the terminal store.
  5. `TreeView` renders the category group → message-hash rows from a `toTree(...)` tree.
- **`test/app-mount.test.tsx`** (1 test) — App calls `startChainPolling()` +
  `initThemeOSListener()` once each on mount and invokes **both cleanups** on unmount
  (spies on the real helpers).
- **`test/smoke.test.tsx`** (updated) — App renders the Interactive MVP screen
  (`findByLabelText(/chain/i)`), replacing the obsolete `/msgboard/` literal assertion.

```
cd packages/ui-react && ../../node_modules/.bin/vitest run
→ Test Files 13 passed (13)
→      Tests 57 passed (57)
```
(51 prior Task-1/2/3 tests + 6 new/updated Task-4 assertions.)

```
../../node_modules/.bin/tsc --noEmit -p tsconfig.json   → exit 0
../../node_modules/.bin/vite build                      → ✓ built, dist/assets/pow-worker-*.js present
```

---

## Deviations from the plan / Svelte source

1. **`children` → `childrenNodes` prop on `TreeView`.** React reserves `children`; the tree's
   child nodes are passed as `childrenNodes`. Pure rename — the tree shape (`Tree.children`)
   and recursion are unchanged.
2. **Balance/symbol passed into `MessageInput`** from the Interactive flow's `useAccount`
   (Task-3 read-only account), rather than the Svelte `account` global singleton. Same
   rendered output; no wagmi (Constraint 4).
3. **Grind+post are one `addMessage`** (the Task-2 seam folded `send` into the worker), so the
   React flow calls `board.addMessage({category, data})` instead of Svelte's
   `doWork()`→`send()` pair. User-visible outcome identical (a posted message + reloaded
   feed). Carried forward from the Task-2 report.
4. **`Terminal` `scrollTo` guard.** jsdom does not implement `HTMLPreElement.scrollTo`; the
   auto-scroll effect now guards `typeof el.scrollTo === 'function'` before calling. Defensive
   only — real browsers still auto-scroll; the SUT behavior is unchanged.
5. **`TreeView` `hexToString` guard.** Wrapped in a try/catch that falls back to the raw hex
   for non-utf8 byte sequences (the Svelte `$derived` never hit this because the rendered
   values were always decodable; the guard avoids a render throw on a malformed category).
6. **App renders only the `Interactive` screen** (inside `#interactive-container`), not the
   full landing-page sections (`Welcome`/`SalesPitch`/`Docs`/…) or the hash router — those are
   Task 5. The MVP vertical slice is the post/PoW board flow, per the Task-4 scope.

---

## Concerns / notes for downstream tasks

- **No real-network test of the grind.** The integration test uses a fake `Worker` + mocked
  SDK; the authoritative "main thread stays responsive during a real grind" proof is the
  Task-6 Playwright assertion (as Task 2 also noted). The off-main-thread guarantee here is
  enforced structurally (seam + the `doPoW` source tripwire) and by the dist chunk.
- **`scopeFromStore()` in `Interactive`** reads `useChainStore.getState()` at call time for
  the persist scope, mirroring the Svelte `getScope()`. Persisted interactive state reloads
  on a chain switch via the same `load(scope, 'interactive', …)` path (the Svelte
  scope-change `$effect`); on the React side, the initial load runs on mount and persistence
  runs on every field change. A focused "reload persisted state on chain switch" effect can be
  added in Task 5 when the full page lifecycle lands, if parity testing flags it.
- **`Summary` `decodeAll`** is a module-scoped mutable holder shared with `TreeView` (the
  Svelte `$state({value})` wrapper). The toggle bumps local state to re-render; a deeper
  global "decode all" propagation across all open TreeView nodes is a Task-5 polish item if
  the parity gate wants live cross-node updates.
- **Landing-page sections + hash router** (`Home`/`DocsPortal`/`Games`/… and `router.tsx`
  wiring) are deliberately deferred to Task 5; `App.tsx` is the minimal MVP shell.
```
