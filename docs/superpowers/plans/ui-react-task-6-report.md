# UI React Migration — Task 6 Report (the Playwright parity gate)

**Date:** 2026-06-25
**Branch:** `feat/ui-react`
**Plan:** `docs/superpowers/plans/2026-06-24-ui-react-migration.md` (Task 6 only) — **the plan file is
NOT present on disk or in git history** in this checkout (same as Tasks 1–5; only the task reports
exist). Task 6 scope was taken from the task brief: a Playwright suite that drives BOTH the live
Svelte `packages/ui` app and the new React `packages/ui-react` app and asserts behavioral parity
(same routes, same core board/post flow, same rendered content) — the gate before the user-gated
cutover (Task 7).
**Status:** DONE_WITH_CONCERNS (gate is GREEN via the standalone driver; the `playwright test`
RUNNER hangs in this sandbox and is left for CI — see "Real vs mocked vs CI-deferred").

The live Svelte `packages/ui` was **NOT modified** (`git status --short packages/ui` and
`git diff --stat packages/ui` both empty, verified before and after the run). Task 7 (the cutover)
was **NOT** done.

---

## STEP 0 — the Task-5-review testTimeout fix (committed as part of this task)

**Finding (from the Task-5 review):** the ui-react unit suite was FLAKY at the committed vitest
config — at the default 5s `testTimeout`, the heavy `<App>`/`DocsPortal` renders (markdown-it +
shiki) intermittently time out under parallel-worker contention.

**Before (committed config, default 5s timeout):**

```
 Test Files  1 failed | 17 passed (18)
      Tests  1 failed | 80 passed (81)
   ✗ test/docs-portal.test.tsx > DocsPortal … "renders the README markdown as HTML headings…"
     → Test timed out in 5000ms.
```

**Fix:** added `testTimeout: 20000` + `hookTimeout: 20000` to the `test` block in
`packages/ui-react/vite.config.ts`.

**After (committed config, no per-run override) — ran 5×, all green:**

```
 Test Files  18 passed (18)
      Tests  81 passed (81)
```

Reliable **81/81** at the committed config. (The fix is the only change to `vite.config.ts`.)

---

## The deliverable — Task 6 parity gate

All new, under `packages/ui-react/` (the Svelte app is only RUN for comparison, never modified):

| File | Purpose |
| --- | --- |
| `playwright.config.ts` | Standard runner config (for CI / real dev boxes). Three `webServer`s: React `dist` on :4310, Svelte `dist` on :4311, the PoW harness on :4320. Cached Chrome-for-Testing resolution (mirrors cosign-web); `workers:1`, no `devices['Desktop Chrome']` spread (keeps `executablePath`). |
| `e2e/parity.spec.ts` | **The parity suite.** ONE set of assertions parameterised over BOTH apps (`:4310` React, `:4311` Svelte). 6 tests × 2 apps = 12 parity tests. |
| `e2e/pow-responsive.spec.ts` | **THE authoritative "main thread stays responsive during a REAL grind" assertion** (the one Tasks 2–5 deferred here). |
| `e2e/harness/` | `index.html` + `main.ts` + `grind-worker.ts` — a tiny page that spawns the REAL `@msgboard/sdk` `doPoW` grind in a Web Worker and exposes `window.__powHarness` (heartbeat + start + result). |
| `e2e/harness-types.d.ts` | Ambient `window.__powHarness` type so the specs typecheck. |
| `vite.e2e.config.ts` | Serves ONLY the harness (`root: e2e/harness`, `worker.format:'es'`), so the responsiveness test needs neither the whole app booting nor any chain reads. |
| `e2e/run-parity.mjs` | **Standalone driver** (the cosign-web `run-happy-path.mjs` pattern) — the SAME assertions + selectors as the two specs, driven through Playwright's browser API with NO test runner. Starts/stops all three Vite servers itself. Prints `E2E_PARITY_PASS`. |
| `package.json` | `test:e2e` (`playwright test`, already present) + new `test:e2e:driver` (`node e2e/run-parity.mjs`). |
| `.gitignore` | ignores Playwright artifacts (`test-results/`, `playwright-report/`). |

### Route / flow coverage (asserted on BOTH apps)

| Assertion | `parity.spec.ts` test | What it proves |
| --- | --- | --- |
| `#/` → Home + `#try-it` + `#interactive` | "route #/ renders the Home page…" | the landing + board section resolves |
| core board scaffolding: `select#location[name="location"]`, `textarea#message`, **"Work + Send It!"** button, **Logs** panel | "the core board view renders its compose scaffolding" | the compose → post UI renders identically |
| `#/docs` → markdown with stable `#install` slug | "route #/docs renders the SDK docs…" | the docs page renders |
| `#/examples` → "Examples" heading + "Live GraphQL archive" | "route #/examples renders…" | examples page parity |
| `#/games` → "MsgBoard Games" heading | "route #/games renders…" | games page parity |
| unknown `#/route` → redirect to `#/` | "an unknown #/route redirects back to #/" | the fallback route parity |

The compose→PoW→post flow's responsive-thread half is asserted separately in
`pow-responsive.spec.ts` (below), because a real grind + on-chain post is not reachable headlessly
(see concerns).

### The PoW responsiveness assertion (the deferred one)

`pow-responsive.spec.ts` drives `e2e/harness/`:

- `grind-worker.ts` runs the **REAL** `@msgboard/sdk` `doPoW` grind — the same grind
  `src/worker/pow-worker.ts` runs in production — in a real Web Worker. Only two substitutions:
  the block read (`eth_getBlockByNumber`) is stubbed in-worker, and the on-chain `addMessage` is
  omitted (both unreachable headlessly). **The proof-of-work itself is not mocked** — it is a real
  ~1,400-iteration elliptic-curve search. Difficulty is driven low-but-non-zero (`workMultiplier:1`,
  `workDivisor:4000` → win-modulus ≈ 4204) so the real grind finishes sub-second.
- `main.ts` runs a main-thread heartbeat on a 10ms `setInterval` (advances only when the main
  thread's event loop is free). The spec samples the heartbeat 5× DURING the grind and asserts it
  advances **strictly monotonically**, then advances past the pre-grind baseline through to
  completion. A main-thread grind would freeze the heartbeat; an off-thread grind cannot.

Observed (real run): `iterations=1408`, `isValid=true`, heartbeat samples `6→11→15→20→25` while the
worker ground. This is the authoritative off-thread proof.

---

## What ran REAL vs MOCKED vs CI-deferred

**REAL (ran green in this sandbox, via `node e2e/run-parity.mjs` → `E2E_PARITY_PASS`):**

- Both apps' **real built `dist/`** served by `vite preview` (React :4310, Svelte :4311).
- Every route / page / board-scaffolding / docs assertion, on **BOTH** apps — true behavioral
  parity, one assertion set, both apps green.
- The **real PoW grind in a real Web Worker** + the **main-thread-responsiveness** measurement
  (1408 real iterations, heartbeat never froze).

```
  OK parity — react (ui-react)
  OK parity — svelte (ui)
  OK responsive grind — iterations=1408
E2E_PARITY_PASS
```

**MOCKED (necessarily, headlessly):**

- The worker's block read (`eth_getBlockByNumber`, stubbed) and the on-chain `addMessage`
  (omitted). A live `msgboard_` RPC module is not exposed by the public PulseChain endpoints
  (`msgboard_status` → `-32601 method does not exist`) and a real post needs a funded account — so
  a full compose→grind→**on-chain post**→board-tree round-trip is **not runnable here**. The board
  *scaffolding* (compose UI) parity IS asserted; the live board tree content is not.

**CI-deferred:**

- The standard **`playwright test` RUNNER hangs in this sandbox.** Verified three ways: (1) the full
  3-server config produced no output and spawned no servers before timeout; (2) `--list` (collection
  only) hangs; (3) even with all three servers pre-started + `reuseExistingServer`, running a single
  spec times out (exit 124) with an empty log. The hang is in the runner's config-load / worker
  bootstrap, NOT in my config or the browser — a bare `chromium.launch()` browser test runs fine
  (the driver proves it; an isolated no-server runner browser test also passed once during probing,
  but the behaviour is not reliable). This matches the environment reality the brief flagged from
  earlier tasks. **The `*.spec.ts` files + `playwright.config.ts` are the CI/dev-box path; the
  driver is the authoritative green path here.** The specs and the driver share identical selectors
  and assertions, and all e2e TS files pass an esbuild parse check, so the specs are not
  dead-on-arrival — they encode the exact assertions the driver verified green.

---

## Deviations

1. **No plan file.** As with Tasks 1–5, `2026-06-24-ui-react-migration.md` is absent; scope is the
   brief. Flagged.
2. **Chain-select parity selector.** The React port adds `aria-label="chain"` to `select#location`
   (an a11y improvement); the live Svelte select has only `id="location" name="location"`. The
   parity assertion keys off the **common** `select#location[name="location"]`, not the React-only
   aria-label — otherwise it would (and initially did) fail the Svelte app. This is a faithful-parity
   selector, not a bug.
3. **Two run entry points.** `test:e2e` (runner, for CI) and `test:e2e:driver` (browser API, for
   sandboxes where the runner hangs). The driver is the one that runs green here.
4. **PoW responsiveness via a harness, not the production page.** The production app exposes no
   `window` hook to inject a fake worker or observe the grind, and a real grind+post needs an
   unreachable live board. So the off-thread assertion runs against a dedicated harness that runs the
   **real SDK grind** off-thread — the production grind code path is byte-identical; what the harness
   changes is only the (unreachable) chain I/O around it.

## Concerns

- **The runner is unproven in this environment.** The specs are written to the standard Playwright
  API and verified by-parse + by-equivalence (same assertions the driver ran green), but they have
  not executed under `playwright test` here. A CI box with a working runner should run
  `npm run test:e2e --workspace=packages/ui-react` once to confirm before relying on it as the gate.
- **The gate does not exercise a live on-chain post.** Parity of the *post UI* + the *real off-thread
  grind* is proven; an end-to-end post to a live board (and the resulting board-tree render) is out
  of headless reach and remains a manual / live-RPC check before cutover.
- **The gate compares the built `dist/` of both apps.** Both dists were pre-built (Task 5); if either
  app changes, rebuild before running the gate (`npm run build` in each).

---

## Commands

```bash
# unit suite (testTimeout fix) — reliable 81/81 at committed config
npm run test --workspace=packages/ui-react

# parity gate — standalone driver (runs green in this sandbox)
node packages/ui-react/e2e/run-parity.mjs        # → E2E_PARITY_PASS
# or: npm run test:e2e:driver --workspace=packages/ui-react

# parity gate — standard runner (CI / real dev boxes; hangs in this sandbox)
npm run test:e2e --workspace=packages/ui-react
```
