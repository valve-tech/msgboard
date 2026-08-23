# Operator Coin-Flip UI — Slice 1 design

Date: 2026-08-22
Status: approved (brainstorm), spec for review before writing-plans
Scope: the first player-facing web UI for `OperatorCoinFlip`, plain bets only,
chain 943, operator-themed. New product subsystem — no contract change, no fund risk.

## 1. Goal

Give a player a real screen to bet against an operator coin-flip table. The player
picks a table, picks a side, stakes Chips on a fair 2× flip, watches the round
settle, and can refund a stale round. A provably-fair verify slip proves each
result from the on-chain seed. The table is skinned by the operator's own theme.

Success = a player on 943 can connect a wallet, open a plain bet on a live operator
table, see it settle (push or claim), read the verify slip, and refund a round whose
seed never formed. `tsc` clean and the existing `games/web` vitest suite green.

## 2. What ships (and what does not)

In scope (slice 1):
- Plain (unboosted) operator bets: table pick → side → stake → open → settle/claim → refund.
- Operator-level theming (the operator's `setMetadataURI` manifest skins the table).
- The provably-fair verify slip on each settled round.
- Chain 943 only.

Out of scope (slice 2+, stated so the boundary is explicit):
- Boosted bets (`openBoosted`) and buy-bonus-chips (`MintSale.buy`). These need new
  indexer entities for `MintSale`/`BonusChips1155`/`BackingPool` and new addresses in
  `config.operator` — a separate build.
- Per-table theming. The contract has no `setTheme` hook today; only operator-level
  `setMetadataURI` exists. Per-table theming is a later slice (a contract change or a
  table-keyed convention inside the operator metadata JSON).
- Chain 369. The operator substrate is not deployed there.

## 3. Architecture

Follows the existing stage-surface pattern. The closest working template is
`games/web/src/components/CoinFlipTablesScreen.tsx` — copy its structure.

- Tab registration: add an `operator` tab id to `TABS` in `games/web/src/App.tsx`
  (import + render `{tab === 'operator' && <OperatorCoinFlipScreen .../>}`), tag it in
  `VALIDATOR_GAMES` (it is validator-settled), and support `?game=operator&table=<id>`
  deep-links like the other tables game.
- New component `games/web/src/components/OperatorCoinFlipScreen.tsx`. Props follow the
  house convention: `{ deployment, data, walletClient, trustAcknowledged, myAddress,
  initialTableId }`.
- The screen returns `<GameStage title subtitle>` (`components/shell/GameStage.tsx`)
  with a coin-flip stage board and a sibling `.tray-col` holding `BetTray` + a side
  `Menu` + `MetaPanel` — the same layout as `CoinFlipTablesScreen`.

## 4. Data flow

Table state (direct reads, viem `readContract` on `OperatorCoinFlip`, ABI
`operatorCoinFlipAbi` from `games/core/src/contracts.ts`):
- `tables(tableId) → { operator, token, maxMultiplierX100, minStake, maxStake, open,
  validatorPolicy }` and `operatorOf(tableId)`.
- `tierPriceOf(tableId, stake)` for the fee/odds display.
- `tableCap(tableId)` / `tableLocked(tableId)` to gate whether a bet fits.

Round history (the existing Ponder indexer — operator events are already indexed):
- Query `game: "operator"` for `RoundOpened` / `RoundSettled` / `RoundRefunded`.
- New hook `useOperatorRounds(deployment)` mirroring the GraphQL shape in
  `games/web/src/hooks/useBackroomData.ts` (the one place that already reads
  `game:"operator"` from the web). Fold logs into round cards the way
  `games/web/src/model/table-rounds.ts` does for the plain tables game.
- Table discovery: reuse `components/TablePicker.tsx`, fed by `TableCreated`/`TableNamed`.

Config: `deployment.operator.coinFlip` is already populated on 943
(`games/web/src/config.ts`). Slice 1 needs no new config fields (mintSale/bonusChips/
backingPool are slice 2).

## 5. Bet flow

Two-step approve-then-open, identical in shape to `CoinFlipTablesScreen`:
1. ERC-20 `approve` of the stake in Chips to `escrow` (escrow pulls the stake on open).
2. `open(tableId, side, stake, validatorSubset, validatorLocations)` via
   `sendGameTx` (`games/web/src/tx.ts`).
   - `side`: 0/1 (0 = heads), chosen with the house `Menu`.
   - `validatorSubset`: **auto-pick the canonical subset** (like every other game
     screen) via the shared `deployment.canonicalSubset`; the player does not choose
     validators. Rationale: the security review NF-1 flags a player-chosen subset as a
     fee-griefing / extraction surface, so hiding it is both simpler and safer.
   - `validatorLocations`: `nextHeatLocations(...)` from `tx.ts`.

Settle:
- Poll `Random.randomness(key)`; when the seed finalizes, call `claim(roundId)` as a
  pull fallback. Push settlement (`onCast`) may beat the poll — the screen shows the
  settled state whichever lands first.
- `refundStale(roundId)` for a round whose seed never formed.

Verify slip: recompute the winner from seed parity purely off the logs, reusing the
`TablesVerifyPanel` pattern (`CoinFlipTablesScreen.tsx`). This is house trust chrome and
is never skinnable.

## 6. Theming

- Read the operator's metadata URI from the indexed `OperatorRegistry.MetadataSet`
  event (already indexed at `indexer/src/index.ts`).
- Fetch the JSON, run it through `parseManifest` (`games/web/src/lib/theme/manifest.ts`),
  and pass the result as the `themeManifest` prop to `GameStage`.
- The engine is fail-safe: only allowlisted non-trust surfaces skin
  (`felt/backdrop/palette/…`, `lib/theme/skinPoints.ts`); trust chrome (amounts, odds,
  the provably-fair slip, wallet cluster) is unskinnable by omission. An absent or
  invalid manifest falls back to the house default.
- One manifest per operator (not per table) in slice 1.

## 7. Reused building blocks (no native form controls)

- `components/Menu.tsx` (side pick), `components/Toggle.tsx` — the house replacements
  for native `select`/`checkbox`.
- `components/shell/BetTray.tsx` + `parseStake` from `components/StakeInput.tsx` for the
  stake input; `components/TablePicker.tsx` for the table selector.
- `components/shell/MetaPanel.tsx`, `components/Meta.tsx` (`AddressLink`, `explorerUrl`,
  `fmtAmount`, `InfoDot`), `components/TrustBanner.tsx`, `components/HowItWorks.tsx`.
- Wallet: `hooks/useWallet.ts` + the wallet cluster in `components/shell/AppShell.tsx`.

## 8. Testing

- `tsc --noEmit` clean in `games/web`.
- The existing `games/web` vitest suite stays green (add unit tests for the new
  `useOperatorRounds` fold and the verify-slip recompute where they mirror existing
  table tests).
- Manual 943 walkthrough: connect wallet → pick a live operator table → open a plain
  bet → observe settle (claim or push) → read the verify slip → refund a stale round.
- No new contract and no fund-moving path, so there is no on-chain deploy in this slice.

## 9. Risks / open notes

- The player round hook reads the indexer; if the operator indexer lags, the screen
  should read the freshest round from a direct `getLogs` on `RoundOpened`/`RoundSettled`
  as a fallback so a just-opened bet is visible immediately (same fallback the plain
  tables screen relies on for its own just-opened round).
- Operator theming fetches an external URI. The fetch must time out and fall back to the
  house look; a slow or dead URI must never block the table from rendering.
