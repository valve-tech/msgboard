# Games trust-gate demotion (Phase 2) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the big `CryptoShowcase` trust panel from leading every game page — keep the thin `TrustBanner` strip as the gate and move `CryptoShowcase`'s model-aware content into the "How it works" modal.

**Architecture:** View-layer only. `HowItWorksModal` gains optional `deployment` + `model` props and renders `<CryptoShowcase>` when a model is present (generic pitch otherwise). `App.tsx` drops the in-flow `<CryptoShowcase>` and passes `deployment` + `model={trustModel}` to the modal. No trust-model, acknowledgment, or gating change.

**Tech Stack:** React 18 + TypeScript + Vite. `CryptoShowcase` is reused as-is.

## Global Constraints

- **No trust-model / acknowledgment / gating change.** `TrustBanner`, `isTrustAcknowledgedFor`, `modelAckKey`, and the `trustAcknowledged`/`trustModelFor(tab)` logic in `App.tsx` are untouched. Play stays gated on the strip's "Got it".
- **No copy change.** `CryptoShowcase`'s `copyFor(model)` text and the generic pitch text are reused verbatim.
- **No new dependency.**
- **Gate:** `cd games/web && npm run typecheck && npm run build` must both pass. Known pre-existing table.css CSS-minifier comment warnings are fine.
- **Spec:** docs/superpowers/specs/2026-07-29-games-trust-gate-demotion-design.md
- **Commit trailer:** `Claude-Session: https://claude.ai/code/session_0161cE6gVKQ1ovVPiUhZDa4Y`, on branch `feat/games-trust-gate-demotion`.

## File Structure

- Modify: `games/web/src/components/HowItWorks.tsx` — `HowItWorksModal` accepts `deployment?` + `model?`, renders `<CryptoShowcase>` when both present, generic pitch otherwise.
- Modify: `games/web/src/App.tsx` — drop the in-flow `<CryptoShowcase>` render + its import; pass `deployment` + `model={trustModel}` to `<HowItWorksModal>`.
- Modify (if needed): `games/web/src/styles/table.css` or `app.css` — minor rule so the reused `.crypto-showcase` block sits cleanly inside the modal.

---

### Task 1: HowItWorksModal renders model-aware CryptoShowcase

**Files:**
- Modify: `games/web/src/components/HowItWorks.tsx`

**Interfaces:**
- Consumes: `CryptoShowcase` from `./CryptoShowcase` (`({deployment: GameDeployment, model: TrustModel})`), `GameDeployment` from `../config`, `TrustModel` from `./TrustBanner`.
- Produces: `HowItWorksModal({ open, onClose, deployment?, model? }: { open: boolean; onClose: () => void; deployment?: GameDeployment; model?: TrustModel | null })`. When `model` and `deployment` are both truthy, the modal body renders `<CryptoShowcase deployment={deployment} model={model} />`; otherwise it renders the existing generic pitch. The header row (title + Close) and the overlay/Esc behavior are unchanged. Props are OPTIONAL so this task typechecks without the App change (Task 2).

- [ ] **Step 1: Add imports + widen the signature**

At the top of `HowItWorks.tsx` add:
```tsx
import { CryptoShowcase } from './CryptoShowcase'
import type { GameDeployment } from '../config'
import type { TrustModel } from './TrustBanner'
```
Change the modal signature to:
```tsx
export const HowItWorksModal = ({ open, onClose, deployment, model }: {
  open: boolean
  onClose: () => void
  deployment?: GameDeployment
  model?: TrustModel | null
}) => {
```
Keep the existing `useEffect` (Esc), `if (!open) return null`, the `.hiw-overlay` wrapper, and the `.pitch` container exactly as they are.

- [ ] **Step 2: Branch the body on `model`**

Inside `<div className="pitch-body" …>`, keep the header row unchanged:
```tsx
<div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', margin: '0.6rem 0 0.2rem' }}>
  <h3 style={{ margin: 0 }}>How the back room stays honest — and cheap</h3>
  <button className="secondary" onClick={onClose}>Close</button>
</div>
```
Then replace the fixed generic body (the `<p className="hero-pitch">` … `<p className="howit-footer">` block) with:
```tsx
{model && deployment ? (
  <CryptoShowcase deployment={deployment} model={model} />
) : (
  <>
    {/* existing generic pitch: hero-pitch <p>, the .howit 3-step block, and the .howit-footer <p> — unchanged */}
  </>
)}
```
Move the existing generic pitch JSX verbatim into the `else` branch — do not edit its copy.

- [ ] **Step 3: Typecheck**

Run: `cd games/web && npm run typecheck`
Expected: PASS (props optional; App.tsx not yet passing them, still compiles).

- [ ] **Step 4: Commit**

```bash
git add games/web/src/components/HowItWorks.tsx
git commit -m "feat(games-web): How-it-works modal renders model-aware CryptoShowcase"
```

---

### Task 2: Drop the in-flow panel + wire App.tsx + modal CSS fit

**Files:**
- Modify: `games/web/src/App.tsx`
- Modify (only if the visual smoke shows it's needed): `games/web/src/styles/table.css`

**Interfaces:**
- Consumes: `HowItWorksModal` (Task 1 signature), the existing `deployment`, `trustModel`, `howOpen`/`setHowOpen` in `App.tsx`.

- [ ] **Step 1: Remove the in-flow CryptoShowcase**

In `games/web/src/App.tsx`, delete the render line (currently ~line 221):
```tsx
{trustModel && <CryptoShowcase deployment={deployment} model={trustModel} />}
```
Then remove the now-unused import `import { CryptoShowcase } from './components/CryptoShowcase'` (confirm `CryptoShowcase` has no other use in App.tsx via grep first). Leave `TrustBanner` and everything else in that `shell-chrome` row exactly as-is.

- [ ] **Step 2: Pass deployment + model to the modal**

Change the `<HowItWorksModal .../>` render (currently `open={howOpen} onClose={() => setHowOpen(false)}`) to also pass:
```tsx
<HowItWorksModal open={howOpen} onClose={() => setHowOpen(false)} deployment={deployment} model={trustModel} />
```
(`trustModel` is `TrustModel | null` — matches the modal's optional `model` prop; on lobby/standings/live it's null → the modal shows the generic pitch.)

- [ ] **Step 3: Typecheck + build**

Run: `cd games/web && npm run typecheck && npm run build`
Expected: both PASS.

- [ ] **Step 4: Visual smoke + CSS fit (controller-run)**

The controller runs the dev server + browser to verify (subagents have no browser). Acceptance:
- On Blackjack (a `cosigned` game): the page leads with the thin trust strip + the felt stage; **the big CryptoShowcase panel is gone** from the flow.
- Clicking "How it works" (top-bar button OR the title-bar `ⓘ`) opens the modal showing the **cosigned** model's content (eyebrow "Co-signed tables", the Sealed/Revealed/Recomputed pillars, the PoW band).
- Switch to a `validator` game (e.g. The Numbers) and a `zk` game (Sudoku): the modal shows *that* model's content.
- On the Lobby: the modal shows the generic pitch (no model).
- Gating unchanged: before "Got it", play is disabled; after, "✓ understood" and play unblocks.
If the reused `.crypto-showcase` block looks cramped/clashing inside the `.pitch` modal container, add a minimal scoping rule (e.g. `.hiw-overlay .crypto-showcase { margin: 0 }` or a small padding reset) in `table.css` — smallest change that makes it sit cleanly. No copy or structural change.

- [ ] **Step 5: Commit**

```bash
git add games/web/src/App.tsx games/web/src/styles/table.css
git commit -m "feat(games-web): demote CryptoShowcase out of the game flow into How-it-works"
```

---

### Task 3: Lock the app to the viewport — no outer scrollbar, isolated pane scroll

**User directive (2026-07-29):** "the app needs to be full screen. no scrollbar. or rather, isolated scrollbar." The shell is already `.app { height:100vh }` with `.rail`/`.stagewrap` as `overflow-y:auto` isolated scroll regions and `.main { overflow:hidden }` (ticker pinned). The remaining leak is the **colophon**, rendered as a sibling *after* `.app` inside `#root`, which pushes `#root` past `100vh` and produces an outer page scrollbar.

**Files:**
- Modify: `games/web/index.html` (the `html`/`body`/`#root` rules)
- Modify: `games/web/src/components/shell/AppShell.tsx` (host the colophon inside the frame)
- Modify: `games/web/src/App.tsx` (move the colophon into the shell / pass it as a slot)

**Interfaces:**
- If a slot is cleanest: `AppShell` gains an optional `footer?: ReactNode` prop rendered as the last child of `.main` (a slim always-visible bar below the scrolling `.stagewrap`). Otherwise the colophon markup moves directly into `.main`.

- [ ] **Step 1: Lock the outer frame (index.html)**

Ensure the page itself never scrolls:
```css
html, body { height: 100%; margin: 0; overflow: hidden; }
#root { height: 100vh; height: 100dvh; overflow: hidden; }
```
(`#root` currently is `min-height` + flex-column to let the colophon flow below — replace that with a fixed-height, overflow-hidden frame now that the colophon moves inside `.main`.)

- [ ] **Step 2: Move the colophon inside the frame**

Relocate the colophon (the "a MsgBoard venue · run by valve" + contracts/msgboard links block) from being a sibling of `<AppShell>` to the **last child of `.main`**, below the scrolling `.stagewrap`, as a slim always-visible footer that stays within the `100vh` frame. Use an `AppShell` `footer?` slot (preferred) or inline it in `.main`. `.main` stays `overflow:hidden`; layout is ticker (fixed) → `.stagewrap` (`flex:1`, scrolls) → colophon (fixed, slim). Add a minimal `.colophon` style tweak if needed so it reads as a thin footer bar.

- [ ] **Step 3: Typecheck + build**

Run: `cd games/web && npm run typecheck && npm run build`
Expected: both PASS.

- [ ] **Step 4: Visual smoke (controller-run)**

Acceptance: at desktop and at 780px, the app fills the viewport with **no outer/page scrollbar**; scrollbars appear only inside the rail (when the 37-game list overflows) and inside the stage content (when a screen's content overflows); the colophon is visible at the bottom of the frame without scrolling the page; the WinTicker stays pinned at the top.

- [ ] **Step 5: Commit**

```bash
git add games/web/index.html games/web/src/components/shell/AppShell.tsx games/web/src/App.tsx
git commit -m "feat(games-web): lock the shell to the viewport — no outer scrollbar, isolated pane scroll"
```

---

## Self-Review

**Spec coverage:**
- Remove CryptoShowcase from flow → Task 2 Step 1 ✓
- Keep TrustBanner strip → untouched (Global Constraint) ✓
- Model-aware modal content → Task 1 Steps 1–2 + Task 2 Step 2 ✓
- Generic pitch fallback (null model) → Task 1 Step 2 else-branch ✓
- No trust/ack/gating change → Global Constraints; only render location moves ✓
- CSS fit → Task 2 Step 4 ✓
- Testing (visual smoke + gate + existing units pass) → Task 2 Step 4 + Global Constraint ✓

**Placeholder scan:** The Task 1 else-branch references "existing generic pitch JSX" — that is a deliberate *move it verbatim* instruction (the exact copy is in HowItWorks.tsx today and must not be edited), not an unwritten placeholder. All other steps carry concrete code.

**Type consistency:** `HowItWorksModal`'s new `deployment?: GameDeployment` / `model?: TrustModel | null` (Task 1) match what `App.tsx` passes (`deployment`, `trustModel: TrustModel | null`) in Task 2. `CryptoShowcase` is called with its exact `({deployment, model})` signature.
