import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchThemeManifest } from './operatorTheme'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('fetchThemeManifest', () => {
  it('returns undefined for a missing URI without fetching', async () => {
    const spy = vi.spyOn(globalThis, 'fetch')
    expect(await fetchThemeManifest(undefined)).toBeUndefined()
    expect(spy).not.toHaveBeenCalled()
  })

  it('returns the parsed JSON on a 2xx response', async () => {
    const body = { palette: { '--felt-hi': '#0a3121' } }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }),
    )
    expect(await fetchThemeManifest('https://op.example/theme.json')).toEqual(body)
  })

  it('returns undefined on a non-2xx response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 404 }))
    expect(await fetchThemeManifest('https://op.example/missing.json')).toBeUndefined()
  })

  it('returns undefined when the fetch throws (network error / abort)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('aborted'))
    expect(await fetchThemeManifest('https://op.example/slow.json', 10)).toBeUndefined()
  })
})
