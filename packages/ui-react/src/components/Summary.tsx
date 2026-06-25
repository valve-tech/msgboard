import { useSyncExternalStore } from 'react'
import { useChainStore, selectCategories, selectMessages } from '../stores/chain'
import { decodeAll, saveTreeNodeState } from './TreeView'
import { ToggleButton } from './ToggleButton'

/** Ported from `Summary.svelte`. Category/message counts from the chain store + decode-all toggle. */
export function Summary() {
  const categories = useChainStore((s) => selectCategories(s).length)
  const messages = useChainStore((s) => selectMessages(s).length)
  // `decodeAll` is a shared external store (see TreeView); subscribe so the toggle reflects its
  // value whether flipped here or reset by a chain-switch reload, and so flipping it propagates
  // live to every mounted TreeView node.
  const decodeAllValue = useSyncExternalStore(
    decodeAll.subscribe,
    decodeAll.getSnapshot,
    decodeAll.getSnapshot,
  )

  return (
    <div className="flex flex-col justify-between my-2 font-mono w-full">
      <div className="w-full flex flex-row justify-between">
        <span className="flex flex-row items-center">
          Categories: {categories}
          <span className="ml-3 flex flex-row items-center gap-1">
            <ToggleButton
              off="0x"
              on="txt"
              offIcon="mdi:code-brackets"
              onIcon="mdi:format-text"
              checked={decodeAllValue}
              onClick={() => {
                decodeAll.value = !decodeAll.value
                saveTreeNodeState()
              }}
            />
            <span className="text-xs text-gray-500 dark:text-gray-400 italic font-sans">
              decode all
            </span>
          </span>
        </span>
        <span>Messages: {messages}</span>
      </div>
    </div>
  )
}
