import { useEffect, useRef, useState } from 'react'

export type MenuOption = {
  label: string
  disabled?: boolean
}

const caret = (
  <svg className="pointer-events-none size-4 text-gray-500 dark:text-gray-400" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <path
      fillRule="evenodd"
      d="M4.22 6.22a.75.75 0 0 1 1.06 0L8 8.94l2.72-2.72a.75.75 0 1 1 1.06 1.06l-3.25 3.25a.75.75 0 0 1-1.06 0L4.22 7.28a.75.75 0 0 1 0-1.06Z"
      clipRule="evenodd"
    />
  </svg>
)

/**
 * The house menu — a div-reveal replacement for native <select> (native form controls can't be
 * styled and are banned across the msgboard apps). Trigger button + positioned options panel,
 * click-outside and Escape close, arrow keys move (skipping disabled options), Enter/Space picks.
 * Styled to match the app's input language (rounded, outline-gray, dark-mode aware).
 */
export const Menu = ({
  label,
  options,
  value,
  onChange,
}: {
  label: string
  options: (string | MenuOption)[]
  value: number
  onChange: (index: number) => void
}) => {
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(value)
  const rootRef = useRef<HTMLSpanElement>(null)
  const panelRef = useRef<HTMLSpanElement>(null)
  const items: MenuOption[] = options.map((o) => (typeof o === 'string' ? { label: o } : o))

  useEffect(() => {
    if (!open) return
    panelRef.current?.children[highlight]?.scrollIntoView({ block: 'nearest' })
  }, [open, highlight])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  const pick = (index: number) => {
    if (items[index]?.disabled) return
    onChange(index)
    setOpen(false)
  }

  /** Next non-disabled index in `dir` from `from`, or `from` when none. */
  const step = (from: number, dir: 1 | -1) => {
    let i = from
    do {
      i += dir
    } while (i >= 0 && i < items.length && items[i]?.disabled)
    return i >= 0 && i < items.length ? i : from
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setOpen(false)
      return
    }
    if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault()
      setHighlight(value)
      setOpen(true)
      return
    }
    if (!open) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlight((h) => step(h, 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight((h) => step(h, -1))
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      pick(highlight)
    }
  }

  return (
    <span className="relative inline-block" ref={rootRef} onKeyDown={onKeyDown}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        className="inline-flex w-full items-center justify-between gap-2 rounded-md bg-white py-1 pl-3 pr-2 text-base text-gray-900 outline-1 -outline-offset-1 outline-gray-300 focus:-outline-offset-2 focus:outline-indigo-600 sm:text-sm/6 dark:bg-gray-800 dark:text-gray-100 dark:outline-gray-600"
        onClick={() => {
          setHighlight(value)
          setOpen((o) => !o)
        }}
      >
        <span className="truncate">{items[value]?.label ?? ''}</span>
        {caret}
      </button>
      {open && (
        <span
          role="listbox"
          aria-label={label}
          ref={panelRef}
          className="absolute left-0 top-full z-30 mt-1 flex max-h-72 min-w-full flex-col overflow-y-auto rounded-md bg-white p-1 shadow-lg ring-1 ring-gray-300 dark:bg-gray-800 dark:ring-gray-600"
        >
          {items.map((option, i) => (
            <button
              key={option.label}
              type="button"
              role="option"
              aria-selected={i === value}
              aria-disabled={option.disabled}
              className={`whitespace-nowrap rounded px-3 py-1 text-left text-base sm:text-sm/6 ${
                option.disabled
                  ? 'cursor-default text-gray-400 dark:text-gray-500'
                  : i === value
                    ? 'font-semibold text-indigo-600 dark:text-indigo-400'
                    : 'text-gray-900 dark:text-gray-100'
              } ${i === highlight && !option.disabled ? 'bg-gray-100 dark:bg-gray-700' : ''}`}
              onPointerEnter={() => !option.disabled && setHighlight(i)}
              onClick={() => pick(i)}
            >
              {option.label}
            </button>
          ))}
        </span>
      )}
    </span>
  )
}
