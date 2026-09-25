import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '@iconify/react'
import { formatEther, isAddress, keccak256, stringToHex, type Hex } from 'viem'
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
import { connectInjectedWallet, getInjectedProvider } from '../lib/wallet'
import { SelectChain } from './SelectChain'
import { Summary } from './Summary'
import { Terminal } from './Terminal'
import { TreeView, loadTreeNodeState, pruneTreeNodeState } from './TreeView'
import { RequestSnapshot, type WorkSnapshot } from './RequestSnapshot'

/** Persisted gas-demo state (legacy `categoryType` / messaging fields ignored on load). */
type InteractiveState = {
  text: string
}

type Props = {
  /**
   * Worker factory passed through to the PoW seam — injectable so headless tests can supply a
   * fake `Worker`. Production omits it (the seam spawns the default ES-module PoW worker).
   * The grind ALWAYS runs in that worker — never the main thread.
   */
  workerFactory?: () => Worker
}

const GAS_CATEGORY = 'gasmoneyplease'
const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

const scopeFromStore = (): string => {
  const s = useChainStore.getState()
  return getScope(selectChain(s)?.id, selectRpcUrl(s))
}

/**
 * Gas / faucet demo (formerly the dual-mode Mechanics laboratory).
 *
 * Request testnet gas via category `gasmoneyplease` + recipient address → grind PoW in the
 * Web Worker seam → worker posts → reload board. Freeform messaging was removed from this tab
 * (Chat covers compose). When the faucet is inactive the panel shows a clear empty state —
 * it does NOT fall back to raw messaging.
 */
export function Interactive({ workerFactory }: Props) {
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
  const hasInjectedWallet = typeof getInjectedProvider() !== 'undefined'

  const initialScope = scopeFromStore()
  const stored = load<Partial<InteractiveState>>(initialScope, 'interactive', {})

  const [text, setText] = useState(stored.text ?? '')
  const [working, setWorking] = useState(false)
  const [workSnapshot, setWorkSnapshot] = useState<WorkSnapshot | null>(null)
  const [result, setResult] = useState<'success' | 'error' | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [showInspect, setShowInspect] = useState(false)
  const [pasteHint, setPasteHint] = useState<string | null>(null)
  const cancelRef = useRef<() => void>(() => {})

  const chainOption = useChainStore((s) => s.chainOption)
  const customRpcUrl = useChainStore((s) => s.customRpcUrl)
  const scope = useChainStore((s) => getScope(selectChain(s)?.id, selectRpcUrl(s)))

  useEffect(() => {
    loadTreeNodeState(initialScope)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const prevScopeRef = useRef(initialScope)
  useEffect(() => {
    if (scope === prevScopeRef.current) return
    prevScopeRef.current = scope
    loadTreeNodeState(scope)
    const next = load<Partial<InteractiveState>>(scope, 'interactive', {})
    setText(next.text ?? '')
    setResult(null)
    setErrorMessage(null)
    setWorkSnapshot(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, chainOption, customRpcUrl])

  const hexdText = (isAddress(text) ? (text as Hex) : stringToHex(text)).toLowerCase() as Hex
  const addressValid = isAddress(text)

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
    if (!transportUrl || !board || !addressValid || !faucetIsActive) return
    setWorking(true)
    setResult(null)
    setErrorMessage(null)
    const category = keccak256(stringToHex(GAS_CATEGORY)) as Hex
    setWorkSnapshot({
      chainName,
      chainId,
      rpc: fullTransportUrl ?? transportUrl,
      categoryType: 'gas-request',
      categoryValue: GAS_CATEGORY,
      categoryEncoding: 'keccak256',
      categoryHex: category,
      messageText: text,
      messageHex: hexdText,
      messageByteLength: (hexdText.length - 2) / 2,
    })
    try {
      await board.addMessage({ category, data: hexdText })
      setResult('success')
      await new Promise((resolve) => setTimeout(resolve, 1000))
      await useChainStore.getState().loadContent()
    } catch (err) {
      if (err) console.error(err)
      setResult('error')
      setErrorMessage(err instanceof Error ? err.message : 'Request failed')
    } finally {
      cancelRef.current = () => {}
      setWorking(false)
    }
  }

  const setInputValue = (value: string) => {
    setText(value.trim())
    setResult(null)
    setErrorMessage(null)
    if (isAddress(value.trim())) account.setAddress(value.trim() as Hex)
    else account.setAddress(null)
  }

  const pasteAddress = async () => {
    try {
      const clip = await navigator.clipboard.readText()
      const next = clip.trim()
      if (!next) {
        setPasteHint('Clipboard is empty.')
        return
      }
      setInputValue(next)
      setPasteHint(isAddress(next) ? null : 'Pasted value is not a valid address.')
    } catch {
      setPasteHint('Could not read clipboard.')
    }
  }

  const useConnectedWallet = async () => {
    try {
      const { address } = await connectInjectedWallet()
      setInputValue(address)
      setPasteHint(null)
    } catch (err) {
      setPasteHint(err instanceof Error ? err.message : 'No injected wallet found.')
    }
  }

  const disabled = working || !rpcValid || !faucetIsActive
  const submitDisabled = disabled || !addressValid
  const disableReason = !faucetIsActive
    ? 'Faucet is not available on this chain.'
    : !rpcValid
      ? 'Select a valid chain / RPC.'
      : !addressValid
        ? 'Enter a valid address to request gas.'
        : null

  useEffect(() => {
    const scope = scopeFromStore()
    save(scope, 'interactive', { text } satisfies InteractiveState)
  }, [text])

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

  useEffect(() => {
    if (!tree.children.length) return
    pruneTreeNodeState(collectLabels(tree.children))
  }, [tree])

  return (
    <div className="flex flex-col max-w-5xl pb-4 px-4 mx-auto w-full bg-white dark:bg-gray-950 lg:rounded-2xl shadow-sm gap-4">
      <div className="flex flex-col grow justify-center items-center">
        <div id="interactive" className="flex w-full grow flex-col gap-3">
          <p className="text-base text-gray-700 dark:text-gray-200 pt-2">
            Prove you’re not a bot, get a little gas.
          </p>

          <SelectChain
            preferFaucet
            onChange={(value) => {
              useChainStore.getState().setChainOption(value as ChainOption)
            }}
          />

          {!faucetIsActive ? (
            <div className="rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 p-4 text-sm text-amber-900 dark:text-amber-100">
              <p className="font-medium">Faucet unavailable on this chain</p>
              <p className="mt-1 text-amber-800 dark:text-amber-200/90">
                Pick a faucet-supported network (e.g. PulseChain V4) to request testnet gas. Freeform
                messaging lives in the Chat tab.
              </p>
            </div>
          ) : (
            <div className="container flex flex-col md:flex-row max-w-5xl items-start gap-4 justify-center grow">
              <div className="container flex flex-col p-3 gap-3 rounded-lg border border-gray-300 dark:border-gray-600 shadow bg-gray-50 dark:bg-gray-900 flex-1 min-w-0">
                <div className="flex flex-col gap-1.5">
                  <div className="flex flex-row items-center justify-between gap-2">
                    <label
                      htmlFor="gas-recipient"
                      className="text-sm font-medium text-gray-800 dark:text-gray-100">
                      Recipient
                    </label>
                    <span className="flex flex-row items-center gap-x-2 text-xs italic text-gray-500 dark:text-gray-400">
                      <Icon icon="fe:wallet" className="size-4" />
                      {formatEther(account.balance ?? 0n)} {account.gasSymbol ?? ''}
                    </span>
                  </div>
                  <input
                    id="gas-recipient"
                    type="text"
                    name="recipient"
                    value={text}
                    disabled={disabled}
                    onChange={(e) => setInputValue(e.target.value)}
                    placeholder="0x… recipient"
                    spellCheck={false}
                    autoComplete="off"
                    className={`font-mono p-2 border rounded-lg bg-white dark:bg-gray-800 dark:border-gray-600 dark:text-gray-100 dark:placeholder-gray-500 w-full outline-none text-sm ${
                      text && !addressValid ? 'border-red-500' : 'border-gray-300'
                    } disabled:opacity-70 disabled:pointer-events-none`}
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void pasteAddress()}
                      disabled={disabled}
                      className="text-xs px-2.5 py-1 rounded-full ring-1 ring-gray-300 dark:ring-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50">
                      Paste
                    </button>
                    {hasInjectedWallet && (
                      <button
                        type="button"
                        onClick={() => void useConnectedWallet()}
                        disabled={disabled}
                        className="text-xs px-2.5 py-1 rounded-full ring-1 ring-gray-300 dark:ring-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50">
                        Use connected wallet
                      </button>
                    )}
                  </div>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    Your browser does the work. No wallet signature required to grind.
                  </p>
                  {pasteHint && (
                    <p className="text-xs text-amber-700 dark:text-amber-300">{pasteHint}</p>
                  )}
                </div>

                <div className="flex flex-col gap-1.5">
                  <div className="flex flex-row items-center gap-2">
                    <button
                      type="button"
                      className="bg-white dark:bg-gray-800 flex-grow text-center justify-center py-3 px-4 inline-flex items-center gap-x-2 text-sm font-semibold text-gray-900 dark:text-gray-100 rounded-lg border border-gray-200 dark:border-gray-700 shadow-sm hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50 disabled:pointer-events-none"
                      onClick={() => void workAndSend()}
                      disabled={submitDisabled}>
                      {working ? 'Working…' : 'Work + Send It!'}
                    </button>
                    {working && (
                      <button
                        type="button"
                        className="bg-red-500 text-slate-100 px-4 py-3 rounded-lg text-sm leading-6 cursor-pointer shrink-0"
                        onClick={() => {
                          cancelRef.current()
                          setWorking(false)
                          setWorkSnapshot(null)
                        }}>
                        Cancel
                      </button>
                    )}
                  </div>
                  {submitDisabled && disableReason && !working && (
                    <p className="text-xs text-gray-500 dark:text-gray-400">{disableReason}</p>
                  )}
                </div>

                <Terminal working={!!working} />

                <RequestSnapshot
                  snapshot={workSnapshot}
                  working={working}
                  onClose={() => {
                    cancelRef.current()
                    setWorkSnapshot(null)
                  }}
                />

                {result === 'success' && addressValid && (
                  <div className="rounded-lg border border-green-300 dark:border-green-700 bg-green-50 dark:bg-green-950/40 p-3 text-sm text-green-900 dark:text-green-100">
                    Gas requested for {shortAddr(text)} on {chainName}.
                  </div>
                )}
                {result === 'error' && (
                  <div className="rounded-lg border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-950/40 p-3 text-sm text-red-900 dark:text-red-100 flex flex-col gap-2">
                    <span>{errorMessage ?? 'Something went wrong requesting gas.'}</span>
                    <button
                      type="button"
                      className="self-start text-xs px-2.5 py-1 rounded-full ring-1 ring-red-400 text-red-800 dark:text-red-100 hover:bg-red-100 dark:hover:bg-red-900/40"
                      onClick={() => void workAndSend()}
                      disabled={submitDisabled}>
                      Retry
                    </button>
                  </div>
                )}
              </div>

              <div className="container flex flex-col mx-auto md:max-w-sm align-top overflow-hidden w-full md:w-auto">
                <button
                  type="button"
                  className="md:hidden mb-2 text-sm text-indigo-600 dark:text-indigo-400 underline-offset-2 hover:underline self-start"
                  onClick={() => setShowInspect((v) => !v)}
                  aria-expanded={showInspect}>
                  {showInspect ? 'Hide inspect' : 'Under the hood'}
                </button>
                <div className={`${showInspect ? 'flex' : 'hidden'} md:flex flex-col gap-2`}>
                  <p className="hidden md:block text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                    Under the hood
                  </p>
                  <div className="relative rounded-lg border border-gray-200 dark:border-gray-700 p-2 bg-white dark:bg-gray-950">
                    {loading && (
                      <div className="absolute inset-0 z-10 flex items-center justify-center bg-white/70 dark:bg-gray-900/70 rounded-lg backdrop-blur-[1px]">
                        <span className="text-sm text-gray-500 dark:text-gray-400 font-mono">
                          Loading…
                        </span>
                      </div>
                    )}
                    <Summary />
                    <TreeView childrenNodes={tree.children} label="Message Board" isRoot hideContent />
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
