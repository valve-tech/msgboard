import { create } from 'zustand'

/** Theme preference: an explicit choice, or follow the OS ("system"). */
export type ThemePreference = 'light' | 'dark' | 'system'

const STORAGE_KEY = 'theme'

const getMql = (): MediaQueryList | null =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null

const readPreference = (): ThemePreference => {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    return v === 'light' || v === 'dark' || v === 'system' ? v : 'system'
  } catch {
    return 'system'
  }
}

const computeResolved = (preference: ThemePreference): 'light' | 'dark' =>
  preference === 'system' ? (getMql()?.matches ? 'dark' : 'light') : preference

/** Apply/remove the `dark` class on <html> to match the resolved theme. */
const applyClass = (resolved: 'light' | 'dark') => {
  if (typeof document !== 'undefined') {
    document.documentElement.classList.toggle('dark', resolved === 'dark')
  }
}

export type ThemeState = {
  preference: ThemePreference
  resolved: 'light' | 'dark'
  setTheme: (preference: ThemePreference) => void
  /** recompute `resolved` from the current preference + OS, and apply the class (used by the OS listener) */
  apply: () => void
}

const initialPreference = readPreference()
const initialResolved = computeResolved(initialPreference)
applyClass(initialResolved)

export const useThemeStore = create<ThemeState>((set, get) => ({
  preference: initialPreference,
  resolved: initialResolved,
  setTheme: (preference) => {
    try {
      localStorage.setItem(STORAGE_KEY, preference)
    } catch {
      /* localStorage may be unavailable */
    }
    const resolved = computeResolved(preference)
    applyClass(resolved)
    set({ preference, resolved })
  },
  apply: () => {
    const resolved = computeResolved(get().preference)
    applyClass(resolved)
    set({ resolved })
  },
}))

/**
 * Wire the OS `prefers-color-scheme` listener (mirrors the module-level `mql` listener in
 * the Svelte store). Mount once from App's `useEffect`; re-applies only while the
 * preference is "system". Returns a cleanup that removes the listener.
 */
export const initThemeOSListener = (): (() => void) => {
  const mql = getMql()
  if (!mql) return () => {}
  const onChange = () => {
    if (useThemeStore.getState().preference === 'system') useThemeStore.getState().apply()
  }
  mql.addEventListener('change', onChange)
  return () => mql.removeEventListener('change', onChange)
}
