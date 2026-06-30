import { useState, type ReactNode } from 'react'
import { Icon } from '@iconify/react'

/** A numbered flow step card with a title + optional subtitle. */
export function Section(props: {
  step: number
  title: string
  done?: boolean
  subtitle?: string
  children: ReactNode
}) {
  return (
    <section className="rounded-xl border border-gray-800 bg-gray-900/60 p-5">
      <header className="mb-4 flex items-center gap-3">
        <span
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${
            props.done ? 'bg-emerald-600 text-white' : 'bg-gray-800 text-gray-300'
          }`}>
          {props.done ? <Icon icon="mdi:check" /> : props.step}
        </span>
        <div>
          <h2 className="text-base font-semibold text-gray-100">{props.title}</h2>
          {props.subtitle && <p className="text-xs text-gray-400">{props.subtitle}</p>}
        </div>
      </header>
      {props.children}
    </section>
  )
}

/** A labelled form field. */
export function Field(props: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-gray-400">{props.label}</span>
      {props.children}
      {props.hint && <span className="mt-1 block text-[11px] text-gray-500">{props.hint}</span>}
    </label>
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
      className={`w-full rounded-md border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-gray-100 outline-none placeholder:text-gray-600 focus:border-indigo-500 disabled:opacity-50 ${
        props.mono ? 'font-mono text-xs' : ''
      }`} />
  )
}

export function Button(props: {
  onClick: () => void
  children: ReactNode
  disabled?: boolean
  variant?: 'primary' | 'ghost' | 'danger'
  busy?: boolean
}) {
  const variant = props.variant ?? 'primary'
  const styles =
    variant === 'primary'
      ? 'bg-indigo-600 hover:bg-indigo-500 text-white disabled:bg-gray-700'
      : variant === 'danger'
        ? 'bg-amber-700 hover:bg-amber-600 text-white disabled:bg-gray-700'
        : 'border border-gray-700 text-gray-200 hover:bg-gray-800 disabled:opacity-40'
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled || props.busy}
      className={`inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition ${styles} disabled:cursor-not-allowed`}>
      {props.busy && <Icon icon="mdi:loading" className="animate-spin" />}
      {props.children}
    </button>
  )
}

/** Monospace value with a copy button. */
export function Copyable(props: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    void navigator.clipboard?.writeText(props.value).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    })
  }
  return (
    <div className="flex items-start gap-2 rounded-md border border-gray-800 bg-gray-950 p-2">
      <code className="grow break-all font-mono text-[11px] text-gray-300">{props.value}</code>
      <button
        type="button"
        onClick={copy}
        title={`Copy ${props.label ?? 'value'}`}
        className="shrink-0 rounded p-1 text-gray-400 hover:bg-gray-800 hover:text-gray-100">
        <Icon icon={copied ? 'mdi:check' : 'mdi:content-copy'} />
      </button>
    </div>
  )
}

export function Pill(props: { children: ReactNode; tone?: 'ok' | 'warn' | 'muted' }) {
  const tone = props.tone ?? 'muted'
  const styles =
    tone === 'ok'
      ? 'bg-emerald-900/50 text-emerald-300'
      : tone === 'warn'
        ? 'bg-amber-900/50 text-amber-300'
        : 'bg-gray-800 text-gray-400'
  return <span className={`rounded px-2 py-0.5 text-[11px] font-medium ${styles}`}>{props.children}</span>
}

export function Notice(props: { tone: 'error' | 'info'; children: ReactNode }) {
  const styles =
    props.tone === 'error'
      ? 'border-red-900 bg-red-950/50 text-red-300'
      : 'border-indigo-900 bg-indigo-950/40 text-indigo-200'
  return <div className={`rounded-md border px-3 py-2 text-xs ${styles}`}>{props.children}</div>
}
