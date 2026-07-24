/**
 * The house toggle — a button-reveal replacement for native checkboxes (the venue doesn't do
 * native form controls; they can't be styled). A brass-boxed check glyph plus the label text,
 * whole row clickable, `role="switch"` for assistive tech.
 */
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
