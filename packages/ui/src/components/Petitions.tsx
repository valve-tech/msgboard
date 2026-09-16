import { useEffect, useMemo, useState } from 'react'
import { Icon } from '@iconify/react'
import { createWalletClient, custom, type Hex } from 'viem'
import {
  type Petition,
  readPetitions,
  readPetitionSignatures,
  tally,
  signPetition,
  PETITION_DOMAIN_NAME,
  PETITION_DOMAIN_VERSION,
  PETITION_TYPES,
  deployments,
} from '@msgboard/petition'
import type { Content } from '@msgboard/sdk'
import {
  useChainStore,
  selectChain,
  selectTransportUrl,
  selectRpcValid,
} from '../stores/chain'
import { makeWorkerBoard, type BoardClient } from '../seams/worker-board'
import { connectInjectedWallet, getInjectedProvider } from '../lib/wallet'
import { shortHex } from '../lib/coinflip'

/**
 * Petitions — a compact teaser of the full petition.msgboard.xyz app: a featured petition read
 * straight off the board, a wallet-signed co-sign posted inline (PoW-stamped, off the main thread),
 * and a prominent link out to the full app for browsing/creating/settling.
 *
 * Reuses the SAME plumbing every other tab in this shell uses — no new infra:
 *   - `makeWorkerBoard` (this package's worker-driven PoW board seam) for the WRITE path (signing).
 *   - The chain store's already-polled `content` (the 20s poll every tab shares) for the READ path —
 *     wrapped as a tiny read-only `BoardClient` so `@msgboard/petition`'s own `readPetitions` /
 *     `readPetitionSignatures` / `tally` do the decode+dedupe, never reimplemented here. This costs
 *     ZERO extra RPC calls; it just replays the poll's own snapshot.
 *   - `connectInjectedWallet` (the same helper Arcade's "Get chips" flow uses).
 *
 * Honesty note: the count shown here is the CAPTURED count — anyone can post a SignatureRecord
 * naming any signer, so this is "posted", not verified. The full app (petition.msgboard.xyz) is
 * where every signature gets client-recomputed against the EIP-712 digest (the trustless number)
 * and, once a verifier is deployed, settled on-chain. We label the count accordingly and never
 * present it as authoritative.
 */

const READ_WINDOW_DAYS = 3
const FULL_APP_URL = 'https://petition.msgboard.xyz'

/**
 * Per-chain PetitionSignatures verifier address. Env override first (explicit literal
 * `import.meta.env.X` accesses so Vite can statically inline them), else `@msgboard/petition`'s
 * `deployments` map. Null means "not deployed on this chain yet" — signing is disabled with an
 * honest message rather than guessing an address (mirrors petition-web's `petitionAddressFor`).
 */
const ADDR_ENV: Record<number, string | undefined> = {
  369: import.meta.env.VITE_PETITION_ADDR_369,
  943: import.meta.env.VITE_PETITION_ADDR_943,
}
const petitionAddressFor = (chainId: number): Hex | null =>
  (ADDR_ENV[chainId] as Hex | undefined) ?? deployments[chainId]?.address ?? null

export function Petitions({ workerFactory }: { workerFactory?: () => Worker }) {
  const transportUrl = useChainStore((s) => selectTransportUrl(s))
  const chainId = useChainStore((s) => selectChain(s)?.id ?? 0)
  const rpcValid = useChainStore((s) => selectRpcValid(s))
  const content = useChainStore((s) => s.content)
  const globalWorkMultiplier = useChainStore((s) => s.globalWorkMultiplier)
  const globalWorkDivisor = useChainStore((s) => s.globalWorkDivisor)

  // The WRITE-capable board — grinds PoW off-thread and posts. Only touched by the sign action.
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

  // A read-only BoardClient backed by the app-wide 20s-polled `content` cache — no extra RPC calls,
  // just lets @msgboard/petition's own readers decode/dedupe the same snapshot every other tab uses.
  const cacheBoard = useMemo<BoardClient>(
    () => ({
      addMessage: () => Promise.reject(new Error('Petitions: cacheBoard is read-only')),
      content: async ({ category }) => ({ [category]: content?.[category] ?? [] }) as Content,
    }),
    [content],
  )

  const [petitions, setPetitions] = useState<Petition[]>([])
  const [selectedId, setSelectedId] = useState<Hex | null>(null)
  const [listError, setListError] = useState<string | null>(null)

  // Sweep the petition index off the cached content — cheap (in-memory), refreshes whenever the
  // page's own poll refreshes `content` or the active chain changes.
  useEffect(() => {
    let alive = true
    void readPetitions(cacheBoard, READ_WINDOW_DAYS)
      .then((all) => {
        if (!alive) return
        const onThisChain = all.filter((p) => p.chainId === chainId).sort((a, b) => b.createdAt - a.createdAt)
        setPetitions(onThisChain)
        setListError(null)
        setSelectedId((cur) => (cur && onThisChain.some((p) => p.id === cur) ? cur : (onThisChain[0]?.id ?? null)))
      })
      .catch(() => {
        if (alive) setListError('Could not read the petition index from the board.')
      })
    return () => {
      alive = false
    }
  }, [cacheBoard, chainId])

  const featured = useMemo(
    () => petitions.find((p) => p.id === selectedId) ?? petitions[0] ?? null,
    [petitions, selectedId],
  )

  const [count, setCount] = useState<number | null>(null)
  useEffect(() => {
    let alive = true
    if (!featured) {
      setCount(null)
      return
    }
    void readPetitionSignatures(cacheBoard, featured.id, READ_WINDOW_DAYS)
      .then((records) => {
        if (alive) setCount(tally(records).count)
      })
      .catch(() => {
        if (alive) setCount(null)
      })
    return () => {
      alive = false
    }
  }, [cacheBoard, featured])

  const verifyingContract = useMemo(() => petitionAddressFor(chainId), [chainId])

  const [wallet, setWallet] = useState<{ address: Hex } | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [walletError, setWalletError] = useState<string | null>(null)
  const [signing, setSigning] = useState(false)
  const [signed, setSigned] = useState(false)
  const [signError, setSignError] = useState<string | null>(null)

  const connectWallet = async () => {
    setConnecting(true)
    setWalletError(null)
    try {
      const w = await connectInjectedWallet()
      setWallet({ address: w.address })
    } catch (e) {
      setWalletError(e instanceof Error ? e.message : 'Failed to connect wallet.')
    } finally {
      setConnecting(false)
    }
  }

  const sign = async () => {
    if (!board || !wallet || !featured || !verifyingContract) return
    setSigning(true)
    setSignError(null)
    try {
      const provider = getInjectedProvider()
      if (!provider) throw new Error('No injected wallet found.')
      const walletClient = createWalletClient({ account: wallet.address, transport: custom(provider) })
      // `signPetition` recomputes the EIP-712 digest internally and passes it to `sign`; we ignore
      // that raw digest arg and instead reconstruct the identical typed data so any wallet's
      // standard `eth_signTypedData_v4` flow works (same approach petition-web's `signTyped` uses —
      // the wallet computes the SAME hash `petitionDigest` would, since domain+types+message match).
      await signPetition(board, featured, verifyingContract, () =>
        walletClient.signTypedData({
          account: wallet.address,
          domain: {
            name: PETITION_DOMAIN_NAME,
            version: PETITION_DOMAIN_VERSION,
            chainId: featured.chainId,
            verifyingContract,
          },
          types: PETITION_TYPES,
          primaryType: 'Petition',
          message: { petitionId: featured.id, statement: featured.statement },
        }),
      )
      setSigned(true)
      // Force the app-wide content poll to refresh now — the cache-backed reader above re-tallies
      // automatically once `content` updates (no separate poll of our own).
      void useChainStore.getState().loadContent()
    } catch (e) {
      setSignError(e instanceof Error ? e.message : 'Failed to sign & post — try again.')
    } finally {
      setSigning(false)
    }
  }

  return (
    <div className="flex w-full flex-col gap-4">
      <div className="flex flex-col gap-3 rounded-xl border border-gray-300 bg-white p-5 dark:border-gray-600 dark:bg-gray-950">
        <div className="flex items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-800 dark:text-gray-100">
            <Icon icon="mdi:file-sign-outline" className="size-4 text-indigo-500" />
            Featured petition
          </h3>
          <span className="font-mono text-[11px] text-gray-400">chain:{chainId || '?'}</span>
        </div>

        {!featured ? (
          <p className="rounded-lg bg-gray-50 p-3 text-xs text-gray-400 dark:bg-gray-900">
            {listError ??
              `No petitions posted on this chain in the last ${READ_WINDOW_DAYS} days. Be the first over on the full app.`}
          </p>
        ) : (
          <>
            <blockquote className="rounded-lg bg-gray-50 p-3 text-sm text-gray-700 dark:bg-gray-900 dark:text-gray-200">
              “{featured.statement}”
            </blockquote>
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-gray-500 dark:text-gray-400">
              <span
                className="inline-flex items-center gap-1.5"
                title="Posted SignatureRecords for this petition, deduped by signer — ANYONE can post a record naming any signer, so this is a CAPTURED count, not a verified one. The full app recomputes each signature against the EIP-712 digest before counting it as trustless.">
                <Icon icon="mdi:pencil-outline" className="size-3.5" />
                {count == null ? '…' : count} signed <span className="opacity-70">(posted, unverified)</span>
                <Icon icon="mdi:help-circle-outline" className="size-3 opacity-60" />
              </span>
              <span className="inline-flex items-center gap-1 font-mono">
                <Icon icon="mdi:identifier" className="size-3.5" />
                {shortHex(featured.id, 8)}
              </span>
            </div>

            {petitions.length > 1 && (
              <div className="flex flex-wrap gap-1.5">
                {petitions.slice(0, 5).map((p) => (
                  <button
                    key={p.id}
                    onClick={() => setSelectedId(p.id)}
                    className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition ${
                      p.id === featured.id
                        ? 'bg-indigo-600 text-white'
                        : 'text-gray-600 ring-1 ring-gray-300 hover:ring-gray-400 dark:text-gray-300 dark:ring-gray-600'
                    }`}>
                    {p.statement.length > 28 ? `${p.statement.slice(0, 28)}…` : p.statement}
                  </button>
                ))}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2 border-t border-gray-200 pt-3 dark:border-gray-700">
              {!verifyingContract ? (
                <span className="text-[11px] text-amber-600 dark:text-amber-400">
                  Signing isn’t enabled on chain {chainId} yet — no PetitionSignatures verifier is deployed here.
                  Sign over on the full app once it’s live.
                </span>
              ) : !wallet ? (
                <button
                  onClick={() => void connectWallet()}
                  disabled={connecting}
                  className="inline-flex items-center gap-1 rounded-full bg-indigo-500/10 px-2.5 py-1 text-xs text-indigo-600 ring-1 ring-indigo-500/30 transition disabled:cursor-not-allowed disabled:opacity-50 dark:text-indigo-400">
                  <Icon icon={connecting ? 'mdi:loading' : 'mdi:wallet-outline'} className={`size-3.5 ${connecting ? 'animate-spin' : ''}`} />
                  {connecting ? 'Connecting…' : 'Connect wallet'}
                </button>
              ) : signed ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-600 ring-1 ring-emerald-500/30 dark:text-emerald-400">
                  <Icon icon="mdi:check" className="size-3.5" />
                  Signed — posted to the board
                </span>
              ) : (
                <button
                  onClick={() => void sign()}
                  disabled={signing || !board}
                  className="inline-flex items-center gap-1.5 rounded-full bg-emerald-600 px-3.5 py-1.5 text-xs font-semibold text-white shadow transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50">
                  <Icon icon={signing ? 'mdi:loading' : 'mdi:fountain-pen-tip'} className={`size-3.5 ${signing ? 'animate-spin' : ''}`} />
                  {signing ? 'Signing & stamping…' : 'Sign this petition'}
                </button>
              )}
            </div>
            {walletError && <p className="text-[11px] text-amber-600 dark:text-amber-400">{walletError}</p>}
            {signError && <p className="text-[11px] text-amber-600 dark:text-amber-400">{signError}</p>}
          </>
        )}
        {!rpcValid && <p className="text-[11px] text-amber-600 dark:text-amber-400">Pick a valid chain to read the board.</p>}
      </div>

      {/* ── the real venue ───────────────────────────────────────── */}
      <div
        className="relative overflow-hidden rounded-xl px-5 py-6 text-white ring-1 ring-indigo-400/30"
        style={{ background: 'linear-gradient(180deg,#1a1f3d,#0d1024)' }}>
        <div
          className="pointer-events-none absolute inset-0"
          style={{ background: 'radial-gradient(70% 60% at 50% 0%, rgba(99,102,241,0.18), transparent 70%)' }}
        />
        <div className="relative flex flex-col items-center gap-3 text-center sm:flex-row sm:justify-between sm:text-left">
          <div>
            <p className="text-sm font-semibold">
              This is a preview. The full{' '}
              <span className="gradient-text bg-gradient-to-br from-indigo-200 via-indigo-400 to-violet-500">
                Petitions
              </span>{' '}
              app lets anyone create a petition, verify every signature client-side, and settle the
              tally on-chain — permissionless, no gatekeeper.
            </p>
            <p className="mt-1 text-xs text-gray-300">
              Co-signed public statements: sign with your wallet, PoW-stamped to the board, tallied
              verifiably, with permissionless on-chain finality.
            </p>
          </div>
          <a
            href={FULL_APP_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 rounded-full bg-indigo-400 px-6 py-2.5 text-sm font-semibold text-gray-950 shadow-lg shadow-indigo-500/20 transition hover:bg-indigo-300">
            Open the full app →
          </a>
        </div>
      </div>
    </div>
  )
}
