import { create } from 'zustand'
import { createPublicClient, http, type Chain, type PublicClient } from 'viem'
import * as msgboard from '@msgboard/sdk'
import type { Content } from '@msgboard/sdk'
import {
  rpcs,
  defaultCustomChain,
  needsProxy,
  type ChainConfig,
  type ChainOption,
} from '../lib/rpc'

/**
 * Chain/board global store (ported from `msgboard.svelte.ts`).
 *
 * The Svelte version held raw `$state` fields and a cloud of `$derived` getters. Here the
 * **raw** state lives in the zustand store and every Svelte `$derived` becomes a pure
 * `select*(state)` helper (a tested selector). Components subscribe via
 * `useChainStore((s) => selectTransportUrl(s))`; out-of-React callers (the 20s poll, the
 * worker-board seam) read `useChainStore.getState()`.
 *
 * INVARIANT: `selectTransportUrl` is the only URL anything uses for RPC — never raw rpcUrl.
 */

const readChainOption = (): ChainOption => {
  try {
    return (localStorage.getItem('chainOption') as ChainOption) ?? 'pulsechain'
  } catch {
    return 'pulsechain'
  }
}
const readCustomRpcUrl = (): string => {
  try {
    return localStorage.getItem('customRpcUrl') ?? ''
  } catch {
    return ''
  }
}
const readForceProxy = (): boolean => {
  try {
    return localStorage.getItem('forceProxy') === 'true'
  } catch {
    return false
  }
}

export type ChainState = {
  /** the selected preset/custom option (persisted) */
  chainOption: ChainOption
  /** rpc url entered by the user when chainOption is 'custom' (persisted) */
  customRpcUrl: string
  /** route every rpc request through the server-side proxy regardless of protocol (persisted) */
  forceProxy: boolean
  /** msgboard content for the active rpc (msgboard_content) */
  content: Content | null
  /** latest block number, refreshed alongside content */
  latestBlockNumber: bigint | null
  /** global work factors from status() — the current threshold */
  globalWorkMultiplier: bigint | null
  globalWorkDivisor: bigint | null
  /** msgboard_ availability for the active rpc: null = checking, true/false = result */
  msgboardEnabled: boolean | null
  /** true while content is being fetched (initial load or chain switch) */
  loading: boolean

  // actions
  setChainOption: (option: ChainOption) => void
  setCustomRpcUrl: (url: string) => void
  setForceProxy: (value: boolean) => void
  clearContent: () => void
  probeMsgboard: () => Promise<void>
  loadContent: () => Promise<void>
}

// ── selectors (each a former `$derived`) ────────────────────────────────────

type RawChain = Omit<
  ChainState,
  'setChainOption' | 'setCustomRpcUrl' | 'setForceProxy' | 'clearContent' | 'probeMsgboard' | 'loadContent'
>

export const selectSelectedOption = (s: RawChain): ChainConfig | undefined =>
  s.chainOption === 'custom' ? undefined : rpcs.get(s.chainOption)

export const selectChain = (s: RawChain): Chain | undefined =>
  s.chainOption === 'custom' ? defaultCustomChain : selectSelectedOption(s)?.chain

export const selectName = (s: RawChain): string | undefined =>
  s.chainOption === 'custom' ? 'Custom' : selectChain(s)?.name

export const selectRpcUrl = (s: RawChain): string | undefined =>
  s.chainOption === 'custom' ? s.customRpcUrl : selectSelectedOption(s)?.rpcUrl

export const selectMustProxy = (s: RawChain): boolean => {
  const url = selectRpcUrl(s)
  return !!url && needsProxy(url)
}

export const selectIsProxied = (s: RawChain): boolean => selectMustProxy(s) || s.forceProxy

export const selectTransportUrl = (s: RawChain): string | undefined => {
  const url = selectRpcUrl(s)
  return url && selectIsProxied(s) ? `/api/rpc-proxy?url=${encodeURIComponent(url)}` : url
}

export const selectFullTransportUrl = (s: RawChain): string | undefined => {
  const t = selectTransportUrl(s)
  return t?.startsWith('/') ? `${globalThis.location?.origin ?? ''}${t}` : t
}

export const selectClient = (s: RawChain): PublicClient =>
  createPublicClient({ chain: selectChain(s), transport: http(selectTransportUrl(s)) }) as PublicClient

export const selectBoardClient = (s: RawChain): msgboard.MsgBoardClient =>
  new msgboard.MsgBoardClient(selectClient(s) as unknown as msgboard.Provider)

const contents = (s: RawChain): Content => s.content ?? ({} as Content)

export const selectCategories = (s: RawChain): string[] => Object.keys(contents(s))

export const selectMessages = (s: RawChain): msgboard.RPCMessage[] =>
  Object.values(contents(s)).flatMap((c) => c)

export const selectRpcValid = (s: RawChain): boolean =>
  s.chainOption !== 'custom'
    ? !!selectSelectedOption(s)
    : !!s.customRpcUrl && /^https?:\/\//.test(s.customRpcUrl)

export const selectFaucetIsActive = (s: RawChain): boolean =>
  s.chainOption === 'custom' || !!selectSelectedOption(s)?.gasSponsor

// ── store ────────────────────────────────────────────────────────────────

const persist = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* localStorage may be unavailable */
  }
}

export const useChainStore = create<ChainState>((set, get) => ({
  chainOption: readChainOption(),
  customRpcUrl: readCustomRpcUrl(),
  forceProxy: readForceProxy(),
  content: null,
  latestBlockNumber: null,
  globalWorkMultiplier: null,
  globalWorkDivisor: null,
  msgboardEnabled: null,
  loading: false,

  setChainOption: (option) => {
    persist('chainOption', option)
    // re-probe on switch
    set({ chainOption: option, msgboardEnabled: null })
    const s = get()
    if (option !== 'custom' || s.customRpcUrl) {
      void s.loadContent()
    }
  },

  setCustomRpcUrl: (url) => {
    persist('customRpcUrl', url)
    set({ customRpcUrl: url, msgboardEnabled: null })
    const s = get()
    if (s.chainOption === 'custom' && url) {
      void s.loadContent()
    }
  },

  setForceProxy: (value) => {
    persist('forceProxy', String(value))
    set({ forceProxy: value, msgboardEnabled: null })
    const s = get()
    if (selectRpcUrl(s)) {
      void s.loadContent()
    }
  },

  clearContent: () => set({ content: null }),

  probeMsgboard: async () => {
    const url = selectTransportUrl(get())
    if (!url) {
      set({ msgboardEnabled: null })
      return
    }
    try {
      const status = await selectBoardClient(get()).status()
      if (selectTransportUrl(get()) !== url) return // superseded by a newer selection
      set({
        msgboardEnabled: !!status?.enabled,
        globalWorkMultiplier: BigInt(status.workMultiplier),
        globalWorkDivisor: BigInt(status.workDivisor),
      })
    } catch {
      if (selectTransportUrl(get()) !== url) return
      set({ msgboardEnabled: false })
    }
  },

  loadContent: async () => {
    // fire the availability probe without awaiting it — content loading must not block on it
    void get().probeMsgboard()
    set({ loading: true })
    try {
      const s = get()
      const [content, blockNumber] = await Promise.all([
        selectBoardClient(s).content(),
        selectClient(s).getBlockNumber(),
      ])
      set({ content, latestBlockNumber: blockNumber })
    } finally {
      set({ loading: false })
    }
  },
}))

/**
 * Start the 20s content poll (mirrors the module-level `setInterval` in the Svelte store).
 * Mount once from App's `useEffect`; the returned cleanup clears the interval.
 */
export const startChainPolling = (): (() => void) => {
  const tick = () => {
    useChainStore
      .getState()
      .loadContent()
      .catch((err) => console.error(err))
  }
  const id = setInterval(tick, 20_000)
  tick()
  return () => clearInterval(id)
}
