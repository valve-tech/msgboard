<script module lang="ts">
  // retain module scoped expansion state for each tree node
  import { kvSeparator, type Tree } from '../lib/log.svelte'
  import { getScope, load, save } from '../lib/persist.svelte'
  import TreeView from './TreeView.svelte'
  import Info from './Info.svelte'
  import ToggleButton from './ToggleButton.svelte'
  import Icon from '@iconify/svelte'
  import { hexToString, stringToHex, type Hex } from 'viem'

  const _initialScope = getScope()

  /** per-node expansion state, persisted per chain scope */
  const _expansionState: Record<string, boolean> = load<Record<string, boolean>>(_initialScope, 'treeExpansion', {})
  /** per-node decode toggle state, persisted per chain scope */
  const _decodeState: Record<string, boolean> = load<Record<string, boolean>>(_initialScope, 'treeDecode', {})

  /** module-scoped toggle: when true, all decodable nodes show decoded text.
   *  Wrapped in an object so the reactive $state is preserved when imported by other components. */
  export const decodeAll = $state({ value: load<boolean>(_initialScope, 'decodeAll', true) })

  /** Load tree node states from localStorage for the given chain scope */
  export function loadTreeNodeState(scope: string): void {
    const expansion = load<Record<string, boolean>>(scope, 'treeExpansion', {})
    const decode = load<Record<string, boolean>>(scope, 'treeDecode', {})
    for (const k of Object.keys(_expansionState)) delete _expansionState[k]
    Object.assign(_expansionState, expansion)
    for (const k of Object.keys(_decodeState)) delete _decodeState[k]
    Object.assign(_decodeState, decode)
    decodeAll.value = load<boolean>(scope, 'decodeAll', true)
  }

  /** Save current tree node states to localStorage for the active chain scope */
  export function saveTreeNodeState(): void {
    const scope = getScope()
    save(scope, 'treeExpansion', _expansionState)
    save(scope, 'treeDecode', _decodeState)
    save(scope, 'decodeAll', decodeAll.value)
  }

  /** Remove entries not present in validLabels and persist the cleaned state */
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
</script>

<script lang="ts">
  type Props = { label: string; children: Tree[]; isRoot?: boolean; hideContent?: boolean; decodable?: boolean; meta?: string }
  const { label: l = '', children = [], isRoot = false, hideContent = false, decodable = false, meta }: Props = $props()
  const kv = $derived(l.split(kvSeparator))
  const isKV = $derived(kv.length > 1)
  const target = $derived(isKV ? kv[1] as Hex : l as Hex)
  let showDecoded = $state(l in _decodeState ? _decodeState[l] : l === stringToHex('gasmoneyplease', { size: 32 }))
  const decoded = $derived(hexToString(target))
  /** effective decoded state: respects both the global "decode all" toggle and the per-node toggle */
  const effectiveDecoded = $derived(decodable && (decodeAll.value || showDecoded))
  /** the key shown in the left column for key:value rows */
  const key = $derived(isKV ? kv[0] : '')
  /** the value shown and copied — strips the key prefix and respects the decoded toggle */
  const value = $derived(effectiveDecoded ? decoded : (isKV ? kv[1] : l))
  /** unbroken hex wraps with break-all; human-readable values break on word/separator boundaries
   *  so numbers (e.g. the stats row) are not split mid-digit on narrow screens */
  const isHexValue = $derived(/^0x[0-9a-fA-F]*$/.test(value))

  const hasChildren = $derived(children.length > 0)

  // auto-expand only the hidden root container so its categories are listed;
  // categories/messages stay collapsed by default unless the user opened them before
  let expanded: boolean = $state(_expansionState[l] ?? hideContent)
  const toggleExpansion = () => {
    if (!hasChildren) return
    expanded = _expansionState[l] = !expanded
    saveTreeNodeState()
  }

  /** brief "copied" flash on the value */
  let copied = $state(false)
  let copyTimer: ReturnType<typeof setTimeout>
  const copyToClipboard = (e: Event) => {
    e.stopPropagation()
    navigator.clipboard.writeText(`${value}`)
    copied = true
    clearTimeout(copyTimer)
    copyTimer = setTimeout(() => { copied = false }, 350)
  }

  const toggleDecode = (e: Event) => {
    e.stopPropagation()
    showDecoded = !showDecoded
    _decodeState[l] = showDecoded
    saveTreeNodeState()
  }
</script>

<ul class={`list list-style-none user-select-none ${isRoot ? 'list-root' : 'pl-3 sm:pl-4'}`}>
  <li>
    {#if !hideContent}
      <div
        class="flex flex-row items-start gap-2 font-mono text-xs sm:text-base py-1 border-gray-100 dark:border-gray-700 rounded"
        class:border-t={!isKV}
        class:cursor-pointer={hasChildren}
        role={hasChildren ? 'button' : undefined}
        tabindex={hasChildren ? 0 : undefined}
        aria-expanded={hasChildren ? expanded : undefined}
        onkeypress={hasChildren ? toggleExpansion : undefined}
        onclick={hasChildren ? toggleExpansion : undefined}>
        {#if hasChildren}
          <Icon
            icon="mdi:chevron-right"
            class="size-4 shrink-0 mt-0.5 text-gray-400 dark:text-gray-500 transition-transform duration-100 {expanded ? 'rotate-90' : ''}" />
        {:else if isKV}
          <span class="shrink-0 w-20 sm:w-28 text-right text-gray-400 dark:text-gray-500 select-none">{key}</span>
        {/if}

        <span class="relative flex-1 min-w-0 group/cp">
          <button
            type="button"
            class={`block w-full ${isHexValue ? 'break-all' : 'break-words'} whitespace-pre-wrap text-left cursor-copy rounded px-1 -mx-1 transition-colors hover:bg-gray-500/10`}
            onclick={copyToClipboard}>{value}</button>
          <span
            class={`pointer-events-none absolute left-0 -top-5 z-20 whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-sans shadow transition-opacity duration-100 group-hover/cp:opacity-100 ${
              copied
                ? 'opacity-100 bg-green-600 text-white'
                : 'opacity-0 bg-white text-gray-700 ring-1 ring-gray-200 dark:bg-gray-800 dark:text-gray-100 dark:ring-0'
            }`}>{copied ? 'Copied!' : 'Click to copy'}</span>
        </span>

        {#if meta}
          <span class="shrink-0 ml-2 text-xs text-gray-400 dark:text-gray-500 font-sans whitespace-nowrap flex flex-row items-center gap-1">{meta}<Info text="Estimated time until this message is removed from the msgboard" align="right" iconClass="size-4" /></span>
        {/if}

        {#if decodable}
          <span class="shrink-0 self-center">
            <ToggleButton off="0x" on="txt" offIcon="mdi:code-brackets" onIcon="mdi:format-text" checked={effectiveDecoded} onclick={toggleDecode} />
          </span>
        {/if}
      </div>
    {/if}
    {#if expanded}
      {#each children as child}
        <TreeView label={child.label} children={child.children} decodable={child.decodable} isRoot={child.isRoot} meta={child.meta} />
      {/each}
    {/if}
  </li>
</ul>
