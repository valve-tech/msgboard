import { useEffect, useRef, useState } from 'react'

export type MenuOption = {
  label: string
  icon?: string
  /** Small right-aligned emoji badge (e.g. the game's trust-model icon) with a hover title. */
  badge?: string
  badgeTitle?: string
}

/**
 * The house menu — a div-reveal replacement for native <select> (the venue doesn't do
 * native selects). Trigger button + positioned options panel, click-outside and Escape
 * close, arrow keys move, Enter/Space picks. Options may carry an icon URL.
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

  // Keep the highlighted option in view when the (now height-capped) panel scrolls.
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
      setHighlight((h) => Math.min(h + 1, items.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight((h) => Math.max(h - 1, 0))
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      pick(highlight)
    }
  }

  const OptionFace = ({ option }: { option: MenuOption }) => (
    <>
      {option.icon && <img className="menu-icon" src={option.icon} alt="" loading="lazy" />}
      <span>{option.label}</span>
      {option.badge && (
        <span className="menu-badge" title={option.badgeTitle} aria-label={option.badgeTitle}>
          {option.badge}
        </span>
      )}
    </>
  )

  return (
    <span className="menu" ref={rootRef} onKeyDown={onKeyDown}>
      <button
        type="button"
        className="menu-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        onClick={() => {
          setHighlight(value)
          setOpen((o) => !o)
        }}
      >
        <OptionFace option={items[value] ?? { label: '' }} />
        <span className="menu-caret" aria-hidden>
          ▾
        </span>
      </button>
      {open && (
        <span className="menu-panel" role="listbox" aria-label={label} ref={panelRef}>
          {items.map((option, i) => (
            <button
              key={option.label}
              type="button"
              role="option"
              aria-selected={i === value}
              className={`menu-option${i === value ? ' selected' : ''}${i === highlight ? ' highlight' : ''}`}
              onPointerEnter={() => setHighlight(i)}
              onClick={() => pick(i)}
            >
              <OptionFace option={option} />
            </button>
          ))}
        </span>
      )}
    </span>
  )
}
