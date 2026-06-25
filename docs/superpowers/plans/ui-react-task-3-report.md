# UI React Migration — Task 3 Report (global stores → zustand + ported hash router)

**Date:** 2026-06-25
**Branch:** `feat/ui-react`
**Plan:** `docs/superpowers/plans/2026-06-24-ui-react-migration.md` (Task 3 only)
**Status:** DONE

Task 3 only. Tasks 1–2 (scaffold + proxy + PoW worker seam) were already committed; Tasks 4–7
(components/pages/parity-gate/cutover) are out of scope and untouched. The live Svelte `packages/ui`
was not modified (verified: `git status --short packages/ui` is empty).

---

## What was built

### Neutral libs (port-as-is / framework-agnostic)
| Target | Source | Mechanism |
| --- | --- | --- |
| `src/lib/highlighter.ts` | `ui/src/lib/highlighter.ts` | byte-copy (shiki sync) |
| `src/lib/section-nav.ts` | `ui/src/lib/section-nav.ts` | byte-copy |
| `src/lib/tree-format.ts` | `ui/src/lib/tree-format.ts` | byte-copy |
| `src/lib/docs-content.generated.ts` | `ui/src/lib/docs-content.generated.ts` | byte-copy |
| `src/lib/rpc.ts` | `ui/src/lib/rpc.svelte.ts` | `SvelteMap`→plain `Map`; everything else identical (`rpcs`, `chainOptions`, `defaultCustomChain`, `needsProxy`, `BLOCK_RANGE_LIMIT`, `BLOCK_TIME_SECONDS`, `VITE_RPC_*` reads, valve.city vk_demo defaults, `gasSponsor`) |
| `src/lib/persist.ts` | `ui/src/lib/persist.svelte.ts` | `getScope(chainId, rpcUrl)` now takes **explicit args** (no implicit reactive read); `load`/`save`/`collectLabels`/`PREFIX='msgboard:ui'` unchanged |
| `src/lib/tree.ts` | pure tree helpers from `ui/src/lib/log.svelte.ts` | `Tree`, `toTree`, `kvSeparator`, `keysToTreeLeaves`, `formatBlocksRemaining`, `difficulty` — Svelte stripped, logic verbatim |

### zustand stores (the global singletons)
- **`src/stores/chain.ts` — `useChainStore`** (the big port, from `msgboard.svelte.ts`).
  Raw state in the store: `chainOption` / `customRpcUrl` / `forceProxy` (persisted to localStorage),
  `content`, `latestBlockNumber`, `globalWorkMultiplier`, `globalWorkDivisor`, `msgboardEnabled`,
  `loading`. Actions: `setChainOption`/`setCustomRpcUrl`/`setForceProxy` (persist + re-probe + conditional
  reload, identical guards to the Svelte setters), `clearContent`, `probeMsgboard` (race-guarded against
  `transportUrl`), `loadContent` (sets `loading`, `Promise.all([content, getBlockNumber])`, fires
  `probeMsgboard()` un-awaited). Plus `startChainPolling()` (20s `setInterval` + immediate call, returns a
  cleanup) for App's `useEffect`.
- **`src/stores/terminal.ts` — `useTerminalStore`** (from `log.svelte.ts`): `logList` / `lastProgress` +
  `printToTerminal` / `updateProgress` / `clearLogs`. `Log` class ported verbatim. `messageList` (was a
  `$derived.by`) → the pure `selectMessageList()` selector reading chain content + `fromRPCMessage` + sort.
- **`src/stores/theme.ts` — `useThemeStore`** (from `theme.svelte.ts`): `preference` / `resolved` /
  `setTheme` (persists `localStorage['theme']` + toggles `.dark` on `<html>`). `initThemeOSListener()`
  exported for App's `useEffect` (re-applies only while preference is `system`; returns cleanup). Initial
  resolve + class apply runs at module load, matching the Svelte `apply()` on import.

### Every Svelte `$derived` → a tested selector (`select*(state)`)
`selectSelectedOption`, `selectChain`, `selectName`, `selectRpcUrl`, `selectMustProxy`, `selectIsProxied`,
**`selectTransportUrl`**, `selectFullTransportUrl`, `selectClient`, `selectBoardClient`, `selectCategories`,
`selectMessages`, `selectRpcValid`, `selectFaucetIsActive`. Components subscribe via
`useChainStore((s) => selectTransportUrl(s))`; out-of-React callers (the poll, the worker-board seam) use
`useChainStore.getState()`.

**Invariant honored:** `selectTransportUrl` is the only URL anything uses for RPC — never raw `rpcUrl`.
The proxy/mixed-content logic is byte-identical to the Svelte source:
`url && isProxied ? `/api/rpc-proxy?url=${encodeURIComponent(url)}` : url`.

### Hash router (ported, NOT react-router)
- **`src/router.tsx`** — a `hashStore` singleton (`subscribe`/`getSnapshot` over `location.hash`, listening
  to `hashchange`/`popstate`/`load`) + `useRoute(): {id}` via `useSyncExternalStore` + `goto('#/x')` +
  `pushState`. `goto` keeps the same `#`-then-`/` validation as `page.svelte.ts`
  (throws `path must start with #` / `second character must be /`).

### Hooks
- **`src/hooks/useAccount.ts`** — read-only "account" replacing the vestigial `web3.svelte.ts` (NO wagmi,
  per Constraint 4). `address` is typed-in `useState<Hex|null>`; balance via a read-only viem client on
  `selectTransportUrl(...)`, 10s poll **only when an address is set**; `gasSymbol` from the active chain.
- **`src/hooks/useChainScope.ts`** — `getScope(chainId, rpcUrl)` recomputed reactively from the chain store
  (replaces Svelte's implicit reactive `getScope()`), so localStorage scoping tracks a chain switch.

---

## `#/route` URL parity evidence

| Behavior | `page.svelte.ts` (Svelte) | `router.tsx` (React) |
| --- | --- | --- |
| route id | `val.raw` (hash minus `#`) | `location.hash.slice(1)` |
| empty hash | `location.hash.slice(1) || '/'` → `/` | `window.location.hash.slice(1) || '/'` → `/` |
| navigate writes | `history.pushState(null,'','#'+raw)` | `history.pushState(null,'','#'+raw)` |
| `goto` guards | `#`-prefix + `/`-second-char, throws otherwise | same two throws, same messages |
| no-op when same | `if (p === page.value) return` | `if (p === getSnapshot().id) return` |
| listeners | `hashchange`/`popstate`/`load` | `hashchange`/`popstate`/`load` |

`test/router.test.ts` asserts the round-trip directly: `goto('#/docs')` → `useRoute().id === '/docs'` AND
`window.location.hash === '#/docs'` (byte-identical); a `hashchange` to `#/games` updates the snapshot;
empty hash resolves to `/`; `goto('/x')` and `goto('#x')` throw. The deep-link `?section=` scheme stays in
`section-nav.ts` (byte-copied), so it cannot disturb the route — same as Svelte.

---

## Tests (TDD: RED → GREEN)

New Task-3 test files (all written before implementation, confirmed RED on missing stores/router, then
GREEN):
- `test/rpc.test.ts` — `needsProxy` truth table (http-on-https / localhost / https / http page) + `rpcs`
  default/override.
- `test/tree.test.ts` — `formatBlocksRemaining` (expired / m+s / s); `toTree` group→leaf with stats + the
  blockHash/blockNumber/nonce/data rows, multi-message grouping, expiry meta presence/absence.
- `test/tree-format.test.ts` — ported from `ui/src/lib/tree-format.test.ts` (import path retargeted).
- `test/chain-derivations.test.ts` — one assertion per derived value: `transportUrl` (raw vs proxied),
  mixed-content (https page + `http://`), `forceProxy` on an https rpc, `mustProxy`, `rpcValid`,
  `faucetIsActive`, `categories`/`messages` from content, `fullTransportUrl` origin prefix, and a
  timer/worker-style out-of-React `setState` notifying a subscriber.
- `test/terminal.test.ts` — `printToTerminal`/`updateProgress`/`clearLogs`; `selectMessageList` sorts by
  category then hash from seeded chain content.
- `test/theme.test.ts` — `setTheme('dark'/'light'/'system')` toggles `.dark` + persists + resolves via a
  mocked `matchMedia`; the OS listener re-applies while preference is `system`.
- `test/router.test.ts` — the parity round-trip above + `useRoute` re-render via `renderHook`.

```
cd packages/ui-react && ../../node_modules/.bin/vitest run
→ Test Files 11 passed (11)
→      Tests 51 passed (51)
```
(6 new Task-3 files / 39 new tests, plus the Task 1/2 + tree-format suites.)

```
npx tsc --noEmit -p tsconfig.json   → exit 0
npm run build                       → ✓ built, exit 0
```

---

## Deviations from the plan

1. **`location.protocol` mocking in tests.** jsdom forbids `vi.spyOn(window.location, 'protocol', 'get')`
   ("Cannot redefine property: protocol"). The RED run surfaced this; resolved by redefining
   `window.location` with a configurable clone (`Object.defineProperty`) per-test and restoring after.
   Pure test-harness detail; the SUT (`needsProxy` / `selectTransportUrl`) is unchanged.
2. **`router.tsx` exposes `hashStore` + `hashStore.handleHashChange()`** as exports so tests can drive a
   `hashchange` deterministically in jsdom (where dispatching a real `hashchange` after setting
   `location.hash` is flaky). Production code uses `useRoute()`/`goto()`; this is an additive seam.
3. **`useRoute()` takes no selector argument** (returns `{id}` straight from `useSyncExternalStore`). The
   plan's table sketched `useRoute()` only; no behavior change.
4. **`startChainPolling()` / `initThemeOSListener()` are exported but not yet mounted.** They belong in
   App's `useEffect` (Task 4 step 5 / Task 4–5). Task 3 produces the store + the lifecycle helper; wiring
   is the next task. Consequently the stores are not yet imported by `App.tsx`, so they are not in the
   production bundle yet (build still green — they ship once Task 4 imports them).

---

## Concerns / notes for downstream tasks

- **Chain-store derivation parity (the MED risk in the plan) is covered** — every `$derived` is a named
  selector with a unit test, especially `transportUrl`/proxy/mixed-content. No code reads raw `rpcUrl` for
  transport (selectors funnel through `selectTransportUrl`); keep that invariant when wiring Task 4's
  `Interactive`/worker-board.
- **Out-of-React `setState`** (the 20s poll, the worker `onProgress` callback) is proven to notify a
  subscriber (`chain-derivations.test.ts` last case). Task 4 should still add a focused component test that a
  timer-driven `set()` re-renders a mounted component (plan's "verify a timer-driven `set()` re-renders").
- **`selectMessageList()` reads the chain store at call time** (it is not a hook). In components, call it
  inside a render that also subscribes to `useChainStore((s) => s.content)` (or memoize on content) so the
  list recomputes when content changes — note this when porting `Terminal`/`TreeView` in Task 4.
- **`chainId` generalization** (Task 2) flows here: the worker-board seam needs `selectChain(state)?.id`;
  `useChainScope` already derives the id the same way.
- The vestigial `web3.svelte.ts`/account+balance map is **dropped**; `useAccount` is the read-only
  replacement (no wagmi, no modal/`fallback` transport).
