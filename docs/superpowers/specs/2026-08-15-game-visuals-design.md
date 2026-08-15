# Game Visuals — design

**Status:** design, awaiting review
**Date:** 2026-08-15
**Surface:** `games/web` — the live game screens on games.msgboard.xyz
**Scope classification:** architectural (a shared visual/motion layer across the game catalog)

## Problem

Every game screen today is abstract: a probability strip, stat tiles, and a
text receipt. There is no game object anywhere — no die on Dice, no card on
Baccarat, no wheel on Roulette. A search of `games/web/src/components/*Screen.tsx`
finds zero `<canvas>`, `<svg>`, or animation. The reference `DiceScreen`
(its own header comment calls it "the template the other session games follow")
renders a `ProbabilityStrip` with a marker plus a `BetTray`. Every other session
game copies that shape.

The owner's critique: the games are "too number heavy rather than relying on
visuals." Opening Dice, "there are no dice."

## Goal

Give each game a real, on-brand visual that animates to the outcome — while
keeping the number-first view for players who prefer it.

## Decisions (approved in chat)

1. **Two presentation modes, one toggle, remembered per player.**
   - **Visual — the default.** The game object animates and lands on the result.
   - **Classic — opt out.** Today's probability strip + stat tiles, plus a small
     game glyph (the "Accent" mockup treatment). Number-lovers lose nothing.
   - Players **opt out of Visual**, not into it. The preference persists in
     `localStorage` (one key, all games).
2. **Clean 2D motion** is the visual style — SVG/CSS, felt-and-brass, small
   bundle. (Skeuomorphic 3D was mocked and rejected: weak render, poor
   effort-to-payoff.)
3. **The animation only reveals the sealed outcome.** It never generates or
   influences the result. This is the one hard rule — see Provably-fair binding.
4. **Prototype on Dice first**, lock the pattern (layer + toggle + persistence),
   then roll out game-by-game.

Reference mockup (interactive, throwaway): the three directions + the live
toggle were built and reviewed at an Artifact page on 2026-08-15.

## Architecture

### A shared motion layer (new)

A small set of reusable primitives under `games/web/src/components/visuals/`
so the catalog reuses one implementation, not 28 bespoke ones:

- **`PresentationMode` context + `usePresentationMode()`** — holds `'visual' |
  'classic'`, reads/writes the `localStorage` key, exposes a setter. A single
  toggle control (`<PresentationToggle />`) lives in the game stage header.
- **`NumberDie`** — the Clean-2D die: a rounded tile whose number flurries then
  lands on a given final value, with win/lose styling. Driven by a prop, not by
  its own RNG.
- **`useReveal(finalValue)`** — the shared "spin then settle on the committed
  value" helper (flurry duration, easing, `prefers-reduced-motion` short-circuit
  to an instant set). Every game object uses it so timing is consistent.
- The existing **`ProbabilityStrip`** stays as the Classic-mode centrepiece; it
  gains the small game glyph.

Each game keeps its own screen; only the stage body swaps between
`<VisualObject outcome=… />` and `<ProbabilityStrip … />` based on
`usePresentationMode()`.

### How a game maps outcome → object

The session already produces the settled result (the roll, the drawn cards, the
wheel index). The visual object takes that value as a prop and reveals it. No new
data, no new network calls.

| Game family | Visual object (Clean 2D) |
|---|---|
| Dice, Dice X2, Limbo | number die that lands on the roll |
| Roulette, Wheel | wheel that spins to the winning index |
| Plinko, Pachinko | ball that drops to the landing bucket |
| Baccarat, Dragon Tiger, Andar Bahar, Pai Gow, Monte | card(s) that flip face-up |
| Mines | grid tiles that flip to gem/mine |
| Towers, Chicken, Greed Dice, Cipher (ladder family) | step tiles that reveal per rung |
| Keno, Cascade, Crash, others | per-game reveal reusing `useReveal` |

Dice is the reference. Later games are separate, small rollout tasks that each
add one `VisualObject` and wire it in — the layer and toggle already exist.

## Dice reference implementation

In `DiceScreen.tsx`, replace the single `<ProbabilityStrip>` stage body with a
mode switch:

- **Visual:** `<NumberDie outcome={roll} target={targetPct} />` — flurries on
  roll, lands on the sealed roll, colours win/lose, shows the win/lose verdict.
- **Classic:** the existing `<ProbabilityStrip>` + stats, plus a small die glyph.
- Header gains `<PresentationToggle />`.

No change to session logic, betting, commit/reveal, or settlement.

## Provably-fair binding (hard rule)

- The visual reads the result **after** it is known from the co-signed session —
  the same value the receipt shows. The RNG commit still lands before the bet.
- The animation is pure presentation. If reduced motion is on, or the animation
  is interrupted, the revealed number is unchanged.
- No `Math.random()` decides anything shown as an outcome. (The mockup used
  random rolls for demo only; the real screen never does.)

## Accessibility & performance

- Honour `prefers-reduced-motion`: skip the flurry, set the final state directly.
- Keyboard: the toggle is a real button pair with focus states; the die/objects
  are not interactive controls (the Roll button drives play).
- Bundle: SVG/CSS only, no sprite sheets, no animation library. The layer is a
  few small components.

## Testing

- Unit (vitest): `NumberDie` lands on the exact value it is given; `useReveal`
  resolves to `finalValue`; reduced-motion path sets instantly; the mode context
  reads/writes `localStorage` and defaults to `visual`.
- Manual: on 943, roll Dice in both modes; confirm the die/strip shows the same
  number as the receipt; toggle persists across reload.

## Deploy / logistics (flagged, decided at implementation time)

The live SPA on games.msgboard.xyz is **behind `master`** (its bundle predates
the operator-assets/backroom merges). A normal `games/web` rebuild ships all of
`master`. Before deploying the visuals we choose:

- (a) isolate the change onto the currently-live version and deploy only that, or
- (b) ship `master` (a broader launch of already-merged, still-gated features).

This does not affect the design; it is a release decision. Deploy still runs
through `ansible/deploy-games-web.yml`.

## Out of scope (YAGNI)

- Skeuomorphic 3D / physics.
- Sound.
- Theming/skins interplay (the operator theming engine is separate; visuals must
  not assume a skin).
- Rolling out beyond Dice in this first change — the catalog rollout is a series
  of follow-on tasks that reuse this layer.

## Success criteria

- Dice shows a die that lands on the real roll, by default.
- A player can opt out to Classic; the choice sticks.
- The layer + toggle are reusable, so the next game is a small addition.
- No change to odds, settlement, or the provably-fair guarantee.
