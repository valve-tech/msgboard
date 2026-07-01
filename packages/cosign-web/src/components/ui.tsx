import { useState, type ReactNode } from 'react'
import { Icon } from '@iconify/react'

/** `0x9A3d…4F10`-style address/hash truncation (mono display). */
export const short = (a?: string | null, head = 6, tail = 4): string =>
  a ? (a.length <= head + tail + 1 ? a : `${a.slice(0, head)}…${a.slice(-tail)}`) : '—'

export const cx = (...c: (string | false | null | undefined)[]): string => c.filter(Boolean).join(' ')

/* ── The quorum seal ──────────────────────────────────────────────────────────────────────────
 * A segmented SVG ring — one arc per required signature (threshold) — filling BRASS as owners sign.
 * The center reads `signed/threshold`. On quorum it completes ("QUORUM MET"); after execute it locks
 * to OXBLOOD ("SEALED"). This IS the threshold progress. Arc fills animate via the `.seg` CSS
 * transition, which is disabled under `prefers-reduced-motion`.
 */
export function Seal(props: {
  signed: number
  threshold: number
  ownersTotal: number
  executed: boolean
}) {
  const { signed, threshold, ownersTotal, executed } = props
  const cx0 = 75
  const cy0 = 75
  const r = 52
  const C = 2 * Math.PI * r
  const n = Math.max(threshold, 1)
  const gap = n > 1 ? 7 : 0
  const seg = C / n - gap
  const met = signed >= threshold && threshold > 0
  const fillColor = executed ? 'var(--oxblood)' : 'var(--brass)'

  const segments = Array.from({ length: n }, (_, i) => {
    const filled = i < signed
    const rot = -90 + (i * 360) / n
    return (
      <circle
        key={i}
        className="seg"
        cx={cx0}
        cy={cy0}
        r={r}
        fill="none"
        stroke={filled ? fillColor : 'var(--line2)'}
        strokeWidth={7}
        strokeLinecap="butt"
        strokeDasharray={`${seg} ${C - seg}`}
        transform={`rotate(${rot} ${cx0} ${cy0})`}
        style={{ filter: filled && !executed ? 'drop-shadow(0 0 3px rgba(199,154,62,.5))' : undefined }} />
    )
  })

  // owner ticks around the outside (one per owner in the set)
  const ticks = Array.from({ length: Math.max(ownersTotal, 1) }, (_, i) => {
    const a = (-90 + (i * 360) / Math.max(ownersTotal, 1)) * (Math.PI / 180)
    const inner = 62
    const outer = 68
    return (
      <line
        key={i}
        x1={cx0 + inner * Math.cos(a)}
        y1={cy0 + inner * Math.sin(a)}
        x2={cx0 + outer * Math.cos(a)}
        y2={cy0 + outer * Math.sin(a)}
        stroke="var(--dim)"
        strokeWidth={2} />
    )
  })

  const caption = executed ? 'SEALED' : met ? 'QUORUM MET' : `${threshold - signed} MORE`

  return (
    <svg
      width="150"
      height="150"
      viewBox="0 0 150 150"
      role="img"
      aria-label={`${signed} of ${threshold} signatures collected${executed ? ', executed' : met ? ', quorum met' : ''}`}>
      <g>{ticks}</g>
      {segments}
      <circle cx={cx0} cy={cy0} r={40} fill="rgba(199,154,62,.05)" stroke="var(--brass-dim)" strokeWidth={1} />
      <text
        x={cx0}
        y={72}
        textAnchor="middle"
        fontFamily="Space Grotesk"
        fontWeight={700}
        fontSize={27}
        fill="var(--parch)">
        {signed}/{threshold || '?'}
      </text>
      <text
        x={cx0}
        y={90}
        textAnchor="middle"
        fontFamily="IBM Plex Mono"
        fontSize={8.5}
        letterSpacing={1.5}
        fill={executed ? 'var(--oxblood)' : 'var(--brass)'}>
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

export function OwnerRow(props: { addr: string; you?: boolean; done: boolean; status: string }) {
  return (
    <div className={cx('owner', props.done && 'done')}>
      <span className={cx('dot', props.done ? 'done' : 'wait')} />
      {short(props.addr)}
      {props.you && <span className="you">you</span>}
      <span className="st">{props.status}</span>
    </div>
  )
}

export function TextInput(props: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  mono?: boolean
  disabled?: boolean
}) {
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
