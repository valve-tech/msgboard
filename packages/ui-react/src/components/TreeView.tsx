import { useRef, useState } from 'react'
import { Icon } from '@iconify/react'
import { hexToString, stringToHex, type Hex } from 'viem'
import { kvSeparator, type Tree } from '../lib/tree'
import { getScope, load, save } from '../lib/persist'
import { resolveCategoryValue } from '../lib/tree-format'
import { useChainStore, selectChain, selectRpcUrl } from '../stores/chain'
import { Info } from './Info'
import { ToggleButton } from './ToggleButton'

/**
 * Ported from `TreeView.svelte`.
 *
 * The Svelte version kept module-scoped expansion/decode state (a `<script module>` block);
 * that maps cleanly to plain module-level objects here. `decodeAll` is exported as a mutable
 * holder (the Svelte `$state({ value })` wrapper) so `Summary` can flip it.
 *
 * NOTE: React reserves the `children` prop name, so the tree's child nodes are passed as
 * `childrenNodes` (the Svelte `children` prop).
 */

// ── module-scoped, persisted node state (verbatim logic from the Svelte module block) ──
const scopeNow = (): string =>
  getScope(selectChain(useChainStore.getState())?.id, selectRpcUrl(useChainStore.getState()))

const _initialScope = scopeNow()
const _expansionState: Record<string, boolean> = load<Record<string, boolean>>(_initialScope, 'treeExpansion', {})
const _decodeState: Record<string, boolean> = load<Record<string, boolean>>(_initialScope, 'treeDecode', {})

/** module-scoped toggle: when true, all decodable nodes show decoded text. */
export const decodeAll = { value: load<boolean>(_initialScope, 'decodeAll', true) }

export function loadTreeNodeState(scope: string): void {
  const expansion = load<Record<string, boolean>>(scope, 'treeExpansion', {})
  const decode = load<Record<string, boolean>>(scope, 'treeDecode', {})
  for (const k of Object.keys(_expansionState)) delete _expansionState[k]
  Object.assign(_expansionState, expansion)
  for (const k of Object.keys(_decodeState)) delete _decodeState[k]
  Object.assign(_decodeState, decode)
  decodeAll.value = load<boolean>(scope, 'decodeAll', true)
}

export function saveTreeNodeState(): void {
  const scope = scopeNow()
  save(scope, 'treeExpansion', _expansionState)
  save(scope, 'treeDecode', _decodeState)
  save(scope, 'decodeAll', decodeAll.value)
}

export function pruneTreeNodeState(validLabels: Set<string>): void {
  let pruned = false
  for (const k of Object.keys(_expansionState)) {
    if (!validLabels.has(k)) {
      delete _expansionState[k]
      pruned = true
    }
  }
  for (const k of Object.keys(_decodeState)) {
    if (!validLabels.has(k)) {
      delete _decodeState[k]
      pruned = true
    }
  }
  if (pruned) saveTreeNodeState()
}

type Props = {
  label?: string
  childrenNodes?: Tree[]
  isRoot?: boolean
  hideContent?: boolean
  decodable?: boolean
  meta?: string
}

export function TreeView({
  label: l = '',
  childrenNodes = [],
  isRoot = false,
  hideContent = false,
  decodable = false,
  meta,
}: Props) {
  const kv = l.split(kvSeparator)
  const isKV = kv.length > 1
  const target = (isKV ? kv[1] : l) as Hex
  const [showDecoded, setShowDecoded] = useState<boolean>(
    l in _decodeState ? _decodeState[l] : l === stringToHex('gasmoneyplease', { size: 32 }),
  )
  const decoded = safeHexToString(target)
  const effectiveDecoded = decodable && (decodeAll.value || showDecoded)
  const key = isKV ? kv[0] : ''
  const value = effectiveDecoded ? decoded : isKV ? kv[1] : l
  const isHexValue = /^0x[0-9a-fA-F]*$/.test(value)
  const hasChildren = childrenNodes.length > 0

  const isCategoryHeader = isRoot && hasChildren
  const categoryValue = resolveCategoryValue(target, decoded, effectiveDecoded)
  const displayValue = isCategoryHeader ? categoryValue : value

  const [expanded, setExpanded] = useState<boolean>(_expansionState[l] ?? hideContent)
  const toggleExpansion = () => {
    if (!hasChildren) return
    const next = !expanded
    _expansionState[l] = next
    setExpanded(next)
    saveTreeNodeState()
  }

  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout>>()
  const copyToClipboard = (e: React.MouseEvent) => {
    e.stopPropagation()
    navigator.clipboard.writeText(`${displayValue}`)
    setCopied(true)
    clearTimeout(copyTimer.current)
    copyTimer.current = setTimeout(() => setCopied(false), 350)
  }

  const toggleDecode = (e: React.MouseEvent) => {
    e.stopPropagation()
    const next = !showDecoded
    setShowDecoded(next)
    _decodeState[l] = next
    saveTreeNodeState()
  }

  return (
    <ul className={`list list-style-none user-select-none ${isRoot ? 'list-root' : 'pl-3 sm:pl-4'}`}>
      <li>
        {!hideContent && (
          <div
            className={`flex flex-row items-start gap-2 font-mono text-xs sm:text-base py-1 border-gray-100 dark:border-gray-700 rounded ${
              !isKV ? 'border-t' : ''
            } ${hasChildren ? 'cursor-pointer' : ''}`}
            role={hasChildren ? 'button' : undefined}
            tabIndex={hasChildren ? 0 : undefined}
            aria-expanded={hasChildren ? expanded : undefined}
            onKeyPress={hasChildren ? toggleExpansion : undefined}
            onClick={hasChildren ? toggleExpansion : undefined}
          >
            {hasChildren ? (
              <Icon
                icon="mdi:chevron-right"
                className={`size-4 shrink-0 mt-0.5 text-gray-400 dark:text-gray-500 transition-transform duration-100 ${
                  expanded ? 'rotate-90' : ''
                }`}
              />
            ) : isKV ? (
              <span className="shrink-0 w-20 sm:w-28 text-right text-gray-400 dark:text-gray-500 select-none">
                {key}
              </span>
            ) : null}

            <span className="relative flex-1 min-w-0 group/cp">
              <button
                type="button"
                className={`block w-full ${
                  isHexValue ? 'break-all' : 'break-words'
                } whitespace-pre-wrap text-left cursor-copy rounded px-1 -mx-1 transition-colors hover:bg-gray-500/10`}
                onClick={copyToClipboard}
              >
                {displayValue}
              </button>
              <span
                className={`pointer-events-none absolute left-0 -top-5 z-20 whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-sans shadow transition-opacity duration-100 group-hover/cp:opacity-100 ${
                  copied
                    ? 'opacity-100 bg-green-600 text-white'
                    : 'opacity-0 bg-white text-gray-700 ring-1 ring-gray-200 dark:bg-gray-800 dark:text-gray-100 dark:ring-0'
                }`}
              >
                {copied ? 'Copied!' : 'Click to copy'}
              </span>
            </span>

            {meta && (
              <span className="shrink-0 ml-2 text-xs text-gray-400 dark:text-gray-500 font-sans whitespace-nowrap flex flex-row items-center gap-1">
                {meta}
                <Info
                  text="Estimated time until this message is removed from the msgboard"
                  align="right"
                  iconClass="size-4"
                />
              </span>
            )}

            {decodable && (
              <span className="shrink-0 self-center">
                <ToggleButton
                  off="0x"
                  on="txt"
                  offIcon="mdi:code-brackets"
                  onIcon="mdi:format-text"
                  checked={effectiveDecoded}
                  onClick={toggleDecode}
                />
              </span>
            )}
          </div>
        )}
        {expanded &&
          childrenNodes.map((child, i) => (
            <TreeView
              key={`${child.label}-${i}`}
              label={child.label}
              childrenNodes={child.children}
              decodable={child.decodable}
              isRoot={child.isRoot}
              meta={child.meta}
            />
          ))}
      </li>
    </ul>
  )
}

/** hexToString can throw on non-utf8 bytes; the Svelte `$derived` swallowed nothing because
 *  the values were always decodable. Guard here so a bad byte sequence renders as raw hex. */
function safeHexToString(target: Hex): string {
  try {
    return hexToString(target)
  } catch {
    return target
  }
}
