# Games shell migration — presentation design

**Date:** 2026-07-30
**Scope:** `games/web` (the `games.msgboard.xyz` SPA)
**Goal:** Migrate the ~30 remaining game screens off their bespoke pre-shell layouts onto the
`AppShell` + stage-archetype system, so every game "sits at a table" with a consistent
rail · win-ticker · stage · docked tray. Build the new stage surfaces the catalog requires.

## Current state

- **Shell:** `AppShell` frames every game (`components/shell/`): `Rail` (nav) · `WinTicker` ·
  top-right · optional chrome · `stagewrap` · footer. A migrated screen renders
  `<GameStage>{surface}</GameStage>` + a `.tray-col` containing `<BetTray>` + `<MetaPanel>`.
- **Stage archetypes:** `model/archetype.ts` maps a `gameId` → one of 5 surfaces:
  `felt | strip | canvas | wheel | grid`. Surfaces live in `components/stages/`
  (`FeltTable`, `ProbabilityStrip`, `CanvasStage`, `WheelBoard`, `RevealGrid`).
- **Migrated (5), one reference per surface:** Blackjack (felt), Dice (strip), Crash (canvas),
  Roulette (wheel), Mines (grid).
- **Remaining:** 30 screens still on their own card-based layouts (sizes: Firewalk 44 →
  Wordle 646 lines).

## Target architecture

Extend the stage-surface set from 5 to **11 wagered surfaces**, plus a **non-stake control
column** variant for games with no wager. `StageArchetype` grows to:

```
felt | strip | canvas | wheel | grid            // existing (roulette keeps `wheel`)
ladder | drop | multiwheel | numberboard | tumble | book   // new (this migration)
```

Four screens are **not** driven by `archetypeFor` (special-cased): Wordle, Sudoku (non-wagered
ZK, bespoke boards + non-stake controls), Raffle (multi-round dashboard, shell chrome only),
Standings (leaderboard, plain page).

### The non-stake control column
`BetTray` assumes a stake amount + a primary bet action. Wordle/Sudoku have neither. Add a
sibling `ControlTray` (same visual container/`.tray-col` styling as `BetTray`, no amount box)
that hosts arbitrary control children + a primary action. Used by Wordle/Sudoku so they get the
shell's rail/stage/chrome without faking a wager.

## Stage surfaces

### Existing surfaces (reused, some slot-repurposing)

**`FeltTable`** (felt) — dealer/player/spots slots on a green felt.
- **Baccarat** — dealer=Banker hand, player=Player hand, spots=Player/Banker/Tie circles.
- **Dragon Tiger** — dealer=Tiger card, player=Dragon card, spots=D/T/Tie circles.
- **Andar Bahar** — joker centered; dealer/player slots repurposed as the Bahar/Andar rows;
  spots=Andar/Bahar circles.
- **Monte** — three face-down cards across the felt front; picked card highlighted; winner
  flips on reveal. (Weak felt fit; acceptable.)
- **Three Card Poker** — dealer 3 committed backs → revealed; player 3 cards foreground; ante
  circle; header shows bonus category.
- **Pai Gow** — dealer 7 backs → front(2)+back(5); player 7 cards with per-card front/set tap
  chips; bet circle.
- **Craps** — felt shows Pass / Don't-Pass line + ON/OFF point puck + the two rolled dice in
  the center (card slots empty). Weakest felt fit but keeps the family.
- **Video Poker** *(override grid→felt)* — single 5-card hand in the foreground player slot with
  per-card hold chips; dealer/spots area shows the 9/6 paytable with the achieved category
  highlighted.
- **Hi-Lo War** *(override grid→felt)* — two card seats (you vs house, house back until
  Call/showdown), war-carry pot indicator, balances headline.

**`ProbabilityStrip`** (strip) — marker + win/lose bar + 3 stat tiles.
- **DiceX2** — marker at per-roll target %; stat tiles show *effective* (mode-adjusted) win
  chance, multiplier, pays-on-win; header notes both/either mode.

**`CanvasStage`** (canvas) — animated focal readout + recent-results rail.
- **Limbo** *(override strip→canvas)* — Crash's structural twin; big drawn-multiplier readout +
  history rail of recent multipliers (no live curve, instant settle).
- **Greed Dice** *(override grid→canvas)* — large animated tumbling die (safe vs bust faces
  highlighted) + a horizontal 10-roll streak meter + running multiplier.

### New surfaces (built this migration)

**`LadderPath`** (ladder) — a directional climb where only the current step is active; builds on
the existing `LadderShell`/`useLadderSession` scaffold. Orientation + per-step shape vary:
- **Hi-Lo** — single current card; higher/lower call; multiplier ladder + next-card reveal.
- **Cipher** — vertical rungs, per-rung digit slots; difficulty chip row.
- **Towers** — vertical stack of 8 floors; current floor's tiles tappable, climbed floors show
  chosen safe tile, floors above locked.
- **Chicken** — horizontal road of 12 lanes; token advances; crash reveal on bust.
- **Firewalk** — horizontal 8 coals with a rising heat gradient (escalation); burn on bust.
- **Heist** — rooms as path steps, per-room vault buttons (1-of-N), alarm reveal on bust.

Common: a "next Xx · cash out Yx" pill above the path; tray holds stake + difficulty chips +
New-run→Cash-out primary; per-step taps live on the stage.

**`DropBoard`** (drop) — a peg/pin triangle sized by `rows`, a bucket/slot ladder beneath colored
by multiplier, and a settling-ball marker in the winning bucket; edge/high-pay buckets + max
multiplier highlighted.
- **Plinko** (risk + rows) · **Pachinko** (risk + rows; shares the surface, different paytable).

**`MultiplierWheel`** (multiwheel) — a segmented multiplier wheel whose conic ring is built from
the paytable distribution, with a pointer and *no* betting grid (distinct from roulette's
`WheelBoard`). Recent-results rail + `{mult ×count}` legend.
- **Wheel** (risk tier + segment count).

**`NumberBoard`** (numberboard) — a persistent numbered board with cells carrying picked / drawn /
picked-and-hit states + a draw animation.
- **Keno** — 1–40 board, pick 1–10, draw 10; header "picked N/10 · draws 10 of 40" → hit count ×
  multiplier. Pick controls + pays-by-hits ladder move into tray children.
- **Lottery** — pari-mutuel variant: a horizontal cumulative-stake pool bar segmented per entrant
  ("you" emphasized) with an animated draw marker landing on the winning segment; pool total +
  prize headline; entrant list below.

**`TumbleGrid`** (tumble) — an animated 6×5 symbol grid stepping through tumble frames
(matched clusters pulse then clear, survivors fall) + running-multiplier banner.
- **Cascade** (stake + Spin only).

**`OfferBook`** (book) — a marketplace of concurrent P2P offers (not a single-outcome table).
Stage shows the coin identity + an aggregate/hero element: open-offer count and the player's
**reveal-due countdown** (the deadline that costs real money). The offer list (post form is in
the tray; taker guess + per-offer cancel/reveal/claim on the cards) stays below the stage.
- **FlipBook** (escrowed: side, stake, bond, open-for, reveal-within).
- **FlipBookX** (signed/x402PLS: side, stake, + wrap-PLS control, websocket freshness).

## Special cases (not `archetypeFor`-driven)

- **Wordle** — `WordBoard`: 6×5 tri-color clue tiles + current typed row (guesser) / challenge
  code + guess-activity (setter). `ControlTray` (no stake): role switch, word/challenge-id
  inputs, Open/Join primary, on-chain toggle, guess submit. Meta: board status, clues
  proven/pending, solved-in-N, EAS/anchor tx links.
- **Sudoku** — `PuzzlePad`: interactive 9×9 input board (clue-locked cells, 3×3 borders, live
  conflict highlight). `ControlTray`: Prove&submit primary, Reset, Record-to-EAS. Meta:
  verified-against-on-chain line, proving progress, tx link, ranked leaderboard.
- **Raffle** — adopt shell chrome (`GameStage` title + `BetTray` commit form + `MetaPanel`
  aggregate stats); the substantive round-cards/ticket-tables/verify panels stay below the shell
  as a dashboard. No reusable surface.
- **Standings** — not a game (no stake/action/result). Keep as a standalone page; adopt shared
  table/heading styling only. Never wrapped in the game shell.

## Migration sequencing

Each phase is independently shippable (via `deploy-games-web.yml`). Reuse-first ordering so the
fastest wins land first; new surfaces are built once then amortized across their games.

1. **Existing-surface games (12)** — Felt: Baccarat, Dragon Tiger, Andar Bahar, Monte, Three Card
   Poker, Pai Gow, Craps, Video Poker, Hi-Lo War. Strip: DiceX2. Canvas: Limbo, Greed Dice.
   *(No new surfaces; some felt slot-repurposing.)*
2. **`LadderPath` + 6 games** — Hi-Lo, Cipher, Towers, Chicken, Firewalk, Heist.
3. **`DropBoard` + 2** — Plinko, Pachinko.
4. **`MultiplierWheel` + 1** — Wheel.
5. **`NumberBoard` + 2** — Keno, Lottery.
6. **`TumbleGrid` + 1** — Cascade.
7. **`OfferBook` + 2** — FlipBook, FlipBookX.
8. **Non-wagered (2)** — `WordBoard`/Wordle, `PuzzlePad`/Sudoku (+ `ControlTray`).
9. **Dashboards (2)** — Raffle (shell chrome), Standings (page styling).

## Testing & verification

- Each surface gets a lightweight render test (mirrors existing `components/stages` patterns and
  `model/archetype.test.ts`).
- Per game: it renders inside `AppShell`, the tray drives the same `useSession`/`useLadderSession`
  flow the old screen used (mechanics unchanged — this is presentation-only), and history/meta
  shows the same data.
- After each phase: `npm run build` in `games/web`, then `deploy-games-web.yml` (whose smoke test
  asserts the live bundle + sibling routes).

## Out of scope

- No game-logic / fairness / settlement changes — presentation only.
- No new games; no paytable changes.
- Standings stays a plain page (not shell-wrapped).
- The Rail brand "M" mark and other shell-chrome polish are separate from this migration.
