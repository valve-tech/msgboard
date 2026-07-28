# Diagnosis: literal "undefined" values in the games.msgboard.xyz Live section

Date: 2026-07-28
Scope: investigation only — no code changed, nothing committed.

## Affected section

`games.msgboard.xyz` → lobby button **"🟢 The record"** (`games/web/src/components/Lobby.tsx:119-121`,
`onPick('live')`) → the **"Live on the board"** panel, i.e. `LiveFeed` (tab `'live'`, mounted at
`games/web/src/App.tsx:555`: `{tab === 'live' && <LiveFeed deployment={deployment} />}`).

This is **not** the landing lobby's "recent settlements" ticker (`Lobby.tsx:125-139`, fed by the
Ponder indexer via `useReceipts` / `POST /games-indexer/graphql`) — that ticker renders correctly
(`flipbookx settled · block 24988207`, etc., no undefineds). The indexer is deployed and serving
data fine; it is not implicated in this bug.

Screenshots (captured live from `https://games.msgboard.xyz/?game=live&chain=943`):
- `.playwright-mcp/games-undefined/01-lobby.png` — the lobby, for reference.
- `.playwright-mcp/games-undefined/02-live-tab-undefined.png` — the Live tab showing the undefineds
  (rows like *"played undefined rounds (balance undefined)"*, *"settled after undefined flips (A
  undefined · B undefined)"*, *"sat down to a Hi-Lo War table (escrow undefined)"*).

Reproduction is 100% consistent: navigate to `?game=live&chain=943`, wait for the poll — most rows
in the feed show literal `undefined`. Confirmed exact undefined fields, by game:

| game (as rendered) | kind | text rendered |
|---|---|---|
| cipher, blackjack, greedDice, paiGow, threeCardPoker, videoPoker, wordle, heist, roulette | summary | `played undefined rounds (balance undefined)` |
| hilo | summary | `settled after undefined flips (A undefined · B undefined)` |
| hilo | open | `sat down to a Hi-Lo War table (escrow undefined)` |
| mines | open/summary | correct — `opened a 25-tile / 3-mine board`, `cashed out 5 safe (0.98 net)` |
| dice/limbo/plinko/keno/wheel/crash/pachinko (drawn games) | summary | correct — `played 255 rounds (balance 40.99)` |

Note: the CSP is set in **Report-Only** mode (console shows ~29 `[Report Only] Refused to connect…`
errors per poll for `rpc/evm/943` and `games-indexer/graphql`), so it does not actually block the
requests — this is noise, not the cause of the undefineds, but is a separate pre-existing issue
worth flagging (a real enforced CSP would break the app).

## Data path (source → render)

1. **Source**: `games/e2e/scripts/session-bots.ts` — the session bots post lifecycle notices to the
   shared MsgBoard lobby category (`games.msgboard.xyz:lobby:<chainId>`) via `broadcast()`
   (`session-bots.ts:360-365`). **Different bot drivers post different payload shapes** for the
   `kind: 'summary'` (and one `kind: 'open'`) notice, depending on which game engine ran the table:
   - `runDrawTable` (dice/limbo/plinko/keno/crash/pachinko/wheel) — `session-bots.ts:442`:
     `broadcast(tableId, { kind: 'summary', game: name, rounds: round, balance: fmt(...) })`
   - `runMinesTable` (mines) — `session-bots.ts:516`:
     `broadcast(tableId, { kind: 'summary', game: 'mines', reveals, busted, multiplierX100, delta })`
   - `runLadderTable` (towers/chicken/firewalk/heist/**hilo**/greedDice/cipher) — `session-bots.ts:591`:
     `broadcast(tableId, { kind: 'summary', game: a.label, steps: state.step, busted, multiplierX100, delta })`
     — **no `rounds`/`balance`/`flips`/`balA`/`balB` fields at all.** Its `open` notice
     (`session-bots.ts:552`) posts `{ kind: 'open', game: a.label, commit, maxSteps }` — no `escrowEach`.
   - `runDecisionTable` (blackjack/threeCardPoker/videoPoker/paiGow/roulette/wordle) —
     `session-bots.ts:654`: `broadcast(tableId, { kind: 'summary', game: a.label, multiplierX100, delta, detail })`
     — again no `rounds`/`balance`.
   - The actual peer-vs-peer duel — `session-bots.ts:862` — posts
     `broadcast(tableId, { kind: 'summary', game: 'hilo-war', flips, balA, balB })`, and its open notice
     (`session-bots.ts:813`) posts `{ kind: 'open', game: 'hilo-war', deck, escrowEach }`.

2. **Transport**: `games/web/src/hooks/useBoardFeed.ts` reads these notices essentially untyped —
   `BoardNotice` is typed as `{ v?, tableId?, at?, kind?, game?, [k: string]: unknown }` (line 6-14),
   i.e. it deliberately makes no promise about which extra fields exist per game. This layer is not
   the bug; it faithfully passes through whatever the bot posted.

3. **Render**: `games/web/src/components/LiveFeed.tsx`, the `describe()` function (lines 22-35):
   ```ts
   if (n.kind === 'summary') {
     if (g === 'mines') return `${n.busted ? 'hit a mine' : `cashed out ${n.reveals} safe`} (${n.delta} net)`
     if (g === 'hilo') return `settled after ${n.flips} flips (A ${n.balA} · B ${n.balB})`
     return `played ${n.rounds} rounds (balance ${n.balance})`
   }
   ```
   This hard-codes only **two** known summary shapes (`mines`, and the generic `rounds`/`balance`
   shape that `runDrawTable` happens to use) plus a **third assumed shape for `game === 'hilo'`**
   (`flips`/`balA`/`balB`) that was written for the **`hilo-war` duel's field names**, not for the
   ladder game literally named `hilo` (`session-bots.ts:610`, `label: 'hilo'`). It has no branch at
   all for the `steps`/`multiplierX100`/`delta` shape that `runLadderTable` and `runDecisionTable`
   use — which covers **12 of the ~20 game types** in the catalog (towers, chicken, firewalk, heist,
   hilo, greedDice, cipher, blackjack, threeCardPoker, videoPoker, paiGow, roulette, wordle). For all
   of those, `describe()` falls through to the generic `rounds`/`balance` template, and since the
   posted notice has neither field, template-literal interpolation of `undefined` prints the literal
   string `"undefined"`. Same mechanism for the `open`-kind `hilo` branch (line 26) reading
   `n.escrowEach`, which the ladder-hilo's open notice never sets.

## Confirmed root cause

Two compounding issues, both in the **frontend's hardcoded assumption of the bot's notice-payload
shape**, not in the indexer, not in JSON/bigint serialization, and not in transport:

1. **Shape mismatch / missing branches**: `LiveFeed.tsx`'s `describe()` only special-cases the
   `mines` summary shape and falls back to a `rounds`/`balance` template for everything else, but the
   bots (`session-bots.ts`) actually emit at least two more distinct summary shapes
   (`steps`/`busted`/`multiplierX100`/`delta` from `runLadderTable`, and
   `multiplierX100`/`delta`/`detail` from `runDecisionTable`) that share no fields with `rounds`/`balance`.
   This is evidenced directly: every game driven by `runLadderTable` or `runDecisionTable` renders
   `undefined` in the live feed; every game driven by `runDrawTable` or `runMinesTable` renders correctly.

2. **A `hilo` name collision**: `session-bots.ts` uses the game name `hilo` for the single-player
   ladder-climb game (`LADDER_TABLES.hilo`, line 610) and a *different* name, `hilo-war`, for the
   peer-vs-peer duel that actually has `flips`/`balA`/`balB`/`escrowEach` fields. `LiveFeed.tsx`'s
   `describe()` special-cases `game === 'hilo'` expecting the duel's field names, but the notices
   actually tagged `hilo` come from the ladder engine and never carry those fields — so the `hilo`
   special-case is dead code with respect to its intended target (`hilo-war` never matches the
   `g === 'hilo'` check and instead silently falls through to the generic `rounds`/`balance` template,
   which is *also* wrong for it, though not observed in this capture).

Ruled out: the Ponder indexer (`games/indexer`) — confirmed deployed and returning correct data via
`/games-indexer/graphql` (used by the unrelated, correctly-rendering "recent settlements" rail). Ruled
out: JSON/bigint serialization — the notices are plain JSON via MsgBoard content, and fields that
exist (e.g. `delta`, `reveals`, `busted` for mines; `rounds`, `balance` for draw games) round-trip and
render correctly, so serialization is not dropping fields. The only difference between working and
broken rows is which fields the bot chose to actually include in the payload for that game engine.

## Recommended fix (not applied)

In `games/web/src/components/LiveFeed.tsx`, `describe()` (lines 22-35), add explicit branches that
match the real payload shapes emitted by `session-bots.ts`, instead of only `mines` + a generic
fallback:

- Add a branch for the ladder/decision shape, keyed on presence of `n.steps` / `n.multiplierX100` /
  `n.detail` (or better, an explicit list of the ladder+decision game names: towers, chicken,
  firewalk, heist, hilo, greedDice, cipher, blackjack, threeCardPoker, videoPoker, paiGow, roulette,
  wordle), e.g. something like
  `` `${n.busted ? 'busted' : 'cashed out'} at step ${n.steps} (x${...}, ${n.delta} net)` `` for the
  ladder shape, and a decision-appropriate summary (`n.detail` / `n.multiplierX100` / `n.delta`) for
  the decision shape.
- Fix the `hilo`/`hilo-war` name collision at the source: either rename the ladder game's label away
  from `hilo` in `session-bots.ts:610` (e.g. to something like `hiloLadder`/`hilo-climb`) to stop
  colliding with the duel's `hilo-war`, and update `describe()`'s `g === 'hilo'` check to
  `g === 'hilo-war'` — or, if the two are meant to share the display name, disambiguate on payload
  shape (`'flips' in n`) rather than on `g`.
- Generally, make `describe()` defensive against missing fields it doesn't recognize (fall back to a
  generic message like `n.detail ?? 'settled'` rather than interpolating unconditionally), so an
  unmapped/future game degrades to something readable instead of the literal string `"undefined"`.

Primary file/lines to change: `games/web/src/components/LiveFeed.tsx:22-35` (describe()). Optionally
also `games/e2e/scripts/session-bots.ts:610` (rename the ladder `hilo` label) if the collision is to
be resolved at the source rather than purely in the renderer.
