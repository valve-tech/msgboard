import { useState } from 'react'
import { rpcs } from '../lib/rpc'
import {
  useChainStore,
  selectRpcUrl,
  selectIsProxied,
  selectMustProxy,
} from '../stores/chain'
import { Copy } from './Copy'
import { Info } from './Info'
import { ToggleButton } from './ToggleButton'

/**
 * Ported from `SelectChain.svelte`.
 *
 * `onChange` is supplied by the parent (Interactive) so the chain-option write goes through
 * `useChainStore.getState().setChainOption`. The custom-url input commits to the store on
 * blur/Enter (mirrors the Svelte `commitCustomUrl`).
 */
type Props = {
  onChange: (e: React.ChangeEvent<HTMLSelectElement>) => void
}

export function SelectChain({ onChange }: Props) {
  const chainOption = useChainStore((s) => s.chainOption)
  const storedCustomUrl = useChainStore((s) => s.customRpcUrl)
  const rpcUrl = useChainStore((s) => selectRpcUrl(s))
  const isProxied = useChainStore((s) => selectIsProxied(s))
  const mustProxy = useChainStore((s) => selectMustProxy(s))
  const msgboardEnabled = useChainStore((s) => s.msgboardEnabled)

  const isCustom = chainOption === 'custom'
  const [customUrl, setCustomUrl] = useState(storedCustomUrl)

  const commitCustomUrl = () => {
    useChainStore.getState().setCustomRpcUrl(customUrl)
  }

  const probeTitle =
    msgboardEnabled === null
      ? 'Checking whether this RPC serves the msgboard_ namespace…'
      : msgboardEnabled
        ? 'This RPC serves the msgboard_ namespace — the board is live on this endpoint.'
        : 'This RPC does not expose the msgboard_ namespace — the board cannot be read or posted here.'

  const shownUrl = isCustom ? customUrl : rpcUrl

  return (
    <div className="flex flex-row gap-4 my-2 w-full items-center">
      <div className="flex flex-row shrink-0 items-center gap-2">
        <div className="grid grid-cols-1">
          <select
            id="location"
            name="location"
            aria-label="chain"
            value={chainOption}
            className="col-start-1 row-start-1 w-full appearance-none rounded-md bg-white dark:bg-gray-800 dark:border-gray-600 dark:text-gray-100 py-1 pl-3 pr-8 text-base text-gray-900 outline-1 -outline-offset-1 outline-gray-300 dark:outline-gray-600 focus:-outline-offset-2 focus:outline-indigo-600 sm:text-sm/6"
            onChange={onChange}
          >
            {[...rpcs.entries()].map(([key, value]) => (
              <option key={key} value={key} disabled={!!value.disabled}>
                {value.chain.name}
              </option>
            ))}
            <option value="custom">Custom</option>
          </select>
          <svg
            className="pointer-events-none col-start-1 row-start-1 mr-2 size-5 self-center justify-self-end text-gray-500 dark:text-gray-400 sm:size-4"
            viewBox="0 0 16 16"
            fill="currentColor"
            aria-hidden="true"
            data-slot="icon"
          >
            <path
              fillRule="evenodd"
              d="M4.22 6.22a.75.75 0 0 1 1.06 0L8 8.94l2.72-2.72a.75.75 0 1 1 1.06 1.06l-3.25 3.25a.75.75 0 0 1-1.06 0L4.22 7.28a.75.75 0 0 1 0-1.06Z"
              clipRule="evenodd"
            />
          </svg>
        </div>
      </div>
      <div className="flex-1 min-w-0">
        {isCustom ? (
          <input
            type="text"
            value={customUrl}
            onChange={(e) => setCustomUrl(e.target.value)}
            onBlur={commitCustomUrl}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitCustomUrl()
            }}
            placeholder="Enter RPC URL..."
            className="w-full text-sm text-gray-700 dark:text-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-md px-2 py-1 dark:placeholder-gray-500 focus:outline-indigo-600 focus:outline-2 focus:-outline-offset-1 h-8"
          />
        ) : (
          <span className="text-sm text-gray-500 dark:text-gray-400 truncate block">{rpcUrl}</span>
        )}
      </div>
      <div className="flex items-center gap-1 shrink-0">
        {shownUrl ? (
          <>
            <span className="flex items-center gap-1 text-xs shrink-0" title={probeTitle}>
              {msgboardEnabled === null ? (
                <>
                  <span className="size-2 rounded-full bg-gray-400 animate-pulse"></span>
                  <span className="text-gray-400 dark:text-gray-500 hidden sm:inline">checking</span>
                </>
              ) : msgboardEnabled ? (
                <>
                  <span className="size-2 rounded-full bg-green-500"></span>
                  <span className="text-green-600 dark:text-green-400 hidden sm:inline">msgboard</span>
                </>
              ) : (
                <>
                  <span className="size-2 rounded-full bg-red-500"></span>
                  <span className="text-red-500 dark:text-red-400 hidden sm:inline">no&nbsp;msgboard</span>
                </>
              )}
            </span>
            <Copy value={shownUrl} />
          </>
        ) : null}
        <span className="group flex items-center gap-1">
          <ToggleButton
            off="direct"
            on="proxy"
            offIcon="mdi:lightning-bolt"
            onIcon="mdi:server"
            checked={isProxied}
            disabled={mustProxy}
            onClick={() => {
              const s = useChainStore.getState()
              s.setForceProxy(!s.forceProxy)
            }}
          />
          <Info
            text={
              mustProxy
                ? 'Proxy (server icon): HTTP URLs must be proxied through the msgboard server because browsers block HTTP requests from HTTPS pages.'
                : isProxied
                  ? 'Proxy (server icon): RPC requests are proxied through the msgboard server to work around mixed-content restrictions.'
                  : 'Direct (lightning icon): RPC requests go directly from the browser to the endpoint. Switch to Proxy (server icon) to route through the msgboard server if the RPC is HTTP-only.'
            }
            align="right"
          />
        </span>
      </div>
    </div>
  )
}
