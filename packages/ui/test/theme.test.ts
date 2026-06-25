import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const importTheme = async () => await import('../src/stores/theme')

const mockMatchMedia = (matches: boolean) => {
  const listeners = new Set<(e: { matches: boolean }) => void>()
  const mql = {
    matches,
    media: '(prefers-color-scheme: dark)',
    addEventListener: (_: string, cb: (e: { matches: boolean }) => void) => listeners.add(cb),
    removeEventListener: (_: string, cb: (e: { matches: boolean }) => void) => listeners.delete(cb),
    dispatch: (m: boolean) => listeners.forEach((cb) => cb({ matches: m })),
  }
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => mql),
  )
  return mql
}

beforeEach(() => {
  vi.resetModules()
  localStorage.clear()
  document.documentElement.classList.remove('dark')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('theme store', () => {
  it("setTheme('dark') toggles the .dark class and persists", async () => {
    mockMatchMedia(false)
    const { useThemeStore } = await importTheme()
    useThemeStore.getState().setTheme('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(localStorage.getItem('theme')).toBe('dark')
    expect(useThemeStore.getState().resolved).toBe('dark')
    expect(useThemeStore.getState().preference).toBe('dark')
  })

  it("setTheme('light') removes the .dark class", async () => {
    mockMatchMedia(true)
    const { useThemeStore } = await importTheme()
    useThemeStore.getState().setTheme('light')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(useThemeStore.getState().resolved).toBe('light')
  })

  it("'system' resolves via matchMedia", async () => {
    mockMatchMedia(true)
    const { useThemeStore } = await importTheme()
    useThemeStore.getState().setTheme('system')
    expect(useThemeStore.getState().resolved).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('the OS listener re-applies while preference is system', async () => {
    const mql = mockMatchMedia(false)
    const { useThemeStore, initThemeOSListener } = await importTheme()
    useThemeStore.getState().setTheme('system')
    const cleanup = initThemeOSListener()
    expect(useThemeStore.getState().resolved).toBe('light')
    mql.matches = true
    mql.dispatch(true)
    expect(useThemeStore.getState().resolved).toBe('dark')
    cleanup()
  })
})
