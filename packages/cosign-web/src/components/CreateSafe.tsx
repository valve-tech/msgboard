import { useEffect, useMemo, useState } from 'react'
import { type Hex, getAddress, isAddress, isAddressEqual } from 'viem'
import { Icon } from '@iconify/react'
import { useWallet } from '../hooks/useWallet'
import { buildSetup, confirmDeploy, isDeploySupported, predictSafeAddress, randomSaltNonce } from '../lib/deploy-safe'
import { Copyable, Field, StepCard, TextInput, cx } from './ui'

type Status = 'idle' | 'deploying' | 'mining' | 'done' | 'error'

/** The "Create a Safe" panel — owners + threshold form with a live predicted-address preview,
 * gated on the connected chain actually hosting Safe v1.4.1. Deploys via the wallet, verifies the
 * mined proxy against the (pure, pre-computed) predicted address, then hands the new Safe up. */
export function CreateSafe(props: { onCreated: (safe: Hex, chainId: number) => void }) {
  const wallet = useWallet()

  const [owners, setOwners] = useState<string[]>([wallet.address ?? ''])
  const [threshold, setThreshold] = useState(1)
  const [saltNonce, setSaltNonce] = useState<bigint>(() => randomSaltNonce())
  const [status, setStatus] = useState<Status>('idle')
  const [error, setError] = useState<string | null>(null)
  const [txHash, setTxHash] = useState<Hex | null>(null)
  const [newSafe, setNewSafe] = useState<Hex | null>(null)
  const [supported, setSupported] = useState<boolean | null>(null)

  // seed the first (still-empty) owner row with the wallet once it connects
  useEffect(() => {
    if (!wallet.address) return
    setOwners((rows) => (rows.length === 1 && rows[0].trim() === '' ? [wallet.address as string] : rows))
  }, [wallet.address])

  // gate: is the canonical v1.4.1 factory even deployed on the wallet's current chain?
  useEffect(() => {
    if (!wallet.chainId) {
      setSupported(null)
      return
    }
    let cancelled = false
    void isDeploySupported(wallet.publicClient(), wallet.chainId).then((ok) => {
      if (!cancelled) setSupported(ok)
    })
    return () => {
      cancelled = true
    }
  }, [wallet.chainId, wallet.publicClient])

  const validOwners = useMemo<Hex[]>(() => {
    const seen = new Set<string>()
    const out: Hex[] = []
    for (const raw of owners) {
      const trimmed = raw.trim()
      if (!trimmed || !isAddress(trimmed)) continue
      const norm = getAddress(trimmed)
      const key = norm.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push(norm)
    }
    return out
  }, [owners])

  // clamp threshold to 1..validOwners.length whenever the valid-owner count changes
  useEffect(() => {
    setThreshold((t) => Math.min(Math.max(t, 1), Math.max(validOwners.length, 1)))
  }, [validOwners.length])

  const predicted = useMemo<Hex | null>(() => {
    if (validOwners.length === 0 || threshold < 1 || threshold > validOwners.length) return null
    try {
      return predictSafeAddress({ owners: validOwners, threshold, saltNonce })
    } catch {
      return null
    }
  }, [validOwners, threshold, saltNonce])

  const busy = status === 'deploying' || status === 'mining'
  const canDeploy =
    !!wallet.address &&
    supported === true &&
    validOwners.length >= 1 &&
    threshold >= 1 &&
    threshold <= validOwners.length &&
    !busy

  const setOwnerAt = (i: number) => (v: string) => setOwners((rows) => rows.map((r, idx) => (idx === i ? v : r)))
  const addOwner = () => setOwners((rows) => [...rows, ''])
  const removeOwner = (i: number) => setOwners((rows) => rows.filter((_, idx) => idx !== i))
  const regenerateSalt = () => setSaltNonce(randomSaltNonce())

  async function onDeploy() {
    setStatus('deploying')
    setError(null)
    try {
      const initializer = buildSetup(validOwners, threshold)
      const predictedAddr = predictSafeAddress({ owners: validOwners, threshold, saltNonce })
      const hash = await wallet.deploySafe(initializer, saltNonce)
      setTxHash(hash)
      setStatus('mining')
      const safe = await confirmDeploy(wallet.publicClient(), hash, predictedAddr)
      setNewSafe(safe)
      setStatus('done')
      props.onCreated(safe, wallet.chainId!)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Deploy failed')
      setStatus('error')
    }
  }

  return (
    <StepCard n="＋" title="Create a Safe" active sub="v1.4.1 · owners + threshold">
      {!wallet.address ? (
        <>
          <p className="hint">Connect a wallet to deploy — it becomes the default first owner.</p>
          <button className="btn brass" onClick={() => void wallet.connect()} disabled={!wallet.available || wallet.connecting}>
            <Icon icon="mdi:wallet" /> {wallet.available ? (wallet.connecting ? 'connecting…' : 'Connect wallet') : 'No injected wallet'}
          </button>
          {wallet.error && <div className="notice err">{wallet.error}</div>}
        </>
      ) : (
        <>
          {supported === false && (
            <div className="notice err">Safe v1.4.1 isn't available on this chain yet.</div>
          )}

          <Field label="Owners" hint="Case-insensitive dedupe — the same address twice only counts once.">
            {owners.map((addr, i) => {
              const trimmed = addr.trim()
              const valid = trimmed !== '' && isAddress(trimmed)
              const isYou = valid && !!wallet.address && isAddressEqual(getAddress(trimmed), wallet.address)
              return (
                <div className={cx('owner', valid && 'done')} key={i}>
                  <span className={cx('dot', valid ? 'done' : 'wait')} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <TextInput value={addr} onChange={setOwnerAt(i)} placeholder="0x… owner address" mono />
                  </div>
                  {isYou && <span className="you">you</span>}
                  <button type="button" className="edit" onClick={() => removeOwner(i)} disabled={owners.length <= 1}>
                    remove
                  </button>
                </div>
              )
            })}
            <button type="button" className="btn" onClick={addOwner}>
              <Icon icon="mdi:plus" /> Add owner
            </button>
          </Field>

          <Field label="Threshold" hint={`1..${Math.max(validOwners.length, 1)} of ${validOwners.length} valid owner(s)`}>
            <input
              type="number"
              className="input mono"
              style={{ width: 90 }}
              min={1}
              max={Math.max(validOwners.length, 1)}
              value={threshold}
              onChange={(e) => {
                const n = Number(e.target.value) || 1
                setThreshold(Math.min(Math.max(n, 1), Math.max(validOwners.length, 1)))
              }} />
          </Field>

          <div className="field">
            <span className="lbl">Predicted Safe address</span>
            {predicted ? (
              <Copyable value={predicted} label="predicted Safe address" />
            ) : (
              <div className="notice info">Add at least one valid owner to compute the predicted address.</div>
            )}
            <div className="btnrow" style={{ marginTop: 8 }}>
              <button type="button" className="btn" onClick={regenerateSalt} disabled={busy}>
                <Icon icon="mdi:dice-multiple" /> Regenerate salt
              </button>
            </div>
          </div>

          <div className="btnrow">
            <button className="btn brass" onClick={() => void onDeploy()} disabled={!canDeploy}>
              {busy ? <Icon icon="mdi:loading" className="spin" /> : <Icon icon="mdi:safe" />}
              {status === 'deploying' ? 'Awaiting wallet…' : status === 'mining' ? 'Mining…' : 'Deploy Safe'}
            </button>
          </div>

          {status === 'mining' && txHash && (
            <div className="notice info">Waiting for confirmation · tx {txHash}</div>
          )}
          {status === 'done' && newSafe && (
            <div className="notice info">Safe deployed at {newSafe} — switching to the co-sign view…</div>
          )}
          {status === 'error' && error && <div className="notice err">{error}</div>}
        </>
      )}
    </StepCard>
  )
}
