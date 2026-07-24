/**
 * ZkChat — an anonymous, IRC-style channel over the MsgBoard board where you prove you
 * belong to a group WITHOUT revealing which member you are (Semaphore-style), so messages
 * are unlinkable to a wallet.
 *
 * ── PATH TAKEN: REAL BROWSER PROVING (option (a) in the brief) ──────────────────────────
 * The full Groth16 membership proof + verification run for real in a Web Worker
 * (worker/zk-worker.ts, driven by the seams/zk-prover.ts seam) using the committed circuit
 * artifacts — `membership.wasm`, `membership_final.zkey`, `verification_key.json` — copied
 * into src/zk-assets/ and wired through vite (`?url` for the wasm/zkey, JSON import for the
 * vkey/group). Proving/verifying is snarkjs (`groth16.fullProve` / `groth16.verify`) with
 * Poseidon identities from circomlibjs — the SAME crypto as packages/examples/src/
 * zk-msgboard.ts, just without its Node-only `createRequire`. Heavy work stays OFF the main
 * thread (project hard rule). Nothing is faked: if the assets/libs fail to load, the seam
 * degrades to a visible "proving unavailable in this build" state rather than forging a
 * proof.
 *
 * ── WIRE ENCODING (mirrors zk-msgboard.ts EXACTLY) ──────────────────────────────────────
 * A post is `ZkPost = { proof, publicSignals, payload }` with publicSignals in circuit order
 * `[root, nullifierHash, externalNullifier, signalHash]`, encoded as the board message
 * `data = toHex(JSON.stringify(post))` (see lib/zk-post.ts, a byte-for-byte port). The
 * channel category is `stringToHex('zkchat', { size: 32 })` — the SAME direct-encoded
 * bytes32 the examples watcher's `msgboardContentSource({ category })` reads — so posts
 * ZkChat makes are decoded + verified by the existing zk-msgboard watcher/archive, and
 * vice-versa. Posting goes through the PoW Web-Worker seam (makeWorkerBoard); the grind is
 * never on the render thread.
 *
 * ── ANONYMITY / UNLINKABILITY ───────────────────────────────────────────────────────────
 * The identity is a wallet-INDEPENDENT Semaphore identity persisted in localStorage
 * (lib/zk-identity.ts). The proof reveals only the group root + a nullifierHash; the author
 * tag in the feed is derived from that nullifierHash, so the same anonymous member looks
 * consistent within an epoch but is not linkable to any address. The anonymity set is the
 * committed dev group ∪ your local identity — small in this DEV build (the dev trusted setup
 * is forgeable; a large on-chain-registered group is the deferred production item, see
 * docs/zk-msgboard.md).
 *
 * Self-contained: no props required — it reads the chain store like Interactive does.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { stringToHex, toHex, type Hex } from 'viem'
import {
  useChainStore,
  selectChain,
  selectTransportUrl,
  selectRpcValid,
} from '../stores/chain'
import { makeWorkerBoard } from '../seams/worker-board'
import { makeZkProver, type ZkProver } from '../seams/zk-prover'
import { loadOrCreateIdentity, rotateIdentity, authorTag, type ZkIdentity } from '../lib/zk-identity'
import {
  decodePost,
  encodePost,
  nullifierHashOf,
  payloadText,
  signalHash,
  signalHashOf,
  type ZkPost,
} from '../lib/zk-post'
import { formatBlocksRemaining } from '../lib/tree'
import { BLOCK_RANGE_LIMIT } from '../lib/rpc'

/** The fixed ZK group channel. Direct bytes32 encoding — matches the examples watcher. */
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

export function ZkChat({ workerFactory, zkWorkerFactory }: Props) {
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
      const status = verifiedRef.current.get(msg.hash) ?? 'verifying'
      let replay = false
      if (post && status === 'verified') {
        const nh = nullifierHashOf(post)
        if (seenNullifiers.has(nh)) replay = true
        else seenNullifiers.add(nh)
      }
      byHash.set(msg.hash, {
        hash: msg.hash,
        blockNumber: BigInt(msg.blockNumber),
        post,
        status,
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

  const onRotate = () => {
    setIdentity(rotateIdentity())
  }

  const disabled = working || !rpcValid || !board || provingUnavailable

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col overflow-hidden rounded-lg bg-white shadow ring-1 ring-gray-200 dark:bg-gray-800 dark:ring-gray-700">
      {/* channel bar — fixed ZK group channel */}
      <div className="flex items-center gap-3 border-b border-gray-200 px-4 py-2.5 dark:border-gray-700">
        <span className="font-mono text-lg text-emerald-600 dark:text-emerald-400">#</span>
        <span className="font-mono text-base font-semibold">{CHANNEL}</span>
        <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-300">
          anonymous · zk-membership
        </span>
        <span className="ml-auto flex items-center gap-3">
          <ProverBadge state={proverReady} />
          <span className="hidden shrink-0 text-xs text-gray-400 sm:inline">{rows.length} live</span>
        </span>
      </div>

      {provingUnavailable && (
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800 dark:border-amber-800/60 dark:bg-amber-900/20 dark:text-amber-300">
          Zero-knowledge proving is unavailable in this build (circuit assets or prover failed to
          load). You can still read the channel — messages show an <em>unverified</em> badge and
          posting is disabled.
        </div>
      )}

      {/* feed (newest at the bottom via flex-col-reverse) */}
      <div
        ref={feedRef}
        className="flex h-80 flex-col-reverse gap-0.5 overflow-y-auto px-4 py-3 font-mono text-sm">
        {rows.length === 0 ? (
          <div className="m-auto max-w-xs text-center text-gray-400">
            <p className="text-sm">
              <span className="text-gray-500 dark:text-gray-300">#{CHANNEL}</span> is quiet.
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
        <div className="flex items-center gap-2 px-4 pt-2">
          <label className="text-xs text-gray-400">as</label>
          <YouTag identity={identity} />
          <button
            type="button"
            onClick={onRotate}
            className="text-[11px] text-gray-400 underline decoration-dotted hover:text-gray-600 dark:hover:text-gray-200"
            title="Generate a fresh anonymous identity (a new pseudonym).">
            new pseudonym
          </button>
          <span className="ml-auto hidden text-[11px] text-gray-400 sm:inline">
            wallet-independent · unlinkable
          </span>
        </div>
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
                  ? `message #${CHANNEL} anonymously`
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
            'Your message carries a real Groth16 membership proof + a nullifier bound to the text, then a PoW stamp — both ground off this thread. Anonymous, but provably in the group.'}
        </p>
      </div>
    </div>
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

/** Your own current pseudonym chip — a stable, non-invertible short fingerprint of the local
 *  identity (NOT a wallet, NOT the nullifier — just so you can see it change after "new
 *  pseudonym"). The per-epoch author tag other people see is derived from the nullifierHash. */
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
    return <span className={`${base} bg-yellow-100 text-yellow-800 dark:bg-yellow-900/50 dark:text-yellow-300`} title="Valid proof, but this member's nullifier was already used this epoch (rate-limit replay).">✓ verified · replay</span>
  switch (status) {
    case 'verified':
      return <span className={`${base} bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-300`} title="Real Groth16 membership proof, bound to this message. Anonymous but provably in-group.">✓ verified-anon</span>
    case 'verifying':
      return <span className={`${base} bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400`}>verifying…</span>
    case 'invalid':
      return <span className={`${base} bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-300`} title="Carries a zk-post envelope, but the proof did not verify (or is not bound to this text).">✗ invalid proof</span>
    case 'unavailable':
      return <span className={`${base} bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400`} title="Prover unavailable in this build — could not verify.">unverified</span>
    case 'unrecognized':
    default:
      return <span className={`${base} bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400`} title="Not a zk-chat post (no membership-proof envelope).">plain msg</span>
  }
}
