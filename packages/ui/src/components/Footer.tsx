import { Icon } from '@iconify/react'
import { useThemeStore, type ThemePreference } from '../stores/theme'

const options: { value: ThemePreference; icon: string; label: string }[] = [
  { value: 'light', icon: 'mdi:white-balance-sunny', label: 'Light' },
  { value: 'dark', icon: 'mdi:moon-waning-crescent', label: 'Dark' },
  { value: 'system', icon: 'mdi:monitor', label: 'System' },
]

/** Ported from `Footer.svelte`. Theme radiogroup (zustand theme store) + copyright. */
export function Footer() {
  const preference = useThemeStore((s) => s.preference)
  const setTheme = useThemeStore((s) => s.setTheme)
  return (
    <div className="text-center text-sm text-gray-200 bg-slate-900 dark:bg-black p-4 flex flex-col items-center gap-3">
      <div
        className="inline-flex items-center gap-0.5 rounded-full border border-slate-700 p-0.5"
        role="radiogroup"
        aria-label="Color theme">
        {options.map((opt) => {
          const active = preference === opt.value
          return (
            <button
              key={opt.value}
              type="button"
              title={opt.label}
              aria-label={opt.label}
              role="radio"
              aria-checked={active}
              className={`flex items-center justify-center size-7 rounded-full transition-colors hover:text-white ${
                active ? 'bg-slate-700 text-white' : 'text-slate-400'
              }`}
              onClick={() => setTheme(opt.value)}>
              <Icon icon={opt.icon} className="size-4" />
            </button>
          )
        })}
      </div>
      <div>
        © {new Date().getFullYear()} Distributed MsgBoard. All rights reserved.
        <br />
        Built with ❤️ for the decentralized web.
      </div>
    </div>
  )
}
