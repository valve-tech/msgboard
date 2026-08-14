import { describe, expect, it } from 'vitest'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { GameDeployment } from '../../config'
import { Reconciliation, rowStatus } from './Reconciliation'

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

describe('rowStatus (pure)', () => {
  it('is ok when the delta is zero', () => {
    expect(rowStatus(0n)).toBe('ok')
  })
  it('is drift for any nonzero delta, either direction', () => {
    expect(rowStatus(1n)).toBe('drift')
    expect(rowStatus(-1n)).toBe('drift')
  })
})

describe('Reconciliation (drift render test)', () => {
  it('renders a green tick when event and view figures agree', () => {
    const html = renderToStaticMarkup(
      React.createElement(Reconciliation, {
        deployment,
        reconciliation: {
          tables: [{ tableId: '0xtable1', eventLocked: 100n, viewLocked: 100n, delta: 0n }],
          tokens: [],
          indexerHead: 100n,
          rpcHead: 100n,
          headDelta: 0n,
        },
        tables: [],
        pit: [],
        tape: [],
        treasury: [],
        status: 'live',
      }),
    )
    expect(html).toContain('reconciled')
    expect(html).not.toContain('drift')
  })

  it('injects drift and asserts the amber badge — never a silently corrected single figure', () => {
    const html = renderToStaticMarkup(
      React.createElement(Reconciliation, {
        deployment,
        reconciliation: {
          // Event-derived says 100 locked; the live view says 80. A real disagreement.
          tables: [{ tableId: '0xtable1', eventLocked: 100n, viewLocked: 80n, delta: 20n }],
          tokens: [],
          indexerHead: 100n,
          rpcHead: 100n,
          headDelta: 0n,
        },
        tables: [],
        pit: [],
        tape: [],
        treasury: [],
        status: 'live',
      }),
    )
    // The drift badge fires...
    expect(html).toContain('drift')
    expect(html).toContain('+20')
    // ...and BOTH raw figures are still visible, not merged/averaged/corrected into one number.
    expect(html).toContain('>100<')
    expect(html).toContain('>80<')
  })

  it('never marks a nonzero ledger delta as reconciled, even when the fee-custody check agrees', () => {
    const html = renderToStaticMarkup(
      React.createElement(Reconciliation, {
        deployment,
        reconciliation: {
          tables: [],
          tokens: [{ token: '0x0000000000000000000000000000000000000009', eventLedger: 5n, viewLedger: 3n, ledgerDelta: 2n, randomBalance: 0n, feeBalance: 0n, feeDelta: 0n }],
          indexerHead: null,
          rpcHead: 50n,
          headDelta: null,
        },
        tables: [],
        pit: [],
        tape: [],
        treasury: [],
        status: 'live',
      }),
    )
    // The ledger row must show drift...
    expect(html).toContain('drift')
    // ...and both the pre-drift and post-drift figures are still on the page, uncorrected.
    expect(html).toContain('5')
    expect(html).toContain('3')
  })
})
