import { Log, terminalState } from './log.svelte'
import * as msgboard from '@msgboard/sdk'
import type { StartWorkReq, CancelReq, WorkerResponseMsg } from '../service-worker'

import { pulsechainV4 } from 'viem/chains'
import { createPublicClient, http, type Chain } from 'viem'

import Worker from '../service-worker/index.js?worker'
import { rpcs, type ChainOption, defaultCustomChain, needsProxy } from './rpc.svelte'

const worker = new Worker()

let defaultChainOption: ChainOption = 'pulsechain'

try {
  defaultChainOption = (localStorage.getItem('chainOption') as ChainOption) ?? 'pulsechain'
} catch {}

export class ChainState {
  /** modify this parameter to change the default chain */
  _chainOption = $state<ChainOption>(defaultChainOption)
  set chainOption(chain: ChainOption) {
    this._chainOption = chain
    localStorage.setItem('chainOption', chain)
    this.msgboardEnabled = null // re-probe on switch
    if (chain !== 'custom' || this._customRpcUrl) {
      this.loadContent()
    }
  }
  get chainOption() {
    return this._chainOption
  }
  /** rpc url entered by the user when chainOption is 'custom' - persisted to localStorage */
  _customRpcUrl = $state<string>(localStorage.getItem('customRpcUrl') ?? '')
  get customRpcUrl() {
    return this._customRpcUrl
  }
  /** updates the custom rpc url, persists to localStorage, and reloads content when the custom chain is active */
  set customRpcUrl(url: string) {
    this._customRpcUrl = url
    localStorage.setItem('customRpcUrl', url)
    this.msgboardEnabled = null // re-probe on url change
    if (this._chainOption === 'custom' && url) {
      this.loadContent()
    }
  }
  /** when true, rpc requests are routed through the server-side proxy regardless of protocol */
  _forceProxy = $state<boolean>(localStorage.getItem('forceProxy') === 'true')
  get forceProxy() {
    return this._forceProxy
  }
  set forceProxy(value: boolean) {
    this._forceProxy = value
    localStorage.setItem('forceProxy', String(value))
    this.msgboardEnabled = null // re-probe through the new transport
    if (this.rpcUrl) {
      this.loadContent()
    }
  }
  /** resolved chain config from the rpcs map - undefined when chainOption is 'custom' */
  selectedOption = $derived(this._chainOption === 'custom' ? undefined : rpcs.get(this._chainOption))
  /** the viem chain definition - falls back to defaultCustomChain for custom rpc connections */
  chain = $derived(this._chainOption === 'custom' ? defaultCustomChain : this.selectedOption?.chain)
  name = $derived(this._chainOption === 'custom' ? 'Custom' : this.chain?.name)
  /** the active rpc url - uses the custom url when chainOption is 'custom' */
  rpcUrl = $derived(this._chainOption === 'custom' ? this._customRpcUrl : this.selectedOption?.rpcUrl)
  /** true when the browser requires proxying due to mixed content (HTTPS page loading an HTTP rpc) */
  mustProxy = $derived(!!this.rpcUrl && needsProxy(this.rpcUrl))
  /** whether rpc requests are currently routed through the server-side proxy (forced or required) */
  isProxied = $derived(this.mustProxy || this._forceProxy)
  /** the url used for actual rpc calls - everything on the page should use this, never rpcUrl directly */
  transportUrl = $derived(
    this.rpcUrl && this.isProxied
      ? `/api/rpc-proxy?url=${encodeURIComponent(this.rpcUrl)}`
      : this.rpcUrl
  )
  /** fully-qualified transport url (resolves relative proxy paths against the current origin) for display */
  fullTransportUrl = $derived(
    this.transportUrl?.startsWith('/')
      ? `${globalThis.location?.origin ?? ''}${this.transportUrl}`
      : this.transportUrl
  )
  client = $derived(createPublicClient({ chain: this.chain, transport: http(this.transportUrl) }))
  boardClient = $derived(new msgboard.MsgBoardClient(this.client as msgboard.Provider))
  // msgboard relevant info
  content: null | msgboard.Content = $state(null)
  contents = $derived(this.content ?? {})
  /** latest block number from the chain, updated alongside content */
  latestBlockNumber: bigint | null = $state(null)
  /** global msgboard work factors from status(), updated alongside content (the current threshold) */
  globalWorkMultiplier: bigint | null = $state(null)
  globalWorkDivisor: bigint | null = $state(null)
  /**
   * msgboard_ availability for the active rpc: null = checking, true = the endpoint
   * serves the msgboard_ namespace, false = reachable-but-disabled or unavailable.
   * Purely informational — it never gates submission or chain switching.
   */
  msgboardEnabled: boolean | null = $state(null)
  /** true while content is being fetched (initial load or chain switch) */
  loading = $state(false)
  /**
   * Non-blocking probe of msgboard_status for the current transport. Runs independently
   * of content loading (so it still reports a result even when content() fails on an
   * endpoint that lacks the namespace), updates the availability badge, and refreshes the
   * global work factors. Race-guarded so a slow probe cannot clobber a newer selection.
   */
  probeMsgboard = async () => {
    const url = this.transportUrl
    if (!url) {
      this.msgboardEnabled = null
      return
    }
    try {
      const status = await this.boardClient.status()
      if (this.transportUrl !== url) return // a newer selection superseded this probe
      this.msgboardEnabled = !!status?.enabled
      this.globalWorkMultiplier = BigInt(status.workMultiplier)
      this.globalWorkDivisor = BigInt(status.workDivisor)
    } catch {
      if (this.transportUrl !== url) return
      this.msgboardEnabled = false
    }
  }
  loadContent = async () => {
    // fire the availability probe without awaiting it — content loading must not block on it
    this.probeMsgboard()
    this.loading = true
    try {
      const [content, blockNumber] = await Promise.all([
        this.boardClient.content(),
        this.client.getBlockNumber(),
      ])
      this.content = content
      this.latestBlockNumber = blockNumber
    } finally {
      this.loading = false
    }
  }
  clearContent = () => {
    this.content = null
  }
  categories = $derived(Object.keys(this.contents))
  messages = $derived(Object.values(this.contents).flatMap((c) => c))
  /** whether the current rpc configuration is valid and usable */
  rpcValid = $derived(
    this._chainOption !== 'custom'
      ? !!this.selectedOption
      : !!this._customRpcUrl && /^https?:\/\//.test(this._customRpcUrl)
  )
  /** custom chains assume the same faucet setup as the testnet (pulsechainV4) */
  faucetIsActive = $derived(this._chainOption === 'custom' || !!this.selectedOption?.gasSponsor)
}

export const chain = new ChainState()

const loadContent = () => {
  chain.loadContent().catch(console.error)
}
setInterval(loadContent, 20_000)
loadContent()

export const cancel = async (reg: ServiceWorkerRegistration) => {
  worker?.postMessage({ type: 'cancel' } as CancelReq)
}

export const doWork = async (rpcUrl: string, category: string, text: string, _cancel = cancel) => {
  let reg!: ServiceWorkerRegistration
  let rejected!: () => void
  let cancelled!: boolean
  const provider = createPublicClient({ chain: pulsechainV4, transport: http(rpcUrl) })
  const { workMultiplier, workDivisor } = await new msgboard.MsgBoardClient(
    provider as msgboard.Provider,
  ).status()
  const initMsg: StartWorkReq = {
    type: 'work',
    rpc: rpcUrl,
    category,
    data: text,
    workMultiplier: workMultiplier,
    workDivisor: workDivisor,
  }
  let workerMsgHandler!: (msg: any) => void
  const unregister = () => {
    worker.removeEventListener('message', workerMsgHandler)
  }
  return {
    cancel: async () => {
      await _cancel(reg)
      cancelled = true
      terminalState.printToTerminal(new Log('cancelled'))
      unregister()
      rejected()
    },
    start: () =>
      new Promise<msgboard.WorkResult>(async (resolve, reject) => {
        rejected = reject

        workerMsgHandler = ({ data: msg }: { data: WorkerResponseMsg }) => {
          if (cancelled) return
          switch (msg.type) {
            case 'log':
              terminalState.printToTerminal(new Log(msg.message))
              break
            case 'progress':
              const { stats } = msg
              terminalState.printToTerminal(
                new Log(`progress ${stats.iterations} over ${stats.duration}ms`),
              )
              terminalState.updateProgress(stats)
              break
            case 'complete':
              const { result } = msg
              unregister()
              resolve(result)
              terminalState.printToTerminal(
                new Log(
                  `valid message ${result.message.hash} at block ${result.message.blockNumber}`,
                ),
              )
              break
            case 'error':
              unregister()
              terminalState.printToTerminal(new Log(`error: ${msg.message}`))
              reject(new Error(msg.message))
              break
            default:
              break
          }
        }

        worker.addEventListener('message', workerMsgHandler)
        worker.postMessage(initMsg)
      }),
  }
}

export const send = async (rpc: string, { message }: msgboard.WorkResult) => {
  const viemClient = createPublicClient({ chain: pulsechainV4, transport: http(rpc) })
  const boardClient = new msgboard.MsgBoardClient(viemClient as msgboard.Provider)
  return boardClient.addMessage(msgboard.toRLP(message))
}
