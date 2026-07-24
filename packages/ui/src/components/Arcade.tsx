import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '@iconify/react'
import { createPublicClient, http, type Hex, type PublicClient } from 'viem'
import {
  useChainStore,
  selectChain,
  selectTransportUrl,
  selectRpcValid,
} from '../stores/chain'
import { makeWorkerBoard } from '../seams/worker-board'
import { channelToCategory } from '../lib/channel'
import {
  flipOutcome,
  randomSeed,
  encodeFlip,
  decodeFlip,
  type FlipSide,
  type FlipOutcome,
} from '../lib/coinflip'

/**
 * Arcade — a provably-fair coin flip played over the board, the whole thesis of the venue in one
 * tab. The player calls heads or tails; the outcome is the parity of
 * `keccak256(blockHash ‖ clientSeed)` where the block hash is the live chain head (the house can't
 * pick it) and the client seed is the player's (re-rollable). It resolves instantly, keeps a
 * session tally, shows the exact recompute so nothing can be fudged, and can optionally publish
 * each flip to a public board category — demonstrating real board posting (PoW off-thread) and
 * reading (the shared content poll) — before pointing at the full 28+-game arcade.
 *
 * No wallet, no stakes, no new deps. Width note: the root is `w-full` and MUST stay that way — the
 * TryIt shell owns the single max-width; the Arcade must not re-center or cap its own width.
 */

const COINFLIP_CHANNEL = 'coinflip-arcade'
const COINFLIP_CATEGORY = channelToCategory(COINFLIP_CHANNEL)
const FEATURED_GAMES = ['Crash', 'Plinko', 'Mines']

type Head = { hash: Hex; number: bigint }
type Resolved = {
  outcome: FlipOutcome
  pick: FlipSide
  win: boolean
  block: bigint
  houseHash: Hex
  seed: Hex
}
type PostState = 'idle' | 'posting' | 'posted' | 'error'

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))
const short = (h: Hex, n = 10) => `${h.slice(0, n)}…${h.slice(-6)}`
const faceIcon = (s: FlipSide) => (s === 'heads' ? 'mdi:alpha-h-circle' : 'mdi:alpha-t-circle')

export function Arcade({ workerFactory }: { workerFactory?: () => Worker }) {
  const transportUrl = useChainStore((s) => selectTransportUrl(s))
  const chainId = useChainStore((s) => selectChain(s)?.id ?? 0)
  const rpcValid = useChainStore((s) => selectRpcValid(s))
  const content = useChainStore((s) => s.content)
  const globalWorkMultiplier = useChainStore((s) => s.globalWorkMultiplier)
  const globalWorkDivisor = useChainStore((s) => s.globalWorkDivisor)

  const [pick, setPick] = useState<FlipSide>('heads')
  const [clientSeed, setClientSeed] = useState<Hex>(() => randomSeed())
  const [head, setHead] = useState<Head | null>(null)
  const [flipping, setFlipping] = useState(false)
  const [result, setResult] = useState<Resolved | null>(null)
  const [tally, setTally] = useState({ wins: 0, losses: 0 })
  const [publish, setPublish] = useState(false)
  const [posting, setPosting] = useState<PostState>('idle')

  // read-only viem client for the house seed (latest block hash), proxy-aware — same pattern as
  // useAccount. Rebuilt only when the transport or chain changes.
  const client = useMemo<PublicClient | null>(() => {
    if (!transportUrl) return null
    const chain = selectChain(useChainStore.getState())
    return createPublicClient({ chain, transport: http(transportUrl) }) as PublicClient
  }, [transportUrl, chainId])

  const readHead = async (): Promise<Head | null> => {
    if (!client) return null
    const block = await client.getBlock({ blockTag: 'latest' })
    return block.hash ? { hash: block.hash, number: block.number ?? 0n } : null
  }

  // keep a fresh house seed: fetch on mount/transport change, then poll every 12s.
  useEffect(() => {
    if (!client) {
      setHead(null)
      return
    }
    let cancelled = false
    const tick = async () => {
      try {
        const h = await readHead()
        if (!cancelled && h) setHead(h)
      } catch {
        /* transient rpc failure — keep the last known head */
      }
    }
    void tick()
    const id = setInterval(() => void tick(), 12_000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client])

  // the PoW board seam — grinds off-thread and posts. Reused across flips; only rebuilt on
  // transport/chain/difficulty change (never in the hot flip path).
  const board = useMemo(() => {
    if (!transportUrl) return null
    return makeWorkerBoard({
      rpc: transportUrl,
      chainId,
      workMultiplier: globalWorkMultiplier != null ? Number(globalWorkMultiplier) : 1,
      workDivisor: globalWorkDivisor != null ? Number(globalWorkDivisor) : 1,
      workerFactory,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transportUrl, chainId, globalWorkMultiplier, globalWorkDivisor, workerFactory])

  const postingRef = useRef(false)
  const postFlip = async (res: Resolved) => {
    if (!board || postingRef.current) return
    postingRef.current = true
    setPosting('posting')
    try {
      const data = encodeFlip({
        pick: res.pick,
        side: res.outcome.side,
        win: res.win,
        seed: res.seed,
        block: Number(res.block),
      })
      await board.addMessage({ category: COINFLIP_CATEGORY, data })
      setPosting('posted')
      await delay(800)
      await useChainStore.getState().loadContent()
    } catch {
      setPosting('error')
    } finally {
      postingRef.current = false
    }
  }

  const flip = async () => {
    if (flipping || !rpcValid) return
    setFlipping(true)
    setResult(null)
    setPosting('idle')

    // pull a fresh head at flip time so the house seed can't have been known when the seed was set
    let seedHead = head
    try {
      const h = await readHead()
      if (h) {
        seedHead = h
        setHead(h)
      }
    } catch {
      /* fall back to the last known head */
    }
    if (!seedHead) {
      setFlipping(false)
      return
    }

    const seed = clientSeed
    const outcome = flipOutcome(seedHead.hash, seed)
    const win = outcome.side === pick
    const res: Resolved = {
      outcome,
      pick,
      win,
      block: seedHead.number,
      houseHash: seedHead.hash,
      seed,
    }

    await delay(1100) // let the coin spin
    setResult(res)
    setTally((t) => ({ wins: t.wins + (win ? 1 : 0), losses: t.losses + (win ? 0 : 1) }))
    setFlipping(false)
    if (publish) void postFlip(res)
    // rotate the seed so the next flip is independent even inside the same block
    setClientSeed(randomSeed())
  }

  // recent public flips, decoded from the shared content poll (real board reads, not local state)
  const feed = useMemo(() => {
    const msgs = content?.[COINFLIP_CATEGORY] ?? []
    return msgs
      .map((m) => decodeFlip(m.data))
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .slice(-8)
      .reverse()
  }, [content])

  const total = tally.wins + tally.losses
  const coinFace: FlipSide = result?.outcome.side ?? pick

  return (
    <div className="flex w-full flex-col gap-4">
      {/* coin spin keyframes — scoped to this component */}
      <style>{`
        @keyframes arcade-coin-spin { from { transform: rotateY(0deg) } to { transform: rotateY(1980deg) } }
        .arcade-coin-flipping { animation: arcade-coin-spin 1.1s cubic-bezier(.2,.75,.25,1) both }
      `}</style>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {/* ── the game ─────────────────────────────────────────────── */}
        <div className="flex flex-col items-center gap-4 rounded-xl border border-gray-300 bg-gray-50 p-5 dark:border-gray-600 dark:bg-gray-900">
          <div className="flex w-full items-center justify-between text-xs font-medium">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-1 text-emerald-600 ring-1 ring-emerald-500/30 dark:text-emerald-400">
              <Icon icon="mdi:shield-check-outline" className="size-3.5" />
              provably fair
            </span>
            <span className="text-gray-500 dark:text-gray-400">
              {head ? `head #${head.number.toString()}` : 'reading head…'}
            </span>
          </div>

          {/* the coin */}
          <div className="grid size-32 place-items-center [perspective:800px]">
            <div
              className={`grid size-32 place-items-center rounded-full bg-gradient-to-br shadow-lg ${
                flipping ? 'arcade-coin-flipping' : ''
              } ${
                result
                  ? result.win
                    ? 'from-emerald-300 to-emerald-600 shadow-emerald-500/30'
                    : 'from-rose-300 to-rose-600 shadow-rose-500/30'
                  : 'from-indigo-300 to-indigo-600 shadow-indigo-500/30'
              }`}>
              <Icon icon={faceIcon(coinFace)} className="size-16 text-white/95" />
            </div>
          </div>

          {/* result line */}
          <div className="flex h-6 items-center text-sm font-semibold">
            {flipping ? (
              <span className="text-gray-500 dark:text-gray-400">flipping…</span>
            ) : result ? (
              <span className={result.win ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}>
                {result.outcome.side === 'heads' ? 'Heads' : 'Tails'} — you {result.win ? 'won' : 'lost'}
              </span>
            ) : (
              <span className="text-gray-500 dark:text-gray-400">call it and flip</span>
            )}
          </div>

          {/* pick + flip */}
          <div className="flex w-full flex-col gap-2">
            <div className="grid grid-cols-2 gap-2">
              {(['heads', 'tails'] as const).map((side) => {
                const on = pick === side
                return (
                  <button
                    key={side}
                    onClick={() => setPick(side)}
                    disabled={flipping}
                    className={`inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium capitalize transition disabled:opacity-50 ${
                      on
                        ? 'bg-indigo-600 text-white ring-1 ring-indigo-600'
                        : 'text-gray-600 ring-1 ring-gray-300 hover:ring-gray-400 dark:text-gray-300 dark:ring-gray-600'
                    }`}>
                    <Icon icon={faceIcon(side)} className="size-4" />
                    {side}
                  </button>
                )
              })}
            </div>
            <button
              onClick={() => void flip()}
              disabled={flipping || !rpcValid}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white shadow transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50">
              <Icon icon={flipping ? 'mdi:loading' : 'mdi:cash-multiple'} className={`size-4 ${flipping ? 'animate-spin' : ''}`} />
              {flipping ? 'Flipping…' : 'Flip the coin'}
            </button>
          </div>

          {/* tally */}
          <div className="flex w-full items-center justify-around border-t border-gray-200 pt-3 text-center dark:border-gray-700">
            <div>
              <div className="text-lg font-bold text-emerald-600 dark:text-emerald-400">{tally.wins}</div>
              <div className="text-[11px] uppercase tracking-wide text-gray-400">wins</div>
            </div>
            <div>
              <div className="text-lg font-bold text-rose-600 dark:text-rose-400">{tally.losses}</div>
              <div className="text-[11px] uppercase tracking-wide text-gray-400">losses</div>
            </div>
            <div>
              <div className="text-lg font-bold text-gray-700 dark:text-gray-200">
                {total ? Math.round((tally.wins / total) * 100) : 0}%
              </div>
              <div className="text-[11px] uppercase tracking-wide text-gray-400">win rate</div>
            </div>
          </div>
        </div>

        {/* ── provably-fair panel + inputs ─────────────────────────── */}
        <div className="flex flex-col gap-3 rounded-xl border border-gray-300 bg-white p-5 dark:border-gray-600 dark:bg-gray-950">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-800 dark:text-gray-100">
            <Icon icon="mdi:calculator-variant-outline" className="size-4 text-indigo-500" />
            Verify it yourself
          </h3>
          <p className="text-xs leading-relaxed text-gray-500 dark:text-gray-400">
            Neither side can bias this. The <span className="font-medium text-gray-700 dark:text-gray-300">house seed</span> is a
            public block hash you didn't choose; the <span className="font-medium text-gray-700 dark:text-gray-300">client seed</span> is
            yours. The face is the parity of <code className="rounded bg-gray-100 px-1 font-mono text-[11px] dark:bg-gray-800">keccak256(blockHash ‖ clientSeed)</code> —
            even is Heads, odd is Tails. Recompute it and check.
          </p>

          {/* client seed — editable / re-rollable */}
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-medium uppercase tracking-wide text-gray-400">your client seed (next flip)</span>
            <div className="flex items-center gap-2">
              <input
                value={clientSeed}
                onChange={(e) => setClientSeed((e.target.value || '0x') as Hex)}
                spellCheck={false}
                className="min-w-0 flex-1 rounded-md border border-gray-300 bg-gray-50 px-2 py-1.5 font-mono text-[11px] text-gray-700 outline-none focus:border-indigo-400 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200"
              />
              <button
                onClick={() => setClientSeed(randomSeed())}
                disabled={flipping}
                title="re-roll your seed"
                className="grid size-8 shrink-0 place-items-center rounded-md text-gray-500 ring-1 ring-gray-300 transition hover:text-indigo-500 hover:ring-indigo-400 disabled:opacity-50 dark:ring-gray-600">
                <Icon icon="mdi:dice-multiple-outline" className="size-4" />
              </button>
            </div>
          </label>

          {/* the recompute for the last flip */}
          {result ? (
            <div className="flex flex-col gap-2 rounded-lg bg-gray-50 p-3 text-[11px] dark:bg-gray-900">
              <Row label={`house seed (block #${result.block.toString()})`} value={short(result.houseHash)} />
              <Row label="client seed" value={short(result.seed)} />
              <Row label="keccak digest" value={short(result.outcome.digest)} />
              <div className="flex items-center justify-between border-t border-gray-200 pt-2 dark:border-gray-700">
                <span className="text-gray-500 dark:text-gray-400">parity → face</span>
                <span className="font-mono font-semibold text-gray-800 dark:text-gray-100">
                  {(BigInt(result.outcome.digest) & 1n).toString()} → {result.outcome.side}
                </span>
              </div>
            </div>
          ) : (
            <div className="rounded-lg bg-gray-50 p-3 text-[11px] text-gray-400 dark:bg-gray-900">
              Flip once to see the exact inputs and the recompute.
            </div>
          )}
        </div>
      </div>

      {/* ── board showcase: publish toggle + live feed ─────────────── */}
      <div className="flex flex-col gap-3 rounded-xl border border-gray-300 bg-gray-50 p-5 dark:border-gray-600 dark:bg-gray-900">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-800 dark:text-gray-100">
            <Icon icon="mdi:access-point" className="size-4 text-indigo-500" />
            Recent flips on the board
            <span className="font-mono text-[11px] font-normal text-gray-400">#{COINFLIP_CHANNEL}</span>
          </h3>
          <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-gray-600 dark:text-gray-300">
            <input
              type="checkbox"
              checked={publish}
              onChange={(e) => setPublish(e.target.checked)}
              className="size-4 accent-indigo-600"
            />
            Publish my flips (PoW-stamped, off-thread)
            {posting === 'posting' && <span className="text-indigo-500">· posting…</span>}
            {posting === 'posted' && <span className="text-emerald-500">· posted ✓</span>}
            {posting === 'error' && <span className="text-rose-500">· post failed</span>}
          </label>
        </div>
        {feed.length ? (
          <ul className="flex flex-col divide-y divide-gray-200 text-xs dark:divide-gray-700">
            {feed.map((r, i) => (
              <li key={i} className="flex items-center justify-between py-1.5">
                <span className="inline-flex items-center gap-1.5 text-gray-600 dark:text-gray-300">
                  <Icon icon={faceIcon(r.side)} className={`size-4 ${r.win ? 'text-emerald-500' : 'text-rose-500'}`} />
                  called <span className="font-medium capitalize">{r.pick}</span> · landed{' '}
                  <span className="font-medium capitalize">{r.side}</span>
                </span>
                <span className="flex items-center gap-2">
                  <span className="font-mono text-gray-400">blk {r.block || '?'}</span>
                  <span className={`rounded-full px-2 py-0.5 font-medium ${r.win ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-rose-500/10 text-rose-600 dark:text-rose-400'}`}>
                    {r.win ? 'won' : 'lost'}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-gray-400">
            No public flips yet. Tick <span className="font-medium">Publish my flips</span> and flip — it posts a PoW-stamped
            record to the <span className="font-mono">{COINFLIP_CHANNEL}</span> category, then reads it back from the shared board poll.
          </p>
        )}
      </div>

      {/* ── the real venue ───────────────────────────────────────── */}
      <div
        className="relative overflow-hidden rounded-xl px-5 py-6 text-white ring-1 ring-amber-400/30"
        style={{ background: 'linear-gradient(180deg,#11301d,#0b2014)' }}>
        <div
          className="pointer-events-none absolute inset-0"
          style={{ background: 'radial-gradient(70% 60% at 50% 0%, rgba(224,168,52,0.16), transparent 70%)' }}
        />
        <div className="relative flex flex-col items-center gap-3 text-center sm:flex-row sm:justify-between sm:text-left">
          <div>
            <p className="text-sm font-semibold">
              This inline flip is a for-fun taste. The full{' '}
              <span className="bg-gradient-to-br from-amber-200 via-amber-400 to-orange-500 bg-clip-text text-transparent">
                MsgBoard Arcade
              </span>{' '}
              is 28+ provably-fair games with real on-chain settlement.
            </p>
            <p className="mt-1 text-xs text-gray-300">
              {FEATURED_GAMES.map((g, i) => (
                <span key={g}>
                  {i > 0 && ' · '}
                  <span className="font-medium text-amber-200">{g}</span>
                </span>
              ))}
              {' '}and more — every draw ships a receipt your browser re-checks against the chain.
            </p>
          </div>
          <a
            href="https://games.msgboard.xyz"
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 rounded-full bg-amber-400 px-6 py-2.5 text-sm font-semibold text-gray-950 shadow-lg shadow-amber-500/20 transition hover:bg-amber-300">
            Enter the full arcade →
          </a>
        </div>
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-gray-500 dark:text-gray-400">{label}</span>
      <span className="font-mono text-gray-700 dark:text-gray-200">{value}</span>
    </div>
  )
}
