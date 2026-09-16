import { Menu } from './components/Menu'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { type Hex, formatUnits, isAddress, isAddressEqual, getAddress } from 'viem'
import { Icon } from '@iconify/react'
import {
  type CosignAdapter,
  type SafePublicClient,
  type SafeTx,
  type SignatureRecord,
  SCHEME,
  makeSafeAdapter,
  safeTransactionDigest,
  decodeSafeMeta,
  encodeSafeMeta,
  buildExecTransactionArgs,
} from '@msgboard/cosign'
import { useWallet } from './hooks/useWallet'
import { makeWorkerBoard, type BoardClient } from './seams/worker-board'
import { BOARD_ENDPOINTS, fetchBoardFactors, type BoardFactors } from './lib/board'
import { safeTxTypedData, assertSafeTxSignatureParity } from './lib/safe-typed-data'
import { chainMeta } from './lib/config'
import { discoverSafes, type DiscoveredSafe } from './lib/discovery'
import { simulateSafeTx, type SimResult } from './lib/simulate'
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
import { Copyable, Field, OwnerRow, RegisterLine, Seal, StepCard, TextInput, cx, short } from './components/ui'
import { CreateSafe } from './components/CreateSafe'
import { SponsorStatus } from './components/SponsorStatus'

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

interface Chosen {
  digest: Hex
  tx: SafeTx | null
  scheme: number
}

export function App() {
  const wallet = useWallet()
  const safeChainId = wallet.chainId

  // ── top-level view: the existing co-sign wizard, or the Create-Safe panel ──────────────────
  const [view, setView] = useState<'cosign' | 'create'>('cosign')

  // ── board endpoint (a ⚙ setting in the rail, not a step) ────────────────────────────────────
  const [boardIdx, setBoardIdx] = useState(1) // default PulseChain mainnet 369
  const endpoint = BOARD_ENDPOINTS[boardIdx]
  const [factors, setFactors] = useState<BoardFactors | null>(null)
  const [showCfg, setShowCfg] = useState(false)
  const [archiveOn] = useState(true)

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

  // ── STEP 1 — pick your Safe (discover ∪ manual) ─────────────────────────────────────────────
  const [discovered, setDiscovered] = useState<DiscoveredSafe[] | null>(null)
  const [discovering, setDiscovering] = useState(false)
  const [manual, setManual] = useState('')
  const [selectedSafe, setSelectedSafe] = useState<Hex | null>(null)
  const [safeInfo, setSafeInfo] = useState<SafeInfo | null>(null)
  const [safeError, setSafeError] = useState<string | null>(null)
  const [safeLoading, setSafeLoading] = useState(false)

  const safe = selectedSafe
  const scope = useMemo<string | null>(
    () => (safe && safeChainId ? scopeFor(safeChainId, safe) : null),
    [safe, safeChainId],
  )

  const adapter = useMemo<CosignAdapter | null>(() => {
    if (!safe || !safeChainId || !wallet.address) return null
    return makeSafeAdapter({
      publicClient: wallet.publicClient() as unknown as SafePublicClient,
      safe,
      chainId: safeChainId,
    })
  }, [safe, safeChainId, wallet])

  // auto-discover the wallet's Safes on connect / chain change
  useEffect(() => {
    if (!wallet.address || !safeChainId) {
      setDiscovered(null)
      return
    }
    let cancelled = false
    setDiscovering(true)
    void discoverSafes(wallet.address, safeChainId)
      .then((list) => {
        if (cancelled) return
        setDiscovered(list)
        if (list.length === 1) void selectAndLoad(list[0].address) // auto-select the sole Safe
      })
      .finally(() => {
        if (!cancelled) setDiscovering(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet.address, safeChainId])

  const selectAndLoad = useCallback(
    // `chainIdOverride` lets a caller that already knows the exact chain (e.g. a just-completed
    // Safe deploy) pin the read to THAT chain rather than trusting `safeChainId` (== wallet.chainId)
    // to still match by the time this async call resolves.
    async (addr: Hex, chainIdOverride?: number) => {
      const chain = chainIdOverride ?? safeChainId
      if (!chain || !wallet.address) return
      setSafeError(null)
      setSafeInfo(null)
      setSelectedSafe(getAddress(addr))
      setSafeLoading(true)
      try {
        const a = makeSafeAdapter({
          publicClient: wallet.publicClient() as unknown as SafePublicClient,
          safe: getAddress(addr),
          chainId: chain,
        })
        const [owners, threshold] = await Promise.all([a.owners!(), a.threshold!()])
        setSafeInfo({ owners, threshold })
      } catch (e) {
        setSafeError(e instanceof Error ? e.message : 'Failed to read Safe (wrong chain, or not a Safe?)')
        setSelectedSafe(null)
      } finally {
        setSafeLoading(false)
      }
    },
    [safeChainId, wallet],
  )

  // hand the newly-deployed Safe to the co-sign flow (same setter as the manual-entry path — reads
  // owners/threshold straight off-chain, so it doesn't matter that we already know them). Pin the
  // read to the chain the deploy actually ran on, rather than relying on `safeChainId` still
  // matching by the time this resolves.
  const handleCreated = useCallback(
    (newSafe: Hex, chainId: number) => {
      setView('cosign')
      void selectAndLoad(newSafe, chainId)
    },
    [selectAndLoad],
  )

  const editSafe = useCallback(() => {
    setSelectedSafe(null)
    setSafeInfo(null)
    setChosen(null)
  }, [])

  // ── STEP 2 — what to sign (+ simulation) ────────────────────────────────────────────────────
  const [mode, setMode] = useState<'paste' | 'safetx'>('safetx')
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

  const [sim, setSim] = useState<SimResult | null>(null)
  const [simBusy, setSimBusy] = useState(false)

  const runSim = useCallback(async () => {
    if (!builtSafeTx || !safe || !safeChainId || !wallet.address) return
    setSimBusy(true)
    try {
      setSim(await simulateSafeTx(safeChainId, safe, wallet.address, builtSafeTx.tx))
    } finally {
      setSimBusy(false)
    }
  }, [builtSafeTx, safe, safeChainId, wallet.address])

  useEffect(() => {
    setSim(null)
    if (mode === 'safetx' && builtSafeTx) void runSim()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [builtSafeTx?.digest, mode])

  const [chosen, setChosen] = useState<Chosen | null>(null)

  const confirmDigest = useCallback(() => {
    if (mode === 'paste' && pasteValid) {
      setChosen({ digest: pasteDigest as Hex, tx: null, scheme: SCHEME.ECDSA })
    } else if (mode === 'safetx' && builtSafeTx) {
      setChosen({ digest: builtSafeTx.digest, tx: builtSafeTx.tx, scheme: SCHEME.EIP712 })
    }
  }, [mode, pasteValid, pasteDigest, builtSafeTx])

  const editDigest = useCallback(() => {
    setChosen(null)
    setSignState('idle')
  }, [])

  // ── STEP 3 — sign & post your share ─────────────────────────────────────────────────────────
  const [signState, setSignState] = useState<'idle' | 'signing' | 'grinding' | 'posted' | 'error'>('idle')
  const [signError, setSignError] = useState<string | null>(null)

  const sign = useCallback(async () => {
    if (!board || !scope || !safe || !safeChainId || !wallet.address || !chosen) return
    setSignError(null)
    setGrind(null)
    setSignState('signing')
    try {
      let record: SignatureRecord
      if (chosen.scheme === SCHEME.ECDSA || !chosen.tx) {
        const signature = await wallet.signRawDigest(chosen.digest)
        record = { digest: chosen.digest, signer: wallet.address, signature, scheme: SCHEME.ECDSA, meta: '0x' }
      } else {
        const tx = chosen.tx
        const signature = await wallet.signTyped(safeTxTypedData(tx, safeChainId, safe))
        // GUARDRAIL: the local SAFE_TX_TYPES must recover to us at the SDK's canonical digest, or we
        // refuse to post (never let a drifted typed-data table produce an adapter-rejected share).
        await assertSafeTxSignatureParity({ safeTx: tx, chainId: safeChainId, safe, signature, expectedSigner: wallet.address })
        record = {
          digest: chosen.digest,
          signer: wallet.address,
          signature,
          scheme: SCHEME.EIP712,
          meta: encodeSafeMeta(tx, safe, safeChainId),
        }
      }
      setSignState('grinding')
      await postShare(board, scope, record)
      setSignState('posted')
      await refreshShares()
    } catch (e) {
      setSignError(e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e))
      setSignState('error')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board, scope, safe, safeChainId, wallet, chosen])

  // ── STEP 4 — collect & execute ──────────────────────────────────────────────────────────────
  const [shares, setShares] = useState<{ record: SignatureRecord; source: 'board' | 'archive' }[]>([])
  const [sharesLoading, setSharesLoading] = useState(false)
  const [annotated, setAnnotated] = useState<AnnotatedShare[]>([])
  const [agg, setAgg] = useState<AggregateResult | null>(null)
  const [aggError, setAggError] = useState<string | null>(null)
  const [submitState, setSubmitState] = useState<{ state: 'idle' | 'busy' | 'done' | 'error'; detail?: string }>({
    state: 'idle',
  })

  const refreshShares = useCallback(async () => {
    if (!board || !scope) return
    setSharesLoading(true)
    try {
      setShares(await loadShares(board, scope, { archive: archiveOn }))
    } finally {
      setSharesLoading(false)
    }
  }, [board, scope, archiveOn])

  // load shares as soon as a digest is chosen (and after posting)
  useEffect(() => {
    if (chosen && board && scope) void refreshShares()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chosen?.digest, board, scope])

  const selectedRecords = useMemo(
    () => (chosen ? shares.filter((s) => s.record.digest === chosen.digest) : []),
    [shares, chosen],
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

  const thresholdMet = safeInfo ? signedOwners.length >= safeInfo.threshold : false

  const runAggregate = useCallback(async () => {
    if (!adapter || selectedRecords.length === 0) return
    setAggError(null)
    try {
      setAgg(await aggregateForSafe(selectedRecords.map((s) => s.record), adapter))
    } catch (e) {
      setAggError(e instanceof Error ? e.message : 'Aggregation failed (RPC / verify error)')
    }
  }, [adapter, selectedRecords])

  // AUTO-run aggregate (read-only) the moment the quorum is met.
  useEffect(() => {
    if (thresholdMet && adapter && !agg && !aggError) void runAggregate()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thresholdMet, adapter, agg, aggError])

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

  const execute = useCallback(async () => {
    if (!safe || !execArgs) return
    setSubmitState({ state: 'busy' })
    try {
      const hash = await wallet.submitExecTransaction(safe, execArgs.args)
      setSubmitState({ state: 'done', detail: hash })
    } catch (e) {
      setSubmitState({ state: 'error', detail: e instanceof Error ? e.message : 'execution rejected' })
    }
  }, [safe, execArgs, wallet])

  // ── wizard progression ──────────────────────────────────────────────────────────────────────
  const iSigned = useMemo(
    () =>
      !!chosen &&
      !!wallet.address &&
      annotated.some((a) => a.signer && isAddressEqual(a.signer, wallet.address as Hex)),
    [annotated, chosen, wallet.address],
  )
  const step1done = !!safeInfo && !!safe
  const step2done = !!chosen
  const step3done = step2done && (signState === 'posted' || iSigned)
  const activeStep = !step1done ? 1 : !step2done ? 2 : !step3done ? 3 : 4

  const meta = chainMeta(safeChainId)
  const valueStr = chosen?.tx ? `${formatUnits(chosen.tx.value, 18)} ${meta.symbol}` : '—'
  const step2Summary = sim?.summary ?? (chosen ? short(chosen.digest) : '')

  // ── render ────────────────────────────────────────────────────────────────────────────────────
  return (
    <div className="wrap">
      <header className="hdr">
        <div className="brand">
          <div className="sig">✶</div>
          <div>
            <div className="eyebrow">signing register</div>
            <h1>Cosign</h1>
          </div>
        </div>
        <div className="who">
          {wallet.address ? (
            <>
              <span className="chip">{short(wallet.address)}</span>
              {board && factors?.enabled ? (
                <span className="live">
                  ◆ <b>on the board</b>
                </span>
              ) : (
                <span className="pill">board offline</span>
              )}
            </>
          ) : (
            <button className="chip" onClick={() => void wallet.connect()} disabled={!wallet.available || wallet.connecting}>
              {wallet.available ? (wallet.connecting ? 'connecting…' : 'connect wallet') : 'no wallet'}
            </button>
          )}
        </div>
      </header>

      <div className="tabrow" style={{ margin: '18px 0 6px' }}>
        <button className={cx('tab', view === 'cosign' && 'on')} onClick={() => setView('cosign')}>
          Co-sign
        </button>
        <button className={cx('tab', view === 'create' && 'on')} onClick={() => setView('create')}>
          Create a Safe
        </button>
      </div>

      {view === 'create' && <CreateSafe wallet={wallet} onCreated={handleCreated} />}

      {view === 'cosign' && (
      <div className="grid">
        {/* ───────────────── MAIN COLUMN ───────────────── */}
        <div>
          {/* STEP 01 — Safe */}
          {step1done && safeInfo && safe ? (
            <RegisterLine n="01" label="Safe" tick="◈" action={{ label: 'change', onClick: editSafe }}>
              {safeInfo.threshold}-of-{safeInfo.owners.length}{' '}
              <span className="tag">
                · {meta.name} {safeChainId} ·
              </span>{' '}
              {short(safe)}
            </RegisterLine>
          ) : (
            <StepCard n="01" title="Pick your Safe" active={activeStep === 1} sub={discovering ? 'discovering…' : 'owned by you'}>
              {!wallet.address ? (
                <>
                  <p className="hint">Connect a wallet to auto-discover the Safes it owns.</p>
                  <button className="btn brass" onClick={() => void wallet.connect()} disabled={!wallet.available || wallet.connecting}>
                    <Icon icon="mdi:wallet" /> {wallet.available ? 'Connect wallet' : 'No injected wallet'}
                  </button>
                  {wallet.error && <div className="notice err">{wallet.error}</div>}
                </>
              ) : (
                <>
                  {discovered && discovered.length > 0 && (
                    <div style={{ marginBottom: 12 }}>
                      <p className="hint">Safes owned by {short(wallet.address)} on {meta.name}:</p>
                      {discovered.map((d) => (
                        <button
                          key={d.address}
                          className={cx('pick', selectedSafe && isAddressEqual(selectedSafe, d.address) && 'on')}
                          onClick={() => void selectAndLoad(d.address)}>
                          <Icon icon="mdi:safe" />
                          {short(d.address)}
                          <span className="pill" style={{ marginLeft: 'auto' }}>
                            {meta.name} {d.chainId}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                  {discovered && discovered.length === 0 && (
                    <div className="notice info">
                      No Safes auto-discovered for this wallet on {meta.name} (indexer/service unavailable or none owned).
                      Enter a Safe address manually below.
                    </div>
                  )}
                  <Field label="Safe address (manual)" hint="Read on your wallet's current chain — the chain id binds the EIP-712 domain.">
                    <div style={{ display: 'flex', gap: 8 }}>
                      <TextInput value={manual} onChange={setManual} placeholder="0x… Safe (proxy) address" mono />
                      <button
                        className="btn"
                        onClick={() => isAddress(manual) && void selectAndLoad(manual as Hex)}
                        disabled={!isAddress(manual) || safeLoading}>
                        {safeLoading ? <Icon icon="mdi:loading" className="spin" /> : 'Load'}
                      </button>
                    </div>
                  </Field>
                  {safeError && <div className="notice err">{safeError}</div>}
                </>
              )}
            </StepCard>
          )}

          {/* STEP 02 — Transaction */}
          {step2done && chosen ? (
            <RegisterLine n="02" label="Transaction" tick="⬡" action={{ label: 'view', onClick: editDigest }}>
              safeTxHash <span className="tag">{short(chosen.digest)}</span>
              {step2Summary && <> · <span className="trunc">{step2Summary}</span></>}
            </RegisterLine>
          ) : (
            <StepCard n="02" title="What to sign" active={activeStep === 2} sub="digest or SafeTx">
              <div className="tabrow">
                <button className={cx('tab', mode === 'safetx' && 'on')} onClick={() => setMode('safetx')}>
                  Build SafeTx
                </button>
                <button className={cx('tab', mode === 'paste' && 'on')} onClick={() => setMode('paste')}>
                  Paste digest
                </button>
              </div>

              {mode === 'paste' ? (
                <Field
                  label="Digest / safeTxHash (bytes32)"
                  hint="Signed with personal_sign → an eth_sign-style ECDSA share. On-chain execute needs the SafeTx fields, so a paste-only digest yields the signatures blob only.">
                  <TextInput value={pasteDigest} onChange={setPasteDigest} placeholder="0x… 32-byte digest" mono />
                </Field>
              ) : (
                <>
                  <div className="formgrid">
                    <Field label="to"><TextInput value={form.to} onChange={setFormField('to')} placeholder="0x… target" mono /></Field>
                    <Field label="value (wei)"><TextInput value={form.value} onChange={setFormField('value')} mono /></Field>
                    <Field label="data"><TextInput value={form.data} onChange={setFormField('data')} mono /></Field>
                    <Field label="operation (0=call,1=delegatecall)"><TextInput value={form.operation} onChange={setFormField('operation')} mono /></Field>
                    <Field label="nonce"><TextInput value={form.nonce} onChange={setFormField('nonce')} mono /></Field>
                    <Field label="safeTxGas"><TextInput value={form.safeTxGas} onChange={setFormField('safeTxGas')} mono /></Field>
                  </div>
                  {builtSafeTx ? (
                    <p className="hint" style={{ margin: '4px 0 0' }}>
                      safeTxHash <span className="mono">{short(builtSafeTx.digest)}</span>
                    </p>
                  ) : (
                    <div className="notice info">Enter a valid `to` address to compute the EIP-712 safeTxHash.</div>
                  )}

                  {/* "What this does" — simulation panel */}
                  {builtSafeTx && (
                    <SimPanel sim={sim} busy={simBusy} onRerun={() => void runSim()} />
                  )}
                </>
              )}

              <div className="btnrow">
                <button
                  className="btn brass"
                  onClick={confirmDigest}
                  disabled={mode === 'paste' ? !pasteValid : !builtSafeTx || (!!sim && sim.reverted)}>
                  <Icon icon="mdi:arrow-right" /> Confirm &amp; continue
                </button>
              </div>
            </StepCard>
          )}

          {/* STEP 03 — Your share */}
          {step3done ? (
            <RegisterLine n="03" label="Your share" tick="✎" action={{ label: 'receipt', onClick: () => void refreshShares() }}>
              signed &amp; posted{' '}
              <span className="tag">
                · {schemeLabel(chosen?.scheme ?? SCHEME.EIP712)}
                {grind ? ` · ${grind.stats.iterations.toString()} iters` : ''}
              </span>
            </RegisterLine>
          ) : (
            <StepCard n="03" title="Sign & post your share" active={activeStep === 3} sub="stamped off-thread">
              {chosen && (
                <>
                  <p className="hint">
                    Sign the {schemeLabel(chosen.scheme)} digest, PoW-stamp it in a Web Worker (never the main
                    thread), and post the share to the board.
                  </p>
                  <div className="btnrow">
                    <button
                      className="btn brass"
                      onClick={() => void sign()}
                      disabled={!board || !scope || signState === 'signing' || signState === 'grinding'}>
                      {signState === 'signing' || signState === 'grinding' ? (
                        <Icon icon="mdi:loading" className="spin" />
                      ) : (
                        <Icon icon="mdi:fountain-pen-tip" />
                      )}
                      Sign &amp; post
                    </button>
                  </div>
                  <div style={{ marginTop: 8 }}>
                    {signState === 'signing' && <span className="pill brass">awaiting wallet signature…</span>}
                    {signState === 'grinding' && (
                      <span className="pill brass">
                        grinding PoW… {grind ? `${grind.stats.iterations.toString()} iters` : ''}
                      </span>
                    )}
                    {signState === 'error' && signError && <div className="notice err">{signError}</div>}
                  </div>
                </>
              )}
            </StepCard>
          )}

          {/* STEP 04 — Collect & execute (terminal active card) */}
          <StepCard n="04" title="Collect & execute" active={activeStep === 4} sub={archiveOn ? 'board ∪ archive' : 'board'}>
            <p className="hint">
              Shares read from the live board{archiveOn ? ' and the archive' : ''}.{' '}
              {thresholdMet ? 'The quorum is met — the seal is ready to execute.' : 'Waiting on more owners to sign.'}
            </p>

            {safeInfo?.owners.map((o) => {
              const match = annotated.find((a) => a.signer && isAddressEqual(a.signer, o))
              const done = !!match
              const you = !!wallet.address && isAddressEqual(o, wallet.address)
              const status = done
                ? `signed · ${schemeLabel(match!.record.scheme).split(' ')[0]}${match!.source === 'archive' ? ' · from archive' : ''}`
                : thresholdMet
                  ? 'not required — quorum met'
                  : 'awaiting signature'
              return <OwnerRow key={o} addr={o} you={you} done={done} status={status} />
            })}

            <div style={{ marginTop: 8 }}>
              <span className={cx('pill', thresholdMet ? 'patina' : 'brass')}>
                {signedOwners.length}/{safeInfo?.threshold ?? '?'} owners signed
              </span>{' '}
              <button className="edit" style={{ marginLeft: 8 }} onClick={() => void refreshShares()}>
                {sharesLoading ? 'reloading…' : 'reload'}
              </button>
            </div>

            {aggError && <div className="notice err">{aggError}</div>}

            {agg && (
              <div style={{ marginTop: 10 }}>
                <span className="pill patina">aggregate ready · {agg.pairs.length} verified</span>
                <div style={{ marginTop: 8 }}>
                  <Copyable value={agg.blob} label="signatures blob" />
                </div>
                <div className="btnrow">
                  {execArgs ? (
                    <button className="btn brass" onClick={() => void execute()} disabled={submitState.state === 'busy'}>
                      {submitState.state === 'busy' ? <Icon icon="mdi:loading" className="spin" /> : <Icon icon="mdi:seal" />}
                      Execute transaction
                    </button>
                  ) : (
                    <span className="pill">paste-only digest — copy the blob and execute via your Safe</span>
                  )}
                  <button
                    className="btn"
                    onClick={() => void navigator.clipboard?.writeText(agg.blob)}>
                    <Icon icon="mdi:content-copy" /> Copy signatures blob
                  </button>
                </div>
                {submitState.state === 'done' && <span className="pill patina">executed: {short(submitState.detail)}</span>}
                {submitState.state === 'error' && <div className="notice err">{submitState.detail}</div>}
              </div>
            )}
          </StepCard>
        </div>

        {/* ───────────────── RAIL — the quorum seal ───────────────── */}
        <aside className="rail-wrap">
          <div className="rail">
            <div className="sealwrap">
              <Seal
                signed={signedOwners.length}
                threshold={safeInfo?.threshold ?? 0}
                ownersTotal={safeInfo?.owners.length ?? 3}
                executed={submitState.state === 'done'} />
            </div>
            <div className="sealcaption">
              <div className="big">
                {submitState.state === 'done'
                  ? 'Sealed'
                  : thresholdMet
                    ? 'Seal ready'
                    : safeInfo
                      ? 'Collecting'
                      : 'Awaiting Safe'}
              </div>
              <div className="small">
                {safeInfo
                  ? `${signedOwners.length} of ${safeInfo.owners.length} owners · threshold ${safeInfo.threshold}`
                  : 'connect + pick a Safe'}
              </div>
            </div>

            <dl className="meta">
              <div className="mrow">
                <dt>safe</dt>
                <dd>
                  {safe ? short(safe) : '—'}{' '}
                  {safeInfo && <span className="q">{safeInfo.threshold}-of-{safeInfo.owners.length}</span>}
                </dd>
              </div>
              <div className="mrow">
                <dt>chain</dt>
                <dd>
                  {meta.name} <span className="q">{safeChainId ?? '?'}</span>
                </dd>
              </div>
              <div className="mrow">
                <dt>digest</dt>
                <dd>{chosen ? short(chosen.digest) : '—'}</dd>
              </div>
              <div className="mrow">
                <dt>value</dt>
                <dd>{valueStr}</dd>
              </div>
            </dl>

            <div className="cfg">
              <span>
                board {endpoint.chainId} · archive {archiveOn ? 'on' : 'off'}
              </span>
              <button className="gear" onClick={() => setShowCfg((s) => !s)}>
                ⚙ settings
              </button>
            </div>
            {showCfg && (
              <div style={{ marginTop: 8 }}>
                <Menu
                  label="board endpoint"
                  options={BOARD_ENDPOINTS.map((b) => b.label)}
                  value={boardIdx}
                  onChange={setBoardIdx}
                />
                <div className="small" style={{ marginTop: 6 }}>
                  {factors ? `work ${factors.workMultiplier}/${factors.workDivisor}` : 'probing board…'}
                </div>
              </div>
            )}
          </div>
        </aside>
      </div>
      )}

      <footer className="foot">
        @msgboard/cosign · safe adapter · ECDSA + EIP-712 · shares stamped off-thread
        <SponsorStatus />
      </footer>
    </div>
  )
}

/** The "What this does" simulation panel. */
function SimPanel(props: { sim: SimResult | null; busy: boolean; onRerun: () => void }) {
  const { sim, busy } = props
  return (
    <div className={cx('sim', sim?.reverted && 'rev')}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span className="eyebrow">what this does</span>
        <button className="edit" style={{ marginLeft: 'auto' }} onClick={props.onRerun} disabled={busy}>
          {busy ? 'simulating…' : 're-simulate'}
        </button>
      </div>
      {busy && !sim && <div className="small">simulating on the Safe's chain…</div>}
      {sim && (
        <>
          <div className="plain">
            {sim.reverted && <Icon icon="mdi:alert" style={{ color: 'var(--oxblood)' }} />} {sim.summary}
          </div>
          {sim.changes.map((c, i) => (
            <div className="chg" key={i}>
              <span className="trunc">
                {short(c.address)} · {c.token ? short(c.token) : c.symbol}
              </span>
              <span className={c.raw < 0n ? 'neg' : 'pos'}>
                {c.amount} {c.token ? '' : c.symbol}
              </span>
            </div>
          ))}
          <details className="raw">
            <summary>raw trace · via {sim.source}</summary>
            <pre>{JSON.stringify(sim.raw, null, 2)}</pre>
          </details>
        </>
      )}
    </div>
  )
}
