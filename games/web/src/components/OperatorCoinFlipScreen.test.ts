import { describe, it, expect } from 'vitest'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { OperatorCoinFlipScreen } from './OperatorCoinFlipScreen'
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
