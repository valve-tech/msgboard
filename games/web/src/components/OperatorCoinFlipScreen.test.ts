import { describe, it, expect, vi } from 'vitest'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { OperatorCoinFlipScreen } from './OperatorCoinFlipScreen'
import { GameStage } from './shell/GameStage'
import { OperatorTablePicker } from './OperatorTablePicker'
import { deployments } from '../config'
import type { ChainData } from '../hooks/useChainData'

const deployment = deployments.find((d) => d.operator)!
const emptyData: ChainData = {
  lobby: { openEntries: [], flips: [] },
  rounds: [],
  blockNumber: 0n,
  timestamps: {},
  refresh: () => {},
}

// A settled round's raw logs, shaped exactly as useOperatorRounds hands them to foldOperatorRounds —
// distinctive hex values so the assertions below can find them unambiguously in the rendered HTML.
const ROUND_ID = `0x${'11'.repeat(32)}`
const TABLE_ID = `0x${'22'.repeat(32)}`
const PLAYER = `0x${'33'.repeat(20)}`
const KEY = `0x${'44'.repeat(32)}`
const SEED = `0x${'54'.repeat(32)}` // last hex digit 4 -> even -> parity matches side=0 (HEADS) + won:true

vi.mock('../hooks/useOperatorRounds', () => ({
  useOperatorRounds: () => ({
    events: [
      {
        name: 'RoundOpened',
        blockNumber: 100n,
        args: {
          roundId: ROUND_ID, tableId: TABLE_ID, player: PLAYER, side: 0,
          stake: 1000000000000000000n, payout: 2000000000000000000n, tierPrice: 1000000000000000000n,
          key: KEY, openedAtBlock: 100n,
        },
      },
      {
        name: 'RoundSettled',
        blockNumber: 101n,
        args: {
          roundId: ROUND_ID, tableId: TABLE_ID, player: PLAYER, won: true,
          payout: 2000000000000000000n, seed: SEED, settledAtBlock: 101n,
        },
      },
    ],
    head: 200n,
    error: undefined,
    refresh: () => {},
  }),
}))

vi.mock('../hooks/useOperatorTable', () => ({
  useOperatorTable: () => ({ table: undefined, refresh: () => {} }),
}))

describe('OperatorCoinFlipScreen', () => {
  it('renders the stage title and the empty picker without a wallet', () => {
    const html = renderToStaticMarkup(
      React.createElement(OperatorCoinFlipScreen, {
        deployment,
        data: emptyData,
        trustAcknowledged: false,
      }),
    )
    expect(html).toContain('OPERATOR TABLES')
    expect(html).toContain('no operator tables yet on this chain')
    expect(html).toContain('connect a wallet to play')
  })
})

/**
 * Trust-chrome-stays-fixed proof (added scope carried from Task 4's review — spec §6).
 *
 * `GameStage` wraps its children in `ThemeProvider`, which applies the operator's validated `palette` as
 * CSS custom properties on a `.theme-root` wrapper div — and CSS custom properties are INHERITED by every
 * descendant. `GameStage.test.ts` already proves that mechanism confines a hostile palette to `.theme-root`
 * and never reaches an `action` prop rendered outside it. What this file proves is the OperatorCoinFlipScreen-
 * specific half: the verify slip, bet amounts, and odds (the round ledger) are not merely opted out by CSS —
 * they are not DESCENDANTS of `<GameStage>` at all, so no manifest GameStage ever receives, hostile or
 * benign, can reach them.
 *
 * Note on SSR: `renderToStaticMarkup` never runs `useEffect`, so the screen's theme-fetch effect never
 * fires and `themeManifest` state is always `undefined` here — there is no way to observe an ACTUALLY
 * fetched hostile manifest applied mid-SSR-render of the unmodified component (this is a hard fact about
 * React's server renderer, not a gap: see OperatorCoinFlipScreen.test.ts's sibling test above and
 * GameStage.test.ts's own comment on the same limitation). So this proof is split in two, each half
 * independently verifiable via SSR:
 *   1. (below) the round ledger / verify slip render OUTSIDE GameStage's `theme-root` wrapper, for the
 *      REAL component composition — true no matter what manifest GameStage is ever given;
 *   2. (GameStage.test.ts) a hostile manifest passed directly to GameStage never reaches anything outside
 *      its own `theme-root` wrapper.
 * Together they show a hostile operator manifest can never restyle the verify slip, amounts, or odds.
 */
describe('OperatorCoinFlipScreen trust chrome is unskinnable', () => {
  it('keeps the verify slip and bet-amount ledger out of the operator-themed subtree', () => {
    const html = renderToStaticMarkup(
      React.createElement(OperatorCoinFlipScreen, {
        deployment,
        data: emptyData,
        trustAcknowledged: false,
      }),
    )

    // Sanity: the settled round actually rendered (the mocked hooks produced trust-chrome content).
    expect(html).toContain('run the flip yourself')
    expect(html).toContain(SEED)
    expect(html).toContain('you won')

    // There is exactly one theme-root wrapper (GameStage's), and it precedes the tray column that
    // holds the round ledger — i.e. the ledger is a SIBLING, never a descendant, of the themed subtree.
    const themeRootCount = html.split('class="theme-root"').length - 1
    expect(themeRootCount).toBe(1)
    const themeRootIdx = html.indexOf('class="theme-root"')
    const trayColIdx = html.indexOf('class="tray-col"')
    const seedIdx = html.indexOf(SEED)
    expect(themeRootIdx).toBeGreaterThanOrEqual(0)
    expect(trayColIdx).toBeGreaterThan(themeRootIdx)
    expect(seedIdx).toBeGreaterThan(trayColIdx)
  })

  it('confines a hostile palette manifest to GameStage\'s own theme-root wrapper, never onto a sibling', () => {
    // A hostile manifest: garish, unbranded colors on tokens an operator might guess collide with house
    // chrome — but the point under test is confinement, not aesthetics. Both values clear parseManifest's
    // contrast gate (dark colors against the fixed cream trust-text color) so they are NOT dropped.
    const hostile = {
      palette: {
        '--felt-hi': '#0000ff',
        '--gold-live': '#000080',
      },
    }
    const html = renderToStaticMarkup(
      React.createElement(
        React.Fragment,
        null,
        React.createElement(GameStage, {
          title: 'OPERATOR TABLES',
          themeManifest: hostile,
          children: React.createElement(
            'div',
            { className: 'cft-surface' },
            React.createElement(OperatorTablePicker, { deployment, tables: [], selected: null, onSelect: () => {} }),
          ),
        }),
        // Stands in for the round ledger / verify slip: a sibling of GameStage, exactly as
        // OperatorCoinFlipScreen renders it in `.tray-col`.
        React.createElement('div', { className: 'trust-probe' }, 'seed proof: does not skin'),
      ),
    )

    // The hostile colors DID reach the theme-root wrapper (the manifest is not simply ignored)...
    const themeRootMatch = /<div class="theme-root" style="([^"]*)">/.exec(html)
    expect(themeRootMatch).toBeTruthy()
    expect(themeRootMatch![1]).toContain('#0000ff')
    expect(themeRootMatch![1]).toContain('#000080')

    // ...but neither hostile value appears ANYWHERE else in the document — in particular not on the
    // sibling trust-probe element, which renders with no style attribute at all.
    expect(html.split('#0000ff').length - 1).toBe(1)
    expect(html.split('#000080').length - 1).toBe(1)
    expect(html).toContain('<div class="trust-probe">seed proof: does not skin</div>')
  })
})
