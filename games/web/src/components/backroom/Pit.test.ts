import { describe, expect, it } from 'vitest'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PitRound } from '../../lib/backroomIndex'
import type { GameDeployment } from '../../config'
import { Pit } from './Pit'

// Plain `.test.ts` (not `.tsx`) so this file matches the project's vitest include glob
// (`src/**/*.test.ts`, `vitest.config.ts`) without adding a jsdom/testing-library dependency — a static
// SSR render via `react-dom/server` is enough to assert on the rendered markup in a Node environment.

const deployment = {
  chainId: 943,
  label: 'Test',
  coinFlip: '0x0000000000000000000000000000000000000001',
  raffle: '0x0000000000000000000000000000000000000002',
  random: '0x0000000000000000000000000000000000000003',
  canonicalSubset: [],
  poolOffsets: {},
  poolSize: 1,
  deployBlock: '0',
} as unknown as GameDeployment

const pendingRound: PitRound = {
  roundId: '0xround1',
  tableId: '0xtable1',
  player: '0x000000000000000000000000000000000000aa',
  side: 1,
  stake: 10n,
  payout: 18n,
  tierPrice: 1n,
  openedAtBlock: 100n,
}

describe('Pit (leak-boundary render test)', () => {
  it('renders a Pending fixture with no outcome text', () => {
    const html = renderToStaticMarkup(
      React.createElement(Pit, {
        deployment,
        pit: [pendingRound],
        lastBlock: 105n,
        decidedUnsettled: 0,
        tableTokens: new Map(),
      }),
    ).toLowerCase()

    // Positions-only content IS expected to render.
    expect(html).toContain('pending')
    expect(html).toContain('tails') // side 1

    // No outcome/reveal/validator material anywhere in the rendered markup.
    for (const forbidden of ['seed', 'won', 'validator', 'reveal', 'preimage', 'outcome', 'result', 'winner', 'decided'])
      expect(html.includes(forbidden)).toBe(false)
  })

  it('shows the decided-but-unsettled count as a count only, never round detail', () => {
    const html = renderToStaticMarkup(
      React.createElement(Pit, {
        deployment,
        pit: [],
        lastBlock: 105n,
        decidedUnsettled: 2,
        tableTokens: new Map(),
      }),
    ).toLowerCase()

    expect(html).toContain('2 rounds decided')
    for (const forbidden of ['seed', 'won', 'validator', 'reveal', 'preimage', 'outcome', 'result', 'winner'])
      expect(html.includes(forbidden)).toBe(false)
  })
})
