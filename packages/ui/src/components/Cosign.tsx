import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '@iconify/react'
import { createWalletClient, custom, isAddressEqual, recoverAddress, type Hex } from 'viem'
import {
  type SafeTx,
  type SafePublicClient,
  type SignatureRecord,
  SCHEME,
  decodeSafeMeta,
  makeSafeAdapter,
  postSignature,
  safeTransactionDigest,
  encodeSafeMeta,
} from '@msgboard/cosign'
import {
  type CosignShare,
  type FleetSafe,
  type VerifiedShare,
  COSIGN_NAMESPACE,
  cosignCategories,
  fleetSafeFor,
  foldQuorum,
  groupByDigest,
  mergeShares,
  readArchiveShares,
  readBoardShares,
  safeScope,
  verifyShares,
} from '../lib/cosign-feed'
import { useChainStore, selectChain, selectClient, selectRpcValid, selectTransportUrl } from '../stores/chain'
import { makeWorkerBoard } from '../seams/worker-board'
import { connectInjectedWallet, getInjectedProvider } from '../lib/wallet'
import { shortHex } from '../lib/coinflip'
import { Menu } from './Menu'

/**
 * Cosign — the landing teaser for cosign.msgboard.xyz.
 *
 * The tab shows two things about one Safe:
 *
 *   1. A LIVE FEED of co-signature shares as they land on the board. It unions the public archive
 *      (Hasura over `message_archive`) with the app-wide `content` snapshot the chain store already
 *      polls, so an hour-old fleet session and a share posted ten seconds ago both appear.
 *   2. A THRESHOLD WALKTHROUGH of the newest session. The msgboard bot fleet owns two of the three
 *      keys on a 2-of-3 Safe and proposes a benign self-call every hour, so a visitor watches a real
 *      quorum form: propose, co-sign, reach the threshold, aggregate.
 *
 * The tab reuses the same plumbing every other tab in this shell uses — no new infra:
 *   - `makeWorkerBoard` for the WRITE path, so the proof of work grinds in a worker, never on the
 *     main thread.
 *   - The chain store's polled `content` for the fresh half of the READ path (zero extra RPC calls).
 *   - `connectInjectedWallet`, the helper Arcade and Petitions already use.
 *   - The house `Menu` for the window picker. This app bans native form controls.
 *
 * Honesty note: every share is checked with `recoverAddress` in the browser, so a record that names
 * a signer it cannot prove is marked invalid on sight. Owner membership needs the Safe's live owner
 * set, which is a chain read. When that read fails, the tab says the owner set is unknown instead of
 * presenting a quorum it cannot justify.
 */

const FULL_APP_URL = 'https://cosign.msgboard.xyz'

/** Window options for the feed. The fleet posts hourly, so a day already shows several sessions. */
const WINDOWS = [
  { label: 'Last 24 hours', days: 1 },
  { label: 'Last 3 days', days: 3 },
  { label: 'Last 7 days', days: 7 },
] as const

/**
 * The viem typed-data table for a Safe `SafeTx` (v1.3.0 / v1.4.1). `@msgboard/cosign` exports the
 * resulting digest but not the shape, so we replicate it here — the same copy the bot fleet keeps.
 * A parity guardrail below refuses to post whenever this table stops producing the canonical digest.
 */
const SAFE_TX_TYPES = {
  SafeTx: [
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'data', type: 'bytes' },
    { name: 'operation', type: 'uint8' },
    { name: 'safeTxGas', type: 'uint256' },
    { name: 'baseGas', type: 'uint256' },
    { name: 'gasPrice', type: 'uint256' },
    { name: 'gasToken', type: 'address' },
    { name: 'refundReceiver', type: 'address' },
    { name: 'nonce', type: 'uint256' },
  ],
} as const

const SAFE_NONCE_ABI = [
  { type: 'function', name: 'nonce', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
] as const

/** What the tab needs to know about the live Safe. */
export interface SafeState {
  owners: Hex[]
  threshold: number
  /** The Safe's transaction nonce, or null when the read failed. */
  nonce: bigint | null
}

/** Reads the live owner set, threshold and nonce for a Safe. Injectable so tests need no network. */
export type SafeReader = (args: { chainId: number; safe: Hex }) => Promise<SafeState>

const defaultSafeReader: SafeReader = async ({ chainId, safe }) => {
  const client = selectClient(useChainStore.getState())
  const adapter = makeSafeAdapter({
    publicClient: client as unknown as SafePublicClient,
    safe,
    chainId,
  })
  const [owners, threshold] = await Promise.all([adapter.owners!(), adapter.threshold!()])
  let nonce: bigint | null = null
  try {
    nonce = (await client.readContract({ address: safe, abi: SAFE_NONCE_ABI, functionName: 'nonce' })) as bigint
  } catch {
    nonce = null
  }
  return { owners, threshold, nonce }
}

/** Formats an archive timestamp for the feed. A board share has none — it just landed. */
const when = (share: CosignShare): string => {
  if (!share.seenAt) return 'just now (live board)'
  const parsed = Date.parse(share.seenAt)
  if (Number.isNaN(parsed)) return share.seenAt
  return new Date(parsed).toLocaleString()
}

const SCHEME_LABEL: Record<number, string> = {
  [SCHEME.ECDSA]: 'eth_sign',
  [SCHEME.EIP1271]: 'EIP-1271',
  [SCHEME.EIP712]: 'EIP-712',
}

export function Cosign({
  workerFactory,
  fetchImpl,
  safeReader = defaultSafeReader,
}: {
  workerFactory?: () => Worker
  /** Injectable `fetch` for the archive query — tests supply a fake, production uses the global. */
  fetchImpl?: typeof fetch
  safeReader?: SafeReader
}) {
  const transportUrl = useChainStore((s) => selectTransportUrl(s))
  const chainId = useChainStore((s) => selectChain(s)?.id ?? 0)
  const rpcValid = useChainStore((s) => selectRpcValid(s))
  const content = useChainStore((s) => s.content)
  const globalWorkMultiplier = useChainStore((s) => s.globalWorkMultiplier)
  const globalWorkDivisor = useChainStore((s) => s.globalWorkDivisor)

  const fleetSafe: FleetSafe | null = useMemo(() => fleetSafeFor({ chainId }), [chainId])

  const [windowIndex, setWindowIndex] = useState(1)
  const days = WINDOWS[windowIndex]!.days

  const categories = useMemo(
    () => (fleetSafe ? cosignCategories({ chainId, safe: fleetSafe.address, days }) : []),
    [chainId, fleetSafe, days],
  )

  // ── the feed ───────────────────────────────────────────────────────────────────────────────
  const [archive, setArchive] = useState<CosignShare[]>([])
  const [loading, setLoading] = useState(false)
  const [feedError, setFeedError] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    if (!fleetSafe || !categories.length) {
      setArchive([])
      return
    }
    let alive = true
    setLoading(true)
    setFeedError(null)
    void readArchiveShares({ chainId, categories, fetchImpl })
      .then((shares) => {
        if (!alive) return
        setArchive(shares)
      })
      .catch((e) => {
        if (!alive) return
        setArchive([])
        setFeedError(e instanceof Error ? e.message : 'Could not reach the message archive.')
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [chainId, categories, fetchImpl, fleetSafe, reloadToken])

  // The live board half — free, because the page already polls `content` for every category.
  const boardShares = useMemo(() => readBoardShares({ content, categories }), [content, categories])
  const merged = useMemo(() => mergeShares({ archive, board: boardShares }), [archive, boardShares])

  // Recovering a signature is the one costly step in the read path, and the 20s content poll hands
  // us the same shares again and again. One cache across renders means each share is recovered once.
  const recoveryCache = useRef(new Map<string, Hex | null>())
  const [verified, setVerified] = useState<VerifiedShare[]>([])
  useEffect(() => {
    let alive = true
    void verifyShares({ shares: merged, cache: recoveryCache.current }).then((shares) => {
      if (alive) setVerified(shares)
    })
    return () => {
      alive = false
    }
  }, [merged])

  // ── the live Safe ──────────────────────────────────────────────────────────────────────────
  const [safeState, setSafeState] = useState<SafeState | null>(null)
  const [safeError, setSafeError] = useState<string | null>(null)
  useEffect(() => {
    if (!fleetSafe || !rpcValid) {
      setSafeState(null)
      return
    }
    let alive = true
    void safeReader({ chainId, safe: fleetSafe.address })
      .then((state) => {
        if (!alive) return
        setSafeState(state)
        setSafeError(null)
      })
      .catch(() => {
        if (!alive) return
        setSafeState(null)
        setSafeError('Could not read the Safe on this chain — owner membership is unknown.')
      })
    return () => {
      alive = false
    }
  }, [chainId, fleetSafe, rpcValid, safeReader, reloadToken])

  // ── the newest session ─────────────────────────────────────────────────────────────────────
  const session = useMemo(() => {
    const groups = groupByDigest({ shares: verified })
    const first = groups.entries().next()
    if (first.done) return null
    const [digest, shares] = first.value
    let safeTx: SafeTx | null = null
    for (const share of shares) {
      try {
        safeTx = decodeSafeMeta(share.record.meta).safeTx
        break
      } catch {
        // A share can carry empty or foreign meta; the next one may still describe the transaction.
      }
    }
    return { digest, shares, safeTx }
  }, [verified])

  const threshold = safeState?.threshold ?? fleetSafe?.threshold ?? 0
  const owners = safeState?.owners ?? []
  const fold = useMemo(
    () => (session ? foldQuorum({ shares: session.shares, owners, threshold }) : null),
    [session, owners, threshold],
  )

  // ── the write path ─────────────────────────────────────────────────────────────────────────
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

  const [wallet, setWallet] = useState<{ address: Hex } | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [signing, setSigning] = useState(false)
  const [signed, setSigned] = useState(false)
  const [signError, setSignError] = useState<string | null>(null)

  const connectWallet = useCallback(async () => {
    setConnecting(true)
    setSignError(null)
    try {
      const w = await connectInjectedWallet()
      setWallet({ address: w.address })
    } catch (e) {
      setSignError(e instanceof Error ? e.message : 'Failed to connect the wallet.')
    } finally {
      setConnecting(false)
    }
  }, [])

  const coSign = useCallback(async () => {
    if (!board || !wallet || !fleetSafe || !session?.safeTx) return
    setSigning(true)
    setSignError(null)
    try {
      const provider = getInjectedProvider()
      if (!provider) throw new Error('No injected wallet found.')
      const walletClient = createWalletClient({ account: wallet.address, transport: custom(provider) })
      const safeTx = session.safeTx
      const signature = await walletClient.signTypedData({
        account: wallet.address,
        domain: { chainId, verifyingContract: fleetSafe.address },
        types: SAFE_TX_TYPES,
        primaryType: 'SafeTx',
        message: {
          to: safeTx.to,
          value: safeTx.value,
          data: safeTx.data,
          operation: safeTx.operation,
          safeTxGas: safeTx.safeTxGas,
          baseGas: safeTx.baseGas,
          gasPrice: safeTx.gasPrice,
          gasToken: safeTx.gasToken,
          refundReceiver: safeTx.refundReceiver,
          nonce: safeTx.nonce,
        },
      })
      // Parity guardrail: the local table must recover to us at the canonical digest, or we refuse
      // to post. A drifted table would otherwise produce a share every reader rejects.
      const canonical = safeTransactionDigest(safeTx, chainId, fleetSafe.address)
      const recovered = await recoverAddress({ hash: canonical, signature })
      if (!isAddressEqual(recovered, wallet.address)) {
        throw new Error('Typed-data parity check failed — refusing to post the share.')
      }
      const record: SignatureRecord = {
        digest: canonical,
        signer: wallet.address,
        signature,
        scheme: SCHEME.EIP712,
        meta: encodeSafeMeta(safeTx, fleetSafe.address, chainId),
      }
      // `postSignature` writes through the worker board, so the proof of work grinds off the main
      // thread. It posts under the same namespace and scope the fleet uses, so the share joins the
      // session already on the board.
      await postSignature(board, {
        namespace: COSIGN_NAMESPACE,
        scope: safeScope({ chainId, safe: fleetSafe.address }),
        record,
      })
      setSigned(true)
      void useChainStore.getState().loadContent()
    } catch (e) {
      setSignError(e instanceof Error ? e.message : 'Failed to sign and post — try again.')
    } finally {
      setSigning(false)
    }
  }, [board, wallet, fleetSafe, session, chainId])

  const isOwner = wallet != null && owners.some((o) => isAddressEqual(o, wallet.address))

  // ── render ─────────────────────────────────────────────────────────────────────────────────
  if (!fleetSafe) {
    return (
      <div className="flex w-full flex-col gap-4">
        <div className="flex flex-col gap-3 rounded-xl border border-gray-300 bg-white p-5 dark:border-gray-600 dark:bg-gray-950">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-800 dark:text-gray-100">
            <Icon icon="mdi:shield-key-outline" className="size-4 text-indigo-500" />
            Co-signatures
          </h3>
          <p className="rounded-lg bg-gray-50 p-3 text-xs text-gray-400 dark:bg-gray-900">
            No demo Safe runs on chain {chainId || '?'} yet. Switch to PulseChain v4 (943) to watch the
            bot fleet reach a 2-of-3 threshold, or open the full app to co-sign your own Safe.
          </p>
        </div>
        <FullAppCallout />
      </div>
    )
  }

  return (
    <div className="flex w-full flex-col gap-4">
      {/* ── the live feed ────────────────────────────────────────── */}
      <div className="flex flex-col gap-3 rounded-xl border border-gray-300 bg-white p-5 dark:border-gray-600 dark:bg-gray-950">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-800 dark:text-gray-100">
            <Icon icon="mdi:shield-key-outline" className="size-4 text-indigo-500" />
            Live co-signatures
          </h3>
          <div className="flex items-center gap-2">
            <Menu
              label="feed window"
              options={WINDOWS.map((w) => w.label)}
              value={windowIndex}
              onChange={setWindowIndex}
            />
            <button
              onClick={() => setReloadToken((t) => t + 1)}
              title="Re-read the archive now"
              className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs text-gray-600 ring-1 ring-gray-300 transition hover:ring-gray-400 dark:text-gray-300 dark:ring-gray-600">
              <Icon icon={loading ? 'mdi:loading' : 'mdi:refresh'} className={`size-3.5 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </div>
        </div>

        <p className="text-xs text-gray-500 dark:text-gray-400">
          Safe{' '}
          <span className="font-mono">{shortHex(fleetSafe.address, 8)}</span> on chain {chainId}. The bot
          fleet holds {fleetSafe.threshold} of the {fleetSafe.ownerCount} keys and proposes one benign
          transaction every hour. Every share below is checked in your browser: the signature must
          recover to the address it names.
        </p>

        {loading && !verified.length ? (
          <p className="rounded-lg bg-gray-50 p-3 text-xs text-gray-400 dark:bg-gray-900">Reading the archive…</p>
        ) : feedError && !verified.length ? (
          <p className="rounded-lg bg-gray-50 p-3 text-xs text-amber-600 dark:bg-gray-900 dark:text-amber-400">
            {feedError} The live board still works — a share posted in the last few minutes appears here.
          </p>
        ) : !verified.length ? (
          <p className="rounded-lg bg-gray-50 p-3 text-xs text-gray-400 dark:bg-gray-900">
            No co-signatures on this Safe in the {WINDOWS[windowIndex]!.label.toLowerCase()}.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-gray-200 dark:divide-gray-700" aria-label="co-signature feed">
            {verified.slice(0, 12).map((share) => (
              <li
                key={`${share.record.digest}-${share.record.signer}-${share.record.signature.slice(0, 18)}`}
                className="flex flex-wrap items-center justify-between gap-2 py-2 text-xs">
                <span className="inline-flex items-center gap-1.5 font-mono text-gray-700 dark:text-gray-200">
                  <Icon
                    icon={share.selfConsistent ? 'mdi:check-decagram' : 'mdi:alert-decagram'}
                    className={`size-3.5 ${share.selfConsistent ? 'text-emerald-500' : 'text-amber-500'}`}
                  />
                  {shortHex(share.record.signer, 6)}
                </span>
                <span className="font-mono text-gray-400">digest {shortHex(share.record.digest, 6)}</span>
                <span className="text-gray-400">{SCHEME_LABEL[share.record.scheme] ?? `scheme ${share.record.scheme}`}</span>
                <span className="text-gray-400">{when(share)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ── the threshold walkthrough ────────────────────────────── */}
      <div className="flex flex-col gap-3 rounded-xl border border-gray-300 bg-white p-5 dark:border-gray-600 dark:bg-gray-950">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-800 dark:text-gray-100">
          <Icon icon="mdi:account-group-outline" className="size-4 text-indigo-500" />
          Threshold walkthrough
        </h3>

        {!session ? (
          <p className="rounded-lg bg-gray-50 p-3 text-xs text-gray-400 dark:bg-gray-900">
            No session to walk through yet. The fleet proposes the next one within the hour.
          </p>
        ) : (
          <>
            <Step
              index={1}
              title="Propose"
              done
              body={
                <>
                  The fleet proposes a benign self-call and hashes it into one Safe digest{' '}
                  <span className="font-mono">{shortHex(session.digest, 8)}</span>
                  {session.safeTx ? <> at Safe nonce {String(session.safeTx.nonce)}</> : null}. The call moves
                  no funds.
                </>
              }
            />
            <Step
              index={2}
              title="Co-sign"
              done={session.shares.length > 0}
              body={
                <>
                  {session.shares.length} share{session.shares.length === 1 ? '' : 's'} sit on the board for
                  this digest. Each one is a PoW-stamped message, not a server record.
                </>
              }
            />
            <Step
              index={3}
              title="Reach the threshold"
              done={!!fold?.thresholdMet}
              body={
                owners.length === 0 ? (
                  <span className="text-amber-600 dark:text-amber-400">
                    {safeError ?? 'The Safe owner set is still loading, so no share counts yet.'}
                  </span>
                ) : (
                  <>
                    {fold!.signedOwners.length} of {threshold} required owners signed
                    {fold!.thresholdMet ? ' — the quorum is met.' : ' — the quorum is still open.'}
                    {fold!.outsiders.length > 0 && (
                      <>
                        {' '}
                        {fold!.outsiders.length} valid signature
                        {fold!.outsiders.length === 1 ? '' : 's'} came from a non-owner and never counts.
                      </>
                    )}
                  </>
                )
              }
            />
            <Step
              index={4}
              title="Aggregate"
              done={!!fold?.thresholdMet}
              body={
                <>
                  At the threshold the shares sort into one signature blob the Safe accepts.{' '}
                  {safeState?.nonce === 0n
                    ? 'This Safe has executed nothing on-chain yet — the fleet stops at a verified aggregate unless a signer holds gas.'
                    : 'The fleet executes only when a signer holds gas; otherwise it stops at the verified aggregate.'}
                </>
              }
            />

            {owners.length > 0 && (
              <div className="flex flex-wrap gap-1.5 border-t border-gray-200 pt-3 dark:border-gray-700">
                {owners.map((owner) => {
                  const signedIt = fold!.signedOwners.some((s) => isAddressEqual(s, owner))
                  return (
                    <span
                      key={owner}
                      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 font-mono text-[11px] ${
                        signedIt
                          ? 'bg-emerald-500/10 text-emerald-600 ring-1 ring-emerald-500/30 dark:text-emerald-400'
                          : 'text-gray-500 ring-1 ring-gray-300 dark:text-gray-400 dark:ring-gray-600'
                      }`}>
                      <Icon icon={signedIt ? 'mdi:check' : 'mdi:minus'} className="size-3" />
                      {shortHex(owner, 6)}
                    </span>
                  )
                })}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2 border-t border-gray-200 pt-3 dark:border-gray-700">
              {!session.safeTx ? (
                <span className="text-[11px] text-amber-600 dark:text-amber-400">
                  This session carries no Safe transaction data, so there is nothing to co-sign here.
                </span>
              ) : !wallet ? (
                <button
                  onClick={() => void connectWallet()}
                  disabled={connecting}
                  className="inline-flex items-center gap-1 rounded-full bg-indigo-500/10 px-2.5 py-1 text-xs text-indigo-600 ring-1 ring-indigo-500/30 transition disabled:cursor-not-allowed disabled:opacity-50 dark:text-indigo-400">
                  <Icon
                    icon={connecting ? 'mdi:loading' : 'mdi:wallet-outline'}
                    className={`size-3.5 ${connecting ? 'animate-spin' : ''}`}
                  />
                  {connecting ? 'Connecting…' : 'Connect wallet'}
                </button>
              ) : signed ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-600 ring-1 ring-emerald-500/30 dark:text-emerald-400">
                  <Icon icon="mdi:check" className="size-3.5" />
                  Signed — posted to the board
                </span>
              ) : (
                <button
                  onClick={() => void coSign()}
                  disabled={signing || !board}
                  className="inline-flex items-center gap-1.5 rounded-full bg-emerald-600 px-3.5 py-1.5 text-xs font-semibold text-white shadow transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50">
                  <Icon
                    icon={signing ? 'mdi:loading' : 'mdi:fountain-pen-tip'}
                    className={`size-3.5 ${signing ? 'animate-spin' : ''}`}
                  />
                  {signing ? 'Signing & stamping…' : 'Add your co-signature'}
                </button>
              )}
              {wallet && !isOwner && (
                <span className="text-[11px] text-gray-500 dark:text-gray-400">
                  Your address does not own this Safe, so your share appears in the feed but never counts
                  toward the quorum.
                </span>
              )}
            </div>
            {signError && <p className="text-[11px] text-amber-600 dark:text-amber-400">{signError}</p>}
          </>
        )}
        {!rpcValid && (
          <p className="text-[11px] text-amber-600 dark:text-amber-400">Pick a valid chain to read the Safe.</p>
        )}
      </div>

      <FullAppCallout />
    </div>
  )
}

/** One numbered step of the walkthrough. */
function Step({
  index,
  title,
  body,
  done,
}: {
  index: number
  title: string
  body: React.ReactNode
  done: boolean
}) {
  return (
    <div className="flex items-start gap-3">
      <span
        className={`mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${
          done ? 'bg-emerald-600 text-white' : 'bg-gray-200 text-gray-500 dark:bg-gray-700 dark:text-gray-300'
        }`}>
        {index}
      </span>
      <p className="text-xs text-gray-600 dark:text-gray-300">
        <span className="font-semibold text-gray-800 dark:text-gray-100">{title}. </span>
        {body}
      </p>
    </div>
  )
}

/** The link out to the real venue — same shape as the Petitions callout. */
function FullAppCallout() {
  return (
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
              Cosign
            </span>{' '}
            app drives your own Safe: pick it, propose a transaction, collect signatures over the board,
            and execute — no signing server, no gatekeeper.
          </p>
          <p className="mt-1 text-xs text-gray-300">
            Signature shares travel as PoW-stamped board messages, so the coordination layer is the
            chain itself.
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
  )
}
