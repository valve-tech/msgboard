import { describe, it, expect } from 'vitest'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { OperatorTablePicker } from './OperatorTablePicker'
import { deployments } from '../config'
import type { OperatorTableCard } from '../lib/operatorIndex'

const deployment = deployments.find((d) => d.operator)!
const TABLE = '0x1111111111111111111111111111111111111111111111111111111111111111' as const
const OP = '0x00000000000000000000000000000000000000E0' as const
const TOKEN = '0x00000000000000000000000000000000000000F0' as const

describe('OperatorTablePicker', () => {
  it('lists an open table with its edge and operator', () => {
    const tables: OperatorTableCard[] = [
      { tableId: TABLE, operator: OP, token: TOKEN, maxMultiplierX100: 196, minStake: 1n, maxStake: 8n, open: true },
    ]
    const html = renderToStaticMarkup(
      React.createElement(OperatorTablePicker, { deployment, tables, selected: null, onSelect: () => {} }),
    )
    expect(html).toContain('1.96×')
    expect(html).toContain('0x0000') // shortened operator address
    expect(html).not.toContain('paused')
  })

  it('shows the empty state with no tables', () => {
    const html = renderToStaticMarkup(
      React.createElement(OperatorTablePicker, { deployment, tables: [], selected: null, onSelect: () => {} }),
    )
    expect(html).toContain('no operator tables')
  })

  it('marks a paused table as unselectable', () => {
    const tables: OperatorTableCard[] = [
      { tableId: TABLE, operator: OP, token: TOKEN, maxMultiplierX100: 200, minStake: 1n, maxStake: 8n, open: false },
    ]
    const html = renderToStaticMarkup(
      React.createElement(OperatorTablePicker, { deployment, tables, selected: null, onSelect: () => {} }),
    )
    expect(html).toContain('paused by operator')
    expect(html).toContain('disabled')
  })
})
