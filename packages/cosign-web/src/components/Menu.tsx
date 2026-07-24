import { useEffect, useRef, useState } from 'react'

/**
 * The house menu — a div-reveal replacement for native <select> (native form controls can't be
 * styled and are banned across the msgboard apps; same pattern as the games venue's Menu).
 * Trigger button + positioned options panel, click-outside and Escape close, arrow keys move,
 * Enter/Space picks.
 */
export const Menu = ({
  label,
  options,
  value,
  onChange,
  disabled,
}: {
  label: string
  options: string[]
  value: number
  onChange: (index: number) => void
  disabled?: boolean
}) => {
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(value)
  const rootRef = useRef<HTMLSpanElement>(null)
  const panelRef = useRef<HTMLSpanElement>(null)

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
    onChange(index)
    setOpen(false)
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
      setHighlight((h) => Math.min(h + 1, options.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight((h) => Math.max(h - 1, 0))
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      pick(highlight)
    }
  }

  return (
    <span className="menu" ref={rootRef} onKeyDown={onKeyDown}>
      <button
        type="button"
        className="menu-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        disabled={disabled}
        onClick={() => {
          setHighlight(value)
          setOpen((o) => !o)
        }}
      >
        <span>{options[value] ?? ''}</span>
        <span className="menu-caret" aria-hidden>
          ▾
        </span>
      </button>
      {open && (
        <span className="menu-panel" role="listbox" aria-label={label} ref={panelRef}>
          {options.map((option, i) => (
            <button
              key={option}
              type="button"
              role="option"
              aria-selected={i === value}
              className={`menu-option${i === value ? ' selected' : ''}${i === highlight ? ' highlight' : ''}`}
              onPointerEnter={() => setHighlight(i)}
              onClick={() => pick(i)}
            >
              {option}
            </button>
          ))}
        </span>
      )}
    </span>
  )
}

/** The house toggle — a button-reveal replacement for native checkboxes. */
export const Toggle = ({
  checked,
  onChange,
  disabled,
  children,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
  children: React.ReactNode
}) => (
  <button
    type="button"
    className={`toggle${checked ? ' on' : ''}`}
    role="switch"
    aria-checked={checked}
    disabled={disabled}
    onClick={() => onChange(!checked)}
  >
    <span className="toggle-box" aria-hidden>
      {checked ? '✓' : ''}
    </span>
    <span>{children}</span>
  </button>
)
