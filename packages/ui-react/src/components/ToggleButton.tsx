import { Icon } from '@iconify/react'

type Props = {
  /** label shown when unchecked (also the accessible name for the off state) */
  off: string
  /** label shown when checked (also the accessible name for the on state) */
  on: string
  /** optional iconify icon shown instead of the `off` text when unchecked */
  offIcon?: string
  /** optional iconify icon shown instead of the `on` text when checked */
  onIcon?: string
  /** size/class applied to the icons (default size-3.5 = 14px) */
  iconClass?: string
  checked: boolean
  onClick: (e: React.MouseEvent) => void
  disabled?: boolean
}

/** Ported from `ToggleButton.svelte`. */
export function ToggleButton({
  off,
  on,
  offIcon,
  onIcon,
  iconClass = 'size-3.5',
  checked = false,
  onClick,
  disabled = false,
}: Props) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent bg-gray-200 dark:bg-gray-700 transition-all duration-200 ease-in-out focus:outline-none focus:ring-1 focus:ring-amber-500 focus:ring-offset-1 ${
        disabled ? 'opacity-50 pointer-events-none' : ''
      } ${checked ? 'bg-amber-400 dark:bg-amber-500' : 'bg-gray-300'}`}
      role="switch"
      aria-checked={checked}
      aria-label={checked ? on : off}
      disabled={disabled}
    >
      <span
        className={`pointer-events-none relative inline-block size-5 transform rounded-full bg-white dark:bg-gray-100 shadow-sm ring-0 transition duration-200 ease-in-out ${
          checked ? 'translate-x-5' : 'translate-x-0'
        }`}
      >
        <span
          className={`absolute inset-0 flex size-full items-center justify-center transition-opacity overflow-hidden ${
            checked ? 'opacity-0 duration-100 ease-out' : 'opacity-100 duration-200 ease-in'
          }`}
          aria-hidden="true"
        >
          {offIcon ? (
            <Icon icon={offIcon} className={`${iconClass} text-gray-600`} />
          ) : (
            <span className="text-[9px] font-mono text-gray-600">{off}</span>
          )}
        </span>
        <span
          className={`absolute inset-0 flex size-full items-center justify-center transition-opacity overflow-hidden ${
            checked ? 'opacity-100 duration-100 ease-out' : 'opacity-0 duration-200 ease-in'
          }`}
          aria-hidden="true"
        >
          {onIcon ? (
            <Icon icon={onIcon} className={`${iconClass} text-amber-700`} />
          ) : (
            <span className="text-[9px] font-mono text-amber-700">{on}</span>
          )}
        </span>
      </span>
    </button>
  )
}
