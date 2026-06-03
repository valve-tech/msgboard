<script lang="ts">
  import { numberToHex, isHex, stringToHex, isAddress, type Hex, keccak256 } from 'viem'

  import { account } from '../lib/web3.svelte'
  import { toTree, terminalState } from '../lib/log.svelte'
  import * as board from '../lib/msgboard.svelte'
  import Summary from './Summary.svelte'
  import MessageInput from '../components/MessageInput.svelte'
  import Category from '../components/Category.svelte'
  import PresetButtons from '../components/PresetButtons.svelte'
  import TreeView, { loadTreeNodeState, pruneTreeNodeState } from '../components/TreeView.svelte'
  import Terminal from '../components/Terminal.svelte'
  import SelectChain from './SelectChain.svelte'
  import RequestSnapshot from './RequestSnapshot.svelte'
  import type { ChainOption } from '../lib/rpc.svelte'
  import { getScope, load, save, collectLabels } from '../lib/persist.svelte'

  type CategoryKey = 'gas-request' | 'input'
  /** shape of the Interactive component's persisted UI state */
  type InteractiveState = {
    categoryType: CategoryKey
    categoryValue: string
    text: string
    showHexResult: boolean
    showCategoryHexResult: boolean
    useKeccak: boolean
  }

  const initialScope = getScope()
  const stored = load<Partial<InteractiveState>>(initialScope, 'interactive', {})
  loadTreeNodeState(initialScope)

  let text = $state(stored.text ?? '')
  let categoryType: CategoryKey = $state(stored.categoryType ?? 'gas-request')
  let categoryValue = $state(stored.categoryValue ?? 'gasmoneyplease')

  // reload all persisted state when the chain scope changes
  let prevScope = initialScope
  $effect(() => {
    const scope = getScope()
    if (scope === prevScope) return
    prevScope = scope
    const state = load<Partial<InteractiveState>>(scope, 'interactive', {})
    categoryType = state.categoryType ?? 'gas-request'
    categoryValue = state.categoryValue ?? 'gasmoneyplease'
    text = state.text ?? ''
    showHexResult = state.showHexResult ?? false
    showCategoryHexResult = state.showCategoryHexResult ?? false
    useKeccak = state.useKeccak ?? true
    loadTreeNodeState(scope)
  })

  $effect(() => {
    if (categoryType === 'gas-request' && !board.chain.faucetIsActive) {
      categoryType = 'input'
    }
  })
  /** Frozen snapshot of data inputs captured at the moment work begins */
  type WorkSnapshot = {
    chainName: string
    chainId: number
    rpc: string
    categoryType: CategoryKey
    categoryValue: string
    categoryEncoding: 'keccak256' | 'direct'
    categoryHex: string
    messageText: string
    messageHex: string
    messageByteLength: number
  }

  let working = $state(false)
  let workSnapshot = $state<WorkSnapshot | null>(null)
  let cancel = $state(() => {})
  let showHexResult = $state(stored.showHexResult ?? false)
  let showCategoryHexResult = $state(stored.showCategoryHexResult ?? false)
  /** when true, category is keccak256 hashed to 32 bytes; when false, direct utf8→hex zero-padded */
  let useKeccak = $state(stored.useKeccak ?? true)
  const categoryByteLength = $derived(new TextEncoder().encode(categoryValue).byteLength)
  /** category exceeds the 32-byte limit and must be hashed via keccak256 */
  const categoryExceedsLimit = $derived(categoryByteLength > 32)
  /** resolved encoding: direct hex only when in input mode, keccak is off, and category fits in 32 bytes */
  const effectiveUseDirectEncoding = $derived(categoryType !== 'gas-request' && !useKeccak && !categoryExceedsLimit)
  const onToggleShowHex = (show: boolean) => {
    showHexResult = show
  }
  const onToggleCategoryHexResult = (show: boolean) => {
    showCategoryHexResult = show
  }

  const hexdText = $derived((isHex(text) ? text : stringToHex(text)).toLowerCase())

  const oncategoryupdate = (type: CategoryKey, category: string) => {
    const modeChanged = type !== categoryType
    if (type === 'gas-request') {
      if (modeChanged) useKeccak = true
      if (account.address) {
        text = account.address
        account.updateBalance()
      }
    } else {
      if (modeChanged) {
        useKeccak = false
        text = ''
      }
    }
    categoryType = type
    categoryValue = category
  }
  const setToAddress = (txt: string) => {
    account.address = txt as Hex
    text = txt
    account.updateBalance()
  }
  const workAndSend = async () => {
    const rpc = board.chain.transportUrl
    if (!rpc) return
    working = true
    const category = effectiveUseDirectEncoding
      ? stringToHex(categoryValue, { size: 32 })
      : categoryValue
    // freeze current data inputs so the user can inspect what was submitted
    workSnapshot = {
      chainName: board.chain.name ?? 'Unknown',
      chainId: board.chain.chain?.id ?? 0,
      rpc: board.chain.fullTransportUrl ?? rpc,
      categoryType,
      categoryValue,
      categoryEncoding: effectiveUseDirectEncoding ? 'direct' : 'keccak256',
      categoryHex: effectiveUseDirectEncoding
        ? stringToHex(categoryValue, { size: 32 })
        : keccak256(stringToHex(categoryValue)),
      messageText: text,
      messageHex: hexdText,
      messageByteLength: (hexdText.length - 2) / 2,
    }
    try {
      const worker = await board.doWork(rpc, category, hexdText)
      cancel = worker.cancel
      const work = await worker.start()
      await board.send(rpc, work)
      workSnapshot = null
      await new Promise((resolve) => setTimeout(resolve, 1000))
      await board.chain.loadContent()
    } catch (err) {
      if (err) console.error(err)
    } finally {
      cancel = () => {}
      working = false
    }
  }
  const setInputValue = (value: string) => {
    text = value
    if (categoryType === 'gas-request') {
      if (!isAddress(text)) {
        return
      }
      setToAddress(text)
    } else {
      account.address = null
    }
  }
  const setRandomText = () => {
    text = keccak256(numberToHex(Date.now()))
  }
  const disabled = $derived(working || !board.chain.rpcValid)
  const submitDisabled = $derived(disabled || (categoryType === 'gas-request' && !isAddress(text)))

  // persist interactive state to chain-scoped localStorage on every change
  $effect(() => {
    const scope = getScope()
    save(scope, 'interactive', {
      categoryType,
      categoryValue,
      text,
      showHexResult,
      showCategoryHexResult,
      useKeccak,
    } satisfies InteractiveState)
  })

  // derive tree once for rendering and pruning
  const tree = $derived(toTree({
    list: terminalState.messageList,
    latestBlockNumber: board.chain.latestBlockNumber ?? undefined,
    globalFactors: board.chain.globalWorkMultiplier != null && board.chain.globalWorkDivisor != null
      ? { workMultiplier: board.chain.globalWorkMultiplier, workDivisor: board.chain.globalWorkDivisor }
      : null,
  }))

  // prune stale TreeView entries when content changes
  $effect(() => {
    if (!tree.children.length) return
    const validLabels = collectLabels(tree.children)
    pruneTreeNodeState(validLabels)
  })
</script>

<div class="flex flex-col max-w-5xl pb-4 px-4 mx-auto w-full bg-white dark:bg-gray-950 lg:rounded-2xl shadow-sm gap-4">
  <div class="flex flex-col grow justify-center items-center">
    <div id="interactive" class="flex w-full grow flex-col">
      <SelectChain onchange={(e) => {
        const target = e.target as HTMLSelectElement
        const chain = target.value as ChainOption
        board.chain.chainOption = chain
      }} />
      <div class="container flex flex-col md:flex-row max-w-5xl items-start gap-4 justify-center grow">
        <div class="container flex flex-col p-3 gap-2 rounded-lg border border-gray-300 dark:border-gray-600 shadow bg-gray-50 dark:bg-gray-900">
          <div class="container m-auto flex-col flex">
            <Category
              type={categoryType}
              value={categoryValue}
              {oncategoryupdate}
              {disabled}
              {cancel}
              {working}
              showHexResult={showCategoryHexResult}
              onToggleShowHex={onToggleCategoryHexResult}
              {useKeccak}
              {categoryExceedsLimit}
              onToggleKeccak={(kec) => { useKeccak = kec }}
            />
          </div>
          <div class="container m-auto flex flex-col text-center">
            <MessageInput {disabled} {text} onchange={setInputValue} type={categoryType} setToRandom={setRandomText} {showHexResult} {onToggleShowHex} />
          </div>
          <div class="container m-auto flex flex-row justify-between">
            <PresetButtons {workAndSend} disabled={submitDisabled} />
          </div>
        </div>
        <div class="container flex flex-col mx-auto md:max-w-sm align-top overflow-hidden">
          <Terminal working={!!working} />
        </div>
      </div>
      <RequestSnapshot snapshot={workSnapshot} {working} onclose={() => { cancel(); workSnapshot = null }} />
    </div>
  </div>
  <div class="flex flex-col relative">
    {#if board.chain.loading}
      <div class="absolute inset-0 z-10 flex items-center justify-center bg-white/70 dark:bg-gray-900/70 rounded-lg backdrop-blur-[1px] transition-opacity duration-200">
        <div class="flex flex-col items-center gap-2">
          <svg class="animate-spin h-6 w-6 text-gray-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
          </svg>
          <span class="text-sm text-gray-500 dark:text-gray-400 font-mono">Loading&hellip;</span>
        </div>
      </div>
    {/if}
    <Summary />
    <TreeView children={tree.children} label="Message Board" isRoot hideContent />
  </div>
</div>
