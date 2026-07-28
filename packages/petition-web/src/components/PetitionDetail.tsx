import { useCallback, useEffect, useMemo, useState } from 'react'
import { Icon } from '@iconify/react'
import { isAddressEqual, type Hex } from 'viem'
import type { SignatureRecord } from '@msgboard/cosign'
import type { Petition } from '@msgboard/petition'
import type { BoardClient } from '../seams/worker-board.js'
import type { UseWallet } from '../hooks/useWallet.js'
import { fetchAllPetitionSignatures, fetchPetitionTally } from '../lib/read-side.js'
import { fetchSettledSigners } from '../lib/settled.js'
import { signPetition as signPetitionFlow, settle as settleFlow } from '../lib/petition-client.js'
import { outstanding } from '../lib/reconcile.js'
import { chainMeta } from '../lib/config.js'
import { Copyable, short } from './ui.js'
import { Tally } from './Tally.js'
import { VerifyPanel, type VerifyOutcome } from './VerifyPanel.js'
import { SignerList } from './SignerList.js'

export function PetitionDetail(props: {
  petition: Petition
  board: BoardClient | null
  wallet: UseWallet
  verifyingContract: Hex | null
  readBase: string
  indexerBase: string
  onBack: () => void
}) {
  const { petition, board, wallet, verifyingContract, readBase, indexerBase } = props
  const meta = chainMeta(petition.chainId)

  const [captured, setCaptured] = useState<SignatureRecord[] | null>(null)
  const [capturedCount, setCapturedCount] = useState(0)
  const [settledSigners, setSettledSigners] = useState<Hex[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const [records, tally, settled] = await Promise.all([
        fetchAllPetitionSignatures(petition.id, readBase),
        fetchPetitionTally(petition.id, readBase),
        fetchSettledSigners(petition.chainId, petition.id, indexerBase),
      ])
      setCaptured(records)
      setCapturedCount(tally.count)
      setSettledSigners(settled)
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Failed to load petition data')
    } finally {
      setLoading(false)
    }
  }, [petition.id, petition.chainId, readBase, indexerBase])

  useEffect(() => {
    void load()
  }, [load])

  const [verifyOutcome, setVerifyOutcome] = useState<VerifyOutcome | null>(null)

  // ── sign ─────────────────────────────────────────────────────────────────────────────────────
  const [signState, setSignState] = useState<'idle' | 'signing' | 'capturing' | 'done' | 'error'>('idle')
  const [signError, setSignError] = useState<string | null>(null)

  const alreadySigned = useMemo(
    () => !!wallet.address && !!captured?.some((r) => isAddressEqual(r.signer, wallet.address as Hex)),
    [captured, wallet.address],
  )

  const doSign = useCallback(async () => {
    if (!board || !wallet.address || !verifyingContract) return
    setSignError(null)
    setSignState('signing')
    try {
      setSignState('capturing')
      await signPetitionFlow(board, petition, verifyingContract, wallet.address, wallet.signTyped)
      setSignState('done')
      await load()
    } catch (e) {
      setSignError(e instanceof Error ? e.message : 'Failed to sign & post')
      setSignState('error')
    }
  }, [board, wallet.address, wallet.signTyped, verifyingContract, petition, load])

  // ── settle ───────────────────────────────────────────────────────────────────────────────────
  const [settleState, setSettleState] = useState<{ state: 'idle' | 'busy' | 'done' | 'error'; detail?: string }>({
    state: 'idle',
  })

  const outstandingSigners = useMemo(
    () => (verifyOutcome ? outstanding(verifyOutcome.verifiedSigners, settledSigners) : []),
    [verifyOutcome, settledSigners],
  )

  const doSettle = useCallback(async () => {
    if (!verifyOutcome || !verifyingContract) return
    setSettleState({ state: 'busy' })
    try {
      const hash = await settleFlow(
        petition,
        verifyingContract,
        verifyOutcome,
        settledSigners,
        wallet.submitBatch,
        async () => {
          const block = await wallet.publicClient().getBlock()
          return block.baseFeePerGas ?? 0n
        },
      )
      setSettleState({ state: 'done', detail: hash })
      await load()
    } catch (e) {
      setSettleState({ state: 'error', detail: e instanceof Error ? e.message : 'settle tx failed' })
    }
  }, [verifyOutcome, verifyingContract, petition, settledSigners, wallet, load])

  const allSigners = useMemo<Hex[]>(() => {
    const seen = new Set<string>()
    const out: Hex[] = []
    for (const r of captured ?? []) {
      const lower = r.signer.toLowerCase()
      if (seen.has(lower)) continue
      seen.add(lower)
      out.push(r.signer)
    }
    return out
  }, [captured])

  const verifiedSet = useMemo(() => new Set(verifyOutcome?.verifiedSigners.map((s) => s.toLowerCase())), [verifyOutcome])
  const settledSet = useMemo(() => new Set(settledSigners.map((s) => s.toLowerCase())), [settledSigners])

  return (
    <div>
      <button type="button" className="edit" onClick={props.onBack} style={{ marginBottom: 12 }}>
        ← back to directory
      </button>

      <div className="step active">
        <div className="head">
          <span className="num on">✶</span>
          <h3>{petition.statement}</h3>
          <span className="sub">
            {meta.name} {petition.chainId}
          </span>
        </div>
        <div className="body">
          <p className="hint">
            petition id <span className="mono">{short(petition.id)}</span> · created by{' '}
            <span className="mono">{short(petition.creator)}</span>
          </p>

          {loadError && <div className="notice err">{loadError}</div>}

          <Tally
            capturedCount={capturedCount}
            verifiedCount={verifyOutcome?.verifiedSigners.length ?? 0}
            settledCount={settledSigners.length}
          />

          {!verifyingContract && (
            <div className="notice info">
              No PetitionSignatures verifier is configured for chain {petition.chainId} — set{' '}
              <code>VITE_PETITION_ADDR_{petition.chainId}</code>. Signing and settling are disabled until then.
            </div>
          )}

          <div className="btnrow">
            {!wallet.address ? (
              <button className="btn brass" onClick={() => void wallet.connect()} disabled={!wallet.available || wallet.connecting}>
                <Icon icon="mdi:wallet" /> {wallet.available ? 'Connect wallet' : 'No injected wallet'}
              </button>
            ) : alreadySigned || signState === 'done' ? (
              <span className="pill patina">✓ you signed this petition</span>
            ) : (
              <button
                className="btn brass"
                onClick={() => void doSign()}
                disabled={!board || !verifyingContract || signState === 'signing' || signState === 'capturing'}>
                {signState === 'signing' || signState === 'capturing' ? (
                  <Icon icon="mdi:loading" className="spin" />
                ) : (
                  <Icon icon="mdi:fountain-pen-tip" />
                )}
                {signState === 'signing' ? 'Awaiting signature…' : signState === 'capturing' ? 'Waiting for capture…' : 'Sign & post'}
              </button>
            )}
            <button className="btn" onClick={() => void load()} disabled={loading}>
              <Icon icon={loading ? 'mdi:loading' : 'mdi:refresh'} className={loading ? 'spin' : undefined} /> reload
            </button>
          </div>
          {signState === 'error' && signError && <div className="notice err">{signError}</div>}

          {captured && captured.length > 0 && verifyingContract && (
            <VerifyPanel petition={petition} verifyingContract={verifyingContract} records={captured} onResult={setVerifyOutcome} />
          )}

          <div style={{ marginTop: 14 }}>
            <div className="eyebrow" style={{ marginBottom: 8 }}>
              signers
            </div>
            <SignerList signers={allSigners} verifiedSet={verifiedSet} settledSet={settledSet} />
          </div>

          <div style={{ marginTop: 14 }}>
            <div className="eyebrow" style={{ marginBottom: 8 }}>
              settle outstanding on-chain
            </div>
            <p className="hint">
              {outstandingSigners.length} verified signer{outstandingSigners.length === 1 ? '' : 's'} not yet settled on-chain.
            </p>
            <div className="btnrow">
              <button
                className="btn brass"
                onClick={() => void doSettle()}
                disabled={!wallet.address || !verifyingContract || outstandingSigners.length === 0 || settleState.state === 'busy'}>
                {settleState.state === 'busy' ? <Icon icon="mdi:loading" className="spin" /> : <Icon icon="mdi:seal" />}
                Settle outstanding on-chain
              </button>
            </div>
            {settleState.state === 'done' && settleState.detail && (
              <div style={{ marginTop: 8 }}>
                <Copyable value={settleState.detail} label="settle tx hash" />
              </div>
            )}
            {settleState.state === 'error' && <div className="notice err">{settleState.detail}</div>}
          </div>
        </div>
      </div>
    </div>
  )
}
