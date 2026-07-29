# Games UI "sitting at a table" redesign — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the shared game shell (rail · win-ticker · dominant stage · docked bet-tray · meta panel) and the five stage archetypes, then migrate one game per archetype (Blackjack, Crash, Dice, Roulette, Mines) end-to-end as the working proof.

**Architecture:** A new `AppShell` frame wraps every game; `App.tsx`'s existing 34-way switch is unchanged in structure but each `<XScreen>` now composes a `GameStage` (the rendered surface) + `BetTray` (docked controls) instead of emitting an inline form. Five reusable stage components (`FeltTable`, `CanvasStage`, `ProbabilityStrip`, `WheelBoard`, `RevealGrid`) cover the whole catalog; Phase 1 migrates one consumer of each. Pure functions (game→archetype map, win-ticker formatter) are TDD'd with vitest; the pure-visual components are gated by `tsc --noEmit` + `vite build` + visual parity against the approved mockups.

**Tech Stack:** React 18 + TypeScript + Vite + vitest. viem for types. No new runtime/rendering dependency (CSS/SVG depth only).

## Global Constraints

- **No game-logic, contract, or settlement changes.** View layer (`games/web/src`) only. Each migrated screen must expose the exact same actions/fields it does today.
- **No new runtime or rendering dependency.** Depth is pure CSS/SVG — no canvas lib, no WebGL, no image-asset pipeline. `@testing-library`/jsdom are NOT added; tests are pure-function (node env) only.
- **No native form controls.** Use the house `Menu`/`Toggle` components where a control is needed (per project rule `no-native-form-controls`). Plain `<input type="text/decimal">` for the amount field is retained (already the pattern in `StakeInput`).
- **Continuous bets already shipped** (`d6a737e`): `parseStake`/`StakeInput` are continuous. `BetTray` wraps `StakeInput`; do not rebuild stake parsing.
- **Perspective rule:** tilt only horizontal play-surfaces with icon-like contents (felt tables; the roulette wheel). Everything text/tap-dense stays flat; depth from elevation/shadow/glow/vignette. Source of truth: spec §2.2.
- **Roulette is European single-zero** (37 pockets, `raw % 37`) — matches `games/msgboard-games/src/games/roulette.ts`. Do not implement 00.
- **Brand palette (verbatim):** `--gold:#e8b93f`, `--gold-dim:#b98f2c`, `--ink:#e9e4d2`, `--muted:#8a927f`, felt `#2a8459/#1c6644/#0a3121/#05160e`, wood `#7a4e2c/#5a3820/#241207`, bg `#0a0d0b`.
- **Visual reference (this session, on disk):** approved mockups at
  `.superpowers/brainstorm/17081-1785336277/content/` — `table-feel-v2.html` (felt),
  `game-configs.html` (Crash/Dice/Mines), `roulette-v2.html` (wheel+board). Port styles from these; they are the accepted look.
- **Commit cadence:** one commit per task, on branch `feat/games-ui-table-redesign`. Trailer `Claude-Session: https://claude.ai/code/session_0161cE6gVKQ1ovVPiUhZDa4Y`.

## File Structure

New (all under `games/web/src`):
- `model/archetype.ts` — pure map `gameId → StageArchetype` + helper. Test: `model/archetype.test.ts`.
- `model/ticker.ts` — pure `summarizeWin(BoardNotice) → TickerLine | null`. Test: `model/ticker.test.ts`.
- `components/shell/AppShell.tsx` — rail + ticker + stage/tray grid frame.
- `components/shell/Rail.tsx` — left icon navigation.
- `components/shell/WinTicker.tsx` — consumes `useBoardFeed`, renders `summarizeWin` lines.
- `components/shell/GameStage.tsx` — bounded, elevated, vignetted surface container (`tilt?` prop).
- `components/shell/BetTray.tsx` — amount (wraps `StakeInput`) + quick-set slot + primary action slot + provably-fair link.
- `components/shell/MetaPanel.tsx` — Recent/Chart/Stats tabs + session P&L slot.
- `components/stages/FeltTable.tsx`, `CanvasStage.tsx`, `ProbabilityStrip.tsx`, `WheelBoard.tsx`, `RevealGrid.tsx` — the five surfaces.
- `styles/table.css` — new stage/shell styles (imported once from `main.tsx`), ported from the mockups.

Modified:
- `games/web/src/App.tsx` — wrap active screen in `AppShell`; drop the pitch block + `GameNav` usage (moved into shell); fairness demoted to a link.
- The 5 migrated screens: `DiceScreen.tsx`, `CrashScreen.tsx`, `BlackjackScreen.tsx`, `RouletteScreen.tsx`, `MinesScreen.tsx` — compose `GameStage`+`BetTray` instead of an inline form (logic untouched).
- `games/web/package.json` — add a `vitest.config.ts` reference only if needed (see Task 1).

---

### Task 1: Test harness + game→archetype map

**Files:**
- Create: `games/web/vitest.config.ts`
- Create: `games/web/src/model/archetype.ts`
- Test: `games/web/src/model/archetype.test.ts`

**Interfaces:**
- Produces: `type StageArchetype = 'felt' | 'canvas' | 'strip' | 'wheel' | 'grid'`; `archetypeFor(gameId: string): StageArchetype` (defaults to `'grid'` for unknown ids — the safest flat fallback).

- [ ] **Step 1: Write the failing test**

```ts
// games/web/src/model/archetype.test.ts
import { describe, it, expect } from 'vitest'
import { archetypeFor } from './archetype'

describe('archetypeFor', () => {
  it('maps card tables to felt', () => {
    for (const g of ['blackjack', 'baccarat', 'dragon-tiger', 'andar-bahar', 'three-card', 'pai-gow', 'craps', 'monte'])
      expect(archetypeFor(g)).toBe('felt')
  })
  it('maps the dice family to strip', () => {
    for (const g of ['dice', 'dicex2', 'limbo']) expect(archetypeFor(g)).toBe('strip')
  })
  it('maps crash to canvas', () => expect(archetypeFor('crash')).toBe('canvas'))
  it('maps roulette to wheel', () => expect(archetypeFor('roulette')).toBe('wheel'))
  it('maps reveal games to grid', () => {
    for (const g of ['mines', 'towers', 'keno', 'plinko', 'pachinko', 'cascade', 'sudoku', 'wordle'])
      expect(archetypeFor(g)).toBe('grid')
  })
  it('defaults unknown ids to grid', () => expect(archetypeFor('nope')).toBe('grid'))
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd games/web && npx vitest run src/model/archetype.test.ts`
Expected: FAIL — cannot find `./archetype`.

- [ ] **Step 3: Create `vitest.config.ts` and the map**

```ts
// games/web/vitest.config.ts
import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { environment: 'node', include: ['src/**/*.test.ts'] } })
```

```ts
// games/web/src/model/archetype.ts
export type StageArchetype = 'felt' | 'canvas' | 'strip' | 'wheel' | 'grid'

const FELT = new Set(['blackjack', 'baccarat', 'dragon-tiger', 'andar-bahar', 'three-card', 'pai-gow', 'craps', 'monte', 'hilo'])
const STRIP = new Set(['dice', 'dicex2', 'limbo'])
const CANVAS = new Set(['crash'])
const WHEEL = new Set(['roulette', 'wheel'])

/** Which stage surface a game renders into. Unknown ids fall back to the flat grid (safest, no perspective). */
export const archetypeFor = (gameId: string): StageArchetype =>
  FELT.has(gameId) ? 'felt' : STRIP.has(gameId) ? 'strip' : CANVAS.has(gameId) ? 'canvas' : WHEEL.has(gameId) ? 'wheel' : 'grid'
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd games/web && npx vitest run src/model/archetype.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add games/web/vitest.config.ts games/web/src/model/archetype.ts games/web/src/model/archetype.test.ts
git commit -m "feat(games-web): stage-archetype map + vitest harness"
```

---

### Task 2: Win-ticker formatter

**Files:**
- Create: `games/web/src/model/ticker.ts`
- Test: `games/web/src/model/ticker.test.ts`

**Interfaces:**
- Consumes: `BoardNotice` from `../hooks/useBoardFeed` (fields: `game?`, `kind?: 'open'|'summary'`, `at?`, `player?` (open), `delta?`/`detail?`/`reveals?`/`busted?`/`multiplierX100?` (summary); open index signature).
- Produces: `type TickerLine = { icon: string; game: string; outcome: string; who: string }`; `summarizeWin(n: BoardNotice): TickerLine | null` — returns `null` for opens and non-win/loss summaries; a formatted line otherwise. Degrades to a generic outcome if a field is missing (mirrors `describe()` in LiveFeed.tsx).

- [ ] **Step 1: Write the failing test**

```ts
// games/web/src/model/ticker.test.ts
import { describe, it, expect } from 'vitest'
import { summarizeWin } from './ticker'

describe('summarizeWin', () => {
  it('returns null for open notices', () => {
    expect(summarizeWin({ kind: 'open', game: 'dice', player: '0x7044000000000000000000000000000000009 5e5' })).toBeNull()
  })
  it('formats a mines cash-out with net delta', () => {
    const l = summarizeWin({ kind: 'summary', game: 'mines', reveals: 5, busted: false, delta: '12.4', player: '0xd8bd420000000000000000000000000000000000' })
    expect(l).not.toBeNull()
    expect(l!.game).toBe('mines')
    expect(l!.outcome).toContain('12.4')
    expect(l!.who).toMatch(/^0x/)
  })
  it('formats a decision detail line', () => {
    const l = summarizeWin({ kind: 'summary', game: 'blackjack', detail: 'paid 3:2', delta: '250' })
    expect(l!.outcome.toLowerCase()).toContain('3:2')
  })
  it('degrades to a generic outcome when fields are missing', () => {
    const l = summarizeWin({ kind: 'summary', game: 'dice' })
    expect(l).not.toBeNull()
    expect(l!.outcome.length).toBeGreaterThan(0)
  })
  it('short-addresses the player when present', () => {
    const l = summarizeWin({ kind: 'summary', game: 'dice', delta: '9.8', player: '0x7044aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa95e5' })
    expect(l!.who).toBe('0x7044…95e5')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd games/web && npx vitest run src/model/ticker.test.ts`
Expected: FAIL — cannot find `./ticker`.

- [ ] **Step 3: Implement the formatter**

```ts
// games/web/src/model/ticker.ts
import type { BoardNotice } from '../hooks/useBoardFeed'

export type TickerLine = { icon: string; game: string; outcome: string; who: string }

const ICON: Record<string, string> = {
  dice: '🎲', limbo: '🚀', crash: '🚀', mines: '💣', blackjack: '🂡', roulette: '🎯', wheel: '🎡', keno: '🔢',
}
const short = (a?: unknown): string =>
  typeof a === 'string' && a.startsWith('0x') && a.length >= 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : ''

/** A one-line social-proof summary of a SETTLEMENT notice, or null if it isn't one worth showing. */
export const summarizeWin = (n: BoardNotice): TickerLine | null => {
  if (n.kind !== 'summary') return null
  const game = typeof n.game === 'string' ? n.game : 'game'
  const net = typeof n.delta !== 'undefined' ? String(n.delta) : ''
  let outcome = ''
  if (typeof n.reveals !== 'undefined' && 'busted' in n) {
    outcome = n.busted ? 'hit a mine' : `cashed ${n.reveals} safe${net ? ` · ${net}` : ''}`
  } else if (typeof n.detail === 'string') {
    outcome = `${n.detail}${net ? ` · ${net}` : ''}`
  } else if (net) {
    outcome = `settled ${net}`
  } else {
    outcome = 'settled'
  }
  return { icon: ICON[game] ?? '🎰', game, outcome, who: short(n.player) }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd games/web && npx vitest run src/model/ticker.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add games/web/src/model/ticker.ts games/web/src/model/ticker.test.ts
git commit -m "feat(games-web): human-readable win-ticker formatter"
```

---

### Task 3: Stage styles + GameStage / BetTray / MetaPanel

**Files:**
- Create: `games/web/src/styles/table.css`
- Create: `games/web/src/components/shell/GameStage.tsx`
- Create: `games/web/src/components/shell/BetTray.tsx`
- Create: `games/web/src/components/shell/MetaPanel.tsx`
- Modify: `games/web/src/main.tsx` (import `./styles/table.css`)

**Interfaces:**
- Produces:
  - `GameStage({ title, subtitle, action, children }: { title: string; subtitle?: string; action?: React.ReactNode; children: React.ReactNode })` — renders the title bar (`h1` + subtitle + optional `action` slot e.g. "How it works") and the elevated `.stage` surface with `children` inside.
  - `BetTray({ amount, onAmount, min, quick, action, children }: { amount: string; onAmount: (v:string)=>void; min?: string; quick?: React.ReactNode; action: React.ReactNode; children?: React.ReactNode })` — amount field (via `StakeInput`), optional extra `children` (fields), a `.pf-link`, and the `action` slot (primary button).
  - `MetaPanel({ tabs, children }: { tabs: string[]; children: React.ReactNode })`.

- [ ] **Step 1: Port the stage/shell CSS**

Create `games/web/src/styles/table.css` by porting the shell + stage classes from the approved mockups (`.app`, `.rail*`, `.ticker*`, `.stagewrap`, `.stage-col`, `.gtitle*`, `.stage`, `.tray-col`, `.bet*`, `.amount`, `.quick`, `.primary`, `.pf-link`, `.meta*`, `.tabs*`, `.pl*`, the `@media (max-width:940px)`/`(max-width:560px)` blocks, and the felt/canvas/strip/wheel/grid stage classes). Use the verbatim palette from Global Constraints. Source files: `table-feel-v2.html`, `game-configs.html`, `roulette-v2.html`.

- [ ] **Step 2: Write GameStage**

```tsx
// games/web/src/components/shell/GameStage.tsx
import type { ReactNode } from 'react'

export const GameStage = ({ title, subtitle, action, children }: {
  title: string; subtitle?: string; action?: ReactNode; children: ReactNode
}) => (
  <div className="stage-col">
    <div className="gtitle">
      <h1>{title}</h1>
      {subtitle && <span className="sub">{subtitle}</span>}
      {action && <span className="pf">{action}</span>}
    </div>
    <div className="stage">{children}</div>
  </div>
)
```

- [ ] **Step 3: Write BetTray (wraps StakeInput)**

```tsx
// games/web/src/components/shell/BetTray.tsx
import type { ReactNode } from 'react'
import { StakeInput } from '../StakeInput'

export const BetTray = ({ amount, onAmount, min, quick, action, children }: {
  amount: string; onAmount: (v: string) => void; min?: string; quick?: ReactNode; action: ReactNode; children?: ReactNode
}) => (
  <div className="bet">
    <div className="top"><span>Amount</span>{min && <span>{min}</span>}</div>
    <StakeInput value={amount} onChange={onAmount} placeholder="stake" />
    {quick}
    {children}
    {action}
    <div className="pf-link">🤝 Provably fair — replay the transcript ↗</div>
  </div>
)
```

- [ ] **Step 4: Write MetaPanel**

```tsx
// games/web/src/components/shell/MetaPanel.tsx
import { useState, type ReactNode } from 'react'

export const MetaPanel = ({ tabs, children }: { tabs: string[]; children: ReactNode }) => {
  const [active, setActive] = useState(0)
  return (
    <div className="meta">
      <div className="tabs">
        {tabs.map((t, i) => (
          <div key={t} className={i === active ? 'on' : ''} onClick={() => setActive(i)}>{t}</div>
        ))}
      </div>
      <div className="pl">{children}</div>
    </div>
  )
}
```

- [ ] **Step 5: Import the CSS and typecheck**

Add `import './styles/table.css'` to `games/web/src/main.tsx`.
Run: `cd games/web && npm run typecheck`
Expected: PASS (no type errors).

- [ ] **Step 6: Commit**

```bash
git add games/web/src/styles/table.css games/web/src/components/shell/ games/web/src/main.tsx
git commit -m "feat(games-web): GameStage + BetTray + MetaPanel + stage styles"
```

---

### Task 4: Rail + WinTicker + AppShell frame

**Files:**
- Create: `games/web/src/components/shell/Rail.tsx`
- Create: `games/web/src/components/shell/WinTicker.tsx`
- Create: `games/web/src/components/shell/AppShell.tsx`

**Interfaces:**
- Consumes: `archetypeFor` (Task 1), `summarizeWin` (Task 2), `useBoardFeed` + `GameDeployment` (existing), the active `Tab` list from `App.tsx`.
- Produces:
  - `Rail({ games, active, onPick }: { games: {id:string;label:string}[]; active: string; onPick:(id:string)=>void })` — icon column; the emoji is the leading glyph already in each `label`.
  - `WinTicker({ deployment }: { deployment: GameDeployment })` — polls `useBoardFeed`, maps through `summarizeWin`, renders the scrolling line row; renders an empty ticker (no crash) when there are no wins yet.
  - `AppShell({ deployment, games, active, onPick, chainMenu, wallet, children }: {...})` — the `.app` grid: `<Rail>` + `.main` (`<WinTicker>` + `chainMenu`/`wallet` row + `.stagewrap` containing `children` and the tray column). `children` is `[stageColumn, trayColumn]`.

- [ ] **Step 1: Write Rail**

```tsx
// games/web/src/components/shell/Rail.tsx
export const Rail = ({ games, active, onPick }: {
  games: { id: string; label: string }[]; active: string; onPick: (id: string) => void
}) => (
  <nav className="rail">
    <div className="mark">M</div>
    {games.map((g) => (
      <div key={g.id} className={`ico${g.id === active ? ' on' : ''}`} title={g.label} onClick={() => onPick(g.id)}>
        {g.label.split(' ')[0]}
      </div>
    ))}
  </nav>
)
```

- [ ] **Step 2: Write WinTicker**

```tsx
// games/web/src/components/shell/WinTicker.tsx
import type { GameDeployment } from '../../config'
import { useBoardFeed } from '../../hooks/useBoardFeed'
import { summarizeWin } from '../../model/ticker'

export const WinTicker = ({ deployment }: { deployment: GameDeployment }) => {
  const notices = useBoardFeed(deployment)
  const lines = notices.map(summarizeWin).filter((l): l is NonNullable<typeof l> => l !== null).slice(0, 12)
  return (
    <div className="ticker">
      {lines.length === 0 && <span className="muted">the board is quiet — settlements will scroll here</span>}
      {lines.map((l, i) => (
        <span key={i}>
          {l.icon} <b>{l.game}</b> {l.outcome}{l.who && <> — <span className="who">{l.who}</span></>}
        </span>
      ))}
    </div>
  )
}
```

- [ ] **Step 3: Write AppShell**

```tsx
// games/web/src/components/shell/AppShell.tsx
import type { ReactNode } from 'react'
import type { GameDeployment } from '../../config'
import { Rail } from './Rail'
import { WinTicker } from './WinTicker'

export const AppShell = ({ deployment, games, active, onPick, topRight, children }: {
  deployment: GameDeployment
  games: { id: string; label: string }[]
  active: string
  onPick: (id: string) => void
  topRight: ReactNode
  children: ReactNode // the [stage-col, tray-col] pair
}) => (
  <div className="app">
    <Rail games={games} active={active} onPick={onPick} />
    <div className="main">
      <WinTicker deployment={deployment} />
      <div className="row shell-top">{topRight}</div>
      <div className="stagewrap">{children}</div>
    </div>
  </div>
)
```

- [ ] **Step 4: Typecheck**

Run: `cd games/web && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add games/web/src/components/shell/Rail.tsx games/web/src/components/shell/WinTicker.tsx games/web/src/components/shell/AppShell.tsx
git commit -m "feat(games-web): Rail + WinTicker + AppShell frame"
```

---

### Task 5: FeltTable stage + migrate Blackjack (proof of the tilt archetype)

**Files:**
- Create: `games/web/src/components/stages/FeltTable.tsx`
- Modify: `games/web/src/components/BlackjackScreen.tsx`

**Interfaces:**
- Consumes: `GameStage`, `BetTray`, `MetaPanel`.
- Produces: `FeltTable({ dealer, player, spots }: { dealer: ReactNode; player: ReactNode; spots?: ReactNode })` — the tilted `.scene`/`.plane`/`.rail-ring`/`.felt` structure from `table-feel-v2.html`, with `dealer` cards placed at the far end, `spots` as the betting circles, and `player` as the foreground `.hand`.

- [ ] **Step 1: Write FeltTable** — port the `.scene/.plane/.rail-ring/.felt/.medal/.arc/.spots/.hand` markup from `table-feel-v2.html` into a component, exposing `dealer`/`player`/`spots` slots. (CSS already in `table.css` from Task 3.)

- [ ] **Step 2: Migrate BlackjackScreen** — read `BlackjackScreen.tsx` (127 lines). Keep ALL existing state/handlers/props (`deployment`, `walletClient`, `trustAcknowledged`, `myAddress`). Replace the returned JSX form with:

```tsx
return (
  <>
    <GameStage title="BLACKJACK" subtitle="sealed before you play" action="⇆ Change table">
      <FeltTable dealer={/* existing dealer-hand render */} player={/* existing player-hand render */} spots={/* bet circles */} />
    </GameStage>
    <div className="tray-col">
      <BetTray amount={stake} onAmount={setStake} action={/* existing Deal/Hit/Stand buttons */}>
        {/* existing action controls */}
      </BetTray>
      <MetaPanel tabs={['Recent', 'Stats']}>{/* existing session summary */}</MetaPanel>
    </div>
  </>
)
```

Map the screen's current buttons/labels into the slots verbatim — do not rename handlers or change game logic.

- [ ] **Step 3: Typecheck + build**

Run: `cd games/web && npm run typecheck && npm run build`
Expected: PASS; `dist/index.html` regenerated.

- [ ] **Step 4: Visual parity check** — `npm run dev`, open Blackjack, confirm the same actions exist (deal/hit/stand/double/split as the old screen exposed) and the felt renders seated. Compare against `table-feel-v2.html`.

- [ ] **Step 5: Commit**

```bash
git add games/web/src/components/stages/FeltTable.tsx games/web/src/components/BlackjackScreen.tsx
git commit -m "feat(games-web): FeltTable stage + Blackjack migration"
```

---

### Task 6: CanvasStage + migrate Crash

**Files:**
- Create: `games/web/src/components/stages/CanvasStage.tsx`
- Modify: `games/web/src/components/CrashScreen.tsx`

**Interfaces:**
- Produces: `CanvasStage({ multiplier, curve, history }: { multiplier: ReactNode; curve?: ReactNode; history?: ReactNode })` — the `.crashstage/.grid/.curve/.mult/.hist` structure from `game-configs.html` (flat, depth via glow — no tilt).

- [ ] **Step 1: Write CanvasStage** — port the `#crash` panel's stage markup (grid, SVG curve, `.mult`, `.hist`) into a component with `multiplier`/`curve`/`history` slots.
- [ ] **Step 2: Migrate CrashScreen** (192 lines) — keep all logic; render `GameStage` + `CanvasStage` (feed live multiplier/history from existing state) + `BetTray` with the existing auto-cashout field + PLACE BET/cashout buttons in the `action` slot.
- [ ] **Step 3:** Run `cd games/web && npm run typecheck && npm run build` — Expected: PASS.
- [ ] **Step 4:** Visual check Crash against `game-configs.html`.
- [ ] **Step 5: Commit** — `git commit -m "feat(games-web): CanvasStage + Crash migration"`

---

### Task 7: ProbabilityStrip + migrate Dice

**Files:**
- Create: `games/web/src/components/stages/ProbabilityStrip.tsx`
- Modify: `games/web/src/components/DiceScreen.tsx`

**Interfaces:**
- Produces: `ProbabilityStrip({ header, markerPct, stats }: { header: string; markerPct: number; stats: {label:string;value:string;gold?:boolean}[] })` — the `.dicestage/.rollhdr/.strip/.bar/.marker/.scale/.stats3` structure from `game-configs.html`. `markerPct` positions `.marker` (0–100). Flat.

- [ ] **Step 1: Write ProbabilityStrip** — port markup; `.marker` `left` = `${markerPct}%`; render `stats` as the three `.stat` tiles (gold class when `gold`).
- [ ] **Step 2: Migrate DiceScreen** (391 lines) — keep logic; feed `header="ROLL UNDER {target}"`, `markerPct` from the win-chance, `stats` = chance/multiplier/pays from existing computed values; `BetTray` gets the win-chance % field + ROLL in the `action` slot.
- [ ] **Step 3:** `cd games/web && npm run typecheck && npm run build` — Expected: PASS.
- [ ] **Step 4:** Visual check Dice against `game-configs.html`.
- [ ] **Step 5: Commit** — `git commit -m "feat(games-web): ProbabilityStrip + Dice migration"`

---

### Task 8: WheelBoard + migrate Roulette (European single-zero)

**Files:**
- Create: `games/web/src/components/stages/WheelBoard.tsx`
- Modify: `games/web/src/components/RouletteScreen.tsx`

**Interfaces:**
- Produces: `WheelBoard({ recent, onCell }: { recent: {n:number;color:'r'|'b'|'g'}[]; onCell?: (bet:string)=>void })` — the tilted wheel (`pockets` conic-gradient built from the European sequence + `reds` set, per `roulette-v2.html`) + the flat full 0–36 board generated in a `useMemo` (0 spanning, 1..36 placed by `gridColumn=Math.ceil(n/3)+1`,`gridRow=3-((n-1)%3)`, 2:1 column, dozens, outside bets).

- [ ] **Step 1: Write WheelBoard** — port the wheel + board-generation script from `roulette-v2.html` into the component (the `reds`/`seq` arrays, conic-gradient string, and the board cell placement). Wheel tilted, board flat.
- [ ] **Step 2: Migrate RouletteScreen** (195 lines) — keep the existing bet-collection/settle logic and European payout wiring; render `GameStage` + `WheelBoard` (recent numbers from state) + `BetTray` with the chip-value selector (reuse existing chip choices) + SPIN in `action`. Confirm the board's red set matches `isRed`/`RED_MASK` from the game module.
- [ ] **Step 3:** `cd games/web && npm run typecheck && npm run build` — Expected: PASS.
- [ ] **Step 4:** Visual check Roulette against `roulette-v2.html`; confirm 0–36 present, colors correct, board legible.
- [ ] **Step 5: Commit** — `git commit -m "feat(games-web): WheelBoard + Roulette migration"`

---

### Task 9: RevealGrid + migrate Mines

**Files:**
- Create: `games/web/src/components/stages/RevealGrid.tsx`
- Modify: `games/web/src/components/MinesScreen.tsx`

**Interfaces:**
- Produces: `RevealGrid({ cols, tiles, banner, onTile }: { cols: number; tiles: {state:'hidden'|'gem'|'bomb'}[]; banner?: ReactNode; onTile?: (i:number)=>void })` — the `.minesstage/.mgrid/.tile/.mnext` structure from `game-configs.html`. `grid-template-columns: repeat(cols,1fr)`. Flat.

- [ ] **Step 1: Write RevealGrid** — port markup; render `tiles` with the `gem`/`bomb`/`hidden` classes; `banner` in `.mnext`.
- [ ] **Step 2: Migrate MinesScreen** — keep logic; feed `cols=5`, `tiles` from the board state, `banner` = next-tile/cash-out multiplier; `BetTray` gets the mines-count field + CASH OUT in `action`.
- [ ] **Step 3:** `cd games/web && npm run typecheck && npm run build` — Expected: PASS.
- [ ] **Step 4:** Visual check Mines against `game-configs.html`.
- [ ] **Step 5: Commit** — `git commit -m "feat(games-web): RevealGrid + Mines migration"`

---

### Task 10: Wire AppShell into App.tsx + demote fairness

**Files:**
- Modify: `games/web/src/App.tsx`

**Interfaces:**
- Consumes: `AppShell`, the existing `GAMES`/`Tab`/`deployment`/`wallet`/`data` wiring.

- [ ] **Step 1: Replace the outer layout** — wrap the active screen in `<AppShell>`, passing `games={GAMES}`, `active={tab}`, `onPick={setTab}`, `deployment`, and `topRight` = the existing chain `Menu` + connect/disconnect wallet controls (moved out of the old `.marquee`). Remove the `.marquee` header block and the `.pitch` `<details>` block (fairness demoted); keep the `<CryptoShowcase>`/`<TrustBanner>` gating exactly as-is. Non-migrated screens still render inside the shell's stage region unchanged (they degrade to their current form until their archetype task lands in a later phase).

- [ ] **Step 2: Move fairness to a link** — the `.pitch` copy relocates behind a "How it works" affordance in the title bar (the `GameStage` `action` slot already supports it); no content deleted, just relocated. For Phase 1 a simple modal/`<details>` toggled from the rail or title is sufficient.

- [ ] **Step 3: Typecheck + build**

Run: `cd games/web && npm run typecheck && npm run build`
Expected: PASS; `dist/` regenerated with the shell.

- [ ] **Step 4: Full smoke** — `npm run dev`; click through the 5 migrated games via the rail, confirm each renders its stage + tray and the win-ticker populates; resize to 780px and confirm the tray reflows under the stage and the rail persists.

- [ ] **Step 5: Commit**

```bash
git add games/web/src/App.tsx
git commit -m "feat(games-web): mount AppShell + demote fairness explainer"
```

---

### Task 11: Green gate + deploy readiness

**Files:** none (verification only).

- [ ] **Step 1: Full test + typecheck + build**

Run: `cd games/web && npm test && npm run typecheck && npm run build`
Expected: vitest PASS (archetype + ticker suites), typecheck PASS, build PASS.

- [ ] **Step 2: Confirm the built bundle** — `grep -o 'index-[A-Za-z0-9_-]*\.js' dist/index.html` returns a fresh hash.

- [ ] **Step 3: Deploy note (do not run headless)** — the deploy is `ansible-playbook deploy-games-web.yml` from `ansible/`, run by the user on VPN (needs `.vault_pass`); it rsyncs `games/web/dist` and body-aware-smoke-tests the live bundle. Per [[deploys-via-ansible-runbook]] — surface this to the user, do not attempt from the background env.

- [ ] **Step 4: Commit any final cleanup** (if none, skip).

---

## Self-Review

**Spec coverage:**
- Shell (rail/ticker/stage/tray/meta) → Tasks 3, 4, 10 ✓
- Perspective rule → encoded per-stage (felt/wheel tilt in Tasks 5, 8; flat in 6, 7, 9) ✓
- Five archetypes → Tasks 5–9 ✓; full 34-game mapping → `archetype.ts` (Task 1) ✓ (remaining games migrate in follow-on phases, noted below)
- Component architecture (AppShell/Rail/WinTicker/GameStage/BetTray/MetaPanel + 5 stages) → Tasks 3–9 ✓
- European roulette → Task 8 + Global Constraint ✓
- Fairness demotion → Task 10 ✓; win-ticker social proof → Tasks 2, 4 ✓
- Continuous bets (no rework) → BetTray wraps StakeInput (Task 3) ✓
- Testing → Tasks 1, 2 (pure fn), typecheck/build gates throughout, responsive smoke (Task 10) ✓
- Deploy unchanged → Task 11 ✓

**Not in Phase 1 (follow-on plans, same pattern):** migrate the remaining felt games (Baccarat, Dragon Tiger, Andar Bahar, Three Card, Pai Gow, Craps, Monte, Hi-Lo War), the rest of the strip/grid/wheel families, the duel/pool variants, The Floor tile identity + rail categories (§4.4), and the deferred contextual on-rail controls (§4.5). Each is a `stage + BetTray` recompose of an existing screen — no new infrastructure.

**Placeholder scan:** Migration steps reference "existing dealer-hand render" etc. — these are deliberate pointers to code already in each screen that must be preserved verbatim, not new logic to invent; the surrounding structure is fully specified. No TBD/TODO remain.

**Type consistency:** `StageArchetype`/`archetypeFor` (Task 1), `TickerLine`/`summarizeWin` (Task 2), and the `GameStage`/`BetTray`/`MetaPanel`/`AppShell` prop shapes (Tasks 3, 4) are used consistently in the consumer tasks (5–10).
