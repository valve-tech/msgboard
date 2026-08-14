# Operator Assets — System 1a: the theming engine

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Build the reusable theming engine — an `AssetRef` abstraction, a hash-committed theme manifest, a four-tier sandboxed renderer, and a skin-point allowlist that keeps trust chrome unskinnable — and wire it to the shared stage surfaces every game already renders on.

**Architecture:** A pure `theme/` web module (manifest parse + validate + resolve) plus a thin renderer that maps validated skin points to CSS custom properties / `<img>` / sandboxed `<iframe>`. Themes apply ONLY through a named skin-point allowlist; anything not on the allowlist (all trust chrome, all amounts/odds) cannot be themed — enforced structurally, not by blocklist. Data source is a theme manifest object; this slice feeds it from a static/prop source, and later slices feed it from `setMetadataURI`/`setTheme` events once the indexer + operator-game UI exist.

**Tech Stack:** React + Vite (games/web), TypeScript, vitest; CSS custom properties in table.css.

**Spec:** `docs/superpowers/specs/2026-08-13-operator-assets-program-design.md` §6 (+ the `AssetRef` table and skin-point/trust-chrome/sandboxing rules).

## Global Constraints

- **Trust chrome is unskinnable (I6).** The ◈ seal, the fairness strip / trust badges / how-it-works, ALL amounts/odds/multipliers/receipts/seed proofs, alert lanes, and wallet/network chrome are OUTSIDE the skin-point allowlist and cannot be themed. Enforced by allowlist (a theme can only touch a named skin point), never by blocklist.
- **Four representation tiers, strict sandboxing:** `declarative` → CSS custom properties (no execution); `media` → `<img>` only (SVG via `data:` img, which neuters scripts); `erc1155` → resolves to media, rendered as media; `generative` (on-chain js/html/svg) → sandboxed `<iframe sandbox="allow-scripts">` (NO `allow-same-origin` → opaque origin, no storage), CSP `default-src 'none'`, no network, `postMessage` carries only `{w,h,theme}` — never wallet/round data. On any table-global surface, generative renders as a STATIC poster until the viewer clicks to activate, and `prefers-reduced-motion` keeps it static.
- **Integrity:** every `media`/`erc1155`/`generative` ref carries a `contentHash`; the renderer refuses a resolved asset whose hash doesn't match (a CDN swap can't change a live surface). Hash verification and any heavy decode run in a Web Worker, never the main thread.
- **Trust-adjacent surfaces stay declarative-only:** surfaces where color encodes payout tier (wheel wedges, drop-board tints) may restyle hue families but the renderer keeps the tier→family mapping and the legend; these accept `declarative` only.
- **Fail safe:** an unknown/unfetchable/hash-mismatch/failing-contrast asset falls back to the house default; a theme can never block or break a surface.
- House UI rules: no native form controls; table.css design language; text wraps not clips.

---

## File Structure

- `games/web/src/lib/theme/assetRef.ts` (create) — `AssetRef` type + parse/normalize + `kind` guard.
- `games/web/src/lib/theme/manifest.ts` (create) — theme manifest type, parse + validate (skin-point allowlist, per-surface allowed kinds, contrast check), returns a safe normalized manifest (drops anything invalid).
- `games/web/src/lib/theme/skinPoints.ts` (create) — the canonical skin-point registry: each entry = { id, surface, allowedKinds, trustAdjacent }. Trust chrome is simply absent from this registry (unskinnable by construction).
- `games/web/src/lib/theme/resolve.ts` (create) — resolve an `AssetRef` to a render instruction; hash-verify (in a worker for media/generative); fall back to house default on any failure.
- `games/web/src/lib/theme/*.test.ts` (create) — unit tests: allowlist enforcement, trust-chrome rejection, per-surface kind rejection, contrast fallback, hash-mismatch fallback.
- `games/web/src/components/theme/ThemeProvider.tsx` (create) — takes a validated manifest, exposes resolved declarative tokens via context + a `useSkin(skinPointId)` hook.
- `games/web/src/components/theme/SkinnedAsset.tsx` (create) — renders a resolved skin point at its correct tier (CSS var / `<img>` / sandboxed `<iframe>` with the poster-until-click behavior).
- `games/web/src/components/theme/GenerativeFrame.tsx` (create) — the sandboxed iframe wrapper (CSP, no-same-origin, postMessage-limited, poster/reduced-motion).
- Wire into the shared stage surfaces (modify, discovered from the codebase): the felt/backdrop/card-back skin points in `games/web/src/styles/table.css` (CSS custom properties) and the stage components under `games/web/src/components/` that render them.

**Discovery step (do first):** grep table.css + the stage components for the real themeable surfaces (felt color/texture, backdrop, `.playcard.back`, chip/coin faces, table plaque, accent palette, wheel-wedge/drop-board tints) and the ◈ seal / trust strip elements. Build `skinPoints.ts` from what actually exists; list the trust-chrome elements you are deliberately excluding.

---

## Task 1: `AssetRef` + skin-point registry + manifest validator (pure, TDD)

**Files:** create `assetRef.ts`, `skinPoints.ts`, `manifest.ts` + `manifest.test.ts`.

**Interfaces:**
- Produces: `type AssetRef = { kind: 'declarative'|'media'|'erc1155'|'generative'; pointer: string; contentHash?: Hex }`; `SKIN_POINTS: Record<string, { surface: string; allowedKinds: AssetRef['kind'][]; trustAdjacent: boolean }>`; `parseManifest(raw: unknown): { skins: Record<string, AssetRef>; palette: Record<string,string> }` (returns a normalized manifest with every invalid entry DROPPED).

- [ ] **Step 1: Discovery** — grep `games/web/src/styles/table.css` and the stage components for the real skin surfaces and the trust-chrome elements (◈ seal, trust strip, amount displays). Write `skinPoints.ts` listing only themeable surfaces; add a comment block naming the excluded trust-chrome elements.

- [ ] **Step 2: Write the failing tests** (`manifest.test.ts`) — assert `parseManifest`:
  - drops a skin targeting a non-existent / trust-chrome skin-point id (e.g. `"trustSeal"`, `"betAmount"`) — the result has no such key;
  - drops a skin whose `kind` is not in that skin point's `allowedKinds` (e.g. `generative` on a `declarative`-only wheel-wedge surface);
  - drops a `media`/`generative` ref with no `contentHash`;
  - drops a declarative palette entry that fails the contrast check against trust-chrome text;
  - keeps a valid declarative felt-color skin and a valid media card-back skin.

Run: `cd games/web && npx vitest run src/lib/theme/manifest.test.ts` → FAIL (module absent).

- [ ] **Step 3: Implement** `assetRef.ts` (type + `parseAssetRef` normalizing the four pointer forms from the spec), `skinPoints.ts`, and `manifest.ts` (`parseManifest` enforcing: skin-point membership, per-surface `allowedKinds`, required `contentHash` for non-declarative, contrast check for palette entries; drop-on-invalid, never throw).

- [ ] **Step 4:** `npx vitest run src/lib/theme/manifest.test.ts` → PASS. `npx tsc --noEmit` clean.
- [ ] **Step 5: Commit** — `git commit -m "feat(assets-s1): theming AssetRef + skin-point allowlist + manifest validator (trust chrome unskinnable)"`

---

## Task 2: Sandboxed resolver + renderer components

**Files:** create `resolve.ts`, `ThemeProvider.tsx`, `SkinnedAsset.tsx`, `GenerativeFrame.tsx` (+ tests where logic warrants).

**Interfaces:**
- Consumes: `AssetRef`, `SKIN_POINTS`, `parseManifest` (Task 1).
- Produces: `<ThemeProvider manifest>`, `useSkin(id)`, `<SkinnedAsset skinPoint=... fallback=...>`.

- [ ] **Step 1:** `resolve.ts` — resolve an `AssetRef` to a render instruction; for `media`/`erc1155`/`generative`, fetch + hash-verify in a Web Worker; return the house `fallback` on any failure (unknown kind, fetch error, hash mismatch). Unit-test the fallback paths with a mocked worker/fetch.
- [ ] **Step 2:** `GenerativeFrame.tsx` — `<iframe sandbox="allow-scripts">` (no `allow-same-origin`), CSP `default-src 'none'` on the frame doc, no network, `postMessage` only `{w,h,theme}`; renders a static poster until click-to-activate; stays static under `prefers-reduced-motion`.
- [ ] **Step 3:** `SkinnedAsset.tsx` — dispatch by kind: declarative → apply CSS custom properties; media/erc1155 → `<img>` (never `<object>`/`<embed>`); generative → `GenerativeFrame`. `ThemeProvider` supplies validated tokens via context + `useSkin`.
- [ ] **Step 4:** `npx tsc --noEmit` clean; vitest for resolver tests pass.
- [ ] **Step 5: Commit** — `git commit -m "feat(assets-s1): sandboxed theme resolver + renderer (declarative/media/generative tiers, worker hash-verify)"`

---

## Task 3: Wire the engine to the shared stage surfaces

**Files:** modify table.css skin points + the stage components discovered in Task 1.

- [ ] **Step 1:** Expose the themeable surfaces as CSS custom properties (felt color/texture, backdrop, card-back, chip/coin faces, accent palette) so a declarative theme sets them via `ThemeProvider`. Leave the ◈ seal + trust strip + amount displays hard-coded (unskinnable).
- [ ] **Step 2:** Render a card-back `media` skin and a backdrop `generative` skin (poster-until-click) through `SkinnedAsset` on the shared stage, driven by a manifest prop (static demo manifest for now; later fed by chain events).
- [ ] **Step 3: Browser verification (house rule):** Playwright — apply a demo theme and screenshot: felt recolored, card back swapped, backdrop poster shown; then assert the ◈ seal and a bet-amount display are UNCHANGED by a theme that (invalidly) tries to target them. Assert no native controls, no horizontal scroll.
- [ ] **Step 4: Commit** — `git commit -m "feat(assets-s1): apply the theming engine to the shared stage surfaces; trust chrome stays fixed"`

---

## Deferred to later slices (documented, not silently dropped)

- **Operator-level theming source** (`OperatorRegistry.setMetadataURI` → `MetadataSet`, theme key) and **per-table theming** (`setTheme`/`TableThemed` on the new OperatorCoinFlip version) — both need the operator event indexer (currently on the backroom-b branch) and the operator-game player UI (does not exist yet). They bundle with the System 2 game redeploy + the operator-game UI build. This slice builds the engine they will feed.
- Contrast-validation thresholds and the exact generative CSP are set here and reused unchanged.

## Self-Review

- **Spec coverage:** §6 AssetRef → Task 1; skin points + trust-chrome exclusion → Task 1 (registry) + Task 3 (wiring); sandboxing tiers → Task 2; contentHash integrity + worker → Task 2; trust-adjacent declarative-only → Task 1 validator. Operator-level/per-table sourcing → explicitly deferred with the reason.
- **No placeholders:** each task has concrete files, tests, and acceptance; the frontend specifics the build discovers from table.css are called out as an explicit discovery step, not a vague "handle it".
- **Leak/trust safety:** trust chrome is unskinnable by construction (absent from the registry), and the generative tier is sandboxed with no same-origin/network/round-data — the two properties most likely to cause harm if wrong.
