import { describe, it, expect } from 'vitest'
import { parseManifest, contrastRatio, TRUST_TEXT_COLOR, MIN_CONTRAST } from './manifest'
import { SKIN_POINTS } from './skinPoints'

// A well-formed 32-byte hex content hash (0x + 64 hex chars).
const HASH = ('0x' + 'ab'.repeat(32)) as `0x${string}`

describe('SKIN_POINTS registry (trust chrome unskinnable by construction — I6)', () => {
  it('registers only themeable surfaces; trust-chrome ids are absent', () => {
    // These ids MUST NOT exist — a manifest can never target them because they are not in the map.
    for (const forbidden of ['trustSeal', 'betAmount', 'fairnessStrip', 'multiplier', 'odds', 'alertLane', 'walletChrome']) {
      expect(SKIN_POINTS[forbidden]).toBeUndefined()
    }
    // A few surfaces that SHOULD be themeable.
    expect(SKIN_POINTS.felt).toBeDefined()
    expect(SKIN_POINTS.cardBack).toBeDefined()
    expect(SKIN_POINTS.wheelWedges).toBeDefined()
  })

  it('keeps trust-adjacent surfaces (wheel wedges / drop-board tints) declarative-only', () => {
    const wheel = SKIN_POINTS.wheelWedges
    const drop = SKIN_POINTS.dropBoardTints
    expect(wheel).toBeDefined()
    expect(drop).toBeDefined()
    expect(wheel?.trustAdjacent).toBe(true)
    expect(wheel?.allowedKinds).toEqual(['declarative'])
    expect(drop?.trustAdjacent).toBe(true)
    expect(drop?.allowedKinds).toEqual(['declarative'])
  })
})

describe('parseManifest', () => {
  it('drops a skin targeting a non-existent / trust-chrome skin-point id', () => {
    const out = parseManifest({
      skins: {
        trustSeal: { kind: 'media', pointer: 'ipfs://evil', contentHash: HASH },
        betAmount: { kind: 'declarative', pointer: '#ff0000' },
        felt: { kind: 'declarative', pointer: '#0a3121' },
      },
    })
    expect(out.skins.trustSeal).toBeUndefined()
    expect(out.skins.betAmount).toBeUndefined()
    expect(out.skins.felt).toBeDefined()
  })

  it('drops a skin whose kind is not in that skin point allowedKinds', () => {
    const out = parseManifest({
      skins: {
        // generative is not allowed on a declarative-only trust-adjacent surface
        wheelWedges: { kind: 'generative', pointer: 'eip155:943/0xabc', contentHash: HASH },
        // media is not allowed on the accent palette (declarative only)
        accentPalette: { kind: 'media', pointer: 'ipfs://x', contentHash: HASH },
      },
    })
    expect(out.skins.wheelWedges).toBeUndefined()
    expect(out.skins.accentPalette).toBeUndefined()
  })

  it('drops a media / generative ref with no contentHash', () => {
    const out = parseManifest({
      skins: {
        cardBack: { kind: 'media', pointer: 'ipfs://Qm' }, // missing contentHash
        backdrop: { kind: 'generative', pointer: 'eip155:943/0xabc' }, // missing contentHash
      },
    })
    expect(out.skins.cardBack).toBeUndefined()
    expect(out.skins.backdrop).toBeUndefined()
  })

  it('drops a declarative palette entry that fails the contrast check against trust-chrome text', () => {
    const out = parseManifest({
      palette: {
        '--panel': '#f0ead4', // near-white — trust-chrome cream text would vanish on it
        '--felt-a': '#0a3121', // dark — trust text stays legible
      },
    })
    expect(out.palette['--panel']).toBeUndefined()
    expect(out.palette['--felt-a']).toBe('#0a3121')
  })

  it('drops a palette entry whose value is not a parseable hex color (fail safe)', () => {
    const out = parseManifest({ palette: { '--bg': 'rgb(0,0,0)', '--panel': 'not-a-color' } })
    expect(out.palette['--bg']).toBeUndefined()
    expect(out.palette['--panel']).toBeUndefined()
  })

  it('keeps a valid declarative felt-color skin and a valid media card-back skin', () => {
    const out = parseManifest({
      skins: {
        felt: { kind: 'declarative', pointer: '#0a3121' },
        cardBack: { kind: 'media', pointer: 'ipfs://QmCardBack', contentHash: HASH },
      },
      palette: { '--felt-a': '#0a3121' },
    })
    expect(out.skins.felt).toEqual({ kind: 'declarative', pointer: '#0a3121' })
    expect(out.skins.cardBack).toEqual({ kind: 'media', pointer: 'ipfs://QmCardBack', contentHash: HASH })
    expect(out.palette['--felt-a']).toBe('#0a3121')
  })

  it('never throws on malformed input; returns an empty normalized manifest', () => {
    expect(parseManifest(null)).toEqual({ skins: {}, palette: {} })
    expect(parseManifest(42)).toEqual({ skins: {}, palette: {} })
    expect(parseManifest({ skins: 'nope', palette: [] })).toEqual({ skins: {}, palette: {} })
    expect(parseManifest({ skins: { felt: { kind: 'bogus', pointer: 'x' } } })).toEqual({ skins: {}, palette: {} })
  })
})

describe('contrastRatio', () => {
  it('is symmetric and clears AA for cream text on dark felt', () => {
    const r = contrastRatio('#0a3121', TRUST_TEXT_COLOR)
    expect(r).toBeGreaterThan(MIN_CONTRAST)
    expect(contrastRatio(TRUST_TEXT_COLOR, '#0a3121')).toBeCloseTo(r, 5)
  })
  it('fails a near-white background against cream trust text', () => {
    expect(contrastRatio('#f0ead4', TRUST_TEXT_COLOR)).toBeLessThan(MIN_CONTRAST)
  })
})
