# Games UI redesign — "sitting at a table"

Date: 2026-07-29
Status: design / awaiting review
Scope target: `games/web` (the games.msgboard.xyz SPA). No game-logic, contract, or
settlement changes.

## 1. Problem

Every game at games.msgboard.xyz renders as a flat inline form. `App.tsx` is a 34-way
`{tab === 'x' && <XScreen/>}` switch; each screen prints its own single-row wager form
(amount + a few pills + an action button + result text). On every game page the biggest,
boldest element above the fold is the *fairness/PoW explainer*, not the game — the game is
the smallest thing on its own page. There is no rendered "surface" for any game, no depth,
no per-genre identity: a dice game and a full card table are visually identical pills.

Research (`docs/superpowers/research/2026-07-28-morbius-vs-games-ux.md`, 14 screenshots)
identified the core lever: give every game a **dominant rendered stage** with the **bet
controls docked in a tray beside it**, and demote the explanatory chrome.

Goal: make each game feel like **sitting down at a table** — a dominant, textured, deep
play surface you look *at*, with controls as peripheral instruments — while keeping our own
"the house shows its work" brand (gold + felt, not a copied palette) and changing **no**
game logic.

## 2. Design principles

### 2.1 The shell (shared by every game)

A single app frame wraps all games:

- **Left icon rail** — slim, always-visible navigation. Replaces today's `Menu` dropdown
  + `GameNav` tab strip. Holds category groups + favorites/recent + The Floor + Standings +
  Live. (34 games do not all fit as icons — see §4.4.)
- **Win-ticker** (top) — human-readable social proof: `🏆 won 20.97 on Dice — 0x70…95e5`,
  not raw event-log strings (`coinflip entered · block 24987982`). Same LiveFeed data,
  reformatted.
- **Stage** (dominant, left/center, ~55–65% width) — the game's rendered surface.
- **Bet tray** (docked, right, `clamp(280px,25vw,350px)`) — amount → quick-set (½/2×/Min/Max)
  → primary action, in the same place every game. Never overlaps the stage.
- **Meta panel** (below the tray) — Recent/Chart/Stats tabs + session P&L, out of the primary
  sightline.
- **Fairness** — demoted from an above-the-fold block to a `ⓘ How it works` affordance in the
  title bar and a small `🤝 Provably fair — replay the transcript ↗` link under the tray. The
  content is retained, not deleted; it stops out-competing the game.

Responsive: below ~940px the tray reflows beneath the stage; the rail persists (hides under
~560px). Verified in mockups at 780px and 1440px.

### 2.2 The perspective rule

**Apply a tilted "seated" camera only to a surface that represents a horizontal real-world
play surface whose contents are icon-like** (cards, chips, betting circles) — things that stay
legible at an angle.

**Keep flat / head-on** any surface that is a screen, instrument, or a grid of numbers/tiles
the player must read or tap precisely. Depth there comes from elevation, inner shadow, glow,
and vignette — never camera tilt.

> Perspective serves immersion only where it doesn't fight legibility or interaction.

Roulette is the canonical split: the **wheel** (a spinning disc, no fine text) gets a gentle
tilt; the **betting board** (dense numbers you tap) stays flat.

### 2.3 Brand

Keep the existing "back room where the books stay open" identity: **gold (`#e8b93f`) + felt
green + dark ambient**. This maps naturally onto a real casino felt. We adopt spatial
structure and depth, not any external palette. All depth is pure CSS/SVG — **no new rendering
dependency** (no canvas lib, no WebGL, no image-asset pipeline).

## 3. The five stage archetypes

| Archetype | Perspective | Surface | Games |
|---|---|---|---|
| **Felt table** | Seated tilt (~58° `rotateX`, foreground rail, hand rendered large & close) | Oval green felt, wood rail, gold betting circles, embossed medallion, chip tray, cards dealt onto felt | Blackjack, Baccarat, Dragon Tiger, Andar Bahar, Three Card Poker, Pai Gow, Craps, Monte, Hi-Lo War |
| **Canvas** | Flat | Dark charted stage, big glowing multiplier + rising curve, history rail of past results | Crash (Limbo as a lighter variant) |
| **Probability strip** | Flat | `ROLL UNDER x` header + horizontal win/lose gradient bar with a glowing marker + 3 stat tiles (chance/multiplier/pays) | Dice, Dice X2, Limbo |
| **Wheel + board** | Wheel: gentle tilt · Board: flat | Tilted disc (real pocket colors, ball) + recent/hot/cold chips + full head-on numbered board | Roulette (European single-zero), Wheel (simpler head-on wheel) |
| **Reveal grid / board** | Flat | Grid or board of tiles/cells with glow on reveal, next-step multiplier pill, cash-out | Mines, Towers, Chicken, Firewalk, Heist, Plinko, Pachinko, Cascade, Keno, Cipher, ZK Sudoku, ZK Wordle |

Small flat variants reuse the grid/strip treatments:
- **Duels** (Coin Flip / Signed Flips / Hi-Lo ladder / Greed Dice / Video Poker) — flat
  card-hand or two-choice surface; peer-vs-peer duels keep their existing trust model.
- **Pools / numbers** (The Numbers / Lottery) — flat numbered-board treatment.

Every game maps to exactly one archetype, so the 34-game catalog is covered by ~5 stage
components rather than 34 bespoke layouts.

### 3.1 Roulette specifics (locked)

European single-zero, matching `games/msgboard-games/src/games/roulette.ts` (`POCKETS = 37`,
winning pocket `raw % 37`, structural 2.70% edge from the single green zero). **Not** American
double-zero: that would be a game-logic change (`% 38`, a 00 pocket, escrow ceiling over 38,
paytable, red mask, bot, tests, on-chain mirror) and would nearly double the house edge to
5.26% — against the "we don't bleed the odds" brand. The board renders the full 0–36 layout
(correct red/black colors, 2:1 columns, dozens, outside bets).

## 4. Component architecture

Grounded in the current `games/web/src` structure (48 components, one `<XScreen>` per game,
shared `StakeInput` / `Menu` / `Toggle` / `GameNav` / `Lobby` / `LiveFeed` / `TrustBanner` /
`CryptoShowcase` / `Meta`).

### 4.1 New shared shell components

- **`AppShell`** — the rail + ticker + stage/tray grid. `App.tsx` renders `<AppShell>` with the
  active `<XScreen>` slotted into the stage region; the giant switch stays but each branch now
  yields *stage content*, not a whole page.
- **`Rail`** — left icon navigation (replaces `Menu`-as-game-picker + `GameNav`). Categories +
  favorites/recent; `no-native-form-controls` rule still applies (house components only).
- **`WinTicker`** — consumes LiveFeed data, formats human-readable lines.
- **`GameStage`** — the bounded, elevated, vignetted surface container each screen renders into.
  Provides the frame, shadow, and (optional) a `tilt` prop for felt/wheel archetypes.
- **`BetTray`** — amount field + quick-set row + primary action slot + provably-fair link.
  Wraps the existing `StakeInput` (already continuous — see §6). Genre screens pass their
  action buttons/fields as children/slots.
- **`MetaPanel`** — Recent/Chart/Stats tabs + session P&L.

### 4.2 Stage components (the five archetypes)

`FeltTable`, `CanvasStage`, `ProbabilityStrip`, `WheelBoard`, `RevealGrid` — each a reusable
surface a family of screens composes. A screen becomes: pick a stage component, feed it the
game's state, render controls into `BetTray`.

### 4.3 What each `<XScreen>` keeps

Game logic, hooks, wallet/chain wiring, trust-model gating, verify/recompute — all unchanged.
The redesign is a **view-layer reshape**: screens stop emitting a form and start composing
`GameStage` + `BetTray`.

### 4.4 Rail with 34 games

The rail cannot show 34 icons. It shows: The Floor (lobby) · a small set of category groups
(Originals / Cards & Table / Wheels / Grids / ZK) that expand · favorites/recent · Standings ·
Live. **The Floor remains the full catalog** — and gets light per-genre tile identity (reuse
each archetype's stage background as the tile thumbnail) rather than 34 bespoke mini-scene
renders. Full bespoke tiles are a possible later enhancement, not in this pass.

### 4.5 Controls placement (recommendation)

Keep all controls in the **fixed right tray**, same position every game (predictable, matches
every archetype). Contextual on-rail action buttons during a live hand (Hit/Stand on the
foreground rail) are a tempting immersion boost but move controls between two places and add
per-game complexity — **deferred** as an enhancement, not in this pass. Open for review.

## 5. Scope & phasing

Confirmed scope: **shell + all five stage archetypes + migrate every game.** Suggested build
order (each a reviewable increment):

1. `AppShell` + `Rail` + `WinTicker` + `GameStage`/`BetTray`/`MetaPanel` skeleton, with one
   game per archetype migrated (Blackjack, Crash, Dice, Roulette, Mines) as the proof.
2. Migrate the rest of each archetype family.
3. The Floor (lobby) tile identity + rail categories.
4. Fairness relocation + win-ticker formatting cleanup.

## 6. Non-goals / already done / deferred

- **Continuous bet amounts** — already shipped (`d6a737e`); `StakeInput`/`parseStake` are
  continuous. `BetTray` wraps them; no re-work.
- **No game-logic / contract / settlement changes.** View layer only.
- **No new rendering dependency.** CSS/SVG depth only.
- **Deferred:** American roulette (rejected), contextual on-rail controls, full bespoke lobby
  tile art, canvas/WebGL hero animations (research option not taken).

## 7. Testing

- Component tests for `GameStage`/`BetTray`/`WinTicker` (render, slots, responsive class
  behavior).
- Existing per-screen logic/verify tests must stay green (view reshape must not touch logic).
- Responsive smoke: stage + tray reflow at ≤940px; rail hides ≤560px.
- Visual parity: each migrated screen still exposes the same actions/fields as before.
- Deploy unchanged: `ansible/deploy-games-web.yml` rsyncs the built `games/web/dist`
  (per [[deploys-via-ansible-runbook]]); body-aware smoke already guards it.

## 8. References

- Research: `docs/superpowers/research/2026-07-28-morbius-vs-games-ux.md`
- Mockups (this session): `.superpowers/brainstorm/…/content/` — `table-feel-v2.html`
  (felt), `game-configs.html` (all five), `roulette-v2.html` (perspective rule applied)
- Roulette logic: `games/msgboard-games/src/games/roulette.ts`
