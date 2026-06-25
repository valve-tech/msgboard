# UI React Migration — Task 5 Report (long-tail pages/components + full hash-router wiring)

**Date:** 2026-06-25
**Branch:** `feat/ui-react`
**Plan:** `docs/superpowers/plans/2026-06-24-ui-react-migration.md` (Task 5 only)
**Status:** DONE

Task 5 only — the full app shell (landing layout + nav) and every remaining hash-routed
page/component beyond the Task-4 MVP slice. Tasks 1–4 (scaffold + rpc-proxy; PoW worker seam;
zustand stores + hash router; the MVP `SelectChain → Interactive → Terminal/TreeView` slice)
are reused verbatim as presentation + wiring substrate. Tasks 6–7 (parity gate, cutover) are
out of scope. The live Svelte `packages/ui` was **NOT** modified
(`git status --short packages/ui` + `git diff --stat packages/ui` both empty).

> Note: the plan file `2026-06-24-ui-react-migration.md` referenced by the Task-1..4 reports is
> not present on disk or in git history in this checkout (only the four task reports are). Task 5
> scope was reconstructed from the Task-4 report's "Concerns / notes for downstream tasks" + the
> "Deviation #6" deferral list (full landing sections + hash router, the chain-switch reload
> effect, `Summary.decodeAll` live propagation) and from the live Svelte source under
> `packages/ui/src/{pages,components}`. Flagged as a deviation below.

---

## Pages ported (additive, `packages/ui-react/src/pages/`)

| React page | Svelte source | Notes |
| --- | --- | --- |
| `Home.tsx` | `pages/Home.svelte` | The landing layout: `SideToc` + the 8 `<section>`s (`top/overview/try-it/use-cases/games/api/network/compare/next-steps`) wrapping `Welcome`, `SalesPitch`, `FullScreen(Interactive)`, `UseCases`, `GamesCallout`, `Docs`, `JoinNetwork`, `ProtocolComparison`, `NextSteps`, `Footer`. Section ids + `scroll-mt-16` preserved. |
| `DocsPortal.tsx` | `pages/DocsPortal.svelte` | markdown-it + shiki pipeline (below). Splits the README around the `GENERATED:OPENRPC` block → renders `OpenRpcReference` for the structured part, markdown for the prose. Heading slug ids + side-TOC built from H2s. |
| `Examples.tsx` | `pages/Examples.svelte` | The 7 example cards + the live GraphQL archive callout. |
| `Games.tsx` | `pages/Games.svelte` | The venue fairness explainer (`GamesLiveProof` + `.games-prose` article + the two contract tables). |
| `RedirectToHome.tsx` | `pages/RedirectToHome.svelte` | `useEffect(() => goto('#/'))` (was Svelte `onMount`). Renders `null`. |

## Components ported (additive, `packages/ui-react/src/components/`)

| React component | Svelte source | Notes |
| --- | --- | --- |
| `Welcome.tsx` | `Welcome.svelte` | Ink hero; rotating prefix word on a `setInterval` (reduced-motion guard), keyed `<span>` for the swap (no svelte transitions — a deviation, below). |
| `Footer.tsx` | `Footer.svelte` | Theme radiogroup wired to the **zustand theme store** (`useThemeStore`) instead of the Svelte `theme`/`setTheme` singletons. |
| `FullScreen.tsx` | `FullScreen.svelte` | Scroll-driven scale/opacity/translate via `IntersectionObserver`; `children`/`id`/`className` props. |
| `SideToc.tsx` | `SideToc.svelte` | Sticky side-TOC; `IntersectionObserver` active-section highlight + `?section=` deep-link (reuses the Task-3 byte-ported `section-nav.ts`). |
| `Code.tsx` | `Code.svelte` | Shared `shiki` instance (Task-3 `highlighter.ts`) → `dangerouslySetInnerHTML` (the Svelte `{@html}`) + `Copy`. |
| `Carousel.tsx` | `Carousel.svelte` | Generic `<T>`; render-prop `card` (the Svelte `{#snippet card}`); arrow enable-state from scroll position. |
| `SalesPitch.tsx` | `SalesPitch.svelte` | Four value-prop cards. |
| `UseCases.tsx` | `UseCases.svelte` | `Carousel` of 6 use-case cards. |
| `ProtocolComparison.tsx` | `ProtocolComparison.svelte` | The MsgBoard/Waku/Nostr comparison table. |
| `NextSteps.tsx` | `NextSteps.svelte` | `Carousel` of CTA cards (literal Tailwind class strings preserved for purge). |
| `JoinNetwork.tsx` | `JoinNetwork.svelte` | The per-network provider support matrix. |
| `GamesCallout.tsx` | `GamesCallout.svelte` | The felt-table venue callout. |
| `Docs.tsx` | `Docs.svelte` | The "Simple API" request/response explorer. Reads the active RPC url from the chain store (`selectRpcUrl`) — the Svelte `chain.rpcUrl` derived. `localStorage['docs']` lang/method persistence kept. |
| `OpenRpcReference.tsx` | `OpenRpcReference.svelte` | Structured JSON-RPC methods + schemas from the `openrpc` object; the Svelte `{#snippet typeRef}` → a `TypeRef` sub-component; click-to-scroll cross-links. |
| `GamesLiveProof.tsx` | `GamesLiveProof.svelte` | Re-verifies the venue's latest settled coin flip from raw chain events every 15s (viem `createPublicClient` + `getContractEvents`), cancel-guarded across the async loop. |

The Task-4 MVP components (`Interactive`, `SelectChain`, `Category`, `MessageInput`,
`PresetButtons`, `Terminal`, `TreeView`, `Summary`, `RequestSnapshot`, `ToggleButton`, `Info`,
`Copy`) are unchanged except for the two carry-forward fixes below.

---

## The iconify swap (`@iconify/svelte` → `@iconify/react`)

Every Svelte `import Icon from '@iconify/svelte'` (the ~22-file usage) maps to
`import { Icon } from '@iconify/react'` with `class=` → `className=`. `@iconify/react@^5.0.2`
was already a declared dependency (added in the scaffold); no new install. The leaf components
already on `@iconify/react` from Task 4 (`Copy`, `Info`, `ToggleButton`, `TreeView`) set the
pattern; Task 5 applies it to the long-tail set (`Welcome`, `Footer`, `Carousel`, `SalesPitch`,
`UseCases`, `NextSteps`, `JoinNetwork`, `GamesCallout`, `Docs`, `Examples`, `Games`).

**Test (`test/components.test.tsx` → "iconify swap"):** asserts the `<Icon>` renders an inline
`<svg>` carrying the requested icon name and that the name never leaks into page text (no
missing-icon placeholder regression). See the test-harness note on the iconify timer below.

---

## The docs / shiki pipeline (`DocsPortal`)

Byte-for-byte the Svelte logic, in a `useMemo`:

- `markdown-it` (`html: false, linkify: true, breaks: false`) with `highlight: (code, lang) =>
  highlightToHtml(code, lang)` — the **same shiki instance** as `<Code>` (Task-3
  `highlighter.ts`), so prose code fences are highlighted, not plain.
- A `heading_open` renderer rule stamps every heading with `slugify(...)` (Task-3
  `section-nav.ts`) so the side-TOC can scroll to it.
- Splits the README at `<!-- GENERATED:OPENRPC:START/END -->`: the prose stays markdown
  (`beforeHtml`/`afterHtml`), the reference is rendered by the structured `OpenRpcReference`
  (from the same `openrpc` object). HTML comments are stripped so `html:false` markdown-it does
  not print them literally.
- The `.docs-prose` and `.games-prose` scoped `<style>` blocks (Svelte `:global(...)`) moved
  into `src/app.css` as plain `.docs-prose …` / `.games-prose …` rules (verbatim declarations).

**Tests (`test/docs-portal.test.tsx`, 4):** rendered H2s carry slug ids (e.g. `#install`);
fenced blocks get shiki classes (`pre.shiki`); the structured OpenRPC heading + `msgboard_status`
render; the `GENERATED:OPENRPC` comment markers are stripped from the output.

---

## Full hash-router wiring + route coverage vs the Svelte app

`App.tsx` now subscribes to the Task-3 ported hash router (`useRoute()`, NOT react-router) and
renders one page per route id, keeping the two global lifecycle effects
(`startChainPolling()` + `initThemeOSListener()`, mounted/torn-down in a `useEffect`).

| `#/route` | Svelte `App.svelte` | React `App.tsx` |
| --- | --- | --- |
| `/` (or empty hash) | `Home` | `Home` |
| `/docs` | `DocsPortal` | `DocsPortal` |
| `/examples` | `Examples` | `Examples` |
| `/games` | `Games` | `Games` |
| anything else | `RedirectToHome` → `#/` | `RedirectToHome` → `#/` |

Identical mapping; every route the Svelte app served resolves the same page here.
Cross-page nav links (`#/docs`, `#/examples`, `#/games`, `#/`, `#interactive`) are preserved
verbatim in the ported markup, and `?section=` deep-links stay in `section-nav.ts` (Task-3
byte-copy), so they cannot disturb the route.

**Tests (`test/routes.test.tsx`, 5):** each `#/route` renders its page (assertions scoped to a
unique element per page, since `SideToc` re-lists heading labels as nav buttons); an unknown
route redirects the hash back to `/`.

---

## Task-4 review carry-forwards

**1. Reload persisted interactive state on a mid-session chain switch.** `Interactive` now
derives the persist `scope` reactively from the chain store (`chainOption`/`customRpcUrl` →
`getScope`). A focused effect — gated on a `prevScopeRef` so it skips the mount run and only
fires on an actual scope change — reloads `loadTreeNodeState(scope)` and re-seeds the six
interactive fields from `load(scope, 'interactive', …)`. This mirrors the Svelte scope-change
`$effect`. **Test (`test/chain-switch-reload.test.tsx`):** seed a persisted body for
`pulsechainV4`'s scope, mount on another chain, switch — the textarea adopts the persisted text.

**2. `Summary.decodeAll` live propagation.** The Svelte source shared a `$state({ value })`
holder between `Summary` (the toggle) and every `TreeView` node. The Task-4 React port made it a
plain module object + a local re-render bump, so flipping it only re-rendered the toggle. It is
now a tiny **external store**: the `.value` get/set API is unchanged (so `loadTreeNodeState` and
the chain-switch reload keep working), but the setter notifies a subscriber set. Both `Summary`
and every `TreeView` node read it via `useSyncExternalStore`, so flipping "decode all"
re-renders **all** mounted nodes live. **Test (`test/decode-all-propagation.test.tsx`):** with a
non-auto-decoding category, flipping the Summary toggle flips a sibling `TreeView` leaf from raw
hex to decoded text.

---

## Tests (TDD: RED → GREEN) + build

New Task-5 test files (written first, confirmed RED on the missing pages/components, then GREEN):

- `test/routes.test.tsx` (5) — full hash-router route coverage.
- `test/docs-portal.test.tsx` (4) — the markdown + shiki + OpenRPC pipeline.
- `test/components.test.tsx` (13) — every long-tail component renders + the iconify swap.
- `test/decode-all-propagation.test.tsx` (1) — decode-all live cross-node propagation.
- `test/chain-switch-reload.test.tsx` (1) — persisted-state reload on chain switch.

```
cd packages/ui-react && ../../node_modules/.bin/vitest run
→ Test Files 18 passed (18)
→      Tests 81 passed (81)
```
(57 prior Task-1..4 tests + 24 new Task-5 assertions.)

```
../../node_modules/.bin/tsc --noEmit -p tsconfig.json   → exit 0
../../node_modules/.bin/vite build                      → exit 0
  dist/assets/pow-worker-qRrVn4O0.js   929.72 kB   ← off-main-thread chunk, hash byte-identical
                                                     to Task-2/Task-4 (worker bundling intact)
  dist/assets/index-*.js             1,715.73 kB   ← main entry; grew (markdown-it + shiki +
                                                     the full landing page now ship), expected
```
The >500 kB warning is the SDK + viem + shiki size (same as cosign-web / Task 4).

---

## Deviations from the plan / Svelte source

1. **Plan file absent.** `2026-06-24-ui-react-migration.md` is referenced by the Task-1..4
   reports but is not on disk or in git history in this checkout. Task-5 scope was reconstructed
   from the Task-4 report's downstream notes + the live Svelte source (see the note at the top).
2. **No svelte transitions.** `Welcome`'s rotating word used Svelte `fly` in/out; the React port
   uses a `key`-ed `<span>` swap (instant). Same content/copy; the entrance animation is dropped.
   Cosmetic only.
3. **`Code`/`DocsPortal` use `dangerouslySetInnerHTML`** for the shiki/markdown output — the
   direct equivalent of the Svelte `{@html}`. The content is trusted, build-time-generated
   (`docs-content.generated.ts`, `html: false` markdown-it, the shared shiki highlighter), not
   user input — same trust posture as the Svelte source.
4. **`.docs-prose`/`.games-prose` styles moved to `app.css`.** Svelte scoped `<style>` with
   `:global(...)` has no per-component-CSS equivalent in this Vite+React setup; the rules are
   global classes now (verbatim declarations). No visual change.
5. **`Docs`/`Footer` read from the zustand stores** (`selectRpcUrl`, `useThemeStore`) rather than
   the Svelte `chain`/`theme` singletons. Same rendered output (Task-3 carry-forward).
6. **Test-harness: `@iconify/react` stubbed in `test/setup.tsx`.** The real `Icon` lazy-loads
   non-bundled icon data (`mdi:*`, `ph:*`, …) over the Iconify API and defers the update through
   an internal `setTimeout`; with no network in jsdom that timer fires *after* teardown, emitting
   noisy "caught after teardown" errors. The setup mocks `Icon` to a synchronous
   `<svg data-icon={icon}>` — faithful to the swap (components still import `Icon` from
   `@iconify/react` and pass `icon`/`className`) and deterministic, with no dangling timer.
   Production is unaffected (test-scoped). The shiki `.shiki` assertions use the real highlighter.
7. **No `.prettierrc` in `packages/ui-react`** (a pre-existing Task-1..4 gap — the Svelte
   `packages/ui` has one). New files were formatted with the project's `packages/ui/.prettierrc`
   (single-quote, no-semi, 100-col, `trailingComma: all`, `bracketSameLine: true`) to match the
   established style. `npm run lint` (`prettier --check .` with no config) reports the repo's
   no-semi style as "issues" for the *pre-existing* files too, so it is a baseline config
   artifact, not a Task-5 regression.

---

## Concerns / notes for downstream tasks

- **Real-network proofs are deferred to Task 6 (Playwright).** `GamesLiveProof` and the board
  flow are exercised with mocked viem/SDK in jsdom; the authoritative "live chain read renders"
  + "main thread stays responsive during a real grind" proofs are the Task-6 parity gate.
- **`Examples` route exists in React but not in `Welcome`'s nav** — it is reached via `NextSteps`
  / direct `#/examples` (same as Svelte: the Svelte `Welcome` also links only `#/docs`). Parity
  preserved; flagging in case the Task-6 gate expects a top-nav Examples link.
- **Main bundle is large (1.7 MB).** Code-splitting the docs/markdown route (dynamic
  `import()` of `DocsPortal` + markdown-it/shiki) is a Task-6/7 perf option; left as-is for
  byte-parity with the Svelte single-bundle build this task.
- **`SideToc` re-lists heading labels as nav buttons**, so several page texts appear twice in the
  DOM (heading + nav). Route/page tests scope to a unique element (the chain selector, a role-
  scoped heading, the "Try it now" CTA) — keep that in mind when adding parity assertions.
