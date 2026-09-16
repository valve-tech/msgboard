# Morbius.io vs games.msgboard.xyz — "sitting at a table" UX research

Date: 2026-07-28
Method: Playwright browser automation, read-only (no wallet connect, no bets placed, no
credentials entered). Screenshots saved to:
`/Users/michaelmclaughlin/.claude/jobs/a0f31ac3/tmp/morbius-research/`

Reminder from project memory: morbius.io is a **catalog/UX reference only** — it is *not*
provably fair (server-side SHA256 = trust-the-server). This document is purely about visual
/interaction layout, not about adopting its trust model.

---

## 1. Morbius.io — per-screen observations

### 1.1 Lobby / landing (`01-morbius-lobby-viewport.png`, `01b-morbius-lobby-fullpage.png`)

- Persistent **left icon rail** (collapsed sidebar) with a home icon, avatar, VIP, referrals,
  and per-category game icons stacked vertically — always visible, never competing with content.
- Top-right is a compact **"balance / token price / swap" ticker bar**, not a big nav.
- Center column: a large hero heading ("WELCOME TO THE FLOOR" / "THE FLOOR — 26 games, one
  chip"), a **horizontal marquee/ticker** of recent wins scrolling past ("💸 WIN 60,000 on
  Blackjack — ZEE"), then a carousel banner (promotions), then a **grid of game tiles that are
  actual rendered mini-scenes** — not icons: the Blackjack tile shows a curved felt table edge
  with two dealt hands and card backs; Baccarat shows two hands "PLAYER" vs "BANKER" with a
  literal "VS"; Video Poker shows a 5-card hand with "HOLD" buttons already lit; Keno shows drawn
  numbers on a board; Craps shows a "PASS LINE" felt layout. Every tile is a small diorama of the
  actual table, not a generic icon.
- Below the grid: a live "WEEKLY DROP" jackpot module with a countdown timer and a "last week's
  top 3" leaderboard with avatar chips.
- A floating **chat tab** is docked to the right edge at all times (multiplayer/social presence
  cue), and a "Take a seat at the table" modal nudges wallet connect using table-seating language.
- Typography: bold condensed display face for game names, small-caps label chips ("HOT",
  "3 SEATS LIVE", "2 TABLES") that imply a living venue with occupancy, not a static catalog.

### 1.2 Dice (`02-morbius-dice-viewport.png`)

- Even the plainest game (dice, no literal table) is built as **one centered card** on a
  darkened backdrop: title + subtitle ("pick a target · roll under it to win · provably fair"),
  a large **horizontal probability strip** (colored win/lose gradient bar) with the payout slider
  drawn as a physical track and a glowing playhead — the slider itself doubles as the "board."
  Win chance / multiplier / payout are laid out as three big stat tiles directly under the visual
  control, not as a text sentence.
- Bet controls (amount, ½, 2×, Max, Roll) sit in a **separate left-hand panel that is narrower
  and visually secondary** to the roll-strip, so the eye lands on the game surface first.
- A session-stats / P&L panel floats bottom-right as a card, not inline in the flow.
- The player looks at one thing while betting: the colored strip and its glowing marker. During
  resolution the marker's position on that same strip is presumably where the roll result lands
  (kept as the single locus of attention).

### 1.3 Crash (`03-morbius-crash-viewport.png`)

- Full-bleed **dark canvas stage** occupies ~65% of viewport width and is visually distinct from
  the betting panel via a hard vertical divider — like a screen at one end of the table and a
  betting rail at the other.
- Center of the canvas shows a giant "CRASH" wordmark with "PLACE A BET TO LAUNCH" beneath it —
  the canvas is clearly a dedicated stage that will host the animated multiplier/rocket, currently
  idle. A history strip of past multipliers (color-coded chips) runs along the bottom of the
  stage, like a scoreboard rail under a screen.
- Bet controls are docked in a **fixed right-hand tray**: amount, MIN/½/2×/MAX quick-set row,
  auto-cashout target with its own slider, then a large green "PLACE BET" button pinned near the
  bottom of that tray — always in the same place regardless of round state.
- Interaction flow: player's eye is on the canvas stage while a round resolves (that's where the
  animation happens); the betting tray is a static instrument panel off to the side, always
  reachable, never overlapping the stage.

### 1.4 Blackjack (`04-morbius-blackjack-choose-table.png`, `05-morbius-blackjack-theme-picker.png`,
`06-morbius-blackjack-choose-table-b.png`, `07-morbius-blackjack-live-table.png`)

This is the clearest illustration of "sitting at an actual table":

- **Pre-game "Choose Your Table" screen**: the page background is a *blurred, dim casino-room
  photo/render* — bokeh wall art, a neon "Blackjack Room" sign glowing on the back wall — so even
  the menu screen is staged inside an implied physical room, not a flat app background. Three
  table cards below show **camera-angle preview renders** of actual green-felt tables (gold
  betting-circle trim, chip stacks, curved rail) each labeled with a table *name* ("High Roller 2",
  "Liberty", "PulseChain Pitbull") and stakes range, like choosing a real table in a casino.
- Clicking a table opens a **"Table theme" picker** — dozens of community-branded felt skins
  (named things like "Dark Pepe," "Green Wick," "PLSX.fun," "LibertySwap") the player can pick as
  their personal table skin, saved per-wallet. This is a customization/ownership hook that
  deepens the "this is my table" feeling.
- **The live table (`07-morbius-blackjack-live-table.png`) is the single best reference shot**:
  a high, slightly tilted **top-down camera angle** looking onto an oval green-felt table with a
  wood rail, gold-trimmed betting circles (dealer spot at top, two player spots at the sides,
  main betting circle at bottom-center), a card shoe and discard tray at the corners, a chip tray
  fanned out at the top behind an empty tufted-leather dealer chair back, and the house logo
  medallion embossed in the felt center. Depth is constructed through the **elevated/tilted
  camera perspective**, layered z-depth (rail → felt → embossed logo → chip tray sitting "on
  top" of the rail), soft ambient occlusion/lighting on the felt, and a wood-grain material on
  the rail.
- Betting controls (amount stepper, quick-bet chips 100/200/300/500/Clear, Hit/Stand/Double/
  Split action buttons, Rebet/Deal) are docked in a **fixed right-hand panel outside the table
  image** — the table surface itself stays completely clean of UI chrome. A secondary panel below
  that (Recent/Chart/Sounds/How/Stats tabs) holds meta info, again off the table.
- Interaction flow: the player's eye stays on the felt the entire time — cards will be dealt
  directly onto the rendered betting circles; controls are peripheral instruments, never on top
  of the game surface.

---

## 2. games.msgboard.xyz — per-screen observations

### 2.1 Lobby (`10-ours-lobby-viewport.png`, `10b-ours-lobby-fullpage.png`)

- Header: wordmark + tagline, chain selector, "Connect wallet" — standard app chrome, fine.
- Below that: a large **collapsible educational panel** ("How the back room stays honest — and
  cheap") that is text-first (paragraphs about seed-sealing, PoW, no-gas) — this is the first
  thing in the content area, before any game is visible.
- Hero copy is a large serif headline ("The house shows its work.") plus another paragraph of
  provable-fairness explanation, then two buttons (Standings / The record).
- A **horizontal marquee of raw event-log strings** ("coinflip entered · block 24987982") — this
  is Morbius's win-ticker pattern, but ours shows raw protocol event names instead of
  human/social wins ("Alice won 60,000 on Blackjack"), so it reads as a debug/telemetry feed, not
  a "the room is alive with players" cue.
- Game grid: **flat rows of text buttons**, each just an emoji + name inside a bordered pill (🎲
  Dice, 🚀 Crash, 🃏 Monte, 🂡 Blackjack, etc.) — no artwork, no felt, no cards, no differentiation
  between a dice game and a full table game. All 34 tiles look identical in weight and material.
  There's no visual hierarchy suggesting "this one is a big multiplayer table" vs "this is a
  simple coin toss."

### 2.2 Dice (`11-ours-dice-viewport.png`, `11b-ours-dice-fullpage.png`)

- Same page chrome as the lobby, **repeated in full**: the entire "how the back room stays
  honest" explainer block (title, 3 stat boxes, PoW callout) reappears at the top of the game
  page, above the fold, before any game control is visible.
- The actual game is a **single-row inline form** at the bottom: a numeric input, three quick-
  amount toggle pills (0.1/1/10), a "win chance %" number input, an "Open table" button, and a
  "connect a wallet to play" caption. That's the entire game surface — no dice art, no visual
  strip/track for the probability, no board.
- Below that, literal text: "This table / No table open — set your stake and odds, then open one
  to start rolling." There is nothing to look at during play except numbers changing in a form
  row — no animation stage, no result rendering implied anywhere on the page.

### 2.3 Blackjack (`12-ours-blackjack-fullpage.png`)

- **Byte-for-byte the same template as Dice**: identical explainer blocks, identical page
  structure, and the "game" itself is reduced to a bet-amount input + 0.1/1/10 pills + a "Deal"
  button. No cards, no felt, no dealer, no seat, no table art of any kind — visually
  indistinguishable from the Dice page except the button says "Deal" instead of showing odds
  controls.

### 2.4 Roulette (`13-ours-roulette-fullpage.png`)

- Again the identical template: same explainer stack, then a form row with amount, 0.1/1/10
  pills, a "bet" dropdown (defaulting to "Red"), and a "Spin" button. No wheel, no board with
  numbers/colors, no chip placement, nothing that visually says "roulette" beyond the label text
  and a 🎯 emoji in the tab strip.

**Pattern across all three games**: the app appears to use one shared "generic wager form"
component for every game regardless of genre (dice-style probability game, card table game, or
wheel game). The differentiation between a 34-game catalog is currently carried entirely by
copy and emoji, not by layout, imagery, or spatial staging.

---

## 3. Diff table — immersion levers Morbius uses vs our gaps

| Lever | Morbius | games.msgboard.xyz | Gap |
|---|---|---|---|
| **Game surface** | Every game has a rendered "stage": felt table, probability strip, or canvas viewport that occupies the dominant visual area (~55–65% of viewport width/height) | No rendered surface at all; the "game" is a single-row form | Total — nothing to look at |
| **Camera / perspective** | Blackjack/table games use an elevated, tilted top-down camera onto an oval table (true "sitting at it" viewpoint); Crash uses a flat full-bleed stage; Dice uses a "physical" horizontal track with a glowing marker | Flat 2D form, no depth cues anywhere | Total |
| **Depth & material** | Green felt texture, wood rail grain, gold trim, embossed medallion, ambient occlusion/shadow layering, ordered z-stack (rail/felt/logo/chips) | Flat solid-color bordered boxes, no texture, no shadow/elevation | Total |
| **Bet controls placement** | Docked in a **fixed side/bottom tray outside the game surface** — never overlapping or competing with it | Controls **are** the entire page (there is no separate surface to keep clean) | Structural — nothing to dock controls beside |
| **Spatial focus / eye path** | One obvious focal point per game (table felt, canvas stage, or slider track); everything else (stats, chat, history) is peripheral and secondary in size/contrast | No focal point; the biggest, boldest thing on every game page is the *educational copy block* above the game, not the game | Inverted priority — chrome outweighs the game |
| **Motion / animation cues** | Idle-state animation affordances implied everywhere (Crash canvas awaiting launch, dealer chair "waiting," slider marker glowing, ticker scrolling) | No animation surface exists to animate | Total |
| **Per-game visual identity** | Each of the 26 games has a bespoke rendered scene (cards for Baccarat, numbers-drawn board for Keno, "PASS LINE" felt for Craps) — instantly recognizable from a thumbnail alone | All 34 tiles are identical pill shape distinguished only by one emoji + text label | Near-total — can't tell games apart by shape |
| **"Choose your table" ritual** | Table-selection screen with named tables ("High Roller 2," "Liberty"), stakes tiers, and a **theme picker** to personalize the felt skin per-wallet — reinforces "this is my seat" | No table concept; you just fill in a form | Total — no ownership/selection ritual |
| **Ambient life / social presence** | Win-ticker shows human-readable wins with player names/amounts ("💸 WIN 60,000 on Blackjack — ZEE"), "3 SEATS LIVE" badges, floating chat tab, weekly-drop leaderboard with avatars | Marquee shows raw protocol event strings ("coinflip entered · block 24987982") — reads as a debug log, not a room full of players | Present but reads as telemetry, not social proof |
| **Chrome-to-game ratio** | Nav is a slim collapsed icon rail; balance/price ticker is compact; game content dominates | Header + collapsible fairness explainer + stat-box row + PoW callout + banner block all sit above the fold before the game; game is the smallest element on the page | Inverted — explanatory chrome dominates, game is an afterthought |
| **Typography as staging** | Bold condensed display wordmarks per game ("CRASH," "Blackjack") set the tone/genre before you even see controls | Small text label in a pill, same weight/size as every other game name | Flat, no hierarchy |
| **Information density during play** | Stats/history/session P&L are collapsed into small floating cards, out of the primary sightline | (N/A pre-wallet) but structurally the fairness/explainer text is the dominant density, always visible, always large | Density is front-loaded as *justification* copy instead of *game* content |

---

## 4. Prioritized, actionable changes

1. **Give every game a dedicated visual "surface" component, not a form.** Build one reusable
   `<GameStage>` shell (a bounded rectangle/canvas region with its own background material —
   felt/gradient/board — sized to dominate the viewport, ~55–65% width on desktop) that each game
   renders itself into. Move the bet inputs out of the flow and into a docked side/bottom tray
   that never sits on top of the stage. This single change (stage + tray split) is the biggest
   lever and mirrors Morbius's Crash/Blackjack layout almost directly.

2. **Move the fairness/PoW explainer out of the primary above-the-fold slot.** It's valuable
   content but currently out-competes the game for attention on every single game page. Collapse
   it by default (it already has a `▾` affordance on the lobby — apply the same collapse-by-default
   to the per-game page, or relocate it to a slide-in / "How it works" modal reachable via an info
   icon, like Morbius does with "Rules · Provably Fair" links).

3. **Add per-game visual identity at the tile and in-game level.** Even simple SVG/canvas treatments
   move the needle: a probability strip with a glowing marker for Dice/Limbo, a felt oval with
   betting circles for Blackjack/Baccarat/Pai Gow, a wheel graphic for Roulette/Wheel, a numbered
   board for Keno. Reuse one "table felt" background asset across the card-table games and one
   "probability strip" asset across the dice-family games — two asset investments cover most of
   the 34-game catalog's genre types.

4. **Introduce camera/depth cues even in 2D**: soft box-shadow/elevation on the stage, a subtle
   radial vignette or ambient-occlusion gradient framing the play surface, and layering (chips/
   cards rendered "above" the felt with a drop shadow) — this alone gets a large fraction of
   Morbius's "depth" feeling without building 3D/photoreal art.

5. **Convert the event-log marquee into human-readable social proof.** Same data, different
   presentation: "🎲 0x7044…95e5 rolled under 50 and won 20.97" instead of "coinflip entered ·
   block 24987982." This is a copy/formatting change, not new infrastructure, and directly
   targets the "room feels alive" gap.

6. **Establish per-genre stage templates instead of one universal form.** At minimum, split the
   shared component into three variants — (a) probability-strip games (Dice, Dice X2, Limbo,
   Crash-family), (b) wheel/board games (Roulette, Wheel, Keno, Plinko/Pachinko), (c) card-table
   games (Blackjack, Baccarat, Poker, Pai Gow, Three Card, Dragon Tiger, Andar Bahar) — so a
   player can tell genre apart from the page shape alone, before reading any label.

7. **Optional, higher-effort, high-payoff**: a "choose your table / seat" step for the card-table
   games (stakes tiers + a named table), matching Morbius's ritual. This is not required for
   fairness or function, but it is the single strongest "you're sitting down to play" cue observed
   and would differentiate the multiplayer/social games in particular.

---

## Screenshot index

| File | Site | Screen |
|---|---|---|
| `01-morbius-lobby-viewport.png` | Morbius | Lobby, viewport |
| `01b-morbius-lobby-fullpage.png` | Morbius | Lobby, full page |
| `02-morbius-dice-viewport.png` | Morbius | Dice game |
| `03-morbius-crash-viewport.png` | Morbius | Crash game (idle, pre-bet) |
| `04-morbius-blackjack-choose-table.png` | Morbius | Blackjack "Choose Your Table" screen |
| `05-morbius-blackjack-theme-picker.png` | Morbius | Blackjack table-theme picker modal |
| `06-morbius-blackjack-choose-table-b.png` | Morbius | Blackjack table-select screen (modal closed) |
| `07-morbius-blackjack-live-table.png` | Morbius | **Live Blackjack table — key reference shot** |
| `10-ours-lobby-viewport.png` | games.msgboard.xyz | Lobby, viewport |
| `10b-ours-lobby-fullpage.png` | games.msgboard.xyz | Lobby, full page |
| `11-ours-dice-viewport.png` | games.msgboard.xyz | Dice game, viewport |
| `11b-ours-dice-fullpage.png` | games.msgboard.xyz | Dice game, full page |
| `12-ours-blackjack-fullpage.png` | games.msgboard.xyz | Blackjack, full page |
| `13-ours-roulette-fullpage.png` | games.msgboard.xyz | Roulette, full page |

All files are under
`/Users/michaelmclaughlin/.claude/jobs/a0f31ac3/tmp/morbius-research/`.

---

## User directives (2026-07-28) — to fold into the games redesign

1. **Kill non-continuous bet amounts.** Stepped/preset bet denominations were only justified when we
   paid a per-bet cost for randomness. We no longer pay for randomness, so bets must be **continuous /
   arbitrary amounts** (free-entry amount, not fixed chip steps). Remove the discrete-amount constraint
   from every game's bet control. (Verify where this is enforced — likely a shared bet-input/chip
   component in `games/web` and/or a min-step in the game modules.)

2. **"Sitting at a table" immersion** is the north star for the games UI (see the diff table above):
   dominant per-game rendered stage, depth/felt/perspective, bet controls in a docked tray *outside*
   the surface, fairness/PoW explainer collapsed and peripheral, per-genre bespoke visuals.

These feed a dedicated games-UI redesign brainstorm (separate spec from petitions).
