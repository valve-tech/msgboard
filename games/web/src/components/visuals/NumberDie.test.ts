import { describe, expect, it } from 'vitest'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { NumberDie } from './NumberDie'

// Plain `.test.ts` + a static SSR render (no jsdom / testing-library), matching the project's
// `src/**/*.test.ts` Node vitest include. Effects never run in `renderToStaticMarkup`, so the die
// renders its resting state — which useReveal seeds to the exact outcome it is given. That is the
// property the spec asks for: the die lands on the value it is handed, never its own RNG.

describe('NumberDie', () => {
  it('lands on the exact outcome it is given', () => {
    const html = renderToStaticMarkup(
      React.createElement(NumberDie, { outcome: 42.87, target: 50, win: true, revealNonce: 1 }),
    )
    expect(html).toContain('42.87')
  })

  it('marks a win with the win state and verdict', () => {
    const html = renderToStaticMarkup(
      React.createElement(NumberDie, { outcome: 12.34, target: 50, win: true, revealNonce: 1 }),
    )
    expect(html).toContain('ndie-win')
    expect(html).toContain('WIN')
  })

  it('marks a loss with the lose state and verdict', () => {
    const html = renderToStaticMarkup(
      React.createElement(NumberDie, { outcome: 88.5, target: 50, win: false, revealNonce: 2 }),
    )
    expect(html).toContain('ndie-lose')
    expect(html).toContain('LOSE')
  })

  it('shows an idle prompt before the first roll', () => {
    const html = renderToStaticMarkup(
      React.createElement(NumberDie, { outcome: undefined, target: 50 }),
    )
    expect(html).toContain('ndie-idle')
    expect(html).toContain('roll to reveal')
  })
})
