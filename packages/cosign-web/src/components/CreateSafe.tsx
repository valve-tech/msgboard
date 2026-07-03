import { useEffect, useMemo, useState } from 'react'
import { type Hex, getAddress, isAddress, isAddressEqual } from 'viem'
import { Icon } from '@iconify/react'
import type { UseWallet } from '../hooks/useWallet'
import { SAFE_V141, buildSetup, confirmDeploy, isDeploySupported, predictSafeAddress, randomSaltNonce } from '../lib/deploy-safe'
import { deployRequestDigest, fetchRelayConfig, solveDeployPow, sponsoredDeploy } from '../lib/gasless'
import { Copyable, Field, StepCard, TextInput, cx } from './ui'

type Status = 'idle' | 'deploying' | 'signing' | 'grinding' | 'relaying' | 'mining' | 'error'

/** The "Create a Safe" panel — owners + threshold form with a live predicted-address preview,
 * gated on the connected chain actually hosting Safe v1.4.1. Deploys via the wallet, verifies the
 * mined proxy against the (pure, pre-computed) predicted address, then hands the new Safe up.
 *
 * Takes the single app-wide `wallet` instance as a prop rather than calling `useWallet()` itself —
 * a second instance would never see this one's `chainId`/`address` (there's no cross-instance
 * broadcast), so the handoff to the co-sign view would silently no-op. */
export function CreateSafe(props: { wallet: UseWallet; onCreated: (safe: Hex, chainId: number) => void }) {
  const { wallet } = props

  const [owners, setOwners] = useState<string[]>([wallet.address ?? ''])
  const [threshold, setThreshold] = useState(1)
  const [saltNonce, setSaltNonce] = useState<bigint>(() => randomSaltNonce())
  const [status, setStatus] = useState<Status>('idle')
  const [error, setError] = useState<string | null>(null)
  const [txHash, setTxHash] = useState<Hex | null>(null)
  const [supported, setSupported] = useState<boolean | null>(null)

  // the optional gasless-deploy relay — only offered on chains it actually sponsors right now
  const [relayChains, setRelayChains] = useState<number[]>([])
  const [relayPowBits, setRelayPowBits] = useState(0)
  const [gasless, setGasless] = useState(false)

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
    void isDeploySupported(wallet.publicClient()).then((ok) => {
      if (!cancelled) setSupported(ok)
    })
    return () => {
      cancelled = true
    }
  }, [wallet.chainId, wallet.publicClient])

  // does the relay currently sponsor this chain? re-fetched on mount and whenever the chain changes.
  useEffect(() => {
    let cancelled = false
    void fetchRelayConfig().then((cfg) => {
      if (cancelled) return
      setRelayChains(cfg.chains)
      setRelayPowBits(cfg.powBits)
    })
    return () => {
      cancelled = true
    }
  }, [wallet.chainId])

  const gaslessAvailable = wallet.chainId != null && relayChains.includes(wallet.chainId)

  // if the relay stops covering this chain (or the chain changes out from under an armed toggle),
  // fall back to the user-pays path rather than silently attempting an unsponsored relay call.
  useEffect(() => {
    if (!gaslessAvailable) setGasless(false)
  }, [gaslessAvailable])

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

  const busy =
    status === 'deploying' || status === 'signing' || status === 'grinding' || status === 'relaying' || status === 'mining'
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
    // capture the chain we're actually deploying on up front — the Deploy button is already
    // disabled whenever this is null (see `canDeploy`), so this is never a silent no-op, and it
    // avoids asserting non-null on a value that could in principle change out from under us.
    const chainId = wallet.chainId
    if (chainId == null) {
      setError('Wallet chain unknown — reconnect and try again')
      setStatus('error')
      return
    }
    setError(null)
    try {
      const initializer = buildSetup(validOwners, threshold)
      const predictedAddr = predictSafeAddress({ owners: validOwners, threshold, saltNonce })

      let hash: Hex
      if (gasless) {
        // relay-sponsored path: sign the request digest, grind the relay's PoW, then let it submit
        // + pay gas. The mined proxy is verified against `predictedAddr` exactly like the
        // user-pays path below — a misbehaving relay can never hand back an unpredicted address.
        setStatus('signing')
        const digest = deployRequestDigest({ chainId, singleton: SAFE_V141.singletonL2, initializer, saltNonce })
        const signature = await wallet.signRawDigest(digest)
        setStatus('grinding')
        const powNonce = await solveDeployPow(digest, relayPowBits)
        setStatus('relaying')
        hash = await sponsoredDeploy({ chainId, initializer, saltNonce, signature, powNonce })
      } else {
        setStatus('deploying')
        hash = await wallet.deploySafe(initializer, saltNonce)
      }

      setTxHash(hash)
      setStatus('mining')
      const safe = await confirmDeploy(wallet.publicClient(), hash, predictedAddr)
      props.onCreated(safe, chainId)
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
                    <TextInput value={addr} onChange={setOwnerAt(i)} placeholder="0x… owner address" mono disabled={busy} />
                  </div>
                  {isYou && <span className="you">you</span>}
                  <button type="button" className="edit" onClick={() => removeOwner(i)} disabled={busy || owners.length <= 1}>
                    remove
                  </button>
                </div>
              )
            })}
            <button type="button" className="btn" onClick={addOwner} disabled={busy}>
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
              disabled={busy}
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

          {gaslessAvailable && (
            <div className="field">
              <label className="lbl" style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: busy ? 'default' : 'pointer' }}>
                <input
                  type="checkbox"
                  checked={gasless}
                  disabled={busy}
                  onChange={(e) => setGasless(e.target.checked)} />
                Gasless deploy (relay-sponsored)
              </label>
              <p className="hint">
                The relay pays gas — you sign the request and solve a small proof of work (~{relayPowBits} bits) instead.
              </p>
            </div>
          )}

          <div className="btnrow">
            <button className="btn brass" onClick={() => void onDeploy()} disabled={!canDeploy}>
              {busy ? <Icon icon="mdi:loading" className="spin" /> : <Icon icon="mdi:safe" />}
              {status === 'deploying'
                ? 'Awaiting wallet…'
                : status === 'signing'
                  ? 'Awaiting signature…'
                  : status === 'grinding'
                    ? 'Solving proof of work…'
                    : status === 'relaying'
                      ? 'Submitting via relay…'
                      : status === 'mining'
                        ? 'Mining…'
                        : 'Deploy Safe'}
            </button>
          </div>

          {status === 'mining' && txHash && (
            <div className="notice info">Waiting for confirmation · tx {txHash}</div>
          )}
          {status === 'error' && error && <div className="notice err">{error}</div>}
        </>
      )}
    </StepCard>
  )
}
