import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '@iconify/react'
import type { Hex } from 'viem'
import type { RPCMessage } from '@msgboard/sdk'
import {
  useChainStore,
  selectChain,
  selectTransportUrl,
  selectRpcValid,
} from '../stores/chain'
import { makeWorkerBoard } from '../seams/worker-board'
import { Menu } from './Menu'
import {
  anonHandle,
  categoryToChannel,
  channelToCategory,
  decodeChatData,
  encodeChatData,
} from '../lib/channel'

/**
 * Channel — the board as a room. This is the feedback fix: the old "Try it" panel let you SEND a
 * message but never showed you the room, so it read like a compose box with nowhere for the
 * conversation to go. Here the category IS the channel (join by name — "lobby", "gm", anything),
 * the feed is every message currently in that category (the board already groups content by
 * category and the store polls it every 20s), and the composer drops a line in. Grinding runs in
 * the Web Worker seam, never the main thread.
 *
 * The board is ephemeral (~120 blocks) and anonymous (no sender field), so this is a live room, not
 * a log: lines age out, and each message wears either the handle its author typed or a stable
 * hash-derived `anon-####` tag. That's the honest shape of the medium — say it plainly rather than
 * fake persistence or identity.
 */

const HANDLE_KEY = 'msgboard.channel.handle'
const CHANNEL_KEY = 'msgboard.channel.name'
const DEFAULT_CHANNELS = ['lobby', 'gm', 'msgboard', 'testing']

const short = (h: string) => `${h.slice(0, 8)}…${h.slice(-4)}`

/** Newest first for the "who's live" sense; the board returns them per category. */
const byBlockDesc = (a: RPCMessage, b: RPCMessage) => Number(BigInt(b.blockNumber) - BigInt(a.blockNumber))

export function Channel({ workerFactory }: { workerFactory?: () => Worker }) {
  const chainId = useChainStore((s) => selectChain(s)?.id ?? 943)
  const transportUrl = useChainStore((s) => selectTransportUrl(s))
  const rpcValid = useChainStore((s) => selectRpcValid(s))
  const content = useChainStore((s) => s.content)
  const latestBlock = useChainStore((s) => s.latestBlockNumber)
  const workMultiplier = useChainStore((s) => s.globalWorkMultiplier)
  const workDivisor = useChainStore((s) => s.globalWorkDivisor)

  const [channel, setChannel] = useState(() => localStorage.getItem(CHANNEL_KEY) ?? 'lobby')
  const [handle, setHandle] = useState(() => localStorage.getItem(HANDLE_KEY) ?? '')
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const feedRef = useRef<HTMLDivElement>(null)

  useEffect(() => localStorage.setItem(CHANNEL_KEY, channel), [channel])
  useEffect(() => localStorage.setItem(HANDLE_KEY, handle), [handle])

  // The channels to offer: the well-knowns, plus any live category that decodes to a readable name,
  // plus whatever the user has joined — deduped, current channel guaranteed present.
  const liveChannels = useMemo(() => {
    const names = new Set(DEFAULT_CHANNELS)
    for (const cat of Object.keys(content ?? {})) {
      const name = categoryToChannel(cat as Hex)
      if (!name.includes('…')) names.add(name)
    }
    names.add(channel)
    return [...names]
  }, [content, channel])

  const category = useMemo(() => channelToCategory(channel), [channel])
  const messages = useMemo(() => {
    const list = (content?.[category] as RPCMessage[] | undefined) ?? []
    return [...list].sort(byBlockDesc)
  }, [content, category])

  const board = useMemo(() => {
    if (!transportUrl) return null
    return makeWorkerBoard({
      rpc: transportUrl,
      chainId,
      workMultiplier: workMultiplier != null ? Number(workMultiplier) : 1,
      workDivisor: workDivisor != null ? Number(workDivisor) : 1,
      workerFactory,
    })
  }, [transportUrl, chainId, workMultiplier, workDivisor, workerFactory])

  const send = async () => {
    const text = draft.trim()
    if (!text || !board || sending) return
    setSending(true)
    try {
      await board.addMessage({ category, data: encodeChatData(text, handle) })
      setDraft('')
      await new Promise((r) => setTimeout(r, 1000))
      await useChainStore.getState().loadContent()
      feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight })
    } catch (err) {
      if (err) console.error(err)
    } finally {
      setSending(false)
    }
  }

  const blocksAgo = (bn: string): string => {
    if (latestBlock == null) return ''
    const d = Number(latestBlock - BigInt(bn))
    return d <= 0 ? 'now' : `${d} blk${d === 1 ? '' : 's'} ago`
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col overflow-hidden rounded-lg bg-white shadow ring-1 ring-gray-200 dark:bg-gray-800 dark:ring-gray-700">
      {/* channel bar */}
      <div className="flex items-center gap-3 border-b border-gray-200 px-4 py-2.5 dark:border-gray-700">
        <span className="font-mono text-lg text-indigo-600 dark:text-indigo-400">#</span>
        <Menu
          label="channel"
          options={liveChannels}
          value={Math.max(0, liveChannels.indexOf(channel))}
          onChange={(i) => setChannel(liveChannels[i]!)}
        />
        <input
          className="min-w-0 flex-1 rounded-md bg-gray-50 px-2.5 py-1 text-sm text-gray-900 outline-1 -outline-offset-1 outline-gray-300 focus:-outline-offset-2 focus:outline-indigo-600 dark:bg-gray-900 dark:text-gray-100 dark:outline-gray-600"
          placeholder="join another channel…"
          value={channel}
          onChange={(e) => setChannel(e.target.value.replace(/\s+/g, '-').toLowerCase().slice(0, 32))}
          aria-label="channel name"
        />
        <span className="hidden shrink-0 text-xs text-gray-400 sm:inline">
          {messages.length} live
        </span>
      </div>

      {/* feed */}
      <div
        ref={feedRef}
        className="flex h-80 flex-col-reverse gap-0.5 overflow-y-auto px-4 py-3 font-mono text-sm">
        {messages.length === 0 && (
          <div className="m-auto max-w-xs text-center text-gray-400">
            <Icon icon="mdi:message-text-outline" className="mx-auto mb-2 size-7 opacity-60" />
            <p className="text-sm">
              <span className="text-gray-500 dark:text-gray-300">#{channel}</span> is quiet.
            </p>
            <p className="mt-1 text-xs">
              The board keeps only the last ~120 blocks, so a room is whoever is talking right now.
              Say something to open it.
            </p>
          </div>
        )}
        {messages.map((m) => {
          const { handle: h, text } = decodeChatData(m.data as Hex)
          const who = h && h.length ? { name: h, color: 'text-indigo-600 dark:text-indigo-400' } : anonHandle(m.hash as Hex)
          return (
            <div key={m.hash} className="flex items-baseline gap-2 rounded px-1 py-0.5 hover:bg-gray-50 dark:hover:bg-gray-700/40">
              <span className={`shrink-0 font-semibold ${who.color}`} title={h ? 'handle typed by the sender' : 'anonymous — derived from the message hash'}>
                {who.name}
              </span>
              <span className="min-w-0 flex-1 break-words text-gray-800 dark:text-gray-100">{text}</span>
              <span className="shrink-0 text-[11px] text-gray-400" title={`${short(m.hash)} · block ${m.blockNumber}`}>
                {blocksAgo(m.blockNumber)}
              </span>
            </div>
          )
        })}
      </div>

      {/* composer */}
      <div className="border-t border-gray-200 dark:border-gray-700">
        <div className="flex items-center gap-2 px-4 pt-2">
          <label className="text-xs text-gray-400">as</label>
          <input
            className="w-32 rounded-md bg-gray-50 px-2 py-0.5 text-xs text-gray-900 outline-1 -outline-offset-1 outline-gray-300 focus:-outline-offset-2 focus:outline-indigo-600 dark:bg-gray-900 dark:text-gray-100 dark:outline-gray-600"
            placeholder="handle (optional)"
            value={handle}
            maxLength={20}
            onChange={(e) => setHandle(e.target.value.replace(/\s+/g, '').slice(0, 20))}
            aria-label="your handle"
          />
          <span className="text-[11px] text-gray-400">no handle → a hash-derived anon tag</span>
        </div>
        <form
          className="flex items-center gap-2 px-4 py-2.5"
          onSubmit={(e) => {
            e.preventDefault()
            void send()
          }}>
          <input
            className="min-w-0 flex-1 rounded-md bg-gray-50 px-3 py-2 text-sm text-gray-900 outline-1 -outline-offset-1 outline-gray-300 focus:-outline-offset-2 focus:outline-indigo-600 disabled:opacity-60 dark:bg-gray-900 dark:text-gray-100 dark:outline-gray-600"
            placeholder={rpcValid ? `message #${channel}` : 'point at a board-serving RPC to post'}
            value={draft}
            disabled={!rpcValid || sending}
            onChange={(e) => setDraft(e.target.value)}
            aria-label="message"
          />
          <button
            type="submit"
            disabled={!rpcValid || sending || !draft.trim()}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-indigo-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50">
            {sending ? (
              <>
                <Icon icon="mdi:pickaxe" className="size-4 animate-pulse" /> grinding…
              </>
            ) : (
              <>
                <Icon icon="mdi:send" className="size-4" /> send
              </>
            )}
          </button>
        </form>
        <p className="px-4 pb-2.5 text-[11px] text-gray-400">
          Each message mints a proof-of-work stamp instead of paying gas — that ~second of grinding
          (kept off this thread) is what admits it to the room. No wallet, no account.
        </p>
      </div>
    </div>
  )
}
