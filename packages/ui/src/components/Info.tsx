import { Icon } from '@iconify/react'

type Props = {
  text: string
  /** horizontal anchor for the tooltip popup - defaults to 'left' */
  align?: 'left' | 'right'
  /** optional size/class for the info icon (defaults to inheriting the text size) */
  iconClass?: string
}

/** Ported from `Info.svelte`. */
export function Info({ text, align = 'left', iconClass = '' }: Props) {
  return (
    <div className="flex group relative">
      <button
        type="button"
        aria-label={text}
        className="flex items-center cursor-help border-0 bg-transparent p-0 text-current focus:outline-none focus-visible:ring-1 focus-visible:ring-indigo-400 rounded"
        onClick={(e) => e.stopPropagation()}
      >
        <Icon icon="mdi:information-outline" className={iconClass} />
      </button>
      <div
        role="tooltip"
        className={`absolute top-0 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 rounded-md p-2 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 invisible group-hover:visible group-focus-within:visible transition-opacity duration-100 text-xs w-72 sm:w-96 max-w-[calc(100vw-1rem)] shadow z-10 -translate-y-full ${
          align === 'left' ? 'left-0' : 'right-0'
        }`}
      >
        {text}
      </div>
    </div>
  )
}
