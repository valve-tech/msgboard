import { create } from 'zustand'
import { type WorkStats, type Message, fromRPCMessage } from '@msgboard/sdk'
import { useChainStore, selectMessages } from './chain'

/**
 * Terminal/log global store (ported from `log.svelte.ts`).
 *
 * `logList` / `lastProgress` + the mutators live in the zustand store. `messageList` —
 * a Svelte `$derived.by` that read the chain store — becomes the pure `selectMessageList()`
 * selector that reads `useChainStore.getState()` content and applies the same sort.
 */

/** A single terminal line. Ported verbatim (the Svelte `$state(new Date())` becomes a plain field). */
export class Log {
  time: Date = new Date()
  constructor(protected text: string) {}
  toString() {
    return this.text
  }
}

export type TerminalState = {
  logList: Log[]
  lastProgress: WorkStats | null
  clearLogs: () => void
  updateProgress: (progress: WorkStats) => void
  printToTerminal: (...items: Log[]) => void
}

export const useTerminalStore = create<TerminalState>((set, get) => ({
  logList: [],
  lastProgress: null,
  clearLogs: () => set({ logList: [] }),
  updateProgress: (progress) => set({ lastProgress: progress }),
  printToTerminal: (...items) => set({ logList: get().logList.concat(items) }),
}))

/**
 * The board message list, sorted by category then hash — was `terminalState.messageList`
 * (`$derived.by`). Reads the chain store's content via `selectMessages` + `fromRPCMessage`.
 */
export const selectMessageList = (): Message[] => {
  const contents = selectMessages(useChainStore.getState()).map((msg) => fromRPCMessage(msg))
  return contents.sort((a, b) => {
    if (a.category < b.category) return -1
    if (a.category > b.category) return 1
    if (a.hash < b.hash) return -1
    if (a.hash > b.hash) return 1
    return 0
  })
}
