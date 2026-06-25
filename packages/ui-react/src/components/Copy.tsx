import { useState } from 'react'
import { Icon } from '@iconify/react'

type Value = string | null | number | undefined | bigint | boolean
type Props = {
  value?: Value
  copy?: (value: Value) => void
  classes?: string
}

/** Ported from `Copy.svelte`. */
export function Copy({ value = '', copy, classes = '' }: Props) {
  const [copied, setCopied] = useState(false)
  const defaultCopy = (v: Value) => {
    navigator.clipboard.writeText(`${v}`)
    setCopied(true)
    setTimeout(() => setCopied(false), 200)
  }
  const doCopy = copy ?? defaultCopy
  return (
    <button
      type="button"
      className={`inline-block min-w-6 copier transition-opacity duration-200 ${copied ? 'opacity-0' : ''} ${classes}`}
      onClick={(e) => {
        e.stopPropagation()
        doCopy(value)
      }}
    >
      <Icon className="inline" icon="ph:copy" />
    </button>
  )
}
