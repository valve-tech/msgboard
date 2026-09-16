# Games trust-gate demotion (redesign Phase 2)

Date: 2026-07-29
Status: design / awaiting review
Scope: `games/web` view layer only. No trust-model, acknowledgment, or gating-logic change.

## Problem

The Phase-1 "sitting at a table" redesign made every game's stage dominant — except the
**trust chrome still leads every page**. `App.tsx` renders the full `CryptoShowcase` panel
(the "THE CRYPTOGRAPHY · Sealed before you play" lead heading + Sealed/Revealed/Recomputed
cards + a proof-of-work callout, ~164 lines) above the stage on every game, keyed by the
game's trust model. On a first visit (before acknowledgment) it fills the top half of the
viewport and pushes the game below the fold — the exact "explainer over game" anti-pattern
the redesign set out to kill.

`TrustBanner` (the `.trust-strip`) is *already* the demoted form: a single always-visible
"Provably fair — <model line>" sentence + an ⓘ info-dot (expandable per-model detail) + a
"Got it" button that sets the per-(chain, model) acknowledgment and unblocks play. It is thin
and correct. The only thing making the page top-heavy is the redundant big `CryptoShowcase`
panel sitting beside it.

## Goal

Every game page leads with the **thin TrustBanner strip**, the **stage dominates immediately**,
and the rich explainer is **one click away** (the shell's "How it works" button, or the strip's
ⓘ). Trust acknowledgment and gating are unchanged.

## Design

### 1. Remove `CryptoShowcase` from the always-visible flow
Delete the `{trustModel && <CryptoShowcase … />}` render in `App.tsx` (the line above the
`TrustBanner`). Keep `TrustBanner` exactly where it is (the full-width `shell-chrome` row above
the stage/tray pair) — it is the slim gate and stays.

### 2. Move `CryptoShowcase` content into the "How it works" modal, model-aware
`HowItWorksModal` currently renders only the generic lobby-pitch copy and takes `{open, onClose}`.
Extend it to `{open, onClose, deployment, model }` where `model: TrustModel | null` is the active
game's trust model (already computed in `App.tsx` as `trustModel`).
- When `model` is set: the modal body renders the **model-aware `CryptoShowcase` content** for
  that model (validator randomness / co-signed tables / zero-knowledge / peer-duel) — reusing
  `CryptoShowcase`'s existing `copyFor(model)` output (lead + Sealed/Revealed/Recomputed + PoW),
  so the four genuinely different trust stories are told accurately and the modal matches the
  strip's one-liner.
- When `model` is null (lobby / standings / live): the modal keeps the current **generic pitch**
  copy as the fallback.

`CryptoShowcase`'s existing `.cs-*` styling was authored for an above-the-fold panel; rendering it
inside the modal may need a light width/padding adjustment in the modal container, but no rewrite —
the component is reused, not rebuilt.

### 3. Nothing else changes
- `TrustModel` keying, `isTrustAcknowledgedFor`, the `modelAckKey` storage, and the
  `trustAcknowledged`/`trustModelFor(tab)` gating in `App.tsx` are untouched. Play is still gated
  on the strip's "Got it".
- The "How it works" openers are unchanged: the shell top-bar button and each migrated table's
  `HowItWorksLink` title action already raise the shared modal via context.
- The other 29 non-migrated screens are unaffected (they render inside the shell as before; they
  just no longer have the big panel above them either).

## Components touched
- `games/web/src/App.tsx` — drop the `<CryptoShowcase>` render; pass `deployment` + `model={trustModel}`
  to `<HowItWorksModal>`.
- `games/web/src/components/HowItWorks.tsx` — `HowItWorksModal` accepts `deployment` + `model`; renders
  the model-aware `CryptoShowcase` content when `model` is set, generic pitch otherwise.
- `games/web/src/components/CryptoShowcase.tsx` — reused as-is; if its body isn't already separately
  renderable, expose the inner content (the `copyFor(model)` block) so the modal can render it without
  the outer above-the-fold wrapper. No copy changes.
- `games/web/src/styles/table.css` / modal styles — minor width/padding so the reused `.cs-*` block
  sits well inside the modal.

## Testing
- Manual browser smoke (the key deliverable is visual): on a migrated game (e.g. Blackjack), the page
  now leads with the thin strip + stage; the big panel is gone; clicking "How it works" (top bar or
  title) opens the modal showing the **active model's** explainer; on the lobby it shows the generic
  pitch.
- Gating unchanged: before "Got it", play stays disabled; after, it unblocks and the strip shows
  "✓ understood". Verify per (chain, model) via `isTrustAcknowledgedFor`.
- `npm run typecheck && npm run build` green; existing 11 unit tests still pass (no logic touched).

## Non-goals
- No change to trust models, acknowledgment storage, or what content the explainer says (copy is reused
  verbatim). No new dependency. No change to the 5 migrated stages or the shell layout.
