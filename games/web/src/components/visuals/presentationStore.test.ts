import { describe, expect, it } from 'vitest'
import {
  readMode,
  writeMode,
  PRESENTATION_STORAGE_KEY,
  type ModeStore,
} from './presentationStore'

/** A minimal in-memory store, so these run in the Node vitest environment (no DOM). */
const makeStore = (initial?: Record<string, string>): ModeStore & { map: Map<string, string> } => {
  const map = new Map<string, string>(Object.entries(initial ?? {}))
  return {
    map,
    getItem: (k) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k, v) => void map.set(k, v),
  }
}

describe('presentation-mode store', () => {
  it('defaults to visual when nothing is stored', () => {
    expect(readMode(makeStore())).toBe('visual')
  })

  it('defaults to visual when no store is available', () => {
    expect(readMode(undefined)).toBe('visual')
    expect(readMode(null)).toBe('visual')
  })

  it('reads a stored classic choice', () => {
    const store = makeStore({ [PRESENTATION_STORAGE_KEY]: 'classic' })
    expect(readMode(store)).toBe('classic')
  })

  it('falls back to visual on an invalid stored value', () => {
    const store = makeStore({ [PRESENTATION_STORAGE_KEY]: 'sideways' })
    expect(readMode(store)).toBe('visual')
  })

  it('writes the mode under the shared key, and reads it back', () => {
    const store = makeStore()
    writeMode(store, 'classic')
    expect(store.map.get(PRESENTATION_STORAGE_KEY)).toBe('classic')
    expect(readMode(store)).toBe('classic')
    writeMode(store, 'visual')
    expect(readMode(store)).toBe('visual')
  })

  it('does not throw when the store is missing', () => {
    expect(() => writeMode(undefined, 'classic')).not.toThrow()
    expect(() => writeMode(null, 'visual')).not.toThrow()
  })

  it('swallows a throwing store (private mode / disabled)', () => {
    const throwing: ModeStore = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }
    expect(readMode(throwing)).toBe('visual')
    expect(() => writeMode(throwing, 'classic')).not.toThrow()
  })
})
