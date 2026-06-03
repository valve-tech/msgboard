/** Theme preference: an explicit choice, or follow the OS ("system"). */
export type ThemePreference = 'light' | 'dark' | 'system'

const STORAGE_KEY = 'theme'

const mql = window.matchMedia('(prefers-color-scheme: dark)')

const readPreference = (): ThemePreference => {
  const v = localStorage.getItem(STORAGE_KEY)
  return v === 'light' || v === 'dark' || v === 'system' ? v : 'system'
}

/** Reactive theme state. `preference` is the user's choice; `resolved` is what's actually shown. */
export const theme = $state<{ preference: ThemePreference; resolved: 'light' | 'dark' }>({
  preference: readPreference(),
  resolved: 'light',
})

const computeResolved = (): 'light' | 'dark' =>
  theme.preference === 'system' ? (mql.matches ? 'dark' : 'light') : theme.preference

/** Resolve the preference and apply/remove the `dark` class on <html>. */
const apply = (): void => {
  theme.resolved = computeResolved()
  document.documentElement.classList.toggle('dark', theme.resolved === 'dark')
}

/** Set the theme preference, persist it, and apply it. */
export const setTheme = (preference: ThemePreference): void => {
  theme.preference = preference
  localStorage.setItem(STORAGE_KEY, preference)
  apply()
}

// initialize on load and keep "system" in sync with OS changes
apply()
mql.addEventListener('change', () => {
  if (theme.preference === 'system') apply()
})
