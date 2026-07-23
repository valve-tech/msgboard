import { useEffect, useState } from 'react'
import * as viem from 'viem'
import { createMsgBoardClient } from '@msgboard/games'
import type { GameDeployment } from '../config'
import { sendGameTx } from '../tx'
import { publicClientFor } from '../wallet'
import { useFlipBookX, type BoardOffer, type XFlip } from '../hooks/useFlipBookX'
import {
  FLIPX_CATEGORY,
  flipBookXAbi,
  newSalt,
  receiveAuthTypedData,
  saveXSecret,
  x402Abi,
  xCommit,
  xOfferId,
  xSecretFor,
  xTakerNonce,
  type XOffer,
} from '../lib/flipBookXContract'
import { AddressLink, InfoDot, SourceNote, fmtAmount } from './Meta'
import { StakeInput, parseStake } from './StakeInput'

const fmtLeft = (seconds: number): string => {
  if (seconds <= 0) return 'now'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`
  return `${s}s`
}

/**
 * VARIANT B — the SIGNED flip book. An offer here is nothing but a signature: your hidden coin
 * choice (a commit) plus an EIP-3009/7598 transfer authorization over x402PLS, sprayed to
 * msgboard for free. Nothing is escrowed until someone takes; the taker's guess is hidden too,
 * so cancelling can never dodge a loss. Two-phase reveal (maker's choice, then taker's guess),
 * each side bonded for its own reveal. The book arrives over a WEBSOCKET — every new chain head
 * pushes a refresh; no polling.
 */
export const FlipBookXScreen = ({
  deployment,
  walletClient,
  trustAcknowledged,
  myAddress,
}: {
  deployment: GameDeployment
  walletClient?: viem.WalletClient
  trustAcknowledged: boolean
  myAddress?: viem.Hex
}) => {
  const data = useFlipBookX(deployment.flipBookX ? deployment : null)
  const [choice, setChoice] = useState(true)
  const [amount, setAmount] = useState('0.1')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [x402Balance, setX402Balance] = useState<bigint>()

  const [now, setNow] = useState(data.chainNow)
  useEffect(() => {
    setNow(data.chainNow)
    const t0 = Date.now()
    const timer = setInterval(() => setNow(data.chainNow + Math.floor((Date.now() - t0) / 1000)), 1000)
    return () => clearInterval(timer)
  }, [data.chainNow])

  const book = deployment.flipBookX
  const token = deployment.x402Pls
  const stake = parseStake(amount)
  const connected = walletClient !== undefined && myAddress !== undefined
  const canAct = connected && trustAcknowledged && !busy && !!book && !!token
  const mine = (a?: viem.Hex) => myAddress !== undefined && a?.toLowerCase() === myAddress.toLowerCase()

  useEffect(() => {
    if (!token || !myAddress) return
    const client = publicClientFor(deployment.chainId, deployment.rpc)
    void client
      .readContract({ address: token, abi: x402Abi, functionName: 'balanceOf', args: [myAddress] })
      .then(setX402Balance)
      .catch(() => undefined)
  }, [deployment, token, myAddress, data.flips.length, busy])

  const run = async (fn: () => Promise<string | void>) => {
    setBusy(true)
    setError(undefined)
    setNotice(undefined)
    try {
      const msg = await fn()
      if (msg) setNotice(msg)
      data.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const wrap = (value: bigint) =>
    run(async () => {
      if (!walletClient || !token) return
      await sendGameTx(deployment, walletClient, { address: token, abi: x402Abi as viem.Abi, functionName: 'wrap', args: [], value })
      return `wrapped ${fmtAmount(deployment, value)} into x402PLS`
    })

  /** Maker: ONE wallet signature = the whole standing offer. Free to post, nothing escrowed. */
  const postOffer = () =>
    run(async () => {
      if (!walletClient?.account || !myAddress || !book || !token || stake === undefined) return
      const bond = stake / 5n
      const salt = newSalt()
      const offer: XOffer = {
        maker: myAddress,
        commit: xCommit(myAddress, choice, salt),
        stake,
        makerBond: bond,
        takerBond: bond,
        takeDeadline: BigInt(now + 2 * 3600),
        makerRevealWindow: 900,
        takerRevealWindow: 900,
      }
      const id = xOfferId(deployment.chainId, book, offer)
      // Secret FIRST — once the signature exists, this browser holds the only opening.
      saveXSecret(deployment.chainId, book, offer.commit, { bit: choice, salt, role: 'maker' })
      const makerSig = await walletClient.signTypedData({
        account: walletClient.account,
        ...receiveAuthTypedData({
          chainId: deployment.chainId,
          token,
          from: myAddress,
          to: book,
          value: stake + bond,
          validBefore: offer.takeDeadline,
          nonce: id,
        }),
      })
      // Spray to the board: PoW-stamped, gas-free, cancellable any time via the wrapper.
      const board = createMsgBoardClient(deployment.boardRpc!)
      const payload = {
        v: 1,
        t: 'offerx',
        at: Date.now(),
        makerSig,
        offer: {
          ...offer,
          stake: offer.stake.toString(),
          makerBond: offer.makerBond.toString(),
          takerBond: offer.takerBond.toString(),
          takeDeadline: offer.takeDeadline.toString(),
        },
      }
      const hex = viem.stringToHex(JSON.stringify(payload))
      const work = await board.doPoW(FLIPX_CATEGORY, hex)
      await board.addMessage(work.message)
      return `signed offer ${id.slice(0, 10)}… posted to the board — no funds moved`
    })

  /** Taker: hidden guess + one signature + one transaction pulls both escrows atomically. */
  const take = (o: BoardOffer, guess: boolean) =>
    run(async () => {
      if (!walletClient?.account || !myAddress || !book || !token) return
      const salt2 = newSalt()
      const guessCommit = xCommit(myAddress, guess, salt2)
      saveXSecret(deployment.chainId, book, guessCommit, { bit: guess, salt: salt2, role: 'taker' })
      const takerSig = await walletClient.signTypedData({
        account: walletClient.account,
        ...receiveAuthTypedData({
          chainId: deployment.chainId,
          token,
          from: myAddress,
          to: book,
          value: o.offer.stake + o.offer.takerBond,
          validBefore: o.offer.takeDeadline,
          nonce: xTakerNonce(o.id, myAddress),
        }),
      })
      await sendGameTx(deployment, walletClient, {
        address: book,
        abi: flipBookXAbi as viem.Abi,
        functionName: 'take',
        args: [o.offer, o.makerSig, myAddress, guessCommit, takerSig],
      })
      return `took ${o.id.slice(0, 10)}… — your guess stays hidden until the maker reveals`
    })

  const revealChoice = (f: XFlip) =>
    run(async () => {
      if (!walletClient || !book) return
      const s = xSecretFor(deployment.chainId, book, /* maker commit is not in the event — */ f.offerId)
      // maker secrets are stored under the COMMIT; recover via the flips() view
      const client = publicClientFor(deployment.chainId, deployment.rpc)
      const flip = (await client.readContract({
        address: book,
        abi: viem.parseAbi([
          'function flips(bytes32) view returns (address maker, address taker, bytes32 commit, bytes32 guessCommit, uint256 stake, uint256 makerBond, uint256 takerBond, uint64 takenAt, uint64 choiceRevealedAt, uint32 w1, uint32 w2, bool choice)',
        ]),
        functionName: 'flips',
        args: [f.offerId],
      })) as readonly [viem.Hex, viem.Hex, viem.Hex, viem.Hex, bigint, bigint, bigint, bigint, bigint, number, number, boolean]
      const secret = s ?? xSecretFor(deployment.chainId, book, flip[2])
      if (!secret) throw new Error('secret not in this browser — reveal from the browser that posted the offer')
      await sendGameTx(deployment, walletClient, {
        address: book,
        abi: flipBookXAbi as viem.Abi,
        functionName: 'revealChoice',
        args: [f.offerId, secret.bit, secret.salt],
      })
      return 'choice revealed — your bond is back'
    })

  const revealGuess = (f: XFlip) =>
    run(async () => {
      if (!walletClient || !book) return
      const secret = xSecretFor(deployment.chainId, book, f.guessCommit)
      if (!secret) throw new Error('guess secret not in this browser — reveal from the browser that took the offer')
      await sendGameTx(deployment, walletClient, {
        address: book,
        abi: flipBookXAbi as viem.Abi,
        functionName: 'revealGuess',
        args: [f.offerId, secret.bit, secret.salt],
      })
      return 'guess revealed — the flip settles now'
    })

  const claim = (f: XFlip, kind: 'maker' | 'taker') =>
    run(async () => {
      if (!walletClient || !book) return
      await sendGameTx(deployment, walletClient, {
        address: book,
        abi: flipBookXAbi as viem.Abi,
        functionName: kind === 'maker' ? 'claimMakerDefault' : 'claimTakerDefault',
        args: [f.offerId],
      })
      return 'default claimed'
    })

  if (!book || !token) {
    return <div className="banner">the signed flip book isn't deployed on {deployment.label} yet</div>
  }

  const open = data.boardOffers
  const inflight = data.flips.filter((f) => f.status === 'taken' || f.status === 'choiceRevealed')
  const settled = data.flips.filter((f) => f.status === 'settled' || f.status === 'makerDefaulted' || f.status === 'takerDefaulted').slice(0, 12)
  const myDue = inflight.filter(
    (f) =>
      (f.status === 'taken' && mine(f.maker) && now <= f.choiceRevealBy) ||
      (f.status === 'choiceRevealed' && mine(f.taker) && now <= (f.guessRevealBy ?? 0)),
  )

  return (
    <div>
      {data.error && <div className="banner bad">read failed: {data.error}</div>}
      {error && <div className="banner bad">{error}</div>}
      {notice && <div className="banner">{notice}</div>}
      {myDue.length > 0 && (
        <div className="banner bad">
          <strong>Reveal due:</strong> miss your window and you forfeit your bond{myDue.some((f) => mine(f.maker)) ? ' (and the pot)' : ''}.
        </div>
      )}

      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <strong>
            Post a signed offer{' '}
            <InfoDot label="how signed offers work">
              Your offer is <strong>just a signature</strong> — a hidden coin choice plus a transfer
              authorization over x402PLS (wrapped PLS, 1:1). Posting costs a proof-of-work stamp, not gas, and
              locks nothing: funds move only if someone takes it, and you can cancel any time by voiding the
              authorization. The taker's guess is hidden too, so nobody can dodge a loss. After a take: you
              reveal your choice within 15 minutes, then the taker reveals their guess — each reveal returns
              that side's bond, and going silent forfeits it.
            </InfoDot>
          </strong>
          <SourceNote deployment={deployment} contract={book} contractLabel="FlipBookX" />
        </div>
        <div className="row">
          <span className="muted">your x402PLS</span>
          <span className="mono">{x402Balance !== undefined ? fmtAmount(deployment, x402Balance) : '—'}</span>
          <button className="secondary" onClick={() => void wrap(viem.parseEther('1'))} disabled={!canAct}>
            Wrap 1 PLS
          </button>
          <InfoDot label="what wrapping is">
            x402PLS is native PLS wrapped 1:1 into a token that supports signed transfers (EIP-3009/7598) —
            the valve x402 wrapper, adminless and redeemable any time. Your stake + bond must be in x402PLS
            before an offer or take can settle against your signature.
          </InfoDot>
        </div>
        <div className="row">
          <span className="muted">your hidden side</span>
          <button className={choice ? '' : 'secondary'} onClick={() => setChoice(true)} disabled={busy}>
            heads
          </button>
          <button className={choice ? 'secondary' : ''} onClick={() => setChoice(false)} disabled={busy}>
            tails
          </button>
          <span className="muted">stake</span>
          <StakeInput value={amount} onChange={setAmount} />
        </div>
        <div className="row">
          <button onClick={() => void postOffer()} disabled={!canAct || stake === undefined}>
            {busy ? 'working…' : 'Sign & post (free — no escrow)'}
          </button>
          {!connected && <span className="muted">connect a wallet to play</span>}
          <span className="muted">
            live over websocket · {data.wsHeads} head{data.wsHeads === 1 ? '' : 's'} pushed
          </span>
        </div>
      </div>

      <h3>Signed offers on the board {data.loading && <span className="muted">refreshing…</span>}</h3>
      {open.length === 0 && <div className="muted">no signed offers right now — post one above, it costs nothing</div>}
      {open.map((o) => (
        <div className="card" key={o.id}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span>
              <span className="tag">{o.id.slice(0, 10)}…</span>
              <AddressLink deployment={deployment} address={o.offer.maker} />
              {mine(o.offer.maker) && <span className="tag ok">you</span>}
              <span className="muted"> stakes </span>
              <strong>{fmtAmount(deployment, o.offer.stake)}</strong>
              <span className="muted"> · your bond {fmtAmount(deployment, o.offer.takerBond)} · open {fmtLeft(Number(o.offer.takeDeadline) - now)} more</span>
            </span>
          </div>
          <div className="row">
            {mine(o.offer.maker) ? (
              <span className="muted">your standing offer — void it any time by cancelling the authorization in your wallet's token</span>
            ) : (
              <>
                <span className="muted">call their coin (your guess stays hidden):</span>
                <button onClick={() => void take(o, true)} disabled={!canAct}>
                  heads
                </button>
                <button onClick={() => void take(o, false)} disabled={!canAct}>
                  tails
                </button>
              </>
            )}
          </div>
        </div>
      ))}

      {inflight.length > 0 && <h3>In flight</h3>}
      {inflight.map((f) => {
        const phase1 = f.status === 'taken'
        const deadline = phase1 ? f.choiceRevealBy : (f.guessRevealBy ?? 0)
        const left = deadline - now
        return (
          <div className="card" key={f.offerId}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span>
                <span className="tag">{f.offerId.slice(0, 10)}…</span>
                <AddressLink deployment={deployment} address={f.maker} />
                {mine(f.maker) && <span className="tag ok">you</span>}
                <span className="muted"> vs </span>
                <AddressLink deployment={deployment} address={f.taker} />
                {mine(f.taker) && <span className="tag ok">you</span>}
                <span className="muted"> · {fmtAmount(deployment, f.stake)} · {phase1 ? 'maker must reveal choice' : `coin was ${f.choice ? 'heads' : 'tails'} — taker must reveal guess`}</span>
              </span>
              <span className={left <= 0 ? 'bad' : 'muted'}>{left > 0 ? `due in ${fmtLeft(left)}` : 'window over'}</span>
            </div>
            <div className="row">
              {phase1 && left > 0 && mine(f.maker) && (
                <button onClick={() => void revealChoice(f)} disabled={!canAct}>
                  Reveal choice
                </button>
              )}
              {!phase1 && left > 0 && mine(f.taker) && (
                <button onClick={() => void revealGuess(f)} disabled={!canAct}>
                  Reveal guess
                </button>
              )}
              {left <= 0 && (
                <button onClick={() => void claim(f, phase1 ? 'maker' : 'taker')} disabled={!canAct}>
                  Claim default
                </button>
              )}
            </div>
          </div>
        )
      })}

      {settled.length > 0 && <h3>Settled</h3>}
      {settled.map((f) => (
        <div className="card" key={f.offerId}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span>
              <span className="tag">{f.offerId.slice(0, 10)}…</span>
              {f.status === 'settled' ? (
                <span className="ok">
                  <AddressLink deployment={deployment} address={f.winner!} /> takes {fmtAmount(deployment, f.pot ?? 0n)}
                </span>
              ) : (
                <span>
                  <span className="tag">{f.status === 'makerDefaulted' ? 'maker no-show' : 'taker no-show'}</span>{' '}
                  <span className="ok">
                    <AddressLink deployment={deployment} address={f.winner!} /> claims {fmtAmount(deployment, f.pot ?? 0n)}
                  </span>
                </span>
              )}
              {mine(f.winner) && <span className="tag gold" style={{ marginLeft: '0.4rem' }}>you won</span>}
            </span>
          </div>
        </div>
      ))}
    </div>
  )
}
