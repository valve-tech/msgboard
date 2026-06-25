import { useEffect, useRef, useState } from 'react'
import { Icon } from '@iconify/react'
import { useTerminalStore } from '../stores/terminal'

type Props = { working?: boolean }

/** Ported from `Terminal.svelte`. Subscribes to the terminal store for log lines + progress. */
export function Terminal({ working = false }: Props) {
  const logList = useTerminalStore((s) => s.logList)
  const lastProgress = useTerminalStore((s) => s.lastProgress)
  const clearLogs = useTerminalStore((s) => s.clearLogs)
  const [collapseTerminal, setCollapseTerminal] = useState(false)
  const terminalEl = useRef<HTMLPreElement | null>(null)

  const count = logList.length
  useEffect(() => {
    const el = terminalEl.current
    // `scrollTo` is unimplemented in jsdom; guard so tests (and any non-DOM host) don't throw.
    if (!el || !count || typeof el.scrollTo !== 'function') return
    el.scrollTo(0, el.scrollHeight)
  }, [count])

  const nPerSecond = lastProgress
    ? `${(BigInt(lastProgress.iterations) * 1_000_000n) / (BigInt(lastProgress.duration) || 1n) / 1_000n}`
    : '-'

  const toggle = () => setCollapseTerminal((c) => !c)

  return (
    <div
      className={`bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 text-slate-900 dark:text-gray-100 rounded-xl font-mono text-left overflow-hidden transition-all duration-100 shadow mx-auto relative w-full ${
        collapseTerminal ? 'h-8' : 'h-80'
      }`}
    >
      <p className="flex justify-between bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 h-8 leading-8 text-sm w-full font-mono text-slate-900 dark:text-gray-100 pl-4 pr-2">
        <span className="flex flex-row items-center gap-2">
          Logs{working && <Icon icon="svg-spinners:3-dots-bounce" />}{' '}
          {nPerSecond === '-' ? '' : `~${nPerSecond} hash/s`}
        </span>
        <span className="flex flex-row">
          <button
            className="px-2 flex items-center cursor-pointer"
            title="clear logs"
            onClick={() => clearLogs()}
            aria-roledescription="clear the list of logs"
            tabIndex={0}
            onKeyPress={() => clearLogs()}
          >
            <Icon icon="grommet-icons:clear" />
          </button>
          <span
            aria-roledescription="opens and closes the terminal box which shows recent rpc requests"
            role="checkbox"
            onKeyPress={toggle}
            onClick={toggle}
            tabIndex={0}
            aria-checked={collapseTerminal}
            className="flex items-center px-2 cursor-pointer"
          >
            <Icon icon={!collapseTerminal ? 'pajamas:expand-up' : 'pajamas:expand-down'} className="size-4" />
          </span>
        </span>
      </p>
      <pre
        ref={terminalEl}
        className="py-2 px-4 overflow-scroll absolute top-[32px] bottom-0 right-0 left-0 scrollbar-color:white"
      >
        {logList.map((log) => log.toString() + '\n').join('')}
      </pre>
    </div>
  )
}
