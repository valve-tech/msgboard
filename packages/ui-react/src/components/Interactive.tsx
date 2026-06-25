import { useEffect, useMemo, useRef, useState } from 'react'
import { numberToHex, isHex, stringToHex, isAddress, keccak256, type Hex } from 'viem'
import {
  useChainStore,
  selectChain,
  selectName,
  selectRpcUrl,
  selectTransportUrl,
  selectFullTransportUrl,
  selectRpcValid,
  selectFaucetIsActive,
} from '../stores/chain'
import type { ChainOption } from '../lib/rpc'
import { useTerminalStore, Log, selectMessageList } from '../stores/terminal'
import { useAccount } from '../hooks/useAccount'
import { getScope, load, save, collectLabels } from '../lib/persist'
import { toTree } from '../lib/tree'
import { makeWorkerBoard } from '../seams/worker-board'
import { SelectChain } from './SelectChain'
import { Category } from './Category'
import { MessageInput } from './MessageInput'
import { PresetButtons } from './PresetButtons'
import { Summary } from './Summary'
import { Terminal } from './Terminal'
import { TreeView, loadTreeNodeState, pruneTreeNodeState } from './TreeView'
import { RequestSnapshot, type WorkSnapshot } from './RequestSnapshot'

type CategoryKey = 'gas-request' | 'input'
type InteractiveState = {
  categoryType: CategoryKey
  categoryValue: string
  text: string
  showHexResult: boolean
  showCategoryHexResult: boolean
  useKeccak: boolean
}

type Props = {
  /**
   * Worker factory passed through to the PoW seam — injectable so headless tests can supply a
   * fake `Worker`. Production omits it (the seam spawns the default ES-module PoW worker).
   * The grind ALWAYS runs in that worker — never the main thread.
   */
  workerFactory?: () => Worker
}

const scopeFromStore = (): string => {
  const s = useChainStore.getState()
  return getScope(selectChain(s)?.id, selectRpcUrl(s))
}

/**
 * Ported from `Interactive.svelte` — the MVP vertical slice.
 *
 * Compose a message → grind PoW in the Web Worker seam (Task 2) → the worker posts it → reload
 * board content (chain store) → Terminal + TreeView render. The grind is dispatched to the
 * worker via `makeWorkerBoard.addMessage`; it NEVER runs on the main thread.
 */
export function Interactive({ workerFactory }: Props) {
  // chain-store reads (each a former Svelte `$derived`)
  const transportUrl = useChainStore((s) => selectTransportUrl(s))
  const fullTransportUrl = useChainStore((s) => selectFullTransportUrl(s))
  const chainId = useChainStore((s) => selectChain(s)?.id ?? 0)
  const chainName = useChainStore((s) => selectName(s) ?? 'Unknown')
  const rpcValid = useChainStore((s) => selectRpcValid(s))
  const faucetIsActive = useChainStore((s) => selectFaucetIsActive(s))
  const loading = useChainStore((s) => s.loading)
  const content = useChainStore((s) => s.content)
  const latestBlockNumber = useChainStore((s) => s.latestBlockNumber)
  const globalWorkMultiplier = useChainStore((s) => s.globalWorkMultiplier)
  const globalWorkDivisor = useChainStore((s) => s.globalWorkDivisor)

  const account = useAccount()

  const initialScope = scopeFromStore()
  const stored = load<Partial<InteractiveState>>(initialScope, 'interactive', {})

  const [text, setText] = useState(stored.text ?? '')
  const [categoryType, setCategoryType] = useState<CategoryKey>(
    stored.categoryType ?? 'gas-request',
  )
  const [categoryValue, setCategoryValue] = useState(stored.categoryValue ?? 'gasmoneyplease')
  const [showHexResult, setShowHexResult] = useState(stored.showHexResult ?? false)
  const [showCategoryHexResult, setShowCategoryHexResult] = useState(
    stored.showCategoryHexResult ?? false,
  )
  const [useKeccak, setUseKeccak] = useState(stored.useKeccak ?? true)

  const [working, setWorking] = useState(false)
  const [workSnapshot, setWorkSnapshot] = useState<WorkSnapshot | null>(null)
  const cancelRef = useRef<() => void>(() => {})

  // the persist scope tracks the active chain + rpc; recompute it reactively so a mid-session
  // chain switch reloads the right slice of persisted state (the Svelte scope-change `$effect`).
  const chainOption = useChainStore((s) => s.chainOption)
  const customRpcUrl = useChainStore((s) => s.customRpcUrl)
  const scope = useChainStore((s) => getScope(selectChain(s)?.id, selectRpcUrl(s)))

  // load persisted tree state once on mount
  useEffect(() => {
    loadTreeNodeState(initialScope)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Reload persisted interactive + tree state when the scope changes mid-session (a chain
  // switch). Skip the very first run — mount already seeded state from `initialScope` above and
  // from the `useState` initializers; re-applying here would clobber unsaved edits. Tracking the
  // previous scope in a ref keeps this a focused "on change" effect (Task-4 review carry-forward).
  const prevScopeRef = useRef(initialScope)
  useEffect(() => {
    if (scope === prevScopeRef.current) return
    prevScopeRef.current = scope
    loadTreeNodeState(scope)
    const next = load<Partial<InteractiveState>>(scope, 'interactive', {})
    setText(next.text ?? '')
    setCategoryType(next.categoryType ?? 'gas-request')
    setCategoryValue(next.categoryValue ?? 'gasmoneyplease')
    setShowHexResult(next.showHexResult ?? false)
    setShowCategoryHexResult(next.showCategoryHexResult ?? false)
    setUseKeccak(next.useKeccak ?? true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, chainOption, customRpcUrl])

  // if the faucet is not active, force out of gas-request mode (Svelte $effect)
  useEffect(() => {
    if (categoryType === 'gas-request' && !faucetIsActive) {
      setCategoryType('input')
    }
  }, [categoryType, faucetIsActive])

  const categoryByteLength = new TextEncoder().encode(categoryValue).byteLength
  const categoryExceedsLimit = categoryByteLength > 32
  const effectiveUseDirectEncoding =
    categoryType !== 'gas-request' && !useKeccak && !categoryExceedsLimit
  const hexdText = (isHex(text) ? text : stringToHex(text)).toLowerCase() as Hex

  const oncategoryupdate = (type: CategoryKey, category: string) => {
    const modeChanged = type !== categoryType
    if (type === 'gas-request') {
      if (modeChanged) setUseKeccak(true)
      if (account.address) {
        setText(account.address)
      }
    } else if (modeChanged) {
      setUseKeccak(false)
      setText('')
    }
    setCategoryType(type)
    setCategoryValue(category)
  }

  /**
   * Memoize the worker board on `transportUrl` / chainId / factors so we don't construct a new
   * read client per render (carry-forward from the Task-3 review: `selectClient`/
   * `selectBoardClient` build a NEW client per call — keep them out of hot render paths). The
   * grind is dispatched through `board.addMessage` → the Web Worker seam.
   */
  const board = useMemo(() => {
    if (!transportUrl) return null
    return makeWorkerBoard({
      rpc: transportUrl,
      chainId,
      workMultiplier: globalWorkMultiplier != null ? Number(globalWorkMultiplier) : 1,
      workDivisor: globalWorkDivisor != null ? Number(globalWorkDivisor) : 1,
      onProgress: (msg) => {
        const { stats } = msg
        useTerminalStore
          .getState()
          .printToTerminal(new Log(`progress ${stats.iterations} over ${stats.duration}ms`))
        useTerminalStore.getState().updateProgress(stats)
      },
      workerFactory,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transportUrl, chainId, globalWorkMultiplier, globalWorkDivisor, workerFactory])

  const workAndSend = async () => {
    if (!transportUrl || !board) return
    setWorking(true)
    const category = (
      effectiveUseDirectEncoding
        ? stringToHex(categoryValue, { size: 32 })
        : keccak256(stringToHex(categoryValue))
    ) as Hex
    setWorkSnapshot({
      chainName,
      chainId,
      rpc: fullTransportUrl ?? transportUrl,
      categoryType,
      categoryValue,
      categoryEncoding: effectiveUseDirectEncoding ? 'direct' : 'keccak256',
      categoryHex: category,
      messageText: text,
      messageHex: hexdText,
      messageByteLength: (hexdText.length - 2) / 2,
    })
    try {
      // the grind + post both run INSIDE the worker (Task-2 seam folds `send` into the worker)
      await board.addMessage({ category, data: hexdText })
      setWorkSnapshot(null)
      await new Promise((resolve) => setTimeout(resolve, 1000))
      await useChainStore.getState().loadContent()
    } catch (err) {
      if (err) console.error(err)
    } finally {
      cancelRef.current = () => {}
      setWorking(false)
    }
  }

  const setInputValue = (value: string) => {
    setText(value)
    if (categoryType === 'gas-request') {
      if (isAddress(value)) account.setAddress(value as Hex)
    } else {
      account.setAddress(null)
    }
  }
  const setRandomText = () => setText(keccak256(numberToHex(Date.now())))

  const disabled = working || !rpcValid
  const submitDisabled = disabled || (categoryType === 'gas-request' && !isAddress(text))

  // persist interactive state on change (Svelte $effect)
  useEffect(() => {
    const scope = scopeFromStore()
    save(scope, 'interactive', {
      categoryType,
      categoryValue,
      text,
      showHexResult,
      showCategoryHexResult,
      useKeccak,
    } satisfies InteractiveState)
  }, [categoryType, categoryValue, text, showHexResult, showCategoryHexResult, useKeccak])

  // derive the render tree from the store's message list
  const tree = useMemo(
    () =>
      toTree({
        list: selectMessageList(),
        latestBlockNumber: latestBlockNumber ?? undefined,
        globalFactors:
          globalWorkMultiplier != null && globalWorkDivisor != null
            ? { workMultiplier: globalWorkMultiplier, workDivisor: globalWorkDivisor }
            : null,
      }),
    [content, latestBlockNumber, globalWorkMultiplier, globalWorkDivisor],
  )

  // prune stale TreeView entries when content changes
  useEffect(() => {
    if (!tree.children.length) return
    pruneTreeNodeState(collectLabels(tree.children))
  }, [tree])

  return (
    <div className="flex flex-col max-w-5xl pb-4 px-4 mx-auto w-full bg-white dark:bg-gray-950 lg:rounded-2xl shadow-sm gap-4">
      <div className="flex flex-col grow justify-center items-center">
        <div id="interactive" className="flex w-full grow flex-col">
          <SelectChain
            onChange={(e) => {
              useChainStore.getState().setChainOption(e.target.value as ChainOption)
            }}
          />
          <div className="container flex flex-col md:flex-row max-w-5xl items-start gap-4 justify-center grow">
            <div className="container flex flex-col p-3 gap-2 rounded-lg border border-gray-300 dark:border-gray-600 shadow bg-gray-50 dark:bg-gray-900">
              <div className="container m-auto flex-col flex">
                <Category
                  type={categoryType}
                  value={categoryValue}
                  oncategoryupdate={oncategoryupdate}
                  disabled={disabled}
                  cancel={() => cancelRef.current()}
                  working={working}
                  showHexResult={showCategoryHexResult}
                  onToggleShowHex={setShowCategoryHexResult}
                  useKeccak={useKeccak}
                  categoryExceedsLimit={categoryExceedsLimit}
                  onToggleKeccak={setUseKeccak}
                />
              </div>
              <div className="container m-auto flex flex-col text-center">
                <MessageInput
                  disabled={disabled}
                  text={text}
                  onChange={setInputValue}
                  type={categoryType}
                  setToRandom={setRandomText}
                  showHexResult={showHexResult}
                  onToggleShowHex={setShowHexResult}
                  balance={account.balance}
                  gasSymbol={account.gasSymbol}
                />
              </div>
              <div className="container m-auto flex flex-row justify-between">
                <PresetButtons workAndSend={workAndSend} disabled={submitDisabled} />
              </div>
            </div>
            <div className="container flex flex-col mx-auto md:max-w-sm align-top overflow-hidden">
              <Terminal working={!!working} />
            </div>
          </div>
          <RequestSnapshot
            snapshot={workSnapshot}
            working={working}
            onClose={() => {
              cancelRef.current()
              setWorkSnapshot(null)
            }}
          />
        </div>
      </div>
      <div className="flex flex-col relative">
        {loading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-white/70 dark:bg-gray-900/70 rounded-lg backdrop-blur-[1px] transition-opacity duration-200">
            <div className="flex flex-col items-center gap-2">
              <svg
                className="animate-spin h-6 w-6 text-gray-400"
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24">
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"></circle>
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
              </svg>
              <span className="text-sm text-gray-500 dark:text-gray-400 font-mono">Loading…</span>
            </div>
          </div>
        )}
        <Summary />
        <TreeView childrenNodes={tree.children} label="Message Board" isRoot hideContent />
      </div>
    </div>
  )
}
