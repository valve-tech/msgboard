import { describe, expect, it } from 'vitest'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { randomRollPercent, prefersReducedMotion, useReveal, DEFAULT_FLURRY_MS } from './reveal'

// A tiny probe so we can assert on `useReveal`'s resting value via a static SSR render. React never
// runs `useEffect` during `renderToStaticMarkup`, so the rendered value is the initial state —
// which useReveal seeds to `finalValue`. That is exactly the reduced-motion / no-JS outcome: the
// hook resolves to the value it was given, with no flurry.
const Probe = ({ value, reducedMotion }: { value: number | undefined; reducedMotion?: boolean }) => {
  const { value: shown, flurrying } = useReveal(value, { reducedMotion })
  return React.createElement(
    'span',
    { 'data-flurrying': String(flurrying) },
    shown === undefined ? 'none' : shown.toFixed(2),
  )
}

describe('randomRollPercent', () => {
  it('stays within [0, 99.99] on the 2-decimal grid', () => {
    for (const r of [0, 0.0001, 0.5, 0.99, 0.999999, 1]) {
      const v = randomRollPercent(() => r)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(99.99)
      // 2-decimal grid: no more than hundredths.
      expect(Math.round(v * 100)).toBeCloseTo(v * 100, 6)
    }
  })

  it('maps a mid draw to a mid percent', () => {
    expect(randomRollPercent(() => 0.5)).toBe(50)
  })
})

describe('prefersReducedMotion', () => {
  it('is false when matchMedia is unavailable (Node)', () => {
    expect(prefersReducedMotion()).toBe(false)
  })
})

describe('useReveal (resting value via SSR)', () => {
  it('rests on the final value it is given', () => {
    const html = renderToStaticMarkup(React.createElement(Probe, { value: 42.87 }))
    expect(html).toContain('42.87')
    expect(html).toContain('data-flurrying="false"')
  })

  it('sets the final value instantly on the reduced-motion path', () => {
    const html = renderToStaticMarkup(React.createElement(Probe, { value: 7.5, reducedMotion: true }))
    expect(html).toContain('7.50')
    expect(html).toContain('data-flurrying="false"')
  })

  it('shows nothing before an outcome exists', () => {
    const html = renderToStaticMarkup(React.createElement(Probe, { value: undefined }))
    expect(html).toContain('none')
  })

  it('exposes a sane default flurry length', () => {
    expect(DEFAULT_FLURRY_MS).toBeGreaterThan(0)
  })
})
