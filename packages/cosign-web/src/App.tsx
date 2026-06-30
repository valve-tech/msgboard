import { useCallback, useEffect, useMemo, useState } from 'react'
import { type Hex, isAddress, isAddressEqual, getAddress } from 'viem'
import { Icon } from '@iconify/react'
import {
  type CosignAdapter,
  type SafePublicClient,
  type SafeTx,
  type SignatureRecord,
  SCHEME,
  makeSafeAdapter,
  safeTransactionDigest,
  encodeSafeMeta,
  decodeSafeMeta,
  buildExecTransactionArgs,
} from '@msgboard/cosign'
import { useWallet } from './hooks/useWallet'
import { makeWorkerBoard, type BoardClient } from './seams/worker-board'
import { BOARD_ENDPOINTS, fetchBoardFactors, type BoardFactors } from './lib/board'
import { safeTxTypedData } from './lib/safe-typed-data'
import {
  type AggregateResult,
  type AnnotatedShare,
  aggregateForSafe,
  annotate,
  loadShares,
  parseSafeTx,
  postShare,
  schemeLabel,
  scopeFor,
} from './lib/cosign'
import type { ProgressMsg } from './worker/types'
import { Button, Copyable, Field, Notice, Pill, Section, TextInput } from './components/ui'

interface SafeInfo {
  owners: Hex[]
  threshold: number
}

const ZERO = '0x0000000000000000000000000000000000000000'

const emptySafeTxForm = {
  to: '',
  value: '0',
  data: '0x',
  operation: '0',
  safeTxGas: '0',
  baseGas: '0',
  gasPrice: '0',
  gasToken: ZERO,
  refundReceiver: ZERO,
  nonce: '0',
}

export function App() {
  const wallet = useWallet()

  // ── step 1: board endpoint ──────────────────────────────────────────────
  const [boardIdx, setBoardIdx] = useState(0)
  const endpoint = BOARD_ENDPOINTS[boardIdx]
  const [factors, setFactors] = useState<BoardFactors | null>(null)

  useEffect(() => {
    let cancelled = false
    setFactors(null)
    void fetchBoardFactors(endpoint.rpc, endpoint.chainId).then((f) => {
      if (!cancelled) setFactors(f)
    })
    return () => {
      cancelled = true
    }
  }, [endpoint.rpc, endpoint.chainId])

  const [grind, setGrind] = useState<ProgressMsg | null>(null)
  const onProgress = useCallback((msg: ProgressMsg) => setGrind(msg), [])

  const board = useMemo<BoardClient | null>(() => {
    if (!factors) return null
    return makeWorkerBoard({
      rpc: endpoint.rpc,
      chainId: endpoint.chainId,
      workMultiplier: factors.workMultiplier,
      workDivisor: factors.workDivisor,
      onProgress,
    })
  }, [endpoint.rpc, endpoint.chainId, factors, onProgress])

  // ── step 2: Safe ─────────────────────────────────────────────────────────
  const [safeInput, setSafeInput] = useState('')
  const safe = useMemo<Hex | null>(() => (isAddress(safeInput) ? getAddress(safeInput) : null), [safeInput])
  const safeChainId = wallet.chainId
  const [safeInfo, setSafeInfo] = useState<SafeInfo | null>(null)
  const [safeLoading, setSafeLoading] = useState(false)
  const [safeError, setSafeError] = useState<string | null>(null)

  const adapter = useMemo<CosignAdapter | null>(() => {
    if (!safe || !safeChainId || !wallet.address) return null
    return makeSafeAdapter({
      publicClient: wallet.publicClient() as unknown as SafePublicClient,
      safe,
      chainId: safeChainId,
    })
  }, [safe, safeChainId, wallet])

  const scope = useMemo<string | null>(
    () => (safe && safeChainId ? scopeFor(safeChainId, safe) : null),
    [safe, safeChainId],
  )

  const loadSafe = useCallback(async () => {
    if (!adapter?.owners || !adapter.threshold) return
    setSafeLoading(true)
    setSafeError(null)
    setSafeInfo(null)
    try {
      const [owners, threshold] = await Promise.all([adapter.owners(), adapter.threshold()])
      setSafeInfo({ owners, threshold })
    } catch (e) {
      setSafeError(e instanceof Error ? e.message : 'Failed to read Safe (wrong chain or not a Safe?)')
    } finally {
      setSafeLoading(false)
    }
  }, [adapter])

  // ── step 3: digest to co-sign ─────────────────────────────────────────────
  const [mode, setMode] = useState<'paste' | 'safetx'>('paste')
  const [pasteDigest, setPasteDigest] = useState('')
  const [form, setForm] = useState(emptySafeTxForm)
  const setFormField = (k: keyof typeof emptySafeTxForm) => (v: string) => setForm((f) => ({ ...f, [k]: v }))

  const builtSafeTx = useMemo<{ tx: SafeTx; digest: Hex } | null>(() => {
    if (mode !== 'safetx' || !safe || !safeChainId || !isAddress(form.to)) return null
    try {
      const tx = parseSafeTx(form)
      return { tx, digest: safeTransactionDigest(tx, safeChainId, safe) }
    } catch {
      return null
    }
  }, [mode, form, safe, safeChainId])

  const pasteValid = /^0x[0-9a-fA-F]{64}$/.test(pasteDigest)

  // ── step 4: sign + post ───────────────────────────────────────────────────
  const [signState, setSignState] = useState<'idle' | 'signing' | 'grinding' | 'posted' | 'error'>('idle')
  const [signError, setSignError] = useState<string | null>(null)

  const sign = useCallback(async () => {
    if (!board || !scope || !safe || !safeChainId || !wallet.address) return
    setSignError(null)
    setGrind(null)
    setSignState('signing')
    try {
      let record: SignatureRecord
      if (mode === 'paste') {
        const digest = pasteDigest as Hex
        const signature = await wallet.signRawDigest(digest)
        record = { digest, signer: wallet.address, signature, scheme: SCHEME.ECDSA, meta: '0x' }
      } else {
        if (!builtSafeTx) throw new Error('Fill in a valid SafeTx (a `to` address is required)')
        const { tx, digest } = builtSafeTx
        const signature = await wallet.signTyped(safeTxTypedData(tx, safeChainId, safe))
        record = {
          digest,
          signer: wallet.address,
          signature,
          scheme: SCHEME.EIP712,
          meta: encodeSafeMeta(tx, safe, safeChainId),
        }
      }
      setSignState('grinding')
      await postShare(board, scope, record)
      setSignState('posted')
      setSelectedDigest(record.digest)
      await refreshShares()
    } catch (e) {
      setSignError(e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e))
      setSignState('error')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board, scope, safe, safeChainId, wallet, mode, pasteDigest, builtSafeTx])

  // ── step 5: read + aggregate ───────────────────────────────────────────────
  const [shares, setShares] = useState<SignatureRecord[]>([])
  const [sharesLoading, setSharesLoading] = useState(false)
  const [selectedDigest, setSelectedDigest] = useState<Hex | null>(null)
  const [annotated, setAnnotated] = useState<AnnotatedShare[]>([])
  const [agg, setAgg] = useState<AggregateResult | null>(null)
  const [aggError, setAggError] = useState<string | null>(null)
  const [aggBusy, setAggBusy] = useState(false)
  const [submitState, setSubmitState] = useState<{ state: 'idle' | 'busy' | 'done' | 'error'; detail?: string }>({
    state: 'idle',
  })

  const refreshShares = useCallback(async () => {
    if (!board || !scope) return
    setSharesLoading(true)
    try {
      setShares(await loadShares(board, scope))
    } finally {
      setSharesLoading(false)
    }
  }, [board, scope])

  const digests = useMemo(() => {
    const set = new Map<Hex, number>()
    for (const r of shares) set.set(r.digest, (set.get(r.digest) ?? 0) + 1)
    return [...set.entries()]
  }, [shares])

  const selectedRecords = useMemo(
    () => (selectedDigest ? shares.filter((r) => r.digest === selectedDigest) : []),
    [shares, selectedDigest],
  )

  useEffect(() => {
    let cancelled = false
    setAgg(null)
    setAggError(null)
    setSubmitState({ state: 'idle' })
    if (selectedRecords.length === 0) {
      setAnnotated([])
      return
    }
    void annotate(selectedRecords).then((a) => {
      if (!cancelled) setAnnotated(a)
    })
    return () => {
      cancelled = true
    }
  }, [selectedRecords])

  const signedOwners = useMemo<Hex[]>(() => {
    if (!safeInfo) return []
    const seen: Hex[] = []
    for (const a of annotated) {
      if (a.signer && safeInfo.owners.some((o) => isAddressEqual(o, a.signer as Hex))) {
        if (!seen.some((s) => isAddressEqual(s, a.signer as Hex))) seen.push(a.signer)
      }
    }
    return seen
  }, [annotated, safeInfo])

  const runAggregate = useCallback(async () => {
    if (!adapter || selectedRecords.length === 0) return
    setAggBusy(true)
    setAggError(null)
    try {
      setAgg(await aggregateForSafe(selectedRecords, adapter))
    } catch (e) {
      setAggError(e instanceof Error ? e.message : 'Aggregation failed (RPC/verify error)')
    } finally {
      setAggBusy(false)
    }
  }, [adapter, selectedRecords])

  // execTransaction args are available only when the share carries a decodable SafeTx meta.
  const execArgs = useMemo(() => {
    if (!agg || agg.ordered.length === 0) return null
    const head = agg.ordered[0]
    if (head.meta === '0x') return null
    try {
      const { safeTx } = decodeSafeMeta(head.meta)
      return { safeTx, args: buildExecTransactionArgs(agg.ordered, safeTx) }
    } catch {
      return null
    }
  }, [agg])

  const submit = useCallback(async () => {
    if (!safe || !execArgs) return
    setSubmitState({ state: 'busy' })
    try {
      const hash = await wallet.submitExecTransaction(safe, execArgs.args)
      setSubmitState({ state: 'done', detail: hash })
    } catch (e) {
      setSubmitState({ state: 'error', detail: e instanceof Error ? e.message : 'submit rejected' })
    }
  }, [safe, execArgs, wallet])

  const thresholdMet = safeInfo ? signedOwners.length >= safeInfo.threshold : false

  // ── render ────────────────────────────────────────────────────────────────
  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <header className="mb-8">
        <div className="flex items-center gap-2">
          <Icon icon="mdi:signature-freehand" className="text-2xl text-indigo-400" />
          <h1 className="text-xl font-bold">Cosign</h1>
        </div>
        <p className="mt-1 text-sm text-gray-400">
          Co-sign a Gnosis Safe transaction off-chain over the MsgBoard signature-share board. Shares are
          PoW-stamped in a Web Worker and bucketed under rotating UTC-day category keys.
        </p>
      </header>

      <div className="flex flex-col gap-5">
        {/* Step 1 — board */}
        <Section step={1} title="Board endpoint" done={!!factors?.enabled} subtitle="Where signature shares are posted + read (independent of the Safe's chain).">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="MsgBoard RPC">
              <select
                value={boardIdx}
                onChange={(e) => setBoardIdx(Number(e.target.value))}
                className="w-full rounded-md border border-gray-700 bg-gray-950 px-3 py-2 text-sm">
                {BOARD_ENDPOINTS.map((b, i) => (
                  <option key={b.rpc} value={i}>
                    {b.label}
                  </option>
                ))}
              </select>
            </Field>
            <div className="flex items-end gap-2 text-xs text-gray-400">
              {!factors && <Pill>probing…</Pill>}
              {factors && (
                <>
                  <Pill tone={factors.enabled ? 'ok' : 'warn'}>
                    msgboard_ {factors.enabled ? 'enabled' : 'unavailable'}
                  </Pill>
                  <Pill>
                    work {factors.workMultiplier}/{factors.workDivisor}
                  </Pill>
                </>
              )}
            </div>
          </div>
        </Section>

        {/* Step 2 — wallet + Safe */}
        <Section step={2} title="Connect wallet & select Safe" done={!!safeInfo}>
          {!wallet.address ? (
            <Button onClick={() => void wallet.connect()} busy={wallet.connecting} disabled={!wallet.available}>
              <Icon icon="mdi:wallet" /> {wallet.available ? 'Connect wallet' : 'No injected wallet'}
            </Button>
          ) : (
            <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-gray-300">
              <Pill tone="ok">connected</Pill>
              <code className="font-mono">{wallet.address}</code>
              <Pill>chain {wallet.chainId ?? '?'}</Pill>
            </div>
          )}
          {wallet.error && (
            <div className="mt-2">
              <Notice tone="error">{wallet.error}</Notice>
            </div>
          )}

          <div className="mt-4 grid gap-3">
            <Field
              label="Safe address"
              hint="Read on the wallet's current chain. Switch your wallet to the Safe's chain first — the chain id binds the EIP-712 domain.">
              <TextInput value={safeInput} onChange={setSafeInput} placeholder="0x… Safe (proxy) address" mono />
            </Field>
            <div>
              <Button onClick={() => void loadSafe()} disabled={!adapter} busy={safeLoading} variant="ghost">
                <Icon icon="mdi:account-multiple" /> Read owners & threshold
              </Button>
            </div>
          </div>

          {safeError && (
            <div className="mt-3">
              <Notice tone="error">{safeError}</Notice>
            </div>
          )}
          {safeInfo && (
            <div className="mt-3 rounded-md border border-gray-800 bg-gray-950 p-3 text-xs">
              <div className="mb-2 flex items-center gap-2">
                <Pill tone="ok">threshold {safeInfo.threshold}</Pill>
                <Pill>
                  {safeInfo.owners.length} owner{safeInfo.owners.length === 1 ? '' : 's'}
                </Pill>
              </div>
              <ul className="space-y-1 font-mono text-gray-400">
                {safeInfo.owners.map((o) => (
                  <li key={o} className="flex items-center gap-2">
                    <Icon icon="mdi:circle-small" /> {o}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Section>

        {/* Step 3 — digest */}
        <Section step={3} title="Pick a digest to co-sign">
          <div className="mb-3 flex gap-2">
            <Button onClick={() => setMode('paste')} variant={mode === 'paste' ? 'primary' : 'ghost'}>
              Paste digest
            </Button>
            <Button onClick={() => setMode('safetx')} variant={mode === 'safetx' ? 'primary' : 'ghost'}>
              Build SafeTx
            </Button>
          </div>

          {mode === 'paste' ? (
            <Field
              label="Digest / safeTxHash (bytes32)"
              hint="Signed with personal_sign → an eth_sign-style ECDSA share. Submission needs the SafeTx fields, so on-chain submit is unavailable for paste-only digests.">
              <TextInput value={pasteDigest} onChange={setPasteDigest} placeholder="0x… 32-byte digest" mono />
            </Field>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="to"><TextInput value={form.to} onChange={setFormField('to')} placeholder="0x… target" mono /></Field>
              <Field label="value (wei)"><TextInput value={form.value} onChange={setFormField('value')} mono /></Field>
              <Field label="data"><TextInput value={form.data} onChange={setFormField('data')} mono /></Field>
              <Field label="operation (0=call,1=delegatecall)"><TextInput value={form.operation} onChange={setFormField('operation')} mono /></Field>
              <Field label="nonce"><TextInput value={form.nonce} onChange={setFormField('nonce')} mono /></Field>
              <Field label="safeTxGas"><TextInput value={form.safeTxGas} onChange={setFormField('safeTxGas')} mono /></Field>
              <Field label="baseGas"><TextInput value={form.baseGas} onChange={setFormField('baseGas')} mono /></Field>
              <Field label="gasPrice"><TextInput value={form.gasPrice} onChange={setFormField('gasPrice')} mono /></Field>
              <Field label="gasToken"><TextInput value={form.gasToken} onChange={setFormField('gasToken')} mono /></Field>
              <Field label="refundReceiver"><TextInput value={form.refundReceiver} onChange={setFormField('refundReceiver')} mono /></Field>
              <div className="sm:col-span-2">
                {builtSafeTx ? (
                  <Field label="computed safeTxHash (EIP-712, signTypedData)">
                    <Copyable value={builtSafeTx.digest} label="digest" />
                  </Field>
                ) : (
                  <Notice tone="info">Enter a valid `to` address to compute the EIP-712 digest.</Notice>
                )}
              </div>
            </div>
          )}
        </Section>

        {/* Step 4 — sign + post */}
        <Section step={4} title="Sign & post share" done={signState === 'posted'}>
          <Button
            onClick={() => void sign()}
            busy={signState === 'signing' || signState === 'grinding'}
            disabled={
              !board ||
              !scope ||
              !wallet.address ||
              (mode === 'paste' ? !pasteValid : !builtSafeTx)
            }>
            <Icon icon="mdi:fountain-pen-tip" /> Sign & post to board
          </Button>
          <div className="mt-3 space-y-2 text-xs text-gray-400">
            {!scope && wallet.address && <Notice tone="info">Load a Safe first to derive the board scope.</Notice>}
            {signState === 'signing' && <Pill tone="warn">awaiting wallet signature…</Pill>}
            {signState === 'grinding' && (
              <Pill tone="warn">
                grinding PoW in worker… {grind ? `${grind.stats.iterations.toString()} iters` : ''}
              </Pill>
            )}
            {signState === 'posted' && <Pill tone="ok">share posted</Pill>}
            {signState === 'error' && signError && <Notice tone="error">{signError}</Notice>}
          </div>
        </Section>

        {/* Step 5 — read + aggregate */}
        <Section step={5} title="Read shares & aggregate">
          <div className="mb-3">
            <Button onClick={() => void refreshShares()} disabled={!board || !scope} busy={sharesLoading} variant="ghost">
              <Icon icon="mdi:refresh" /> Reload shares ({shares.length})
            </Button>
          </div>

          {digests.length > 0 && (
            <div className="mb-3">
              <span className="mb-1 block text-xs font-medium text-gray-400">Co-sign sessions (by digest)</span>
              <ul className="space-y-1">
                {digests.map(([d, n]) => (
                  <li key={d}>
                    <button
                      type="button"
                      onClick={() => setSelectedDigest(d)}
                      className={`flex w-full items-center justify-between rounded-md border px-3 py-2 text-left font-mono text-[11px] ${
                        selectedDigest === d ? 'border-indigo-500 bg-indigo-950/40' : 'border-gray-800 hover:bg-gray-800/50'
                      }`}>
                      <span className="truncate">{d}</span>
                      <span className="ml-2 shrink-0 text-gray-400">
                        {n} share{n === 1 ? '' : 's'}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {selectedDigest && (
            <div className="rounded-md border border-gray-800 bg-gray-950 p-3">
              <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
                {safeInfo ? (
                  <Pill tone={thresholdMet ? 'ok' : 'warn'}>
                    {signedOwners.length}/{safeInfo.threshold} owners signed
                  </Pill>
                ) : (
                  <Pill>load Safe for threshold progress</Pill>
                )}
                <Pill>{selectedRecords.length} raw shares</Pill>
              </div>

              <ul className="mb-3 space-y-1 text-[11px]">
                {annotated.map((a, i) => {
                  const isOwner = !!a.signer && !!safeInfo?.owners.some((o) => isAddressEqual(o, a.signer as Hex))
                  return (
                    <li key={`${a.record.signature}-${i}`} className="flex items-center gap-2 font-mono text-gray-400">
                      <Icon
                        icon={a.signer ? (isOwner ? 'mdi:check-circle' : 'mdi:help-circle') : 'mdi:alert-circle'}
                        className={a.signer ? (isOwner ? 'text-emerald-400' : 'text-gray-500') : 'text-red-400'} />
                      <span className="truncate">{a.signer ?? 'unrecoverable'}</span>
                      <span className="ml-auto shrink-0 text-gray-600">{schemeLabel(a.record.scheme)}</span>
                    </li>
                  )
                })}
              </ul>

              <Button onClick={() => void runAggregate()} disabled={!adapter} busy={aggBusy}>
                <Icon icon="mdi:layers-triple" /> Verify & aggregate (adapter)
              </Button>
              {!adapter && <p className="mt-2 text-[11px] text-gray-500">Connect wallet + load Safe to enable aggregation.</p>}
              {aggError && (
                <div className="mt-2">
                  <Notice tone="error">{aggError}</Notice>
                </div>
              )}

              {agg && (
                <div className="mt-3 space-y-2">
                  <span className="block text-xs font-medium text-gray-400">
                    Final Safe `signatures` blob ({agg.pairs.length} verified)
                  </span>
                  <Copyable value={agg.blob} label="signatures blob" />

                  {execArgs ? (
                    <div className="mt-3 space-y-2">
                      <Notice tone="info">
                        execTransaction args are available (this digest carries a SafeTx). Submitting sends a real
                        transaction from your wallet on chain {safeChainId} — experimental, untested against a live Safe.
                      </Notice>
                      <Button onClick={() => void submit()} busy={submitState.state === 'busy'} variant="danger">
                        <Icon icon="mdi:send" /> Submit execTransaction
                      </Button>
                      {submitState.state === 'done' && (
                        <Pill tone="ok">submitted: {submitState.detail?.slice(0, 14)}…</Pill>
                      )}
                      {submitState.state === 'error' && <Notice tone="error">{submitState.detail}</Notice>}
                    </div>
                  ) : (
                    <Notice tone="info">
                      Submit is unavailable: this is a paste-only digest with no SafeTx fields. Copy the blob above and
                      submit via your existing Safe execution path.
                    </Notice>
                  )}
                </div>
              )}
            </div>
          )}
        </Section>
      </div>

      <footer className="mt-10 text-center text-[11px] text-gray-600">
        @msgboard/cosign · Safe adapter · ECDSA + EIP-712 owner paths
      </footer>
    </div>
  )
}
