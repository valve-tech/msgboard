/**
 * Chat — ONE unified chat surface with a privacy-mode selector. It collapses the three formerly
 * separate experiences (public Channel, encrypted private rooms, anonymous Whisper) into a single
 * tab whose segmented control picks HOW you talk. The three modes reuse the EXISTING behaviour and
 * libraries wholesale — this is a consolidation, not a rewrite:
 *
 *   • Public (🌐)    — a named public channel, handle-identified, plaintext. (was Channel's public
 *                      path: join by name, channelToCategory, encode/decodeChatData, worker post.)
 *   • Anonymous (🥷) — the ZK-membership room: an anonymous pseudonym, real Groth16 proving via the
 *                      zk-prover seam, the recovery-key backup/import panel, AND the proof inspector.
 *                      (was Whisper, verbatim — plus the new wallet-derived portable identity.)
 *   • Encrypted (🔒) — a shared-key private room: XChaCha20-Poly1305 bodies via room-crypto.ts, the
 *                      honest trust banner (incl. replay disclosure), share-invite, decrypt-or-badge
 *                      feed, ciphertext-dedup replay guard. (was Channel's encrypted-rooms path.)
 *
 * Every honest trust-model caveat the originals showed is preserved unchanged. The one-line
 * explainer under the selector states each mode's privacy property plainly:
 *   Public → everyone sees who + what · Anonymous → hides who, text is public ·
 *   Encrypted → hides what from outsiders, but the sender is only a handle.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Icon } from '@iconify/react'
import { base64urlnopad } from '@scure/base'
import { stringToHex, toHex, getAddress, hexToBytes, type Address, type Hex } from 'viem'
import type { RPCMessage } from '@msgboard/sdk'
import {
  useChainStore,
  selectChain,
  selectTransportUrl,
  selectRpcValid,
} from '../stores/chain'
import { makeWorkerBoard } from '../seams/worker-board'
import { makeZkProver, type ZkProver } from '../seams/zk-prover'
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
import {
  loadOrCreateIdentity,
  rotateIdentity,
  persistIdentity,
  authorTag,
  exportIdentity,
  importAndPersistIdentity,
  type ZkIdentity,
} from '../lib/zk-identity'
import {
  hasInjectedWallet,
  deriveIdentityFromWallet,
} from '../lib/wallet-identity'
import {
  deriveEncKeypair,
  dmCategory,
  encodeContact,
  parseContact,
  sealMessage,
  openMessage,
  isUndecryptable as isDmUndecryptable,
  type Contact,
  type EncKeypair,
} from '../lib/dm-crypto'
import { randomIdentity } from '../lib/zk-identity'
import {
  decodePost,
  encodePost,
  nullifierHashOf,
  rootOf,
  externalNullifierOf,
  signalHashOf,
  payloadText,
  signalHash,
  type ZkPost,
} from '../lib/zk-post'
import { formatBlocksRemaining } from '../lib/tree'
import { BLOCK_RANGE_LIMIT } from '../lib/rpc'
import { readDeepLink, writeDeepLink, currentShareUrl } from '../lib/deeplink'
import { checkAnnouncement, decryptMessage as decryptStealthMessage } from '../lib/stealth'
import * as sm from '../lib/stealth-messenger'

// ── mode selector ────────────────────────────────────────────────────────────────────────

type Mode = 'public' | 'anonymous' | 'encrypted' | 'direct' | 'stealth'
const MODE_KEY = 'msgboard.chat.mode'
const isMode = (s: unknown): s is Mode =>
  s === 'public' || s === 'anonymous' || s === 'encrypted' || s === 'direct' || s === 'stealth'

const MODES: { id: Mode; label: string; icon: string; explainer: string }[] = [
  {
    id: 'public',
    label: 'Public',
    icon: 'mdi:web',
    explainer: 'Everyone sees who and what — a named public channel, in plaintext.',
  },
  {
    id: 'anonymous',
    label: 'Anonymous',
    icon: 'mdi:incognito',
    explainer: 'Hides who, not what — post behind a zero-knowledge membership proof; the text stays public.',
  },
  {
    id: 'encrypted',
    label: 'Encrypted',
    icon: 'mdi:lock',
    explainer: 'Hides what from outsiders — a shared-key private room. The sender is only a handle, not a proven identity.',
  },
  {
    id: 'direct',
    label: 'Direct',
    icon: 'mdi:email-lock',
    explainer: 'Private messages encrypted to specific people — only they can read them. Senders are unverified.',
  },
  {
    id: 'stealth',
    label: 'Stealth',
    icon: 'mdi:incognito-circle',
    explainer: 'On-chain messages to a hidden recipient — the sender is proven, but only the recipient can tell a message is theirs.',
  },
]

/**
 * The privacy-mode toggle — lives as a thin toolbar strip INSIDE the message card (not a second row
 * of tabs above it). Active mode is filled + labeled; the others are icon-only on small screens with
 * the explainer on hover. The current mode's explainer trails as subtle text.
 */
function ModeBar({ active, onChange }: { active: Mode; onChange: (m: Mode) => void }) {
  const current = MODES.find((m) => m.id === active)!
  return (
    <div className="flex items-center gap-2 border-b border-gray-200 bg-gray-50 px-3 py-2 dark:border-gray-700 dark:bg-gray-900/50">
      <div className="inline-flex shrink-0 gap-0.5 rounded-md bg-gray-200/70 p-0.5 dark:bg-gray-800" role="group" aria-label="privacy mode">
        {MODES.map((m) => {
          const on = m.id === active
          const accent =
            m.id === 'anonymous'
              ? 'bg-emerald-600'
              : m.id === 'encrypted'
                ? 'bg-emerald-700'
                : m.id === 'direct'
                  ? 'bg-violet-600'
                  : m.id === 'stealth'
                    ? 'bg-teal-600'
                    : 'bg-indigo-600'
          return (
            <button
              key={m.id}
              type="button"
              aria-pressed={on}
              title={m.explainer}
              onClick={() => onChange(m.id)}
              className={`inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium transition ${
                on
                  ? `${accent} text-white`
                  : 'text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-100'
              }`}>
              <Icon icon={m.icon} className="size-3.5" />
              <span className={on ? '' : 'hidden sm:inline'}>{m.label}</span>
            </button>
          )
        })}
      </div>
      <span className="min-w-0 flex-1 truncate text-[11px] text-gray-400" title={current.explainer}>
        {current.explainer}
      </span>
    </div>
  )
}

export function Chat({ workerFactory }: { workerFactory?: () => Worker }) {
  // A shared deep-link (?mode=…&demo=…) wins over the localStorage default; otherwise fall back to the
  // last-used mode, then 'public'. Every mode change is mirrored to BOTH localStorage and the URL.
  const [mode, setMode] = useState<Mode>(() => {
    const link = readDeepLink().mode
    if (link) return link
    const stored = localStorage.getItem(MODE_KEY)
    return isMode(stored) ? stored : 'public'
  })
  useEffect(() => {
    localStorage.setItem(MODE_KEY, mode)
    writeDeepLink({ mode })
  }, [mode])

  // The "talk to yourself" two-user demo overlay — opened from Encrypted or Direct mode. It replaces
  // the single-user view with two isolated participants exchanging REAL encrypted board posts. The
  // value records which crypto path the demo is exercising; null → normal single-user view. It is
  // deep-linkable (?demo=…), so a shared URL can land straight on the demo pane.
  const [demo, setDemo] = useState<'encrypted' | 'direct' | null>(() => readDeepLink().demo ?? null)
  useEffect(() => writeDeepLink({ demo }), [demo])
  if (demo) {
    return (
      <div className="flex w-full flex-col">
        <TwoUserDemo kind={demo} onClose={() => setDemo(null)} workerFactory={workerFactory} />
      </div>
    )
  }

  // The privacy toggle now lives INSIDE each pane's card (via ModeBar), so there is no second row of
  // tabs above the container. Each mode is its own self-contained pane driving the shared chain
  // store; remount-per-switch resets transient composer state cleanly. Public + Encrypted are the two
  // Channel paths; Anonymous is the full Whisper (ZK) experience; Direct is per-recipient E2E DMs.
  return (
    <div className="flex w-full flex-col">
      {mode === 'public' && <ChannelPane mode="public" activeMode={mode} onMode={setMode} workerFactory={workerFactory} />}
      {mode === 'encrypted' && (
        <ChannelPane
          mode="encrypted"
          activeMode={mode}
          onMode={setMode}
          workerFactory={workerFactory}
          onDemo={() => setDemo('encrypted')}
        />
      )}
      {mode === 'anonymous' && <AnonymousRoom activeMode={mode} onMode={setMode} workerFactory={workerFactory} />}
      {mode === 'direct' && (
        <DirectPane activeMode={mode} onMode={setMode} workerFactory={workerFactory} onDemo={() => setDemo('direct')} />
      )}
      {mode === 'stealth' && <StealthPane activeMode={mode} onMode={setMode} />}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// PUBLIC + ENCRYPTED — absorbed from Channel.tsx
//
// Channel already unified these two: the `encrypted` boolean drives the whole render. Here the top
// mode selector chooses the path — Public forces the plaintext named-channel view (no rooms strip);
// Encrypted shows the private-rooms strip + shared-key crypto UI. The board model is identical: a
// category is a room, content() groups messages by category, the worker seam grinds + posts. The
// board is ephemeral (~120 blocks) and anonymous (no sender field), so this is a live room, not a
// log. Encrypted bodies are XChaCha20-Poly1305 under a shared 32-byte key; the category is derived
// from the key (keccak256("msgboard:eroom:v1"||key)) so the room is unlinkable to any plaintext name.
// ═══════════════════════════════════════════════════════════════════════════════════════════

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

function ChannelPane({
  mode,
  activeMode,
  onMode,
  workerFactory,
  onDemo,
}: {
  mode: 'public' | 'encrypted'
  activeMode: Mode
  onMode: (m: Mode) => void
  workerFactory?: () => Worker
  /** Encrypted mode only: open the two-user "talk to yourself" demo. */
  onDemo?: () => void
}) {
  const publicMode = mode === 'public'

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
  // The active encrypted room, keyed by its base64url key; null → no room selected yet.
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

  // In public mode we never resolve a room; in encrypted mode the active room + its key bytes. If
  // the persisted id no longer resolves to a room with a valid key, we treat it as "no room".
  const activeRoom = useMemo(
    () => (publicMode ? null : (rooms.find((r) => r.keyBase64url === activeRoomId) ?? null)),
    [publicMode, rooms, activeRoomId],
  )
  const roomKey = useMemo(() => (activeRoom ? roomKeyBytes(activeRoom) : null), [activeRoom])
  const encrypted = activeRoom != null && roomKey != null

  // The channels to offer (public mode only): well-knowns + live categories that decode to a
  // readable name + whatever the user has joined — deduped, current channel guaranteed present.
  const liveChannels = useMemo(() => {
    const names = new Set(DEFAULT_CHANNELS)
    for (const cat of Object.keys(content ?? {})) {
      const name = categoryToChannel(cat as Hex)
      if (!name.includes('…')) names.add(name)
    }
    names.add(channel)
    return [...names]
  }, [content, channel])

  // The category we read + post: name-encoded for public, derived-from-key for an encrypted room.
  // In encrypted mode with no room selected, there is nothing to read/post (category = null).
  const category = useMemo(
    () =>
      publicMode
        ? channelToCategory(channel)
        : encrypted && roomKey
          ? deriveCategory(roomKey)
          : null,
    [publicMode, encrypted, roomKey, channel],
  )
  const messages = useMemo(() => {
    if (!category) return []
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

  // Can we post right now? Public: whenever the RPC is valid. Encrypted: only inside an active room.
  const canPost = rpcValid && !!category && (publicMode || encrypted)

  const send = async () => {
    const text = draft.trim()
    if (!text || !board || sending || !category || !canPost) return
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
    <div className="flex w-full flex-col overflow-hidden rounded-lg bg-white shadow ring-1 ring-gray-200 dark:bg-gray-800 dark:ring-gray-700">
      <ModeBar active={activeMode} onChange={onMode} />
      {/* channel / room bar */}
      <div className="flex items-center gap-3 border-b border-gray-200 px-4 py-2.5 dark:border-gray-700">
        {publicMode ? (
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
        ) : encrypted ? (
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
              title="leave this room (stays in your list)">
              <Icon icon="mdi:close" className="inline size-3.5" /> leave
            </button>
          </>
        ) : (
          <>
            <Icon icon="mdi:lock-outline" className="size-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
            <span className="min-w-0 flex-1 truncate font-semibold text-gray-700 dark:text-gray-200">
              Private rooms
            </span>
            <span className="hidden shrink-0 text-xs text-gray-400 sm:inline">
              pick, create, or join a room below
            </span>
          </>
        )}
      </div>

      {/* private-rooms strip (encrypted mode only): the picker/list, with a 🔒 on each room */}
      {!publicMode && (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-gray-200 px-4 py-2 text-xs dark:border-gray-700">
          <span className="inline-flex items-center gap-1 text-gray-400">
            <Icon icon="mdi:lock-outline" className="size-3.5" /> rooms
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
          {onDemo && (
            <button
              type="button"
              onClick={onDemo}
              title="Watch two freshly-generated identities exchange real end-to-end encrypted messages over this board."
              className="ml-auto inline-flex items-center gap-1 rounded-full bg-violet-600 px-2.5 py-1 font-medium text-white hover:bg-violet-500">
              <Icon icon="mdi:account-multiple" className="size-3.5" /> Demo: talk to yourself
            </button>
          )}
        </div>
      )}

      {/* honest trust model — unmissable when a room is active */}
      {encrypted && (
        <div className="border-b border-emerald-200 bg-emerald-50 px-4 py-2.5 text-[11px] leading-relaxed text-emerald-900 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-200">
          <p className="font-semibold">
            <Icon icon="mdi:shield-lock" className="inline size-3.5" /> End-to-end encrypted
            (XChaCha20-Poly1305). Outsiders can’t read this room and it’s unlinkable by name.
          </p>
          <p className="mt-1 text-emerald-800 dark:text-emerald-300/90">
            Shared key — any invite-holder can read and post · no forward secrecy · metadata is public.
          </p>
          <details className="group mt-1">
            <summary className="cursor-pointer list-none font-medium text-emerald-700 hover:underline dark:text-emerald-300">
              <Icon icon="mdi:chevron-right" className="inline size-3.5 transition group-open:rotate-90" />
              Details
            </summary>
            <p className="mt-1 text-emerald-800 dark:text-emerald-300/90">
              The <strong>shared key means any invite-holder can read AND post as any handle</strong>{' '}
              (no per-sender identity yet). There is <strong>no forward secrecy</strong> — a leaked
              invite exposes all past and future messages, so mint a new room to rotate. And{' '}
              <strong>metadata is public</strong>: the board still shows that a conversation is
              happening, when, how big, and its PoW stamps — encryption hides content, not activity.
              Outsiders can also <strong>replay old ciphertext</strong> (not read or alter it — just
              re-post a copy), so treat message timing as approximate. Keep your invite secret; lose
              it and the room is unrecoverable.
            </p>
          </details>
        </div>
      )}

      {/* feed */}
      <div
        ref={feedRef}
        className="flex h-80 flex-col-reverse gap-0.5 overflow-y-auto px-4 py-3 font-mono text-sm">
        {!publicMode && !encrypted ? (
          <div className="m-auto max-w-xs text-center text-gray-400">
            <Icon icon="mdi:lock-plus-outline" className="mx-auto mb-2 size-7 opacity-60" />
            <p className="text-sm">No room open.</p>
            <p className="mt-1 text-xs">
              Encrypted rooms are shared-key: <strong>create</strong> one and share the invite, or{' '}
              <strong>join</strong> with an invite someone sent you. The board only ever carries
              ciphertext.
            </p>
          </div>
        ) : messages.length === 0 ? (
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
        ) : (
          messages.map((m) => {
            const decoded =
              encrypted && roomKey
                ? decryptMessage(roomKey, category!, m.data as Hex)
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
          })
        )}
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
                : !publicMode && !encrypted
                  ? 'open a room to post'
                  : encrypted
                    ? `encrypted message to 🔒 ${activeRoom!.name}`
                    : `message #${channel}`
            }
            value={draft}
            disabled={!canPost || sending}
            onChange={(e) => setDraft(e.target.value)}
            aria-label="message"
          />
          <button
            type="submit"
            disabled={!canPost || sending || !draft.trim()}
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

// ═══════════════════════════════════════════════════════════════════════════════════════════
// DIRECT — per-recipient end-to-end encrypted DMs (dm-crypto.ts)
//
// A 4th privacy mode. Where Encrypted uses ONE shared room key, Direct uses PUBLIC-KEY encryption to
// named people: your DM address is an X25519 public key (your "contact card"), derived deterministic-
// ally from your local identity. You add other people's contact cards, pick who a conversation is
// with, and each message is sealed so ONLY those recipients (and you) can open it — with per-message
// forward secrecy (a fresh ephemeral key every send). The conversation lives in a category derived
// from the member pubkeys, so both sides converge on where to read/post. All crypto is in
// dm-crypto.ts; this pane is just wiring + honest trust copy.
// ═══════════════════════════════════════════════════════════════════════════════════════════

const DM_CONTACTS_KEY = 'msgboard.dm.contacts'
const DM_NAME_KEY = 'msgboard.dm.name'

/** The persisted shape of a contact (pubkey as base64url so it JSON-serialises). */
interface StoredContact {
  pubkey: string
  label?: string
}

const loadContacts = (): Contact[] => {
  try {
    const raw = localStorage.getItem(DM_CONTACTS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const out: Contact[] = []
    for (const c of parsed as StoredContact[]) {
      if (!c || typeof c.pubkey !== 'string') continue
      try {
        const pubkey = base64urlnopad.decode(c.pubkey)
        if (pubkey.length !== 32) continue
        out.push(typeof c.label === 'string' && c.label ? { pubkey, label: c.label } : { pubkey })
      } catch {
        /* skip a corrupt entry */
      }
    }
    return out
  } catch {
    return []
  }
}

const saveContacts = (contacts: Contact[]): void => {
  try {
    const stored: StoredContact[] = contacts.map((c) => ({
      pubkey: base64urlnopad.encode(c.pubkey),
      ...(c.label ? { label: c.label } : {}),
    }))
    localStorage.setItem(DM_CONTACTS_KEY, JSON.stringify(stored))
  } catch {
    /* localStorage may be unavailable */
  }
}

/** A short, human fingerprint of a pubkey — for chips/labels when no display name is set. */
const pubkeyShort = (pubkey: Uint8Array): string => toHex(pubkey).slice(2, 10)

function DirectPane({
  activeMode,
  onMode,
  workerFactory,
  onDemo,
}: {
  activeMode: Mode
  onMode: (m: Mode) => void
  workerFactory?: () => Worker
  onDemo?: () => void
}) {
  const chainId = useChainStore((s) => selectChain(s)?.id ?? 943)
  const transportUrl = useChainStore((s) => selectTransportUrl(s))
  const rpcValid = useChainStore((s) => selectRpcValid(s))
  const content = useChainStore((s) => s.content)
  const latestBlock = useChainStore((s) => s.latestBlockNumber)
  const workMultiplier = useChainStore((s) => s.globalWorkMultiplier)
  const workDivisor = useChainStore((s) => s.globalWorkDivisor)

  // Reuse the SAME local identity the Anonymous mode uses (zkchat:identity:v1) — a user with an
  // identity already has a DM address. deriveEncKeypair turns those Semaphore secrets into a stable
  // X25519 keypair (deterministic, so the contact card stays valid across sessions).
  const [identity] = useState<ZkIdentity>(() => loadOrCreateIdentity())
  const myKeypair = useMemo<EncKeypair>(() => deriveEncKeypair(identity), [identity])
  const [myName, setMyName] = useState(() => localStorage.getItem(DM_NAME_KEY) ?? '')
  useEffect(() => localStorage.setItem(DM_NAME_KEY, myName), [myName])

  const [contacts, setContacts] = useState<Contact[]>(() => loadContacts())
  useEffect(() => saveContacts(contacts), [contacts])
  // The selected conversation members, as pubkey-hex keys (order-independent; a Set).
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [copied, setCopied] = useState(false)
  const feedRef = useRef<HTMLDivElement>(null)

  const myContact = useMemo(
    () => encodeContact(myKeypair.publicKey, myName.trim() || undefined),
    [myKeypair, myName],
  )

  // Resolve the selected pubkey-hex keys back to their Contact bytes.
  const selectedContacts = useMemo(
    () => contacts.filter((c) => selected.has(toHex(c.pubkey))),
    [contacts, selected],
  )

  // The conversation category = dmCategory([me, ...them]). Null until at least one recipient is picked.
  const category = useMemo<Hex | null>(() => {
    if (selectedContacts.length === 0) return null
    return dmCategory([myKeypair.publicKey, ...selectedContacts.map((c) => c.pubkey)])
  }, [myKeypair, selectedContacts])

  const messages = useMemo(() => {
    if (!category) return []
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

  const canPost = rpcValid && !!category && !!board

  const copyMyCard = async () => {
    try {
      await navigator.clipboard.writeText(myContact)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      window.prompt('Copy your contact card:', myContact)
    }
  }

  const addContact = () => {
    const raw = window.prompt('Paste a contact card (msgboard-contact:v1:…):')?.trim()
    if (!raw) return
    const parsed = parseContact(raw)
    if (!parsed) {
      window.alert('That contact card is malformed — nothing added.')
      return
    }
    if (toHex(parsed.pubkey) === toHex(myKeypair.publicKey)) {
      window.alert('That is your own contact card.')
      return
    }
    setContacts((cs) => {
      const key = toHex(parsed.pubkey)
      if (cs.some((c) => toHex(c.pubkey) === key)) return cs // already known
      const label = parsed.label || window.prompt('Name this contact (local label):')?.trim() || undefined
      return [...cs, label ? { pubkey: parsed.pubkey, label } : { pubkey: parsed.pubkey }]
    })
    // Auto-select the just-added contact for a fresh 1:1 conversation.
    setSelected(new Set([toHex(parsed.pubkey)]))
  }

  const toggleContact = (pubkey: Uint8Array) => {
    const key = toHex(pubkey)
    setSelected((s) => {
      const next = new Set(s)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const removeContact = (pubkey: Uint8Array) => {
    const key = toHex(pubkey)
    setContacts((cs) => cs.filter((c) => toHex(c.pubkey) !== key))
    setSelected((s) => {
      const next = new Set(s)
      next.delete(key)
      return next
    })
  }

  const send = async () => {
    const text = draft.trim()
    if (!text || !board || sending || !category || selectedContacts.length === 0) return
    const data = sealMessage(
      myKeypair.privateKey,
      myKeypair.publicKey,
      selectedContacts.map((c) => c.pubkey),
      category,
      text,
      myName.trim() || undefined,
    )
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

  const blocksAgo = (bn: string): string => {
    if (latestBlock == null) return ''
    const d = Number(latestBlock - BigInt(bn))
    return d <= 0 ? 'now' : `${d} blk${d === 1 ? '' : 's'} ago`
  }

  const convoLabel =
    selectedContacts.length === 0
      ? null
      : selectedContacts.length === 1
        ? selectedContacts[0]!.label || `contact ${pubkeyShort(selectedContacts[0]!.pubkey)}`
        : `group of ${selectedContacts.length + 1}`

  return (
    <div className="flex w-full flex-col overflow-hidden rounded-lg bg-white shadow ring-1 ring-gray-200 dark:bg-gray-800 dark:ring-gray-700">
      <ModeBar active={activeMode} onChange={onMode} />

      {/* your contact card (your DM address) */}
      <div className="flex flex-wrap items-center gap-2 border-b border-gray-200 px-4 py-2.5 dark:border-gray-700">
        <Icon icon="mdi:email-lock" className="size-5 shrink-0 text-violet-600 dark:text-violet-400" />
        <span className="shrink-0 text-xs text-gray-400">your card</span>
        <code
          className="min-w-0 flex-1 truncate rounded bg-gray-100 px-2 py-1 font-mono text-[11px] text-gray-700 select-all dark:bg-gray-900 dark:text-gray-200"
          title={myContact}>
          {myContact}
        </code>
        <button
          type="button"
          onClick={() => void copyMyCard()}
          className="inline-flex shrink-0 items-center gap-1 rounded-md bg-violet-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-violet-500">
          <Icon icon={copied ? 'mdi:check' : 'mdi:content-copy'} className="size-3.5" />
          {copied ? 'copied' : 'copy'}
        </button>
      </div>

      {/* display name + contacts strip */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-gray-200 px-4 py-2 text-xs dark:border-gray-700">
        <span className="inline-flex items-center gap-1 text-gray-400">
          <Icon icon="mdi:account-multiple-outline" className="size-3.5" /> to
        </span>
        {contacts.length === 0 && (
          <span className="text-gray-400">no contacts yet — add one you were sent</span>
        )}
        {contacts.map((c) => {
          const key = toHex(c.pubkey)
          const on = selected.has(key)
          return (
            <span
              key={key}
              className={`group inline-flex items-center gap-1 rounded-full px-2.5 py-1 font-medium ${
                on
                  ? 'bg-violet-600 text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600'
              }`}>
              <button
                type="button"
                onClick={() => toggleContact(c.pubkey)}
                title={on ? 'in this conversation — click to remove' : `add ${c.label ?? key} to the conversation`}
                className="inline-flex items-center gap-1">
                <Icon icon={on ? 'mdi:check-circle' : 'mdi:circle-outline'} className="size-3" />
                <span className="max-w-[9rem] truncate">{c.label || `contact ${pubkeyShort(c.pubkey)}`}</span>
              </button>
              <button
                type="button"
                onClick={() => removeContact(c.pubkey)}
                title="forget this contact"
                className={`opacity-0 transition group-hover:opacity-100 ${on ? 'text-white/80 hover:text-white' : 'text-gray-400 hover:text-red-500'}`}>
                <Icon icon="mdi:close" className="size-3" />
              </button>
            </span>
          )
        })}
        <button
          type="button"
          onClick={addContact}
          className="inline-flex items-center gap-1 rounded-full border border-dashed border-gray-300 px-2.5 py-1 text-gray-500 hover:border-violet-500 hover:text-violet-600 dark:border-gray-600 dark:text-gray-400">
          <Icon icon="mdi:account-plus" className="size-3.5" /> add contact
        </button>
        <input
          className="ml-auto w-32 rounded-md bg-gray-50 px-2 py-0.5 text-xs text-gray-900 outline-1 -outline-offset-1 outline-gray-300 focus:-outline-offset-2 focus:outline-violet-600 dark:bg-gray-900 dark:text-gray-100 dark:outline-gray-600"
          placeholder="your display name"
          value={myName}
          maxLength={24}
          onChange={(e) => setMyName(e.target.value.slice(0, 24))}
          aria-label="your display name"
        />
        {onDemo && (
          <button
            type="button"
            onClick={onDemo}
            title="Watch two freshly-generated identities exchange real end-to-end encrypted DMs over this board."
            className="inline-flex items-center gap-1 rounded-full bg-violet-600 px-2.5 py-1 font-medium text-white hover:bg-violet-500">
            <Icon icon="mdi:account-multiple" className="size-3.5" /> Demo: talk to yourself
          </button>
        )}
      </div>

      {/* honest trust model — unmissable */}
      <div className="border-b border-violet-200 bg-violet-50 px-4 py-2.5 text-[11px] leading-relaxed text-violet-900 dark:border-violet-900/50 dark:bg-violet-950/40 dark:text-violet-200">
        <p className="font-semibold">
          <Icon icon="mdi:shield-lock" className="inline size-3.5" /> End-to-end encrypted to the
          named recipients (X25519 + XChaCha20-Poly1305). Each message uses a fresh ephemeral key, so
          compromising one message&apos;s transient keys doesn&apos;t expose the others.
        </p>
        <p className="mt-1 text-violet-800 dark:text-violet-300/90">
          Unverified senders · metadata is public · keys don&apos;t rotate.
        </p>
        <details className="group mt-1">
          <summary className="cursor-pointer list-none font-medium text-violet-700 hover:underline dark:text-violet-300">
            <Icon icon="mdi:chevron-right" className="inline size-3.5 transition group-open:rotate-90" />
            Details
          </summary>
          <p className="mt-1 text-violet-800 dark:text-violet-300/90">
            <strong>The sender is not authenticated</strong> — the name on a message is a self-typed
            label inside the ciphertext, and anyone who can address this conversation could send under
            any name. Treat identities as unverified. <strong>No full forward secrecy</strong>: your
            long-term DM key is derived from your local identity and never rotates, so if that
            identity secret is compromised, all your DMs — past and future — can be read (losing it
            also loses the messages). <strong>Metadata leaks</strong>: the board is public, so a
            conversation&apos;s existence in this derived category, timing, sizes, recipient count and
            PoW stamps are visible, and anyone who knows all participants&apos; pubkeys can locate the
            category (they still can&apos;t read it). <strong>Recipients are fixed at send</strong> —
            no group re-key or revocation yet.
          </p>
        </details>
      </div>

      {/* feed */}
      <div
        ref={feedRef}
        className="flex h-80 flex-col-reverse gap-0.5 overflow-y-auto px-4 py-3 font-mono text-sm">
        {!category ? (
          <div className="m-auto max-w-xs text-center text-gray-400">
            <Icon icon="mdi:email-lock-outline" className="mx-auto mb-2 size-7 opacity-60" />
            <p className="text-sm">No conversation selected.</p>
            <p className="mt-1 text-xs">
              Share <strong>your card</strong> above, <strong>add</strong> someone else's, then pick
              them to start a conversation. Only the people you pick can read what you send.
            </p>
          </div>
        ) : messages.length === 0 ? (
          <div className="m-auto max-w-xs text-center text-gray-400">
            <Icon icon="mdi:lock-outline" className="mx-auto mb-2 size-7 opacity-60" />
            <p className="text-sm">
              <span className="text-gray-500 dark:text-gray-300">{convoLabel}</span> is quiet.
            </p>
            <p className="mt-1 text-xs">
              The board keeps only the last ~120 blocks. Say something — it's sealed to{' '}
              {selectedContacts.length === 1 ? 'this recipient' : 'these recipients'} before the PoW
              stamp admits it.
            </p>
          </div>
        ) : (
          messages.map((m) => {
            const decoded = openMessage(myKeypair.privateKey, myKeypair.publicKey, category, m.data as Hex)
            if (isDmUndecryptable(decoded)) {
              const anon = anonHandle(m.hash as Hex)
              return (
                <div
                  key={m.hash}
                  className="flex items-baseline gap-2 rounded px-1 py-0.5 text-gray-400"
                  title="a sealed message you are not a recipient of (or from another conversation)">
                  <span className="inline-flex shrink-0 items-center gap-1 font-semibold text-gray-400">
                    <Icon icon="mdi:lock-alert" className="size-3.5" /> not for you
                  </span>
                  <span className="min-w-0 flex-1 truncate italic">{anon.name}</span>
                  <span className="shrink-0 text-[11px] text-gray-400" title={`${short(m.hash)} · block ${m.blockNumber}`}>
                    {blocksAgo(m.blockNumber)}
                  </span>
                </div>
              )
            }
            const { handle: h, text } = decoded
            // The handle is a self-asserted label inside the ciphertext — NOT an authenticated
            // sender (audit MEDIUM 2). Render it muted, not as a confident coloured identity, and
            // mark it unverified so a reader never mistakes it for a proven name.
            const who = h && h.length ? { name: h } : anonHandle(m.hash as Hex)
            return (
              <div key={m.hash} className="flex items-baseline gap-2 rounded px-1 py-0.5 hover:bg-gray-50 dark:hover:bg-gray-700/40">
                <span className="shrink-0 font-medium text-gray-500 dark:text-gray-400" title="unverified sender — a self-typed label inside the encrypted body, not a proven identity">
                  {who.name}
                  <span className="ml-0.5 text-[9px] font-normal text-gray-400" aria-hidden>~</span>
                </span>
                <span className="min-w-0 flex-1 break-words text-gray-800 dark:text-gray-100">{text}</span>
                <span className="shrink-0 text-[11px] text-gray-400" title={`${short(m.hash)} · block ${m.blockNumber}`}>
                  {blocksAgo(m.blockNumber)}
                </span>
              </div>
            )
          })
        )}
      </div>

      {/* composer */}
      <div className="border-t border-gray-200 dark:border-gray-700">
        <form
          className="flex items-center gap-2 px-4 py-2.5"
          onSubmit={(e) => {
            e.preventDefault()
            void send()
          }}>
          <input
            className="min-w-0 flex-1 rounded-md bg-gray-50 px-3 py-2 text-sm text-gray-900 outline-1 -outline-offset-1 outline-gray-300 focus:-outline-offset-2 focus:outline-violet-600 disabled:opacity-60 dark:bg-gray-900 dark:text-gray-100 dark:outline-gray-600"
            placeholder={
              !rpcValid
                ? 'point at a board-serving RPC to post'
                : !category
                  ? 'pick a contact to message'
                  : `encrypted message to ${convoLabel}`
            }
            value={draft}
            disabled={!canPost || sending}
            onChange={(e) => setDraft(e.target.value)}
            aria-label="message"
          />
          <button
            type="submit"
            disabled={!canPost || sending || !draft.trim()}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-violet-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-50">
            {sending ? (
              <>
                <Icon icon="mdi:pickaxe" className="size-4 animate-pulse" /> grinding…
              </>
            ) : (
              <>
                <Icon icon="mdi:send-lock" className="size-4" /> seal &amp; send
              </>
            )}
          </button>
        </form>
        <p className="px-4 pb-2.5 text-[11px] text-gray-400">
          Each message is sealed to {selectedContacts.length <= 1 ? 'your recipient' : 'your recipients'} (and to
          you, so you keep a readable copy) with a fresh ephemeral key, then stamped with ~a second of
          PoW off this thread. The board only ever sees ciphertext.
        </p>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// STEALTH — on-chain private messaging to a HIDDEN recipient (StealthMessenger.sol, ERC-5564/6538)
//
// The odd one out among the modes: this does NOT ride the ephemeral PoW board. It talks to a real
// deployed contract on chain 943, so it needs a wallet (to register, to sign each message, to pay
// gas) and it persists — messages live on-chain, not in a ~120-block window. What it BUYS over the
// other modes is the pair the contract guarantees: the SENDER is cryptographically proven (an
// EIP-712 signature the contract recovers → the emitted `sender` topic), while the RECIPIENT is
// hidden from everyone but themselves (a one-time stealth address only they can recognise, by
// scanning MessageSent logs with their private viewing key + the 1-byte view tag).
//
// Identity is derived DETERMINISTICALLY from a wallet signature (deriveStealthMetaAddressFromSeed),
// so the same spending+viewing keys come back on any device by re-signing. All crypto is in
// ../lib/stealth; all chain wiring (inlined ABI, dedicated 943 read client, wallet writes, the
// log scan) is in ../lib/stealth-messenger. This pane is wiring + honest trust copy.
// ═══════════════════════════════════════════════════════════════════════════════════════════

/** A detected, decrypted inbox message — deduped on content hash, with a PROVEN sender. */
interface StealthInboxItem {
  id: Hex
  sender: Address
  text: string
  blockNumber: bigint
  txHash: Hex
}

/** Short 0x… form for addresses / hashes. */
const shortHex = (h: string) => `${h.slice(0, 6)}…${h.slice(-4)}`

type RegState = 'idle' | 'signing' | 'pending' | 'done' | 'err'
type SendState = 'idle' | 'deriving' | 'pending' | 'done' | 'err'
type LookupState =
  | { status: 'idle' | 'looking' | 'invalid' | 'unregistered' }
  | { status: 'found'; meta: Uint8Array }

function StealthPane({ activeMode, onMode }: { activeMode: Mode; onMode: (m: Mode) => void }) {
  const walletAvailable = useMemo(() => hasInjectedWallet(), [])
  const client = useMemo(() => sm.stealthPublicClient(), [])

  // Wallet-derived stealth identity — kept in memory only (never persisted): the wallet IS the
  // backup, re-signing restores the exact same keys. null until the user connects + signs.
  const [identity, setIdentity] = useState<sm.StealthIdentity | null>(null)
  const [deriving, setDeriving] = useState(false)
  const [deriveError, setDeriveError] = useState<string | null>(null)

  // On-chain registration status for this identity's address.
  const [registeredMeta, setRegisteredMeta] = useState<Uint8Array | null | undefined>(undefined)
  const [regState, setRegState] = useState<RegState>('idle')
  const [regError, setRegError] = useState<string | null>(null)

  // Compose: recipient EOA + its looked-up meta-address, and the body.
  const [recipient, setRecipient] = useState('')
  const [lookup, setLookup] = useState<LookupState>({ status: 'idle' })
  const [body, setBody] = useState('')
  const [sendState, setSendState] = useState<SendState>('idle')
  const [sendError, setSendError] = useState<string | null>(null)
  const [sendTx, setSendTx] = useState<Hex | null>(null)

  // Inbox scan.
  const [inbox, setInbox] = useState<StealthInboxItem[]>([])
  const [scanning, setScanning] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)
  const [scannedOnce, setScannedOnce] = useState(false)

  const myMetaHex = identity ? toHex(identity.meta.metaAddress) : null
  const registered =
    registeredMeta != null && myMetaHex != null && toHex(registeredMeta) === myMetaHex
  const registeredDifferent = registeredMeta != null && myMetaHex != null && !registered

  // ── derive identity from wallet ──────────────────────────────────────────────────────
  const deriveIdentity = async () => {
    setDeriving(true)
    setDeriveError(null)
    try {
      const id = await sm.deriveStealthIdentityFromWallet()
      setIdentity(id)
      setRegisteredMeta(undefined)
      void refreshRegistration(id.address)
    } catch (err) {
      setDeriveError(err instanceof Error ? err.message : 'Could not derive from wallet.')
    } finally {
      setDeriving(false)
    }
  }

  const refreshRegistration = async (address: Address) => {
    try {
      setRegisteredMeta(await sm.readRegisteredMeta(client, address))
    } catch {
      setRegisteredMeta(null)
    }
  }

  // ── register on-chain ────────────────────────────────────────────────────────────────
  const register = async () => {
    if (!identity) return
    setRegState('signing')
    setRegError(null)
    try {
      const hash = await sm.registerOnChain(identity.address, identity.meta.metaAddress)
      setRegState('pending')
      await client.waitForTransactionReceipt({ hash })
      await refreshRegistration(identity.address)
      setRegState('done')
      setTimeout(() => setRegState('idle'), 2500)
    } catch (err) {
      setRegError(err instanceof Error ? err.message : 'Registration failed.')
      setRegState('err')
    }
  }

  // ── recipient lookup (debounced on the input) ──────────────────────────────────────────
  useEffect(() => {
    const addr = recipient.trim()
    if (!addr) {
      setLookup({ status: 'idle' })
      return
    }
    if (!sm.isAddress(addr)) {
      setLookup({ status: 'invalid' })
      return
    }
    let alive = true
    setLookup({ status: 'looking' })
    const t = setTimeout(async () => {
      try {
        const meta = await sm.readRegisteredMeta(client, getAddress(addr))
        if (!alive) return
        setLookup(meta ? { status: 'found', meta } : { status: 'unregistered' })
      } catch {
        if (alive) setLookup({ status: 'unregistered' })
      }
    }, 350)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [recipient, client])

  // ── send ───────────────────────────────────────────────────────────────────────────────
  const send = async () => {
    const text = body.trim()
    if (!identity || !text || lookup.status !== 'found') return
    setSendState('deriving')
    setSendError(null)
    setSendTx(null)
    try {
      const { txHash } = await sm.sendStealthMessage(identity.address, lookup.meta, text)
      setSendState('pending')
      setSendTx(txHash)
      await client.waitForTransactionReceipt({ hash: txHash })
      setBody('')
      setSendState('done')
      setTimeout(() => setSendState('idle'), 2500)
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Send failed.')
      setSendState('err')
    }
  }

  // ── inbox scan ──────────────────────────────────────────────────────────────────────────
  const scan = useMemo(
    () => async (id: sm.StealthIdentity) => {
      setScanning(true)
      setScanError(null)
      try {
        const announcements = await sm.fetchAnnouncements(client)
        const scanKeys = { spendingPubKey: id.meta.spendingPubKey, viewingPrivKey: id.meta.viewingPrivKey }
        const seen = new Set<string>()
        const found: StealthInboxItem[] = []
        for (const a of announcements) {
          const contentId = sm.announcementContentHash(a.ephemeralPubKey, a.ciphertext)
          if (seen.has(contentId)) continue // client-side dedup (no on-chain dedup exists)
          const hit = checkAnnouncement(
            {
              stealthAddress: hexToBytes(a.stealthAddress),
              ephemeralPubKey: hexToBytes(a.ephemeralPubKey),
              viewTag: sm.viewTagByte(a.viewTag),
            },
            scanKeys,
          )
          if (!hit) continue
          seen.add(contentId)
          try {
            const plaintext = decryptStealthMessage(hit.sharedSecret, hexToBytes(a.ciphertext))
            found.push({
              id: contentId,
              sender: a.sender,
              text: new TextDecoder().decode(plaintext),
              blockNumber: a.blockNumber,
              txHash: a.txHash,
            })
          } catch {
            /* a detected message that won't decrypt — skip (tampered / not really ours) */
          }
        }
        found.sort((x, y) => Number(y.blockNumber - x.blockNumber))
        setInbox(found)
      } catch (err) {
        setScanError(err instanceof Error ? err.message : 'Scan failed.')
      } finally {
        setScanning(false)
        setScannedOnce(true)
      }
    },
    [client],
  )

  // Auto-scan once on identity, then poll every 20s while the pane is open.
  useEffect(() => {
    if (!identity) return
    void scan(identity)
    const iv = setInterval(() => void scan(identity), 20_000)
    return () => clearInterval(iv)
  }, [identity, scan])

  const canSend = !!identity && lookup.status === 'found' && !!body.trim() && sendState !== 'deriving' && sendState !== 'pending'

  return (
    <div className="flex w-full flex-col overflow-hidden rounded-lg bg-white shadow ring-1 ring-gray-200 dark:bg-gray-800 dark:ring-gray-700">
      <ModeBar active={activeMode} onChange={onMode} />

      {/* header */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-gray-200 px-4 py-2.5 dark:border-gray-700">
        <Icon icon="mdi:incognito-circle" className="size-5 shrink-0 text-teal-600 dark:text-teal-400" />
        <span className="font-mono text-base font-semibold">Stealth</span>
        <span className="rounded-full bg-teal-100 px-2 py-0.5 text-xs font-medium text-teal-800 dark:bg-teal-900/50 dark:text-teal-300">
          on-chain · hidden recipient
        </span>
        <span className="ml-auto hidden shrink-0 text-xs text-gray-400 sm:inline">chain 943</span>
      </div>

      {/* honest trust model */}
      <div className="border-b border-teal-200 bg-teal-50 px-4 py-2.5 text-[11px] leading-relaxed text-teal-900 dark:border-teal-900/50 dark:bg-teal-950/40 dark:text-teal-200">
        <p className="font-semibold">
          <Icon icon="mdi:shield-account" className="inline size-3.5" /> Sender proven, recipient
          hidden. The contract recovers your signature, so the on-chain <strong>sender is
          authenticated & public</strong>; the <strong>recipient is hidden</strong> from everyone but
          themselves.
        </p>
        <p className="mt-1 text-teal-800 dark:text-teal-300/90">
          Metadata (timing / size / your address) is public · no forward secrecy.
        </p>
        <details className="group mt-1">
          <summary className="cursor-pointer list-none font-medium text-teal-700 hover:underline dark:text-teal-300">
            <Icon icon="mdi:chevron-right" className="inline size-3.5 transition group-open:rotate-90" />
            Details
          </summary>
          <p className="mt-1 text-teal-800 dark:text-teal-300/90">
            Each message rides a fresh one-time <strong>stealth address</strong> derived (ERC-5564)
            from the recipient&apos;s published meta-address; only they can link it back to
            themselves, by scanning logs with their private viewing key. The body is encrypted under
            the ERC-5564 shared secret. But <strong>the traffic is not hidden</strong>: that a message
            exists, its size, its timing, and <strong>your (sender) address</strong> are all on-chain.
            There is <strong>no forward secrecy</strong> — your stealth keys are derived from one
            wallet signature and never rotate, so compromising it exposes past and future messages.
            The contract keeps <strong>no on-chain dedup</strong>, so this client dedups received
            messages on their content hash.
          </p>
        </details>
      </div>

      {/* IDENTITY / REGISTER */}
      <div className="border-b border-gray-200 px-4 py-3 dark:border-gray-700">
        {!walletAvailable ? (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800/60 dark:bg-amber-900/20 dark:text-amber-300">
            No injected wallet found. Stealth messaging needs a wallet to register, sign, and send on
            chain 943 — install one to use this mode.
          </div>
        ) : !identity ? (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void deriveIdentity()}
                disabled={deriving}
                className="inline-flex items-center gap-1.5 rounded-md bg-teal-600 px-3 py-2 text-sm font-medium text-white hover:bg-teal-500 disabled:opacity-50">
                <Icon icon="mdi:wallet-outline" className="size-4" />
                {deriving ? 'sign in wallet…' : 'Derive stealth identity'}
              </button>
              <span className="text-[11px] text-gray-500 dark:text-gray-400">
                Sign a fixed message to derive your spending + viewing keys — recoverable on any
                device by re-signing. The signature never leaves this browser.
              </span>
            </div>
            {deriveError && <p className="text-[11px] text-red-600 dark:text-red-400">{deriveError}</p>}
          </div>
        ) : (
          <div className="flex flex-col gap-2 text-xs">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="text-gray-400">you are</span>
              <code
                className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[11px] text-gray-700 dark:bg-gray-900 dark:text-gray-200"
                title={identity.address}>
                {shortHex(identity.address)}
              </code>
              {registered ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-300">
                  <Icon icon="mdi:check-decagram" className="size-3.5" /> registered — others can message you
                </span>
              ) : registeredDifferent ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:bg-amber-900/50 dark:text-amber-300">
                  <Icon icon="mdi:alert" className="size-3.5" /> a different meta-address is registered — re-register to update
                </span>
              ) : registeredMeta === undefined ? (
                <span className="text-[11px] text-gray-400">checking registration…</span>
              ) : (
                <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-600 dark:bg-gray-700 dark:text-gray-300">
                  <Icon icon="mdi:cloud-off-outline" className="size-3.5" /> not registered — others can&apos;t message you yet
                </span>
              )}
            </div>
            <div className="flex items-start gap-2">
              <span className="mt-1 shrink-0 text-gray-400">meta</span>
              <code className="min-w-0 flex-1 break-all rounded bg-gray-100 px-2 py-1 font-mono text-[10px] text-gray-600 select-all dark:bg-gray-900 dark:text-gray-300" title="your stealth meta-address (spendingPub ‖ viewingPub)">
                {myMetaHex}
              </code>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {!registered && (
                <button
                  type="button"
                  onClick={() => void register()}
                  disabled={regState === 'signing' || regState === 'pending'}
                  className="inline-flex items-center gap-1.5 rounded-md bg-teal-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-teal-500 disabled:opacity-50">
                  <Icon icon="mdi:cloud-upload-outline" className="size-3.5" />
                  {regState === 'signing'
                    ? 'confirm in wallet…'
                    : regState === 'pending'
                      ? 'registering…'
                      : registeredDifferent
                        ? 'Re-register on-chain'
                        : 'Register on-chain'}
                </button>
              )}
              <button
                type="button"
                onClick={() => identity && void refreshRegistration(identity.address)}
                className="text-[11px] text-gray-400 underline decoration-dotted hover:text-gray-600 dark:hover:text-gray-200">
                refresh status
              </button>
              {regState === 'done' && (
                <span className="text-[11px] text-emerald-600 dark:text-emerald-400">registered ✓</span>
              )}
            </div>
            {regError && <p className="text-[11px] text-red-600 dark:text-red-400">{regError}</p>}
          </div>
        )}
      </div>

      {/* SEND */}
      {identity && (
        <div className="border-b border-gray-200 px-4 py-3 dark:border-gray-700">
          <div className="mb-2 flex items-center gap-2 text-xs text-gray-400">
            <Icon icon="mdi:send-lock-outline" className="size-3.5" /> send a stealth message
          </div>
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <input
                className="min-w-0 flex-1 rounded-md bg-gray-50 px-2.5 py-1.5 font-mono text-xs text-gray-900 outline-1 -outline-offset-1 outline-gray-300 focus:-outline-offset-2 focus:outline-teal-600 dark:bg-gray-900 dark:text-gray-100 dark:outline-gray-600"
                placeholder="recipient address (0x…)"
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
                aria-label="recipient address"
              />
              {lookup.status === 'looking' && <span className="text-[11px] text-gray-400">looking up…</span>}
              {lookup.status === 'found' && (
                <span className="inline-flex items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400">
                  <Icon icon="mdi:check" className="size-3.5" /> registered
                </span>
              )}
              {lookup.status === 'invalid' && recipient.trim() && (
                <span className="text-[11px] text-red-500">not a valid address</span>
              )}
              {lookup.status === 'unregistered' && (
                <span className="text-[11px] text-amber-600 dark:text-amber-400">
                  this address hasn&apos;t registered a stealth meta-address — you can&apos;t message it
                </span>
              )}
            </div>
            <form
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                void send()
              }}>
              <input
                className="min-w-0 flex-1 rounded-md bg-gray-50 px-3 py-2 text-sm text-gray-900 outline-1 -outline-offset-1 outline-gray-300 focus:-outline-offset-2 focus:outline-teal-600 disabled:opacity-60 dark:bg-gray-900 dark:text-gray-100 dark:outline-gray-600"
                placeholder={lookup.status === 'found' ? 'message (encrypted to the recipient)' : 'enter a registered recipient first'}
                value={body}
                disabled={lookup.status !== 'found' || sendState === 'deriving' || sendState === 'pending'}
                onChange={(e) => setBody(e.target.value)}
                aria-label="stealth message"
              />
              <button
                type="submit"
                disabled={!canSend}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-teal-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-teal-500 disabled:opacity-50">
                {sendState === 'deriving' ? (
                  <>
                    <Icon icon="mdi:pen" className="size-4 animate-pulse" /> sign…
                  </>
                ) : sendState === 'pending' ? (
                  <>
                    <Icon icon="mdi:loading" className="size-4 animate-spin" /> sending…
                  </>
                ) : (
                  <>
                    <Icon icon="mdi:send-lock" className="size-4" /> send
                  </>
                )}
              </button>
            </form>
            {sendState === 'done' && (
              <p className="text-[11px] text-emerald-600 dark:text-emerald-400">
                sent ✓ {sendTx && <span className="font-mono">{shortHex(sendTx)}</span>}
              </p>
            )}
            {sendState === 'err' && sendError && (
              <p className="text-[11px] text-red-600 dark:text-red-400">{sendError}</p>
            )}
            <p className="text-[11px] leading-snug text-gray-400">
              You sign an EIP-712 digest binding this exact message to your key + this chain/contract,
              then submit it. The recipient stays hidden; your address is proven and public.
            </p>
          </div>
        </div>
      )}

      {/* INBOX */}
      {identity && (
        <div className="flex flex-col">
          <div className="flex items-center gap-2 border-b border-gray-200 px-4 py-2 text-xs dark:border-gray-700">
            <Icon icon="mdi:inbox-arrow-down" className="size-4 text-teal-600 dark:text-teal-400" />
            <span className="font-semibold text-gray-700 dark:text-gray-200">Inbox</span>
            <span className="text-gray-400">{inbox.length} for you</span>
            <button
              type="button"
              onClick={() => identity && void scan(identity)}
              disabled={scanning}
              className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-teal-700 hover:bg-teal-50 disabled:opacity-50 dark:text-teal-300 dark:hover:bg-teal-900/30">
              <Icon icon={scanning ? 'mdi:loading' : 'mdi:refresh'} className={`size-3.5 ${scanning ? 'animate-spin' : ''}`} />
              {scanning ? 'scanning…' : 'refresh'}
            </button>
          </div>
          <div className="flex h-72 flex-col gap-1.5 overflow-y-auto px-4 py-3 font-mono text-sm">
            {scanError ? (
              <div className="m-auto max-w-xs text-center text-[11px] text-red-500">{scanError}</div>
            ) : inbox.length === 0 ? (
              <div className="m-auto max-w-xs text-center text-gray-400">
                <Icon icon="mdi:inbox-outline" className="mx-auto mb-2 size-7 opacity-60" />
                <p className="text-sm">{scannedOnce ? 'No messages for you yet.' : 'Scanning the chain…'}</p>
                <p className="mt-1 text-xs">
                  Register your meta-address and share your address so others can send you a stealth
                  message. Only you can tell which on-chain messages are yours.
                </p>
              </div>
            ) : (
              inbox.map((m) => (
                <div
                  key={m.id}
                  className="flex items-baseline gap-2 rounded px-1 py-0.5 hover:bg-gray-50 dark:hover:bg-gray-700/40">
                  <span
                    className="inline-flex shrink-0 items-center gap-1 font-semibold text-teal-700 dark:text-teal-300"
                    title={`proven sender ${m.sender}`}>
                    <Icon icon="mdi:check-decagram" className="size-3.5" />
                    {shortHex(m.sender)}
                  </span>
                  <span className="min-w-0 flex-1 break-words text-gray-800 dark:text-gray-100">{m.text}</span>
                  <span
                    className="shrink-0 text-[11px] text-gray-400"
                    title={`block ${m.blockNumber} · tx ${m.txHash}`}>
                    #{m.blockNumber.toString()}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// TWO-USER DEMO — "talk to yourself" over the REAL board
//
// Instantiates TWO genuinely independent participants (Alice + Bob), each with its own freshly
// generated in-memory identity + enc keypair — NOT shared localStorage, so they are two different
// users. Both are wired to the same conversation: for `encrypted`, a shared room key; for `direct`,
// each is the other's recipient (category from both pubkeys). You send from one composer; the crypto
// runs for real, the ciphertext is posted to the board, and it appears DECRYPTED in the other pane.
// No faking: real keys, real board posts, real decrypt. "Close demo" returns to the single-user view.
// ═══════════════════════════════════════════════════════════════════════════════════════════

/** One demo participant's fixed, in-memory crypto material (regenerated per demo, never persisted). */
interface DemoParticipant {
  name: string
  identity: ZkIdentity
  keypair: EncKeypair
}

function TwoUserDemo({
  kind,
  onClose,
  workerFactory,
}: {
  kind: 'encrypted' | 'direct'
  onClose: () => void
  workerFactory?: () => Worker
}) {
  const chainId = useChainStore((s) => selectChain(s)?.id ?? 943)
  const transportUrl = useChainStore((s) => selectTransportUrl(s))
  const rpcValid = useChainStore((s) => selectRpcValid(s))
  const content = useChainStore((s) => s.content)
  const latestBlock = useChainStore((s) => s.latestBlockNumber)
  const workMultiplier = useChainStore((s) => s.globalWorkMultiplier)
  const workDivisor = useChainStore((s) => s.globalWorkDivisor)

  // Two isolated participants + (for encrypted) a shared room key — generated ONCE per demo mount.
  // useRef so a re-render never regenerates keys mid-conversation.
  const setup = useRef<{
    alice: DemoParticipant
    bob: DemoParticipant
    roomKey: Uint8Array
    category: Hex
  }>()
  if (!setup.current) {
    const mk = (name: string): DemoParticipant => {
      const identity = randomIdentity()
      return { name, identity, keypair: deriveEncKeypair(identity) }
    }
    const alice = mk('Alice')
    const bob = mk('Bob')
    const roomKey = mintRoomKey()
    const category =
      kind === 'encrypted'
        ? deriveCategory(roomKey)
        : dmCategory([alice.keypair.publicKey, bob.keypair.publicKey])
    setup.current = { alice, bob, roomKey, category }
  }
  const { alice, bob, roomKey, category } = setup.current

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

  const messages = useMemo(() => {
    const list = (content?.[category] as RPCMessage[] | undefined) ?? []
    return [...list].sort(byBlockDesc)
  }, [content, category])

  // Seal a message AS a participant (real crypto for the chosen path).
  const sealAs = (from: DemoParticipant, to: DemoParticipant, text: string): Hex =>
    kind === 'encrypted'
      ? encryptMessage(roomKey, category, text, from.name)
      : sealMessage(from.keypair.privateKey, from.keypair.publicKey, [to.keypair.publicKey], category, text, from.name)

  // Open a message AS a participant (their own key). Both parties can read every message in the demo.
  const openAs = (who: DemoParticipant, dataHex: Hex): { handle?: string; text: string } | { undecryptable: true } =>
    kind === 'encrypted'
      ? decryptMessage(roomKey, category, dataHex)
      : openMessage(who.keypair.privateKey, who.keypair.publicKey, category, dataHex)

  const [sendingFrom, setSendingFrom] = useState<string | null>(null)

  // "Copy link" — this demo is the thing people most want to share ("talk to yourself"), and the URL
  // already carries ?demo=… (written by Chat), so the current href lands a visitor right back here.
  const [copied, setCopied] = useState(false)
  const copyLink = async () => {
    const url = currentShareUrl()
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      window.prompt('Copy this link:', url)
    }
  }

  const post = async (from: DemoParticipant, to: DemoParticipant, text: string) => {
    if (!board || !text.trim() || sendingFrom) return
    setSendingFrom(from.name)
    try {
      await board.addMessage({ category, data: sealAs(from, to, text.trim()) })
      await new Promise((r) => setTimeout(r, 1000))
      await useChainStore.getState().loadContent()
    } catch (err) {
      if (err) console.error(err)
    } finally {
      setSendingFrom(null)
    }
  }

  const blocksAgo = (bn: string): string => {
    if (latestBlock == null) return ''
    const d = Number(latestBlock - BigInt(bn))
    return d <= 0 ? 'now' : `${d} blk${d === 1 ? '' : 's'} ago`
  }

  return (
    <div className="flex w-full flex-col overflow-hidden rounded-lg bg-white shadow ring-1 ring-gray-200 dark:bg-gray-800 dark:ring-gray-700">
      {/* demo header */}
      <div className="flex flex-wrap items-center gap-2 border-b border-violet-200 bg-violet-50 px-4 py-2.5 dark:border-violet-900/50 dark:bg-violet-950/40">
        <Icon icon="mdi:account-multiple" className="size-5 shrink-0 text-violet-600 dark:text-violet-400" />
        <span className="font-semibold text-violet-900 dark:text-violet-100">
          Demo: talk to yourself — {kind === 'encrypted' ? 'shared-key room' : 'per-recipient DM'}
        </span>
        <span className="min-w-0 flex-1 text-[11px] text-violet-800 dark:text-violet-300/90">
          Two independent identities exchanging <strong>real</strong> end-to-end encrypted messages
          over this board. Send from either side; watch it decrypt on the other.
        </span>
        <button
          type="button"
          onClick={() => void copyLink()}
          title="Copy a link that reopens this demo"
          className="inline-flex shrink-0 items-center gap-1 rounded-md bg-white px-2.5 py-1 text-xs font-medium text-violet-700 ring-1 ring-violet-300 hover:bg-violet-100 dark:bg-gray-800 dark:text-violet-200 dark:ring-violet-800 dark:hover:bg-gray-700">
          <Icon icon={copied ? 'mdi:check' : 'mdi:link-variant'} className="size-3.5" /> {copied ? 'copied' : 'copy link'}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex shrink-0 items-center gap-1 rounded-md bg-white px-2.5 py-1 text-xs font-medium text-violet-700 ring-1 ring-violet-300 hover:bg-violet-100 dark:bg-gray-800 dark:text-violet-200 dark:ring-violet-800 dark:hover:bg-gray-700">
          <Icon icon="mdi:close" className="size-3.5" /> close demo
        </button>
      </div>

      {!rpcValid && (
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800 dark:border-amber-800/60 dark:bg-amber-900/20 dark:text-amber-300">
          Point at a board-serving RPC to run the demo — the exchange posts real messages to the board.
        </div>
      )}

      {/* two panes side by side */}
      <div className="grid grid-cols-1 sm:grid-cols-2">
        {[
          { self: alice, other: bob },
          { self: bob, other: alice },
        ].map(({ self, other }, i) => (
          <DemoPane
            key={self.name}
            self={self}
            other={other}
            messages={messages}
            openAs={openAs}
            onSend={(text) => void post(self, other, text)}
            sending={sendingFrom === self.name}
            disabled={!rpcValid || !board || sendingFrom != null}
            blocksAgo={blocksAgo}
            className={i === 0 ? 'sm:border-r border-gray-200 dark:border-gray-700' : ''}
          />
        ))}
      </div>
    </div>
  )
}

/** One side of the two-user demo: that participant's view of the shared conversation + a composer. */
function DemoPane({
  self,
  other,
  messages,
  openAs,
  onSend,
  sending,
  disabled,
  blocksAgo,
  className,
}: {
  self: DemoParticipant
  other: DemoParticipant
  messages: RPCMessage[]
  openAs: (who: DemoParticipant, dataHex: Hex) => { handle?: string; text: string } | { undecryptable: true }
  onSend: (text: string) => void
  sending: boolean
  disabled: boolean
  blocksAgo: (bn: string) => string
  className?: string
}) {
  const [draft, setDraft] = useState('')
  const feedRef = useRef<HTMLDivElement>(null)
  const submit = () => {
    if (!draft.trim() || disabled) return
    onSend(draft)
    setDraft('')
  }
  return (
    <section className={`flex min-w-0 flex-col ${className ?? ''}`} aria-label={`${self.name} pane`}>
      <div className="flex items-center gap-2 border-b border-gray-200 bg-gray-50 px-3 py-2 dark:border-gray-700 dark:bg-gray-900/50">
        <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-violet-600 text-xs font-bold text-white">
          {self.name[0]}
        </span>
        <span className="font-semibold text-gray-800 dark:text-gray-100">{self.name}</span>
        <code
          className="ml-auto truncate font-mono text-[10px] text-gray-400"
          title={`X25519 pubkey ${toHex(self.keypair.publicKey)}`}>
          {pubkeyShort(self.keypair.publicKey)}
        </code>
      </div>

      <div
        ref={feedRef}
        className="flex h-72 flex-col-reverse gap-0.5 overflow-y-auto px-3 py-3 font-mono text-sm">
        {messages.length === 0 ? (
          <div className="m-auto max-w-[14rem] text-center text-xs text-gray-400">
            Nothing yet. Send from either side — the ciphertext hits the board, then decrypts here.
          </div>
        ) : (
          messages.map((m) => {
            const decoded = openAs(self, m.data as Hex)
            const mine = !isDmUndecryptable(decoded) && decoded.handle === self.name
            if (isDmUndecryptable(decoded)) {
              return (
                <div key={m.hash} className="flex items-baseline gap-2 rounded px-1 py-0.5 text-gray-400" title="not addressed to this participant">
                  <span className="inline-flex shrink-0 items-center gap-1 font-semibold">
                    <Icon icon="mdi:lock-alert" className="size-3.5" /> can’t open
                  </span>
                  <span className="shrink-0 text-[11px]">{blocksAgo(m.blockNumber)}</span>
                </div>
              )
            }
            return (
              <div
                key={m.hash}
                className={`flex items-baseline gap-2 rounded px-1 py-0.5 ${mine ? 'flex-row-reverse text-right' : ''}`}>
                <span className={`shrink-0 font-semibold ${mine ? 'text-violet-600 dark:text-violet-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                  {decoded.handle || other.name}
                </span>
                <span className="min-w-0 flex-1 break-words text-gray-800 dark:text-gray-100">{decoded.text}</span>
                <span className="shrink-0 text-[11px] text-gray-400" title={`block ${m.blockNumber}`}>
                  {blocksAgo(m.blockNumber)}
                </span>
              </div>
            )
          })
        )}
      </div>

      <form
        className="flex items-center gap-2 border-t border-gray-200 px-3 py-2.5 dark:border-gray-700"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}>
        <input
          className="min-w-0 flex-1 rounded-md bg-gray-50 px-3 py-2 text-sm text-gray-900 outline-1 -outline-offset-1 outline-gray-300 focus:-outline-offset-2 focus:outline-violet-600 disabled:opacity-60 dark:bg-gray-900 dark:text-gray-100 dark:outline-gray-600"
          placeholder={`message as ${self.name}…`}
          value={draft}
          disabled={disabled}
          onChange={(e) => setDraft(e.target.value)}
          aria-label={`message as ${self.name}`}
        />
        <button
          type="submit"
          disabled={disabled || !draft.trim()}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-violet-600 px-3 py-2 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-50">
          {sending ? <Icon icon="mdi:pickaxe" className="size-4 animate-pulse" /> : <Icon icon="mdi:send-lock" className="size-4" />}
        </button>
      </form>
    </section>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// ANONYMOUS — absorbed from Whisper.tsx (verbatim behaviour + the new wallet-derived identity)
//
// An anonymous room over the board where you prove you belong to a group WITHOUT revealing which
// member you are (Semaphore-style), so messages are unlinkable to a wallet. The on-wire channel
// category + proof envelope are UNCHANGED, so posts stay byte-for-byte compatible with the existing
// zk-msgboard watcher/archive. ANONYMOUS, NOT ENCRYPTED: message text is PUBLIC (see the Inspector).
// The full Groth16 membership proof + verification run for real in a Web Worker via seams/zk-prover.
// ═══════════════════════════════════════════════════════════════════════════════════════════

/** Display name for the room. */
const ROOM = 'Whisper'
/** The fixed ZK group channel — UNCHANGED on-wire (scope + bytes32 category). */
const CHANNEL = 'zkchat'
const CHANNEL_CATEGORY = stringToHex(CHANNEL, { size: 32 }) as Hex

type VerifyStatus = 'verifying' | 'verified' | 'invalid' | 'unrecognized' | 'unavailable'

/** A decoded feed row: a board message, its ZkPost (if it decoded), and its verify status. */
type FeedRow = {
  hash: string
  blockNumber: bigint
  post: ZkPost | null
  status: VerifyStatus
  replay: boolean
}

type AnonProps = {
  /** The active Chat privacy mode + its setter — drives the in-card ModeBar toggle. */
  activeMode: Mode
  onMode: (m: Mode) => void
  /** Injectable PoW worker factory (headless tests supply a fake). Prod omits it. */
  workerFactory?: () => Worker
  /** Injectable ZK worker factory (headless tests supply a fake). Prod omits it. */
  zkWorkerFactory?: () => Worker
}

function AnonymousRoom({ activeMode, onMode, workerFactory, zkWorkerFactory }: AnonProps) {
  const transportUrl = useChainStore((s) => selectTransportUrl(s))
  const chainId = useChainStore((s) => selectChain(s)?.id ?? 0)
  const rpcValid = useChainStore((s) => selectRpcValid(s))
  const content = useChainStore((s) => s.content)
  const latestBlockNumber = useChainStore((s) => s.latestBlockNumber)
  const globalWorkMultiplier = useChainStore((s) => s.globalWorkMultiplier)
  const globalWorkDivisor = useChainStore((s) => s.globalWorkDivisor)

  const [identity, setIdentity] = useState<ZkIdentity>(() => loadOrCreateIdentity())
  const [text, setText] = useState('')
  const [status, setStatus] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  const [proverReady, setProverReady] = useState<boolean | null>(null) // null = probing
  const [view, setView] = useState<'chat' | 'inspect'>('chat') // narrow-screen toggle only
  const feedRef = useRef<HTMLDivElement | null>(null)

  // ── the ZK prover seam (one long-lived worker for the section) ──────────────────────
  const prover = useMemo<ZkProver>(() => makeZkProver(zkWorkerFactory), [zkWorkerFactory])
  useEffect(() => {
    let alive = true
    prover
      .whenReady()
      .then(() => alive && setProverReady(true))
      .catch(() => alive && setProverReady(false))
    return () => {
      alive = false
      prover.dispose()
    }
  }, [prover])

  // ── the PoW board seam (grind + post OFF the main thread) ───────────────────────────
  const board = useMemo(() => {
    if (!transportUrl) return null
    return makeWorkerBoard({
      rpc: transportUrl,
      chainId,
      workMultiplier: globalWorkMultiplier != null ? Number(globalWorkMultiplier) : 1,
      workDivisor: globalWorkDivisor != null ? Number(globalWorkDivisor) : 1,
      workerFactory,
    })
  }, [transportUrl, chainId, globalWorkMultiplier, globalWorkDivisor, workerFactory])

  // ── raw channel messages from the chain store, newest first ─────────────────────────
  const messages = useMemo(() => {
    const list = content?.[CHANNEL_CATEGORY] ?? []
    return [...list].sort((a, b) => {
      const ba = BigInt(a.blockNumber)
      const bb = BigInt(b.blockNumber)
      return ba === bb ? 0 : ba > bb ? -1 : 1
    })
  }, [content])

  // ── verification: decode + real Groth16 verify per message, memoised by hash ─────────
  const verifiedRef = useRef(new Map<string, VerifyStatus>())
  const [verifyVersion, setVerifyVersion] = useState(0)

  useEffect(() => {
    if (proverReady === null) return
    let cancelled = false
    const cache = verifiedRef.current
    const run = async () => {
      for (const msg of messages) {
        if (cancelled) return
        const key = msg.hash
        const existing = cache.get(key)
        if (existing && existing !== 'verifying') continue
        const post = decodePost(msg.data as Hex)
        if (!post) {
          cache.set(key, 'unrecognized')
          continue
        }
        // cheap, main-thread gate: the proof must be BOUND to this exact payload.
        if (signalHashOf(post) !== signalHash(post.payload).toString()) {
          cache.set(key, 'invalid')
          continue
        }
        if (proverReady === false) {
          cache.set(key, 'unavailable')
          continue
        }
        cache.set(key, 'verifying')
        const valid = await prover.verify(post)
        if (cancelled) return
        cache.set(key, valid ? 'verified' : 'invalid')
        setVerifyVersion((n) => n + 1)
      }
      if (!cancelled) setVerifyVersion((n) => n + 1)
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [messages, proverReady, prover])

  // ── assemble feed rows (+ flag nullifier replays among verified posts) ──────────────
  const rows = useMemo<FeedRow[]>(() => {
    const seenNullifiers = new Set<string>()
    // Walk oldest→newest for replay detection, then present newest-first.
    const chronological = [...messages].reverse()
    const byHash = new Map<string, FeedRow>()
    for (const msg of chronological) {
      const post = decodePost(msg.data as Hex)
      const rowStatus = verifiedRef.current.get(msg.hash) ?? 'verifying'
      let replay = false
      if (post && rowStatus === 'verified') {
        const nh = nullifierHashOf(post)
        if (seenNullifiers.has(nh)) replay = true
        else seenNullifiers.add(nh)
      }
      byHash.set(msg.hash, {
        hash: msg.hash,
        blockNumber: BigInt(msg.blockNumber),
        post,
        status: rowStatus,
        replay,
      })
    }
    return messages.map((m) => byHash.get(m.hash)!).filter(Boolean)
    // verifyVersion bumps whenever a message's verify status changes in verifiedRef
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, verifyVersion, proverReady])

  // keep the newest message in view
  useEffect(() => {
    const el = feedRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [rows.length])

  const provingUnavailable = proverReady === false

  const send = async () => {
    const trimmed = text.trim()
    if (!trimmed || !board || working || provingUnavailable) return
    setWorking(true)
    try {
      setStatus('proving group membership…')
      const payload = toHex(trimmed)
      // The proof is produced under the CURRENT `identity` — so an imported/rotated/wallet-derived
      // identity is picked up by this very next post (the worker never caches identity).
      const post = await prover.prove({ identity, payload, scope: CHANNEL })
      const data = encodePost(post)
      setStatus('grinding proof-of-work + posting…')
      await board.addMessage({ category: CHANNEL_CATEGORY, data })
      setText('')
      setStatus('posted — waiting for the board to catch up…')
      await new Promise((r) => setTimeout(r, 1000))
      await useChainStore.getState().loadContent()
      setStatus(null)
    } catch (err) {
      setStatus(err instanceof Error ? `failed: ${err.message}` : 'failed to post')
    } finally {
      setWorking(false)
    }
  }

  const onRotate = () => setIdentity(rotateIdentity())
  const onAdoptIdentity = (id: ZkIdentity) => setIdentity(id) // already persisted by the panel

  const disabled = working || !rpcValid || !board || provingUnavailable

  return (
    <div className="flex w-full flex-col overflow-hidden rounded-lg bg-white shadow ring-1 ring-gray-200 dark:bg-gray-800 dark:ring-gray-700">
      <ModeBar active={activeMode} onChange={onMode} />
      {/* header bar — room identity + prover state + narrow-screen view toggle */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-gray-200 px-4 py-2.5 dark:border-gray-700">
        <WhisperMark />
        <span className="font-mono text-base font-semibold">{ROOM}</span>
        <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-300">
          anonymous · zk-membership
        </span>
        <span className="ml-auto flex items-center gap-3">
          <ProverBadge state={proverReady} />
          <span className="hidden shrink-0 text-xs text-gray-400 sm:inline">{rows.length} live</span>
        </span>
        {/* toggle only matters on narrow screens; ≥lg shows Room + Inspector side by side */}
        <div className="flex w-full shrink-0 gap-1 lg:hidden" role="tablist" aria-label="whisper view">
          <ViewTab label="Room" on={view === 'chat'} onClick={() => setView('chat')} />
          <ViewTab label="Inspector" on={view === 'inspect'} onClick={() => setView('inspect')} />
        </div>
      </div>

      {/* identity panel — your pseudonym, reveal recovery key, import, rotate, make-portable */}
      <IdentityPanel identity={identity} onRotate={onRotate} onAdopt={onAdoptIdentity} />

      {provingUnavailable && (
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800 dark:border-amber-800/60 dark:bg-amber-900/20 dark:text-amber-300">
          Zero-knowledge proving is unavailable in this build (circuit assets or prover failed to
          load). You can still read the room — messages show an <em>unverified</em> badge and
          posting is disabled.
        </div>
      )}

      {/* split body: chat room ‖ inspector (side-by-side ≥lg, toggle < lg) */}
      <div className="flex flex-col lg:flex-row">
        {/* ── chat column ── */}
        <section
          className={`${view === 'chat' ? 'flex' : 'hidden'} min-w-0 flex-1 flex-col lg:flex`}
          aria-label="room">
          <div
            ref={feedRef}
            className="flex h-80 flex-col-reverse gap-0.5 overflow-y-auto px-4 py-3 font-mono text-sm">
            {rows.length === 0 ? (
              <div className="m-auto max-w-xs text-center text-gray-400">
                <p className="text-sm">
                  <span className="text-gray-500 dark:text-gray-300">{ROOM}</span> is quiet.
                </p>
                <p className="mt-1 text-xs">
                  Post the first message — you prove you belong to the group without revealing which
                  member you are. The proof rides inside the board message; the room verifies it.
                </p>
              </div>
            ) : (
              rows.map((row) => (
                <ChatRow key={row.hash} row={row} latestBlockNumber={latestBlockNumber} />
              ))
            )}
          </div>

          {/* composer */}
          <div className="border-t border-gray-200 dark:border-gray-700">
            <form
              className="flex items-center gap-2 px-4 py-2.5"
              onSubmit={(e) => {
                e.preventDefault()
                void send()
              }}>
              <input
                className="min-w-0 flex-1 rounded-md bg-gray-50 px-3 py-2 text-sm text-gray-900 outline-1 -outline-offset-1 outline-gray-300 focus:-outline-offset-2 focus:outline-emerald-600 disabled:opacity-60 dark:bg-gray-900 dark:text-gray-100 dark:outline-gray-600"
                placeholder={
                  provingUnavailable
                    ? 'posting disabled — prover unavailable'
                    : rpcValid
                      ? `whisper into ${ROOM} anonymously`
                      : 'point at a board-serving RPC to post'
                }
                value={text}
                disabled={disabled}
                onChange={(e) => setText(e.target.value)}
                aria-label="message"
              />
              <button
                type="submit"
                disabled={disabled || text.trim().length === 0}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-emerald-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50">
                {working ? 'proving…' : 'post anon'}
              </button>
            </form>
            <p className="px-4 pb-2.5 text-[11px] text-gray-400">
              {status ??
                'Your message carries a real Groth16 membership proof + a nullifier bound to the text, then a PoW stamp — both ground off this thread. Anonymous, but the text itself is public.'}
            </p>
          </div>
        </section>

        {/* ── inspector column ── */}
        <section
          className={`${view === 'inspect' ? 'flex' : 'hidden'} min-w-0 flex-1 flex-col border-gray-200 lg:flex lg:border-l dark:border-gray-700`}
          aria-label="inspector">
          <Inspector rows={rows} />
        </section>
      </div>
    </div>
  )
}

/** The Whisper mark (incognito). Inline so the header reads without an icon dependency here. */
function WhisperMark() {
  return (
    <span className="font-mono text-lg text-emerald-600 dark:text-emerald-400" aria-hidden="true">
      ⊘
    </span>
  )
}

function ViewTab({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={on}
      onClick={onClick}
      className={`flex-1 rounded-md px-3 py-1 text-xs font-medium transition ${
        on
          ? 'bg-indigo-600 text-white'
          : 'text-gray-600 ring-1 ring-gray-300 hover:text-gray-900 dark:text-gray-300 dark:ring-gray-600 dark:hover:text-white'
      }`}>
      {label}
    </button>
  )
}

/** The connected prover's state, as a small status pill. */
function ProverBadge({ state }: { state: boolean | null }) {
  if (state === null)
    return <span className="text-xs text-gray-400 font-mono">prover: loading…</span>
  if (state === false)
    return <span className="text-xs text-amber-600 dark:text-amber-400 font-mono">prover: unavailable</span>
  return <span className="text-xs text-emerald-600 dark:text-emerald-400 font-mono">prover: ready</span>
}

// ── identity panel ─────────────────────────────────────────────────────────────────────

/**
 * Your identity, made real and backupable — TWO coexisting backups:
 *   1. the RECOVERY KEY (walletless): a single Base58Check string that IS this pseudonym, and
 *   2. the WALLET (portable): connect an injected wallet and re-sign a fixed message to re-derive
 *      the SAME identity on any device (wallet-identity.ts). The signature never leaves the browser
 *      — it is only HKDF key material — and the derivation is deterministic for standard wallets.
 * Shows the current pseudonym, a hidden-by-default reveal-recovery-key control, an import field,
 * and (when an injected wallet is present) the "make portable" control.
 */
function IdentityPanel({
  identity,
  onRotate,
  onAdopt,
}: {
  identity: ZkIdentity
  onRotate: () => void
  /** Adopt a new identity as active (the panel has already persisted it). */
  onAdopt: (id: ZkIdentity) => void
}) {
  const [open, setOpen] = useState(false)
  const [revealed, setRevealed] = useState(false)
  const [copied, setCopied] = useState(false)
  const [importValue, setImportValue] = useState('')
  const [importState, setImportState] = useState<'idle' | 'ok' | 'bad'>('idle')
  const [walletState, setWalletState] = useState<'idle' | 'signing' | 'ok' | 'err'>('idle')
  const [walletError, setWalletError] = useState<string | null>(null)
  const walletAvailable = useMemo(() => hasInjectedWallet(), [])

  const recoveryKey = useMemo(() => exportIdentity(identity), [identity])

  // Hide the revealed secret again whenever the identity changes (rotate/import/wallet).
  useEffect(() => {
    setRevealed(false)
    setCopied(false)
  }, [identity])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(recoveryKey)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard may be unavailable; the string is visible to copy manually */
    }
  }

  const doImport = () => {
    const id = importAndPersistIdentity(importValue)
    if (!id) {
      setImportState('bad')
      return
    }
    setImportState('ok')
    setImportValue('')
    onAdopt(id)
    setTimeout(() => setImportState('idle'), 2000)
  }

  // Wallet-derived portable identity: sign the fixed message → derive the Semaphore secrets locally,
  // persist them (same store the recovery key uses), then adopt so the very next proof uses them.
  // The derivation also yields X25519 encryption keys for a future per-recipient-encryption tier;
  // we don't surface them here, but deriving them now means the wallet already prepares that path.
  const makePortable = async () => {
    setWalletState('signing')
    setWalletError(null)
    try {
      const derived = await deriveIdentityFromWallet()
      persistIdentity(derived.identity)
      onAdopt(derived.identity)
      // derived.encPublicKey / encPrivateKey are held for the future DM tier — nothing to show yet.
      setWalletState('ok')
      setTimeout(() => setWalletState('idle'), 2500)
    } catch (err) {
      setWalletError(err instanceof Error ? err.message : 'Could not derive from wallet.')
      setWalletState('err')
    }
  }

  return (
    <div className="border-b border-gray-200 bg-gray-50/60 px-4 py-2 text-xs dark:border-gray-700 dark:bg-gray-900/30">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-gray-400">you are</span>
        <YouTag identity={identity} />
        <button
          type="button"
          onClick={onRotate}
          className="text-[11px] text-gray-400 underline decoration-dotted hover:text-gray-600 dark:hover:text-gray-200"
          title="Generate a fresh anonymous identity (a new pseudonym). Your current one is lost unless you saved its recovery key.">
          new pseudonym
        </button>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="ml-auto text-[11px] font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-400"
          aria-expanded={open}>
          {open ? 'hide backup ▴' : 'back up / restore ▾'}
        </button>
      </div>

      {open && (
        <div className="mt-2 space-y-3 rounded-md border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-800">
          {/* two backups coexist — say so up front */}
          <p className="text-[11px] leading-snug text-gray-500 dark:text-gray-400">
            Your pseudonym has <strong>two independent backups</strong>: the walletless{' '}
            <strong>recovery key</strong> below, or a <strong>wallet</strong> you can re-sign from
            anywhere. Either one restores this identity — you only need one.
          </p>

          {/* reveal recovery key */}
          <div>
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-gray-700 dark:text-gray-200">Recovery key</span>
              {!revealed ? (
                <button
                  type="button"
                  onClick={() => setRevealed(true)}
                  className="rounded bg-gray-800 px-2 py-1 text-[11px] font-medium text-white hover:bg-gray-700 dark:bg-gray-600 dark:hover:bg-gray-500">
                  Reveal recovery key
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setRevealed(false)}
                  className="rounded px-2 py-1 text-[11px] font-medium text-gray-500 ring-1 ring-gray-300 hover:text-gray-700 dark:text-gray-400 dark:ring-gray-600">
                  Hide
                </button>
              )}
            </div>
            {revealed ? (
              <div className="mt-2 space-y-1.5">
                <div className="flex items-start gap-2">
                  <code className="min-w-0 flex-1 break-all rounded bg-gray-100 px-2 py-1.5 font-mono text-[11px] text-gray-800 select-all dark:bg-gray-900 dark:text-gray-100">
                    {recoveryKey}
                  </code>
                  <button
                    type="button"
                    onClick={() => void copy()}
                    className="shrink-0 rounded bg-emerald-600 px-2 py-1.5 text-[11px] font-medium text-white hover:bg-emerald-500">
                    {copied ? 'copied ✓' : 'copy'}
                  </button>
                </div>
                <p className="rounded border border-red-300 bg-red-50 px-2 py-1.5 text-[11px] leading-snug text-red-800 dark:border-red-800/60 dark:bg-red-900/20 dark:text-red-300">
                  <strong>Treat this like a private key.</strong> This key <em>is</em> your identity:
                  anyone who has it can post as you. Back it up somewhere safe. It is a local secret —
                  it is never posted or sent anywhere. If you lose it and clear this browser, this
                  pseudonym is <strong>gone for good</strong>.
                </p>
              </div>
            ) : (
              <p className="mt-1 text-[11px] leading-snug text-gray-500 dark:text-gray-400">
                Hidden by default. It is one backup of this pseudonym — reveal it, then store it like
                a private key. Without it (and without a wallet), clearing this browser loses the
                identity forever.
              </p>
            )}
          </div>

          {/* import */}
          <div>
            <label className="font-semibold text-gray-700 dark:text-gray-200">
              Restore from a recovery key
            </label>
            <div className="mt-1 flex items-start gap-2">
              <input
                className="min-w-0 flex-1 rounded bg-gray-50 px-2 py-1.5 font-mono text-[11px] text-gray-900 outline-1 -outline-offset-1 outline-gray-300 focus:outline-indigo-500 dark:bg-gray-900 dark:text-gray-100 dark:outline-gray-600"
                placeholder="paste a recovery key (whisper1…)"
                value={importValue}
                onChange={(e) => {
                  setImportValue(e.target.value)
                  setImportState('idle')
                }}
                aria-label="recovery key to import"
              />
              <button
                type="button"
                onClick={doImport}
                disabled={importValue.trim().length === 0}
                className="shrink-0 rounded bg-indigo-600 px-2.5 py-1.5 text-[11px] font-medium text-white hover:bg-indigo-500 disabled:opacity-50">
                Import
              </button>
            </div>
            {importState === 'bad' && (
              <p className="mt-1 text-[11px] text-red-600 dark:text-red-400">
                Not a valid recovery key (bad checksum, format, or out-of-range secret).
              </p>
            )}
            {importState === 'ok' && (
              <p className="mt-1 text-[11px] text-emerald-600 dark:text-emerald-400">
                Imported — your pseudonym switched. Your next post proves under this identity.
              </p>
            )}
            <p className="mt-1 text-[11px] leading-snug text-gray-500 dark:text-gray-400">
              Importing replaces your current pseudonym on this device. Save the current key first if
              you want to keep it.
            </p>
          </div>

          {/* wallet-derived portable identity */}
          {walletAvailable && (
            <div className="rounded border border-indigo-200 bg-indigo-50/60 p-2.5 dark:border-indigo-900/60 dark:bg-indigo-900/20">
              <div className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1.5 font-semibold text-indigo-900 dark:text-indigo-200">
                  <Icon icon="mdi:wallet-outline" className="size-3.5" /> Make portable
                </span>
                <button
                  type="button"
                  onClick={() => void makePortable()}
                  disabled={walletState === 'signing'}
                  className="shrink-0 rounded bg-indigo-600 px-2.5 py-1.5 text-[11px] font-medium text-white hover:bg-indigo-500 disabled:opacity-50">
                  {walletState === 'signing' ? 'sign in wallet…' : 'connect wallet'}
                </button>
              </div>
              <p className="mt-1.5 leading-snug text-indigo-800/90 dark:text-indigo-200/80">
                Derive this pseudonym from a wallet signature so it is restorable on any device by
                re-signing — the wallet becomes your backup. The derivation is{' '}
                <strong>local</strong>: the signature never leaves this browser, it only derives
                keys. Works with standard wallets (deterministic signatures); a wallet with
                non-deterministic signatures can’t restore. This also prepares your encryption keys
                for private DMs (coming).
              </p>
              {walletState === 'ok' && (
                <p className="mt-1 text-[11px] text-emerald-600 dark:text-emerald-400">
                  Derived from your wallet — this pseudonym is now portable. Re-sign the same message
                  anywhere to restore it. Your next post proves under this identity.
                </p>
              )}
              {walletState === 'err' && walletError && (
                <p className="mt-1 text-[11px] text-red-600 dark:text-red-400">{walletError}</p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** Your own current pseudonym chip — a stable, non-invertible short fingerprint of the local
 *  identity (NOT a wallet, NOT the nullifier — just so you can see it change after "new
 *  pseudonym"). The per-room author tag other people see is derived from the nullifierHash. */
function YouTag({ identity }: { identity: ZkIdentity }) {
  const shortId = (identity.nullifier % 0x10000n).toString(16).padStart(4, '0')
  const hue = Number(identity.trapdoor % 360n)
  return (
    <span
      className="inline-flex items-center gap-1 rounded bg-gray-100 px-1.5 py-0.5 font-mono text-xs dark:bg-gray-900"
      title="Your local, wallet-independent identity (fingerprint only — secrets never leave this browser).">
      <span className="size-2 rounded-full" style={{ backgroundColor: `hsl(${hue} 65% 50%)` }} />
      you·{shortId}
    </span>
  )
}

/** One message row: anonymized author tag + text + freshness + verify badge. */
function ChatRow({
  row,
  latestBlockNumber,
}: {
  row: FeedRow
  latestBlockNumber: bigint | null
}) {
  const tag =
    row.post != null
      ? authorTag(nullifierHashOf(row.post))
      : { handle: 'plain', short: row.hash.slice(2, 6), hue: 0 }
  const text = row.post ? payloadText(row.post.payload) : '(plain board message — no membership proof)'
  const freshness =
    latestBlockNumber != null
      ? formatBlocksRemaining(BLOCK_RANGE_LIMIT - (latestBlockNumber - row.blockNumber))
      : null

  return (
    <div className="flex items-baseline gap-2 rounded px-1 py-0.5 hover:bg-gray-50 dark:hover:bg-gray-700/40">
      <span
        className="inline-flex shrink-0 items-center gap-1 font-semibold"
        style={{ color: `hsl(${tag.hue} 70% 40%)` }}
        title={row.post ? `nullifier ${nullifierHashOf(row.post).slice(0, 18)}…` : row.hash}>
        <span className="size-2 rounded-full" style={{ backgroundColor: `hsl(${tag.hue} 70% 45%)` }} />
        {tag.handle}·{tag.short}
      </span>
      <span className="min-w-0 flex-1 break-words text-gray-800 dark:text-gray-100">{text}</span>
      <span className="flex shrink-0 flex-col items-end gap-0.5">
        <StatusBadge status={row.status} replay={row.replay} />
        {freshness && (
          <span className="text-[10px] text-gray-400" title={`block ${row.blockNumber.toString()}`}>
            {freshness}
          </span>
        )}
      </span>
    </div>
  )
}

function StatusBadge({ status, replay }: { status: VerifyStatus; replay: boolean }) {
  const base = 'text-[10px] px-1.5 py-0.5 rounded-full font-sans font-medium whitespace-nowrap'
  if (status === 'verified' && replay)
    return <span className={`${base} bg-yellow-100 text-yellow-800 dark:bg-yellow-900/50 dark:text-yellow-300`} title="Valid proof, but this member's nullifier was already used this room (rate-limit replay).">✓ verified · replay</span>
  switch (status) {
    case 'verified':
      return <span className={`${base} bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-300`} title="Real Groth16 membership proof, bound to this message. Anonymous but provably in-group.">✓ verified-anon</span>
    case 'verifying':
      return <span className={`${base} bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400`}>verifying…</span>
    case 'invalid':
      return <span className={`${base} bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-300`} title="Carries a Whisper envelope, but the proof did not verify (or is not bound to this text).">✗ invalid proof</span>
    case 'unavailable':
      return <span className={`${base} bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400`} title="Prover unavailable in this build — could not verify.">unverified</span>
    case 'unrecognized':
    default:
      return <span className={`${base} bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400`} title="Not a Whisper post (no membership-proof envelope).">plain msg</span>
  }
}

// ── inspector ──────────────────────────────────────────────────────────────────────────

/**
 * An x-ray of the room. Two parts:
 *  1. A fixed legend — "what each key can do" — that tells the honest truth: the anonymous mode is
 *     anonymous, NOT encrypted. Text is public; there are no decryption keys.
 *  2. A per-message breakdown — cryptographic status (with the WHY), the four public signals
 *     decoded + labeled in plain language, and what is REVEALED vs HIDDEN for that message.
 */
function Inspector({ rows }: { rows: FeedRow[] }) {
  return (
    <div className="flex h-[26.5rem] flex-col overflow-y-auto px-4 py-3 text-xs lg:h-auto">
      <KeyLegend />
      <h4 className="mt-4 mb-1.5 font-semibold text-gray-700 dark:text-gray-200">
        Per-message x-ray
      </h4>
      {rows.length === 0 ? (
        <p className="text-gray-400">No messages yet. Posts will be broken down here.</p>
      ) : (
        <div className="space-y-2">
          {rows.map((row) => (
            <MessageXray key={row.hash} row={row} />
          ))}
        </div>
      )}
    </div>
  )
}

/** The honest "what data can be read/decrypted by what key" legend. */
function KeyLegend() {
  return (
    <div className="rounded-md border border-indigo-200 bg-indigo-50/60 p-3 dark:border-indigo-900/60 dark:bg-indigo-900/20">
      <p className="font-semibold text-indigo-900 dark:text-indigo-200">
        Anonymous, not encrypted.
      </p>
      <p className="mt-1 leading-snug text-indigo-800/90 dark:text-indigo-200/80">
        Message text is <strong>public</strong> — it rides in the board post in the clear and anyone
        can read it. There are <strong>no decryption keys</strong>. What is hidden is <em>which
        member</em> wrote it, not the words. (For hidden bodies, use Encrypted mode.)
      </p>
      <dl className="mt-2 space-y-1.5">
        <LegendRow k="Your recovery key" role="private · never sent">
          Proves you belong to the group and produces your room-scoped pseudonym. No one can produce
          your pseudonym without it, and it never appears in any post.
        </LegendRow>
        <LegendRow k="Group root" role="public">
          The membership set you prove you are part of. Public — it identifies the group, not you.
        </LegendRow>
        <LegendRow k="Message body" role="public · plaintext">
          The words. Readable by anyone. A proof binds to the text but does not conceal it.
        </LegendRow>
      </dl>
      <p className="mt-2 text-[11px] italic leading-snug text-indigo-700/80 dark:text-indigo-300/70">
        End-to-end encrypted rooms — a key that actually decrypts message bodies — are the separate
        Encrypted mode. In this mode nothing decrypts the text because nothing encrypts it.
      </p>
    </div>
  )
}

function LegendRow({ k, role, children }: { k: string; role: string; children: ReactNode }) {
  return (
    <div className="rounded bg-white/70 px-2 py-1.5 dark:bg-gray-800/50">
      <dt className="flex items-center justify-between gap-2">
        <span className="font-semibold text-gray-800 dark:text-gray-100">{k}</span>
        <span className="shrink-0 rounded-full bg-gray-200 px-1.5 py-0.5 text-[10px] font-medium text-gray-700 dark:bg-gray-700 dark:text-gray-200">
          {role}
        </span>
      </dt>
      <dd className="mt-0.5 leading-snug text-gray-600 dark:text-gray-300">{children}</dd>
    </div>
  )
}

/** Human-readable cryptographic status for a row + the WHY behind it. */
function statusExplain(status: VerifyStatus): { label: string; why: string; tone: string } {
  switch (status) {
    case 'verified':
      return {
        label: 'verified-anon',
        why: 'A real Groth16 membership proof: groth16.verify passed against the committed verification key.',
        tone: 'text-emerald-700 dark:text-emerald-300',
      }
    case 'invalid':
      return {
        label: 'unverified',
        why: 'A proof envelope is present, but it did not verify — or it is not bound to this exact text.',
        tone: 'text-red-700 dark:text-red-300',
      }
    case 'unavailable':
      return {
        label: 'unverified',
        why: 'The prover is unavailable in this build, so this proof could not be checked.',
        tone: 'text-amber-700 dark:text-amber-300',
      }
    case 'verifying':
      return {
        label: 'verifying…',
        why: 'Running the real Groth16 verification off the main thread.',
        tone: 'text-gray-500 dark:text-gray-400',
      }
    case 'unrecognized':
    default:
      return {
        label: 'undecodable',
        why: 'Not a Whisper post — it carries no membership-proof envelope.',
        tone: 'text-gray-500 dark:text-gray-400',
      }
  }
}

/** The per-message breakdown: status + labeled public signals + revealed/hidden. */
function MessageXray({ row }: { row: FeedRow }) {
  const [open, setOpen] = useState(false)
  const explain = statusExplain(row.status)
  const preview = row.post ? payloadText(row.post.payload) : '(plain board message)'

  return (
    <div className="rounded-md border border-gray-200 dark:border-gray-700">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
        aria-expanded={open}>
        <span className={`shrink-0 font-semibold ${explain.tone}`}>{explain.label}</span>
        <span className="min-w-0 flex-1 truncate text-gray-700 dark:text-gray-200">{preview}</span>
        <span className="shrink-0 text-gray-400">{open ? '▴' : '▾'}</span>
      </button>

      {open && (
        <div className="space-y-2.5 border-t border-gray-100 px-2.5 py-2 dark:border-gray-700/60">
          <p className="leading-snug text-gray-600 dark:text-gray-300">{explain.why}</p>

          {row.post ? (
            <>
              <div>
                <p className="mb-1 font-semibold text-gray-700 dark:text-gray-200">Public signals</p>
                <div className="space-y-1.5">
                  <SignalRow
                    label="root"
                    plain="The group this author proved membership in."
                    value={rootOf(row.post)}
                  />
                  <SignalRow
                    label="nullifierHash"
                    plain="This author's per-room pseudonym seed — deterministic, so their posts link to each other IN THIS ROOM, but to no wallet."
                    value={nullifierHashOf(row.post)}
                  />
                  <SignalRow
                    label="externalNullifier"
                    plain="This room / scope. The same member gets a different pseudonym in a different room."
                    value={externalNullifierOf(row.post)}
                  />
                  <SignalRow
                    label="signalHash"
                    plain="Binds the proof to THIS exact message text — the proof can't be lifted onto a different message."
                    value={signalHashOf(row.post)}
                  />
                </div>
              </div>

              <div className="grid gap-2 sm:grid-cols-2">
                <RevealHidden
                  kind="revealed"
                  items={[
                    'The author is a member of the group (root).',
                    'A stable room-scoped pseudonym (nullifierHash).',
                    'The message text (public).',
                  ]}
                />
                <RevealHidden
                  kind="hidden"
                  items={[
                    'WHICH member wrote it — unlinkable within the group.',
                    'Any wallet or on-chain address.',
                    'The two identity secrets (they stay on the author’s device).',
                  ]}
                />
              </div>
            </>
          ) : (
            <p className="text-gray-500 dark:text-gray-400">
              Nothing to decode — this board message is not a Whisper post.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

/** One labeled public signal: human meaning always visible; raw value in mono, full on hover. */
function SignalRow({ label, plain, value }: { label: string; plain: string; value: string }) {
  return (
    <div className="rounded bg-gray-50 px-2 py-1.5 dark:bg-gray-900/40">
      <div className="flex items-baseline justify-between gap-2">
        <code className="shrink-0 font-mono font-semibold text-indigo-700 dark:text-indigo-300">
          {label}
        </code>
        <code
          className="min-w-0 truncate font-mono text-[10px] text-gray-500 dark:text-gray-400"
          title={value}>
          {value}
        </code>
      </div>
      <p className="mt-0.5 leading-snug text-gray-600 dark:text-gray-300">{plain}</p>
    </div>
  )
}

function RevealHidden({ kind, items }: { kind: 'revealed' | 'hidden'; items: string[] }) {
  const revealed = kind === 'revealed'
  return (
    <div
      className={`rounded border px-2 py-1.5 ${
        revealed
          ? 'border-amber-200 bg-amber-50/70 dark:border-amber-800/50 dark:bg-amber-900/15'
          : 'border-emerald-200 bg-emerald-50/70 dark:border-emerald-800/50 dark:bg-emerald-900/15'
      }`}>
      <p
        className={`font-semibold ${
          revealed ? 'text-amber-800 dark:text-amber-300' : 'text-emerald-800 dark:text-emerald-300'
        }`}>
        {revealed ? 'Revealed' : 'Hidden'}
      </p>
      <ul className="mt-0.5 space-y-0.5 text-gray-600 dark:text-gray-300">
        {items.map((it) => (
          <li key={it} className="leading-snug">
            • {it}
          </li>
        ))}
      </ul>
    </div>
  )
}
