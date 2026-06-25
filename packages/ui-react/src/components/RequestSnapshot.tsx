import { useState } from 'react'
import { Icon } from '@iconify/react'

/** Frozen snapshot of the data inputs captured when a work request begins. */
export type WorkSnapshot = {
  chainName: string
  chainId: number
  rpc: string
  categoryType: string
  categoryValue: string
  categoryEncoding: 'keccak256' | 'direct'
  categoryHex: string
  messageText: string
  messageHex: string
  messageByteLength: number
}

type Props = {
  snapshot: WorkSnapshot | null
  working?: boolean
  onClose?: () => void
}

/** Ported from `RequestSnapshot.svelte`. */
export function RequestSnapshot({ snapshot, working = false, onClose }: Props) {
  const [collapsed, setCollapsed] = useState(false)
  if (!snapshot) return null

  return (
    <div className="flex flex-col rounded-lg border border-gray-300 dark:border-gray-600 shadow bg-gray-50 dark:bg-gray-900 p-3 font-mono text-sm mt-4">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2">
          <span className="font-semibold text-gray-700 dark:text-gray-200">Request Data</span>
          {working && <Icon icon="svg-spinners:3-dots-bounce" className="size-4 text-gray-500 dark:text-gray-400" />}
        </span>
        <span className="flex items-center gap-1">
          <button
            type="button"
            className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 cursor-pointer"
            onClick={() => setCollapsed((c) => !c)}
            title={collapsed ? 'expand' : 'minimize'}
          >
            <Icon icon={collapsed ? 'pajamas:expand-down' : 'pajamas:expand-up'} className="size-4" />
          </button>
          {onClose && (
            <button
              type="button"
              className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 cursor-pointer"
              onClick={onClose}
              title="cancel and close"
            >
              <Icon icon="mdi:close" className="size-4" />
            </button>
          )}
        </span>
      </div>

      {!collapsed && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 mt-2 text-xs">
          <dt className="text-gray-500 dark:text-gray-400 text-right">chain</dt>
          <dd className="flex flex-col md:flex-row md:justify-between md:gap-4">
            <span>
              {snapshot.chainName} ({snapshot.chainId})
            </span>
            <span className="break-all text-gray-500 dark:text-gray-400">{snapshot.rpc}</span>
          </dd>

          <dt className="text-gray-500 dark:text-gray-400 text-right">category</dt>
          <dd className="break-all">
            {snapshot.categoryEncoding === 'keccak256'
              ? `keccak256(toHex(${snapshot.categoryValue}))`
              : `toHex(${snapshot.categoryValue})`}
          </dd>

          <dt className="text-gray-500 dark:text-gray-400 text-right">↳</dt>
          <dd className="break-all">{snapshot.categoryHex}</dd>

          <dt className="text-gray-500 dark:text-gray-400 text-right">message</dt>
          <dd className="break-all">{snapshot.messageText || '(empty)'}</dd>

          <dt className="text-gray-500 dark:text-gray-400 text-right">↳ hex</dt>
          <dd className="break-all">{snapshot.messageHex}</dd>

          <dt className="text-gray-500 dark:text-gray-400 text-right">↳ bytes</dt>
          <dd>{snapshot.messageByteLength}</dd>
        </dl>
      )}
    </div>
  )
}
