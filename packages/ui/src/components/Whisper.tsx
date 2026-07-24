/**
 * Whisper — an anonymous room over the MsgBoard board where you prove you belong to a group
 * WITHOUT revealing which member you are (Semaphore-style), so messages are unlinkable to a
 * wallet. (Formerly "ZK Chat" — this is display-only rebrand; the on-wire channel category
 * and proof envelope are UNCHANGED, so posts stay byte-for-byte compatible with the existing
 * zk-msgboard watcher/archive.)
 *
 * ── ANONYMOUS, NOT ENCRYPTED ────────────────────────────────────────────────────────────
 * The interesting honest truth Whisper surfaces (see the Inspector): message TEXT is PUBLIC
 * — it rides in the board post in the clear, anyone can read it. There are no decryption
 * keys. Your recovery key (lib/zk-identity.ts) is a LOCAL secret that does exactly one thing:
 * it lets you PROVE group membership and produce YOUR room-scoped pseudonym. It never appears
 * in any post. End-to-end encrypted rooms (a key that actually decrypts bodies) are a possible
 * FUTURE mode — not what ships here.
 *
 * ── PATH TAKEN: REAL BROWSER PROVING ────────────────────────────────────────────────────
 * The full Groth16 membership proof + verification run for real in a Web Worker
 * (worker/zk-worker.ts, driven by the seams/zk-prover.ts seam) using the committed circuit
 * artifacts. Nothing is faked: if the assets/libs fail to load, the seam degrades to a visible
 * "proving unavailable" state rather than forging a proof.
 *
 * ── WIRE ENCODING (mirrors zk-msgboard.ts EXACTLY) ──────────────────────────────────────
 * A post is `ZkPost = { proof, publicSignals, payload }` with publicSignals in circuit order
 * `[root, nullifierHash, externalNullifier, signalHash]`, encoded as the board message
 * `data = toHex(JSON.stringify(post))`. The channel category is `stringToHex('zkchat',
 * { size: 32 })` — UNCHANGED — so Whisper posts decode + verify under the existing
 * zk-msgboard watcher/archive, and vice-versa.
 *
 * ── IDENTITY (real, now surfaced) ───────────────────────────────────────────────────────
 * The identity is a wallet-INDEPENDENT Semaphore identity (two field-element secrets) persisted
 * in localStorage (lib/zk-identity.ts). It is now backupable: the identity panel can reveal a
 * single copy-pasteable recovery key and import one back. That key IS the pseudonym — a local
 * secret, never posted. Proofs are produced under whatever identity is passed to `prover.prove`
 * per post, so an imported/rotated identity is picked up by the very next post (no worker
 * re-init needed — the worker never caches the identity).
 *
 * Self-contained: no props required — it reads the chain store like Interactive does.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { stringToHex, toHex, type Hex } from 'viem'
import {
  useChainStore,
  selectChain,
  selectTransportUrl,
  selectRpcValid,
} from '../stores/chain'
import { makeWorkerBoard } from '../seams/worker-board'
import { makeZkProver, type ZkProver } from '../seams/zk-prover'
import {
  loadOrCreateIdentity,
  rotateIdentity,
  authorTag,
  exportIdentity,
  importAndPersistIdentity,
  type ZkIdentity,
} from '../lib/zk-identity'
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

/** Display name for the room. */
const ROOM = 'Whisper'
/** The fixed ZK group channel — UNCHANGED on-wire (scope + bytes32 category). Display only
 *  ever shows "Whisper"; this literal is the scope/category the proof + board post use. */
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

type Props = {
  /** Injectable PoW worker factory (headless tests supply a fake). Prod omits it. */
  workerFactory?: () => Worker
  /** Injectable ZK worker factory (headless tests supply a fake). Prod omits it. */
  zkWorkerFactory?: () => Worker
}

export function Whisper({ workerFactory, zkWorkerFactory }: Props) {
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
  const prover = useMemo<ZkProver>(
    () => makeZkProver(zkWorkerFactory),
    [zkWorkerFactory],
  )
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
      // The proof is produced under the CURRENT `identity` — so an imported/rotated
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
  const onImport = (id: ZkIdentity) => setIdentity(id) // already persisted by the panel

  const disabled = working || !rpcValid || !board || provingUnavailable

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col overflow-hidden rounded-lg bg-white shadow ring-1 ring-gray-200 lg:max-w-5xl dark:bg-gray-800 dark:ring-gray-700">
      {/* header bar — room identity + prover state + narrow-screen view toggle */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-gray-200 px-4 py-2.5 dark:border-gray-700">
        <Icon />
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

      {/* identity panel — your pseudonym, reveal recovery key, import, rotate */}
      <IdentityPanel identity={identity} onRotate={onRotate} onImport={onImport} />

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
function Icon() {
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
 * Your identity, made real and backupable. Shows the current pseudonym, a hidden-by-default
 * "reveal recovery key" control (the ONE secret that IS this identity), and an import field.
 * Copy is deliberately load-bearing and blunt: this key is a private key. If you lose it and
 * clear this browser, that pseudonym is gone for good.
 */
function IdentityPanel({
  identity,
  onRotate,
  onImport,
}: {
  identity: ZkIdentity
  onRotate: () => void
  onImport: (id: ZkIdentity) => void
}) {
  const [open, setOpen] = useState(false)
  const [revealed, setRevealed] = useState(false)
  const [copied, setCopied] = useState(false)
  const [importValue, setImportValue] = useState('')
  const [importState, setImportState] = useState<'idle' | 'ok' | 'bad'>('idle')

  const recoveryKey = useMemo(() => exportIdentity(identity), [identity])

  // Hide the revealed secret again whenever the identity changes (rotate/import).
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
    onImport(id)
    setTimeout(() => setImportState('idle'), 2000)
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
                Hidden by default. It is the only backup of this pseudonym — reveal it, then store it
                like a private key. Without it, clearing this browser loses the identity forever.
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
        </div>
      )}
    </div>
  )
}

/** Your own current pseudonym chip — a stable, non-invertible short fingerprint of the local
 *  identity (NOT a wallet, NOT the nullifier — just so you can see it change after "new
 *  pseudonym"). The per-room author tag other people see is derived from the nullifierHash. */
function YouTag({ identity }: { identity: ZkIdentity }) {
  const short = (identity.nullifier % 0x10000n).toString(16).padStart(4, '0')
  const hue = Number(identity.trapdoor % 360n)
  return (
    <span
      className="inline-flex items-center gap-1 rounded bg-gray-100 px-1.5 py-0.5 font-mono text-xs dark:bg-gray-900"
      title="Your local, wallet-independent identity (fingerprint only — secrets never leave this browser).">
      <span className="size-2 rounded-full" style={{ backgroundColor: `hsl(${hue} 65% 50%)` }} />
      you·{short}
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
 *  1. A fixed legend — "what each key can do" — that tells the honest truth: Whisper is
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
        Whisper is anonymous, not encrypted.
      </p>
      <p className="mt-1 leading-snug text-indigo-800/90 dark:text-indigo-200/80">
        Message text is <strong>public</strong> — it rides in the board post in the clear and anyone
        can read it. There are <strong>no decryption keys</strong>. What is hidden is <em>which
        member</em> wrote it, not the words.
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
        End-to-end encrypted rooms — a key that actually decrypts message bodies — are a possible
        future mode, not what ships here. Today, nothing decrypts the text because nothing encrypts
        it.
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
