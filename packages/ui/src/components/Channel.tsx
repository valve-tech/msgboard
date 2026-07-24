import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '@iconify/react'
import { base64urlnopad } from '@scure/base'
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
import {
  decryptMessage,
  deriveCategory,
  encodeInvite,
  encryptMessage,
  isUndecryptable,
  mintRoomKey,
  parseInvite,
} from '../lib/room-crypto'

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
 *
 * ENCRYPTED PRIVATE ROOMS (the 🔒 mode): the same model, but message BODIES are end-to-end encrypted
 * with a shared 32-byte room key (XChaCha20-Poly1305). The board category is derived from the key
 * (keccak256("msgboard:eroom:v1"||key)), so the room is unlinkable to any plaintext name and only
 * key-holders know where to read/post. The board only ever carries ciphertext. See room-crypto.ts.
 */

const HANDLE_KEY = 'msgboard.channel.handle'
const CHANNEL_KEY = 'msgboard.channel.name'
const ROOMS_KEY = 'msgboard.channel.rooms'
const ACTIVE_ROOM_KEY = 'msgboard.channel.activeRoom'
const DEFAULT_CHANNELS = ['lobby', 'gm', 'msgboard', 'testing']

const short = (h: string) => `${h.slice(0, 8)}…${h.slice(-4)}`

/** A joined encrypted room, as persisted. `name` is LOCAL only; `keyBase64url` is the shared key. */
interface EncRoom {
  name: string
  keyBase64url: string
}

const loadRooms = (): EncRoom[] => {
  try {
    const raw = localStorage.getItem(ROOMS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (r): r is EncRoom =>
        r && typeof r.name === 'string' && typeof r.keyBase64url === 'string',
    )
  } catch {
    return []
  }
}

/** Decode a persisted room's base64url key back to bytes, or null if it's somehow corrupt. */
const roomKeyBytes = (room: EncRoom): Uint8Array | null => {
  try {
    const key = base64urlnopad.decode(room.keyBase64url)
    return key.length === 32 ? key : null
  } catch {
    return null
  }
}

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
  const [rooms, setRooms] = useState<EncRoom[]>(() => loadRooms())
  // The active encrypted room, keyed by its base64url key; null → public-channel mode.
  const [activeRoomId, setActiveRoomId] = useState<string | null>(
    () => localStorage.getItem(ACTIVE_ROOM_KEY) || null,
  )
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [copied, setCopied] = useState(false)
  const feedRef = useRef<HTMLDivElement>(null)

  useEffect(() => localStorage.setItem(CHANNEL_KEY, channel), [channel])
  useEffect(() => localStorage.setItem(HANDLE_KEY, handle), [handle])
  useEffect(() => localStorage.setItem(ROOMS_KEY, JSON.stringify(rooms)), [rooms])
  useEffect(() => {
    if (activeRoomId) localStorage.setItem(ACTIVE_ROOM_KEY, activeRoomId)
    else localStorage.removeItem(ACTIVE_ROOM_KEY)
  }, [activeRoomId])

  // The active encrypted room (if any) + its key bytes. If the persisted id no longer resolves to a
  // room with a valid key, we fall back to public mode rather than render a broken room.
  const activeRoom = useMemo(
    () => rooms.find((r) => r.keyBase64url === activeRoomId) ?? null,
    [rooms, activeRoomId],
  )
  const roomKey = useMemo(() => (activeRoom ? roomKeyBytes(activeRoom) : null), [activeRoom])
  const encrypted = activeRoom != null && roomKey != null

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

  // The category we read + post: derived-from-key for an encrypted room, name-encoded for public.
  const category = useMemo(
    () => (encrypted && roomKey ? deriveCategory(roomKey) : channelToCategory(channel)),
    [encrypted, roomKey, channel],
  )
  const messages = useMemo(() => {
    const list = (content?.[category] as RPCMessage[] | undefined) ?? []
    let rows = [...list].sort(byBlockDesc)
    // Encrypted-room replay guard (audit F1): the shared-key model lets a NON-key-holder copy an
    // existing ciphertext off the public category and re-post it verbatim — it decrypts as
    // authentic and looks current. It can neither read nor alter the message, but the duplicate is
    // a conversation-integrity nuisance. Every genuine message carries a fresh random 24-byte
    // nonce, so identical `data` bytes ⇒ the same original re-posted: collapse them to the earliest
    // instance. (Kills verbatim replay while any copy is in the live window; the trust panel
    // discloses the residual — an aged-out message re-posted after the original is gone.)
    if (encrypted) {
      const seen = new Set<string>()
      rows = rows
        .slice()
        .reverse()
        .filter((m) => (seen.has(m.data) ? false : (seen.add(m.data), true)))
        .reverse()
    }
    return rows
  }, [content, category, encrypted])

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
    // Encrypt in the active room, else post plaintext. Either way the PoW grind is the worker's job.
    const data =
      encrypted && roomKey
        ? encryptMessage(roomKey, category, text, handle)
        : encodeChatData(text, handle)
    setSending(true)
    try {
      await board.addMessage({ category, data })
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

  const createRoom = () => {
    const name = window.prompt('Name this private room (local label only — never posted):')?.trim()
    if (!name) return
    const key = mintRoomKey()
    const keyBase64url = base64urlnopad.encode(key)
    setRooms((rs) => [...rs, { name, keyBase64url }])
    setActiveRoomId(keyBase64url)
  }

  const joinRoom = () => {
    const raw = window.prompt('Paste a room invite (msgboard-room:v1:…):')?.trim()
    if (!raw) return
    const parsed = parseInvite(raw)
    if (!parsed) {
      window.alert('That invite is malformed — nothing joined.')
      return
    }
    const keyBase64url = base64urlnopad.encode(parsed.key)
    const name =
      parsed.name?.trim() ||
      window.prompt('Local name for this room:')?.trim() ||
      'private room'
    setRooms((rs) => {
      const existing = rs.find((r) => r.keyBase64url === keyBase64url)
      return existing ? rs : [...rs, { name, keyBase64url }]
    })
    setActiveRoomId(keyBase64url)
  }

  const shareInvite = async () => {
    if (!activeRoom || !roomKey) return
    const invite = encodeInvite(roomKey, activeRoom.name)
    try {
      await navigator.clipboard.writeText(invite)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      window.prompt('Copy this invite (keep it secret):', invite)
    }
  }

  const blocksAgo = (bn: string): string => {
    if (latestBlock == null) return ''
    const d = Number(latestBlock - BigInt(bn))
    return d <= 0 ? 'now' : `${d} blk${d === 1 ? '' : 's'} ago`
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col overflow-hidden rounded-lg bg-white shadow ring-1 ring-gray-200 dark:bg-gray-800 dark:ring-gray-700">
      {/* channel / room bar */}
      <div className="flex items-center gap-3 border-b border-gray-200 px-4 py-2.5 dark:border-gray-700">
        {encrypted ? (
          <>
            <Icon icon="mdi:lock" className="size-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
            <span className="min-w-0 flex-1 truncate font-semibold text-gray-900 dark:text-gray-100">
              {activeRoom!.name}
            </span>
            <button
              type="button"
              onClick={() => void shareInvite()}
              className="inline-flex shrink-0 items-center gap-1 rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-500">
              <Icon icon={copied ? 'mdi:check' : 'mdi:share-variant'} className="size-3.5" />
              {copied ? 'copied' : 'share invite'}
            </button>
            <button
              type="button"
              onClick={() => setActiveRoomId(null)}
              className="shrink-0 rounded-md px-2 py-1 text-xs text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700"
              title="back to public channels">
              <Icon icon="mdi:pound" className="inline size-3.5" /> channels
            </button>
          </>
        ) : (
          <>
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
          </>
        )}
      </div>

      {/* private-rooms strip: the picker/list, with a 🔒 on each encrypted room */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-gray-200 px-4 py-2 text-xs dark:border-gray-700">
        <span className="inline-flex items-center gap-1 text-gray-400">
          <Icon icon="mdi:lock-outline" className="size-3.5" /> private
        </span>
        {rooms.map((r) => {
          const active = r.keyBase64url === activeRoomId
          const broken = roomKeyBytes(r) == null
          return (
            <button
              key={r.keyBase64url}
              type="button"
              disabled={broken}
              onClick={() => setActiveRoomId(r.keyBase64url)}
              title={broken ? 'this room key is corrupt' : `switch to ${r.name}`}
              className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 font-medium ${
                active
                  ? 'bg-emerald-600 text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600'
              } ${broken ? 'opacity-40' : ''}`}>
              <Icon icon="mdi:lock" className="size-3" />
              <span className="max-w-[10rem] truncate">{r.name}</span>
            </button>
          )
        })}
        <button
          type="button"
          onClick={createRoom}
          className="inline-flex items-center gap-1 rounded-full border border-dashed border-gray-300 px-2.5 py-1 text-gray-500 hover:border-emerald-500 hover:text-emerald-600 dark:border-gray-600 dark:text-gray-400">
          <Icon icon="mdi:plus" className="size-3.5" /> new
        </button>
        <button
          type="button"
          onClick={joinRoom}
          className="inline-flex items-center gap-1 rounded-full border border-dashed border-gray-300 px-2.5 py-1 text-gray-500 hover:border-emerald-500 hover:text-emerald-600 dark:border-gray-600 dark:text-gray-400">
          <Icon icon="mdi:link-variant" className="size-3.5" /> join
        </button>
      </div>

      {/* honest trust model — unmissable when a room is active */}
      {encrypted && (
        <div className="border-b border-emerald-200 bg-emerald-50 px-4 py-2.5 text-[11px] leading-relaxed text-emerald-900 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-200">
          <p className="font-semibold">
            <Icon icon="mdi:shield-lock" className="inline size-3.5" /> End-to-end encrypted
            (XChaCha20-Poly1305). Outsiders can’t read this room and it’s unlinkable by name.
          </p>
          <p className="mt-1 text-emerald-800 dark:text-emerald-300/90">
            But be honest about the limits: the <strong>shared key means any invite-holder can read
            AND post as any handle</strong> (no per-sender identity yet). There is{' '}
            <strong>no forward secrecy</strong> — a leaked invite exposes all past and future
            messages, so mint a new room to rotate. And <strong>metadata is public</strong>: the
            board still shows that a conversation is happening, when, how big, and its PoW stamps —
            encryption hides content, not activity. Outsiders can also <strong>replay old
            ciphertext</strong> (not read or alter it — just re-post a copy), so treat message
            timing as approximate. Keep your invite secret; lose it and the room is unrecoverable.
          </p>
        </div>
      )}

      {/* feed */}
      <div
        ref={feedRef}
        className="flex h-80 flex-col-reverse gap-0.5 overflow-y-auto px-4 py-3 font-mono text-sm">
        {messages.length === 0 && (
          <div className="m-auto max-w-xs text-center text-gray-400">
            <Icon
              icon={encrypted ? 'mdi:lock-outline' : 'mdi:message-text-outline'}
              className="mx-auto mb-2 size-7 opacity-60"
            />
            <p className="text-sm">
              <span className="text-gray-500 dark:text-gray-300">
                {encrypted ? `🔒 ${activeRoom!.name}` : `#${channel}`}
              </span>{' '}
              is quiet.
            </p>
            <p className="mt-1 text-xs">
              The board keeps only the last ~120 blocks, so a room is whoever is talking right now.
              Say something to open it.
            </p>
          </div>
        )}
        {messages.map((m) => {
          const decoded =
            encrypted && roomKey
              ? decryptMessage(roomKey, category, m.data as Hex)
              : decodeChatData(m.data as Hex)
          if (isUndecryptable(decoded)) {
            const anon = anonHandle(m.hash as Hex)
            return (
              <div
                key={m.hash}
                className="flex items-baseline gap-2 rounded px-1 py-0.5 text-gray-400"
                title="ciphertext this room key can’t open (wrong key, tampered, or another room)">
                <span className="inline-flex shrink-0 items-center gap-1 font-semibold text-gray-400">
                  <Icon icon="mdi:lock-alert" className="size-3.5" /> can’t decrypt
                </span>
                <span className="min-w-0 flex-1 truncate italic">{anon.name}</span>
                <span className="shrink-0 text-[11px] text-gray-400" title={`${short(m.hash)} · block ${m.blockNumber}`}>
                  {blocksAgo(m.blockNumber)}
                </span>
              </div>
            )
          }
          const { handle: h, text } = decoded
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
            placeholder={
              !rpcValid
                ? 'point at a board-serving RPC to post'
                : encrypted
                  ? `encrypted message to 🔒 ${activeRoom!.name}`
                  : `message #${channel}`
            }
            value={draft}
            disabled={!rpcValid || sending}
            onChange={(e) => setDraft(e.target.value)}
            aria-label="message"
          />
          <button
            type="submit"
            disabled={!rpcValid || sending || !draft.trim()}
            className={`inline-flex shrink-0 items-center gap-1.5 rounded-md px-3.5 py-2 text-sm font-medium text-white disabled:opacity-50 ${
              encrypted ? 'bg-emerald-600 hover:bg-emerald-500' : 'bg-indigo-600 hover:bg-indigo-500'
            }`}>
            {sending ? (
              <>
                <Icon icon="mdi:pickaxe" className="size-4 animate-pulse" /> grinding…
              </>
            ) : (
              <>
                <Icon icon={encrypted ? 'mdi:lock' : 'mdi:send'} className="size-4" />{' '}
                {encrypted ? 'encrypt & send' : 'send'}
              </>
            )}
          </button>
        </form>
        <p className="px-4 pb-2.5 text-[11px] text-gray-400">
          {encrypted
            ? 'Encrypted end-to-end, then stamped: the body is sealed before that ~second of PoW grinding (kept off this thread) admits it to the room. The board only ever sees ciphertext.'
            : 'Each message mints a proof-of-work stamp instead of paying gas — that ~second of grinding (kept off this thread) is what admits it to the room. No wallet, no account.'}
        </p>
      </div>
    </div>
  )
}
