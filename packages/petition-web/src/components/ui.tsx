import { useState, type ReactNode } from 'react'
import { Icon } from '@iconify/react'

/** `0x9A3d…4F10`-style address/hash truncation (mono display). */
export const short = (a?: string | null, head = 6, tail = 4): string =>
  a ? (a.length <= head + tail + 1 ? a : `${a.slice(0, head)}…${a.slice(-tail)}`) : '—'

export const cx = (...c: (string | false | null | undefined)[]): string => c.filter(Boolean).join(' ')

/* ── The progress ring ────────────────────────────────────────────────────────────────────────
 * A segmented SVG ring — adapted from cosign-web's quorum "Seal" for petitions: `filled` of `total`
 * segments in brass, center reads `filled/total` (or just `filled` past `capAt`, matching the tier
 * label in the caption). Purely presentational threshold styling.
 */
export function ProgressRing(props: {
  filled: number
  total: number
  caption: string
  tone?: 'brass' | 'patina'
}) {
  const { filled, total, caption } = props
  const cx0 = 75
  const cy0 = 75
  const r = 52
  const C = 2 * Math.PI * r
  const n = Math.max(Math.min(total, 24), 1) // cap ring segments visually at 24 slices
  const gap = n > 1 ? 7 : 0
  const seg = C / n - gap
  const filledSegs = total > 0 ? Math.round((Math.min(filled, total) / total) * n) : 0
  const fillColor = props.tone === 'patina' ? 'var(--patina)' : 'var(--brass)'

  const segments = Array.from({ length: n }, (_, i) => {
    const on = i < filledSegs
    const rot = -90 + (i * 360) / n
    return (
      <circle
        key={i}
        className="seg"
        cx={cx0}
        cy={cy0}
        r={r}
        fill="none"
        stroke={on ? fillColor : 'var(--line2)'}
        strokeWidth={7}
        strokeLinecap="butt"
        strokeDasharray={`${seg} ${C - seg}`}
        transform={`rotate(${rot} ${cx0} ${cy0})`} />
    )
  })

  return (
    <svg width="150" height="150" viewBox="0 0 150 150" role="img" aria-label={caption}>
      {segments}
      <circle cx={cx0} cy={cy0} r={40} fill="rgba(199,154,62,.05)" stroke="var(--brass-dim)" strokeWidth={1} />
      <text x={cx0} y={72} textAnchor="middle" fontFamily="Space Grotesk" fontWeight={700} fontSize={22} fill="var(--parch)">
        {filled}
      </text>
      <text x={cx0} y={90} textAnchor="middle" fontFamily="IBM Plex Mono" fontSize={8.5} letterSpacing={1} fill={fillColor}>
        {caption}
      </text>
    </svg>
  )
}

/** A collapsed, completed step — a ledger line carrying its real dynamic values in mono. */
export function RegisterLine(props: {
  n: string
  label: string
  tick: string
  children: ReactNode
  action?: { label: string; onClick: () => void }
}) {
  return (
    <div className="reg">
      <span className="n">{props.n}</span>
      <span className="lbl">{props.label}</span>
      <span className="val trunc">
        <span className="seal-tick">{props.tick}</span>
        {props.children}
      </span>
      {props.action && (
        <button type="button" className="edit" onClick={props.action.onClick}>
          {props.action.label}
        </button>
      )}
    </div>
  )
}

/** The one active step card (bold) or a locked future-step head. */
export function StepCard(props: {
  n: string
  title: string
  sub?: string
  active: boolean
  children?: ReactNode
}) {
  return (
    <div className={cx('step', props.active && 'active')}>
      <div className="head">
        <span className={cx('num', props.active ? 'on' : 'off')}>{props.n}</span>
        <h3>{props.title}</h3>
        {props.sub && <span className="sub">{props.sub}</span>}
      </div>
      {props.active && props.children && <div className="body">{props.children}</div>}
    </div>
  )
}

export function TextInput(props: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  mono?: boolean
  disabled?: boolean
  multiline?: boolean
}) {
  if (props.multiline) {
    return (
      <textarea
        value={props.value}
        disabled={props.disabled}
        placeholder={props.placeholder}
        onChange={(e) => props.onChange(e.target.value)}
        rows={3}
        className={cx('input', props.mono && 'mono')} />
    )
  }
  return (
    <input
      type="text"
      value={props.value}
      disabled={props.disabled}
      placeholder={props.placeholder}
      onChange={(e) => props.onChange(e.target.value)}
      className={cx('input', props.mono && 'mono')} />
  )
}

export function Field(props: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="lbl">{props.label}</span>
      {props.children}
      {props.hint && <span className="hint" style={{ margin: '5px 0 0' }}>{props.hint}</span>}
    </label>
  )
}

export function Copyable(props: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    void navigator.clipboard?.writeText(props.value).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    })
  }
  return (
    <div className="notice info" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <code className="mono trunc" style={{ flex: 1, fontSize: 11 }}>
        {props.value}
      </code>
      <button
        type="button"
        onClick={copy}
        title={`Copy ${props.label ?? 'value'}`}
        className="edit"
        style={{ marginLeft: 0 }}>
        <Icon icon={copied ? 'mdi:check' : 'mdi:content-copy'} />
      </button>
    </div>
  )
}
