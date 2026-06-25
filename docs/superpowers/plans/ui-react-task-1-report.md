# UI React Migration — Task 1 Report

**Date:** 2026-06-25
**Branch:** `feat/ui-react` (off `master`, independent of the cosign branches)
**Plan:** `docs/superpowers/plans/2026-06-24-ui-react-migration.md` — Task 1 only
**Status:** DONE

---

## Scope delivered

Task 1 only: scaffold the brand-new `packages/ui-react` package (Vite 6 + React 18.3 + Tailwind v4,
mirroring `packages/cosign-web` conventions), wire it into root `workspaces`, port the `/api/rpc-proxy`
Vite middleware + its allow-list **byte-for-byte** from the live Svelte `packages/ui/vite.config.ts`,
add the byte-diff gate the plan specifies, and land a green `vite build` + the Task-1 smoke test.

No other tasks (worker seam, stores, router, pages, components, Playwright, cutover) were touched.
`packages/ui` (Svelte) was left completely untouched. No push, no deploy.

## Files created

```
packages/ui-react/
  index.html               # ported from packages/ui/index.html: entry -> src/main.tsx, #app -> #root,
                           #   pre-paint theme <script> VERBATIM, favicons, font-awesome, robots noindex
  package.json             # name "msgboard-ui-react", React 18.3, NO @reown/@wagmi/@walletconnect
  tsconfig.json            # copied from cosign-web (react-jsx, bundler resolution, strict)
  vite.config.ts           # react()+tailwindcss() base (cosign-web) + proxy/guard COPIED VERBATIM from ui
  src/
    main.tsx               # createRoot(<StrictMode><App/></StrictMode>) + import './app.css' (NO WagmiProvider)
    App.tsx                # temporary shell: <main>msgboard</main> (replaced in Task 4/5)
    app.css                # copied VERBATIM from packages/ui/src/app.css
    vite-env.d.ts          # /// <reference types="vite/client" />
  public/                  # cork-board.webp, favicon.{svg,png,webp}, apple-touch-icon.png, logo.svg,
                           #   openrpc.json  (copied from packages/ui/public)
  test/
    smoke.test.tsx         # the plan's Task-1 smoke test (renders App shell, asserts /msgboard/i)
    proxy-parity.test.ts   # the byte-diff gate (proxy/guard/allow-list definitions == packages/ui)
```

Root `package.json`: added `"packages/ui-react"` to `workspaces` (right after `"packages/ui"`).
`package-lock.json` updated by `npm i`. `packages/ui` left in place — both coexist until cutover.

## How the rpc-proxy was preserved (the mixed-content lifeline)

The four proxy definitions — `readBody`, `malformedUrlGuard`, `ALLOWED_RPC_HOSTS` (+ `isAllowedRpcTarget`),
and `rpcProxyPlugin` — were pasted **byte-for-byte** from `packages/ui/vite.config.ts` (its lines 6-111,
including the `node:http` `IncomingMessage`/`ServerResponse` type imports the proxy needs). Only the base
config object differs intentionally, to match cosign-web's React stack:

- `svelte()` -> `react()` in the `plugins` array (plugin order otherwise identical:
  `[malformedUrlGuard(), rpcProxyPlugin(), tailwindcss(), react()]`)
- added the cosign-web `worker: { format: 'es' }` comment + `build.target: 'esnext'` (already in ui too)
- added the cosign-web vitest `test` block (`environment: 'jsdom'`, `include`, `globals: true`)

The `ALLOWED_RPC_HOSTS` allow-list is identical: `rpc.v4.testnet.pulsechain.com`, `rpc.pulsechain.com`,
`rpc-pulsechain.g4mm4.io`, `valve.city` (matches `*.valve.city`). Both `configureServer` AND
`configurePreviewServer` register the proxy + guard, so the lifeline works under `vite preview` (prod) too.

### Byte-diff gate result

A direct diff of the proxy/guard definition span proves equality:

```
$ diff <(sed -n '6,111p' packages/ui/vite.config.ts) <(sed -n '6,111p' packages/ui-react/vite.config.ts)
  (no output — byte-identical)
```

The repeatable gate lives in `test/proxy-parity.test.ts`. It extracts the contiguous definition span
(`const readBody` through the `}` that closes `rpcProxyPlugin`, i.e. everything above
`export default defineConfig`) from BOTH configs and asserts `portedBlocks === sourceBlocks`, with sanity
checks that the extraction actually captured `ALLOWED_RPC_HOSTS`, `'/api/rpc-proxy'`, `'valve.city'`,
`const isAllowedRpcTarget`, and `rpcProxyPlugin`. **Passing.**

> Note on the plan's exact `sed` one-liner: the plan's range `/rpcProxyPlugin/,/^}/` also matches the
> `plugins:` array line (which contains `rpcProxyPlugin()`) and then runs to the next `^}` (the close of
> `defineConfig`), so it over-captures into the config object and reports the *intentional* base-config
> differences (svelte->react, the worker comment, the test block) as a non-empty diff. That is a false
> positive from the loose anchor, not a proxy regression. The test gate anchors on the **definitions**
> only (lines 6-111), which are what must stay verbatim and which ARE byte-identical (empty diff above).

## Test / build output

- `npx tsc --noEmit -p tsconfig.json` -> exit 0 (no errors)
- `../../node_modules/.bin/vitest run` -> **Test Files 2 passed (2), Tests 2 passed (2)**
  (`smoke.test.tsx` + `proxy-parity.test.ts`)
- `npm run build` -> `✓ built in ~0.7s`, 27 modules, `dist/` emitted (index.html + assets/index-*.{js,css})
- `npm run build --workspace=packages/ui-react` (from root) -> builds alongside the workspace, exit 0
- Tailwind v4 `@custom-variant dark` survived the css copy: built CSS contains a `.dark` selector
  (`grep -c '\.dark' dist/assets/index-*.css` -> 1). All public assets ship into `dist/`
  (favicons, cork-board.webp, logo.svg, openrpc.json).

## Confirmation: packages/ui (Svelte) untouched

`git status --short packages/ui/` and `git diff --stat packages/ui/` are both empty. The new package is
purely additive; the live Svelte app keeps serving production unchanged.

## Deviations from the plan

1. **package.json `start` script:** used the plan's literal `"start": "npm run preview -- --host"`
   (cosign-web pins `--port 4173`; the plan text for ui-react omits the port). The proxy lives in
   `configurePreviewServer` either way; the port can be pinned in Task 6's Playwright `webServer` if needed.
2. **Byte-diff gate implementation:** implemented as a vitest test (`proxy-parity.test.ts`) anchored on the
   definition span rather than the plan's looser inline `sed` one-liner, because that one-liner over-captures
   into the config object (see the note above) and would false-positive on the intentional svelte->react base
   diffs. The stricter, definition-anchored gate is byte-exact and CI-repeatable. A raw
   `diff <(sed -n '6,111p' ...)` confirms the same (empty).
3. **`SOURCE`/`PORTED` path resolution in the test:** uses `process.cwd()` (vitest runs with cwd at the
   package root) instead of `import.meta.url`, because under jsdom `import.meta.url` resolves to an `http://`
   URL (vite serves the test module), which `fileURLToPath`/`readFileSync` reject.

## Concerns / notes for later tasks

- The root `package.json` on `master` lists only `packages/cosign` among the cosign packages (not
  cosign-web/cosign-core/cosign-tui — those live on `feat/cosign-surfaces`). So `cosign-web`'s SOURCE files
  are NOT present on this branch; I mirrored its conventions from values captured while reading them on the
  cosign branch (vite.config base, tsconfig, package.json, main.tsx). The `packages/cosign-web/` directory
  visible in the working tree here is only leftover `dist/`/`node_modules/`/`test-results/` and was left
  untouched (not staged).
- The pre-paint theme `<script>` and `app.css` (`@custom-variant dark`) are ported verbatim, so the
  Task 3 theme store can toggle `.dark` on `<html>` with no FOUC — ready for Task 3.
- No vestigial wallet deps (`@reown/*`, `@wagmi/*`, `wagmi`, `@walletconnect/*`) were added, per Constraint 4.
```
