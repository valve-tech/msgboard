import { useEffect, useMemo, useState } from 'react'
import { Icon } from '@iconify/react'
import {
  useChainStore,
  selectChain,
  selectTransportUrl,
  selectRpcValid,
} from '../stores/chain'
import { makeWorkerBoard } from '../seams/worker-board'
import { shortHex, type FlipSide, type FlipFeedRecord } from '../lib/coinflip'
import type { FlipResult, FlipStep } from '../lib/arcade-engine'

/**
 * Arcade — a genuinely provably-fair coin flip, played as a REAL board-mediated commit-reveal round
 * against a house bot, at ZERO stakes (play-money). The player calls heads or tails; the house commits
 * its server seed (publishing only its hash) BEFORE the player reveals its client seed, so neither side
 * can grind the 50/50. Every step is a public, PoW-stamped, EIP-712-co-signed board message — the whole
 * handshake IS the showcase — and anyone can recompute the outcome from the signed transcript.
 *
 * The heavy engine (`@msgboard/games` + `@msgboard/settle`) is LAZY-LOADED (dynamic import) so it only
 * enters the bundle when this tab opens. No wallet, no on-chain, no funds — an ephemeral key co-signs.
 *
 * Width note: the root is `w-full` and MUST stay that way — the TryIt shell owns the single max-width;
 * the Arcade must not re-center or cap its own width.
 */

/** The runtime type of the lazily-imported engine module (type-only — erased, no bundle cost). */
type ArcadeEngine = typeof import('../lib/arcade-engine')

const faceIcon = (s: FlipSide) => (s === 'heads' ? 'mdi:alpha-h-circle' : 'mdi:alpha-t-circle')

/** The four public handshake milestones, in order, with their showcase copy. */
const STEPS: ReadonlyArray<{ id: FlipStep; icon: string; title: string; detail: string }> = [
  { id: 'commit', icon: 'mdi:lock-outline', title: 'You commit', detail: 'post the sealed hash of your client seed to the board' },
  { id: 'grant', icon: 'mdi:handshake-outline', title: 'House commits blind', detail: 'signs OpenTerms carrying only the hash of its server seed' },
  { id: 'reveal', icon: 'mdi:key-outline', title: 'You reveal', detail: 'send your client seed; both sides co-sign the round' },
  { id: 'transcript', icon: 'mdi:file-certificate-outline', title: 'Settled on the board', detail: 'the doubly-signed transcript lands, publicly re-auditable' },
]

const FEATURED_GAMES = ['Crash', 'Plinko', 'Mines']
const STARTING_BALANCE = 1000n

export function Arcade({ workerFactory }: { workerFactory?: () => Worker }) {
  const transportUrl = useChainStore((s) => selectTransportUrl(s))
  const chainId = useChainStore((s) => selectChain(s)?.id ?? 0)
  const rpcValid = useChainStore((s) => selectRpcValid(s))
  const content = useChainStore((s) => s.content)
  const globalWorkMultiplier = useChainStore((s) => s.globalWorkMultiplier)
  const globalWorkDivisor = useChainStore((s) => s.globalWorkDivisor)

  // The engine is lazy-loaded on mount (tab open) so the landing bundle stays lean.
  const [eng, setEng] = useState<ArcadeEngine | null>(null)
  useEffect(() => {
    let alive = true
    void import('../lib/arcade-engine')
      .then((m) => { if (alive) setEng(m) })
      .catch(() => { if (alive) setEng(null) })
    return () => { alive = false }
  }, [])

  const [pick, setPick] = useState<FlipSide>('heads')
  const [flipping, setFlipping] = useState(false)
  const [reached, setReached] = useState<FlipStep[]>([])
  const [result, setResult] = useState<FlipResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [balance, setBalance] = useState<bigint>(STARTING_BALANCE)
  const [tally, setTally] = useState({ wins: 0, losses: 0 })

  // The PoW board seam — grinds off-thread and posts. Rebuilt only on transport/chain/difficulty change.
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

  const flip = async () => {
    if (flipping || !rpcValid || !board || !eng) return
    setFlipping(true)
    setResult(null)
    setError(null)
    setReached([])
    try {
      // A fresh session: OPEN (nonce 0) + ROUND (nonce 1) → a co-signed transcript. The engine drives
      // the real handshake over the board; the outcome is read from the co-signed ROUND state, never
      // fabricated. Publishing is MANDATORY — the handshake IS the on-board round.
      const res = await eng.runBoardFlip({
        board: board as unknown as Parameters<ArcadeEngine['runBoardFlip']>[0]['board'],
        chainId,
        pick,
        onStep: (s) => setReached((r) => (r.includes(s) ? r : [...r, s])),
      })
      setResult(res)
      setBalance((b) => b + res.playerDelta)
      setTally((t) => ({ wins: t.wins + (res.win ? 1 : 0), losses: t.losses + (res.win ? 0 : 1) }))
      // Best-effort: pull the just-posted round back off the board for the public feed.
      void useChainStore.getState().loadContent()
    } catch {
      // Liveness: a withheld/absent house reveal stalls the round. No stakes were at risk, and the
      // partial handshake is publicly visible on the board — void it and let the player retry cleanly.
      setError('The house bot didn’t respond — this round is void (no stakes were at risk). Try again.')
    } finally {
      setFlipping(false)
    }
  }

  // Recent public flips, decoded from the shared content poll — REAL board reads recomputed from the
  // co-signed transcripts on the landing category, not local state. Empty until the engine loads.
  const feed = useMemo<FlipFeedRecord[]>(() => {
    if (!eng || !chainId) return []
    const msgs = content?.[eng.landingCategoryHash(chainId)] ?? []
    return eng.decodeFeed(msgs)
  }, [content, eng, chainId])

  const total = tally.wins + tally.losses
  const coinFace: FlipSide = result?.side ?? pick
  const parity = result ? (result.raw & 1n).toString() : null

  return (
    <div className="flex w-full flex-col gap-4">
      {/* coin spin keyframes — scoped to this component; loops while the handshake runs */}
      <style>{`
        @keyframes arcade-coin-spin { from { transform: rotateY(0deg) } to { transform: rotateY(360deg) } }
        .arcade-coin-flipping { animation: arcade-coin-spin 0.9s linear infinite }
      `}</style>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {/* ── the game ─────────────────────────────────────────────── */}
        <div className="flex flex-col items-center gap-4 rounded-xl border border-gray-300 bg-gray-50 p-5 dark:border-gray-600 dark:bg-gray-900">
          <div className="flex w-full items-center justify-between text-xs font-medium">
            <span
              title={
                'Provably fair by COMMIT-REVEAL, played on msgboard against a house bot.\n' +
                '• The house commits its server seed first — it publishes only keccak256(serverSeed) in the signed OpenTerms.\n' +
                '• Only THEN do you reveal your client seed. Since neither side knows the other’s secret when it commits, neither can grind the 50/50.\n' +
                '• The house then reveals its server seed; your client re-derives the outcome and co-signs ONLY if keccak256(serverSeed) matches the commit AND the round used the exact client seed you committed.\n' +
                'Every step is a public, signed board message — recompute it yourself from the transcript (see the Verify panel).'
              }
              className="inline-flex cursor-help items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-1 text-emerald-600 underline decoration-dotted decoration-emerald-500/40 underline-offset-2 ring-1 ring-emerald-500/30 dark:text-emerald-400">
              <Icon icon="mdi:shield-check-outline" className="size-3.5" />
              provably fair
              <Icon icon="mdi:help-circle-outline" className="size-3 opacity-60" />
            </span>
            <span className="inline-flex items-center gap-1.5 text-gray-500 dark:text-gray-400">
              <Icon icon="mdi:poker-chip" className="size-3.5 text-amber-500" />
              {balance.toString()} fun-chips
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
              <span className="text-gray-500 dark:text-gray-400">running the handshake…</span>
            ) : error ? (
              <span className="text-amber-600 dark:text-amber-400">round void</span>
            ) : result ? (
              <span className={result.win ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}>
                {result.side === 'heads' ? 'Heads' : 'Tails'} — you {result.win ? 'won' : 'lost'} {result.stake.toString()}
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
              disabled={flipping || !rpcValid || !board || !eng}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white shadow transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50">
              <Icon icon={flipping ? 'mdi:loading' : 'mdi:cash-multiple'} className={`size-4 ${flipping ? 'animate-spin' : ''}`} />
              {flipping ? 'Playing on the board…' : !eng ? 'Loading the engine…' : error ? 'Try again' : 'Flip the coin'}
            </button>
            {error && <p className="text-center text-[11px] text-amber-600 dark:text-amber-400">{error}</p>}
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

        {/* ── the handshake showcase (the point of the venue) ──────── */}
        <div className="flex flex-col gap-3 rounded-xl border border-gray-300 bg-white p-5 dark:border-gray-600 dark:bg-gray-950">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-800 dark:text-gray-100">
            <Icon icon="mdi:swap-horizontal-bold" className="size-4 text-indigo-500" />
            The commit-reveal handshake
          </h3>
          <p className="text-xs leading-relaxed text-gray-500 dark:text-gray-400">
            This isn’t a solo demo — it’s a real round played over msgboard against a house bot. The house
            commits its server seed <span className="font-medium text-gray-700 dark:text-gray-300">first</span> (it
            publishes only the hash), so it can’t react to your seed; you reveal
            <span className="font-medium text-gray-700 dark:text-gray-300"> only after</span> that commit is signed,
            so you can’t grind against a known server seed. Neither side can bias the 50/50.
          </p>
          <ol className="flex flex-col gap-2">
            {STEPS.map((step, i) => {
              const done = reached.includes(step.id) || (!!result && !error)
              const active = flipping && reached.length === i
              return (
                <li key={step.id} className="flex items-start gap-3">
                  <span
                    className={`mt-0.5 grid size-6 shrink-0 place-items-center rounded-full ring-1 transition ${
                      done
                        ? 'bg-emerald-500/10 text-emerald-600 ring-emerald-500/40 dark:text-emerald-400'
                        : active
                          ? 'bg-indigo-500/10 text-indigo-600 ring-indigo-500/40 dark:text-indigo-400'
                          : 'text-gray-400 ring-gray-300 dark:ring-gray-600'
                    }`}>
                    <Icon icon={done ? 'mdi:check' : active ? 'mdi:loading' : step.icon} className={`size-3.5 ${active ? 'animate-spin' : ''}`} />
                  </span>
                  <div className="flex flex-col">
                    <span className={`text-xs font-medium ${done || active ? 'text-gray-800 dark:text-gray-100' : 'text-gray-500 dark:text-gray-400'}`}>
                      {step.title}
                    </span>
                    <span className="text-[11px] text-gray-400">{step.detail}</span>
                  </div>
                </li>
              )
            })}
          </ol>
        </div>
      </div>

      {/* ── verify panel: recompute the flip from the co-signed transcript ─────── */}
      <div className="flex flex-col gap-3 rounded-xl border border-gray-300 bg-white p-5 dark:border-gray-600 dark:bg-gray-950">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-800 dark:text-gray-100">
          <Icon icon="mdi:calculator-variant-outline" className="size-4 text-indigo-500" />
          Verify it yourself
        </h3>
        <p className="text-xs leading-relaxed text-gray-500 dark:text-gray-400">
          Every value below is read from the doubly-co-signed transcript on the board. The house’s
          <span className="font-medium text-gray-700 dark:text-gray-300"> server seed</span> was fixed by its
          commit <code className="rounded bg-gray-100 px-1 font-mono text-[11px] dark:bg-gray-800">rngCommit = keccak256(serverSeed)</code>
          {' '}before your <span className="font-medium text-gray-700 dark:text-gray-300">client seed</span> was revealed. The face is the
          parity of <code className="rounded bg-gray-100 px-1 font-mono text-[11px] dark:bg-gray-800">raw = keccak256(serverSeed ‖ clientSeed ‖ nonce)</code> —
          even is Heads, odd is Tails. Check the reveal against the commit and recompute.
        </p>

        {result ? (
          <div className="flex flex-col gap-2 rounded-lg bg-gray-50 p-3 text-[11px] dark:bg-gray-900">
            <Row label="rngCommit (house, at open)" value={shortHex(result.rngCommit)} />
            <div className="flex items-center justify-between gap-2">
              <span className="text-gray-500 dark:text-gray-400">serverSeed (revealed)</span>
              <span className="flex items-center gap-1.5">
                <span className="font-mono text-gray-700 dark:text-gray-200">{shortHex(result.serverSeed)}</span>
                <span className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 font-medium ${result.commitOk ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-rose-500/10 text-rose-600 dark:text-rose-400'}`}>
                  <Icon icon={result.commitOk ? 'mdi:check-circle-outline' : 'mdi:alert-circle-outline'} className="size-3" />
                  keccak {result.commitOk ? '= commit' : '≠ commit'}
                </span>
              </span>
            </div>
            <Row label="clientSeed (yours)" value={shortHex(result.clientSeed)} />
            <Row label="raw" value={shortHex(`0x${result.raw.toString(16)}` as `0x${string}`)} />
            <div className="flex items-center justify-between border-t border-gray-200 pt-2 dark:border-gray-700">
              <span className="text-gray-500 dark:text-gray-400">parity → face</span>
              <span className="font-mono font-semibold text-gray-800 dark:text-gray-100">
                {parity} → {result.side}
              </span>
            </div>
          </div>
        ) : (
          <div className="rounded-lg bg-gray-50 p-3 text-[11px] text-gray-400 dark:bg-gray-900">
            Flip once to see the co-signed seeds and the recompute.
          </div>
        )}
      </div>

      {/* ── board showcase: live feed of recent rounds ─────────────── */}
      <div className="flex flex-col gap-3 rounded-xl border border-gray-300 bg-gray-50 p-5 dark:border-gray-600 dark:bg-gray-900">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-800 dark:text-gray-100">
          <Icon icon="mdi:access-point" className="size-4 text-indigo-500" />
          Recent flips on the board
          <span className="font-mono text-[11px] font-normal text-gray-400">landing:{chainId || '?'}</span>
        </h3>
        {feed.length ? (
          <ul className="flex flex-col divide-y divide-gray-200 text-xs dark:divide-gray-700">
            {feed.map((r) => (
              <li key={r.tableId} className="flex items-center justify-between py-1.5">
                <span className="inline-flex items-center gap-1.5 text-gray-600 dark:text-gray-300">
                  <Icon icon={faceIcon(r.side)} className={`size-4 ${r.win ? 'text-emerald-500' : 'text-rose-500'}`} />
                  called <span className="font-medium capitalize">{r.pick}</span> · landed{' '}
                  <span className="font-medium capitalize">{r.side}</span>
                </span>
                <span className="flex items-center gap-2">
                  <span className="font-mono text-gray-400">{shortHex(r.tableId, 8)}</span>
                  <span className={`rounded-full px-2 py-0.5 font-medium ${r.win ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-rose-500/10 text-rose-600 dark:text-rose-400'}`}>
                    {r.win ? 'won' : 'lost'}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-gray-400">
            No public rounds yet. Every flip posts its full commit-reveal handshake (PoW-stamped, off-thread)
            to this chain’s landing category, then reads the co-signed transcripts back from the shared board poll.
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
              This flip is the real protocol at zero stakes. The full{' '}
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
              {' '}and more — every round ships a signed transcript your browser re-checks against the chain.
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
