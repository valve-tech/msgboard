import { useEffect, useState } from 'react'
import * as viem from 'viem'
import type { GameDeployment } from '../config'
import { sendGameTx } from '../tx'
import { useFlipBook, type OfferView } from '../hooks/useFlipBook'
import { useBoardBroadcaster } from '../hooks/useBoardBroadcaster'
import {
  flipBookAbi,
  flipCommit,
  flipSecretFor,
  forgetFlipSecret,
  newSalt,
  saveFlipSecret,
  sideLabel,
} from '../lib/flipBookContract'
import { AddressLink, InfoDot, SourceNote, explorerUrl, fmtAmount } from './Meta'
import { StakeInput, parseStake } from './StakeInput'

const OPEN_FOR = [
  { label: '1 hour', seconds: 3_600 },
  { label: '6 hours', seconds: 21_600 },
  { label: '24 hours', seconds: 86_400 },
] as const

const REVEAL_WINDOWS = [
  { label: '10 min', seconds: 600 },
  { label: '1 hour', seconds: 3_600 },
  { label: '6 hours', seconds: 21_600 },
] as const

/** "3h 12m" / "4m 09s" — a countdown that stays short on a card line. */
const fmtLeft = (seconds: number): string => {
  if (seconds <= 0) return 'now'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`
  return `${s}s`
}

const TxLink = ({ deployment, tx }: { deployment: GameDeployment; tx?: viem.Hex }) => {
  if (!tx) return null
  const url = explorerUrl(deployment, 'tx', tx)
  return url ? (
    <a href={url} target="_blank" rel="noreferrer">
      tx ↗
    </a>
  ) : null
}

/**
 * The coin flip as an OFFER BOOK — the P2P guessing game (matching pennies) played against
 * FlipBook. A maker escrows stake+bond behind a hidden heads/tails commit; a taker matches the
 * stake and states a public guess; the maker opens the commit within the window or forfeits
 * stake AND bond. No validators, no house, no shared randomness: guessing uniformly wins exactly
 * half against ANY opponent strategy, so each side's odds are protected by their own coin.
 *
 * The maker's (choice, salt) lives ONLY in this browser's localStorage (written before the post
 * tx) — the screen's job is to make the reveal deadline impossible to miss.
 */
export const FlipBookScreen = ({
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
  const data = useFlipBook(deployment, myAddress)
  const broadcast = useBoardBroadcaster({ boardRpc: deployment.boardRpc, chainId: deployment.chainId })
  const [choice, setChoice] = useState<boolean>(true)
  const [amount, setAmount] = useState('0.1')
  const [bondAmount, setBondAmount] = useState('0.05')
  const [openFor, setOpenFor] = useState<number>(OPEN_FOR[1].seconds)
  const [revealWindow, setRevealWindow] = useState<number>(REVEAL_WINDOWS[1].seconds)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  // Countdowns tick against CHAIN time: anchor at the head timestamp each poll, advance locally.
  const [now, setNow] = useState(data.chainNow)
  useEffect(() => {
    setNow(data.chainNow)
    const t0 = Date.now()
    const timer = setInterval(() => setNow(data.chainNow + Math.floor((Date.now() - t0) / 1000)), 1000)
    return () => clearInterval(timer)
  }, [data.chainNow])

  const flipBook = deployment.flipBook
  const stake = parseStake(amount)
  const bond = parseStake(bondAmount)
  const connected = walletClient !== undefined && myAddress !== undefined
  const canAct = connected && trustAcknowledged && !busy && flipBook !== undefined
  const mine = (a?: viem.Hex) => myAddress !== undefined && a?.toLowerCase() === myAddress.toLowerCase()

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError(undefined)
    try {
      await fn()
      data.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const post = () =>
    run(async () => {
      if (!walletClient || !myAddress || !flipBook || stake === undefined || bond === undefined) return
      const salt = newSalt()
      const commit = flipCommit(myAddress, choice, salt)
      // Persist the secret BEFORE broadcasting: once the escrow is on chain, this browser holds
      // the only copy of the opening — losing it would mean forfeiting the flip.
      saveFlipSecret(deployment.chainId, flipBook, commit, { choice, salt })
      await sendGameTx(deployment, walletClient, {
        address: flipBook,
        abi: flipBookAbi,
        functionName: 'post',
        args: [commit, bond, BigInt(now + openFor), revealWindow],
        value: stake + bond,
      })
      broadcast({ kind: 'open', game: 'flipbook', stake: viem.formatEther(stake), bond: viem.formatEther(bond) })
    })

  const take = (offer: OfferView, guess: boolean) =>
    run(async () => {
      if (!walletClient || !flipBook) return
      await sendGameTx(deployment, walletClient, {
        address: flipBook,
        abi: flipBookAbi,
        functionName: 'take',
        args: [offer.offerId, guess],
        value: offer.stake,
      })
    })

  const cancel = (offer: OfferView) =>
    run(async () => {
      if (!walletClient || !flipBook) return
      await sendGameTx(deployment, walletClient, {
        address: flipBook,
        abi: flipBookAbi,
        functionName: 'cancel',
        args: [offer.offerId],
      })
      forgetFlipSecret(deployment.chainId, flipBook, offer.commit)
    })

  const reveal = (offer: OfferView) =>
    run(async () => {
      if (!walletClient || !flipBook) return
      const secret = flipSecretFor(deployment.chainId, flipBook, offer.commit)
      if (!secret) throw new Error('no stored secret for this offer in this browser — it cannot be revealed from here')
      await sendGameTx(deployment, walletClient, {
        address: flipBook,
        abi: flipBookAbi,
        functionName: 'reveal',
        args: [offer.offerId, secret.choice, secret.salt],
      })
      forgetFlipSecret(deployment.chainId, flipBook, offer.commit)
    })

  const claim = (offer: OfferView) =>
    run(async () => {
      if (!walletClient || !flipBook) return
      await sendGameTx(deployment, walletClient, {
        address: flipBook,
        abi: flipBookAbi,
        functionName: 'claim',
        args: [offer.offerId],
      })
    })

  const withdraw = () =>
    run(async () => {
      if (!walletClient || !flipBook) return
      await sendGameTx(deployment, walletClient, { address: flipBook, abi: flipBookAbi, functionName: 'withdraw', args: [] })
    })

  if (!flipBook) {
    return <div className="banner">the P2P flip isn't deployed on {deployment.label} yet — pick another chain</div>
  }

  const open = data.offers.filter((o) => o.status === 'open' && o.takeDeadline >= now)
  const expired = data.offers.filter((o) => o.status === 'open' && o.takeDeadline < now)
  const pending = data.offers.filter((o) => o.status === 'taken')
  const settled = data.offers.filter((o) => o.status === 'revealed' || o.status === 'forfeited').slice(0, 15)
  // My reveals due — the one deadline on this screen that costs real money if missed.
  const revealsDue = pending.filter((o) => mine(o.maker))

  return (
    <div>
      {data.error && <div className="banner bad">chain read failed: {data.error}</div>}
      {error && <div className="banner bad">{error}</div>}
      {data.owed > 0n && (
        <div className="banner">
          the book owes you {fmtAmount(deployment, data.owed)} (a payout couldn't be pushed to your address){' '}
          <button onClick={() => void withdraw()} disabled={!canAct}>
            Withdraw
          </button>
        </div>
      )}

      {revealsDue.length > 0 && (
        <div className="banner bad">
          <strong>Reveal due:</strong> you have {revealsDue.length === 1 ? 'a taken flip' : `${revealsDue.length} taken flips`} —
          miss the window and you forfeit stake <em>and</em> bond.
          {revealsDue.map((o) => {
            const secret = flipSecretFor(deployment.chainId, flipBook, o.commit)
            const left = (o.revealBy ?? 0) - now
            return (
              <span key={o.offerId.toString()} style={{ marginLeft: '0.5rem' }}>
                #{o.offerId.toString()} ({fmtLeft(left)} left){' '}
                {secret ? (
                  <button onClick={() => void reveal(o)} disabled={!canAct || left <= 0}>
                    Reveal now
                  </button>
                ) : (
                  <span className="bad">— secret not in this browser; reveal from the browser that posted it</span>
                )}
              </span>
            )
          })}
        </div>
      )}

      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <strong>
            Post an offer{' '}
            <InfoDot label="how posting works">
              You pick a side and it is hidden behind a hash; your <strong>stake + bond</strong> escrow immediately, so
              the offer can't be yanked once someone takes it. When a taker calls your coin, you have the reveal window
              to open your commit — win or lose. Reveal a loss and you only lose the stake; sit on it and you forfeit
              the stake <strong>and</strong> the bond. Your hidden side is stored only in this browser.
            </InfoDot>
          </strong>
          <SourceNote deployment={deployment} contract={flipBook} contractLabel="FlipBook" />
        </div>
        <div className="row">
          <span className="muted">your hidden side</span>
          <button className={choice ? '' : 'secondary'} onClick={() => setChoice(true)} disabled={busy}>
            heads
          </button>
          <button className={choice ? 'secondary' : ''} onClick={() => setChoice(false)} disabled={busy}>
            tails
          </button>
        </div>
        <div className="row">
          <span className="muted">stake</span>
          <StakeInput value={amount} onChange={setAmount} />
        </div>
        <div className="row">
          <span className="muted">
            bond{' '}
            <InfoDot label="why a bond">
              The bond is what makes walking away from a lost flip a mistake: revealing a loss costs your stake, bailing
              costs your stake <strong>plus</strong> this bond. It comes straight back to you the moment you reveal —
              win or lose.
            </InfoDot>
          </span>
          <StakeInput value={bondAmount} onChange={setBondAmount} placeholder="bond" />
        </div>
        <div className="row">
          <span className="muted">open for</span>
          {OPEN_FOR.map((o) => (
            <button
              key={o.seconds}
              className={`chip${openFor === o.seconds ? ' active' : ''}`}
              onClick={() => setOpenFor(o.seconds)}
              disabled={busy}
            >
              {o.label}
            </button>
          ))}
          <span className="muted">reveal within</span>
          {REVEAL_WINDOWS.map((o) => (
            <button
              key={o.seconds}
              className={`chip${revealWindow === o.seconds ? ' active' : ''}`}
              onClick={() => setRevealWindow(o.seconds)}
              disabled={busy}
            >
              {o.label}
            </button>
          ))}
        </div>
        <div className="row">
          <button onClick={() => void post()} disabled={!canAct || stake === undefined || bond === undefined}>
            {busy ? 'working…' : `Escrow ${stake !== undefined && bond !== undefined ? fmtAmount(deployment, stake + bond) : ''} & post`}
          </button>
          {!connected && <span className="muted">connect a wallet to post or take</span>}
          {connected && !trustAcknowledged && <span className="muted">acknowledge the fairness note above first</span>}
        </div>
      </div>

      <h3>
        Open offers{' '}
        <InfoDot label="how taking works">
          Match the stake and call the maker's hidden coin — your guess is your whole move, nothing more to do. Guess
          right and the pot (2×stake) is yours at reveal; if the maker refuses to reveal, the window lapses and you
          claim the pot <strong>plus their bond</strong>. Calling at random wins exactly half against anyone, so no
          maker can out-strategy you.
        </InfoDot>
        {data.loading && <span className="muted"> refreshing…</span>}
      </h3>
      {open.length === 0 && <div className="muted">no open offers — post one above and let the board find your opponent</div>}
      {open.map((o) => (
        <div className="card" key={o.offerId.toString()}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span>
              <span className="tag">#{o.offerId.toString()}</span>
              <AddressLink deployment={deployment} address={o.maker} />
              {mine(o.maker) && <span className="tag ok">you</span>}
              <span className="muted"> stakes </span>
              <strong>{fmtAmount(deployment, o.stake)}</strong>
              <span className="muted"> · bond {fmtAmount(deployment, o.bond)} · reveal within {fmtLeft(o.revealWindow)}</span>
            </span>
            <span className="muted">open {fmtLeft(o.takeDeadline - now)} more · <TxLink deployment={deployment} tx={o.postTx} /></span>
          </div>
          <div className="row">
            {mine(o.maker) ? (
              <button className="secondary" onClick={() => void cancel(o)} disabled={!canAct}>
                Cancel & refund
              </button>
            ) : (
              <>
                <span className="muted">call their coin:</span>
                <button onClick={() => void take(o, true)} disabled={!canAct}>
                  heads
                </button>
                <button onClick={() => void take(o, false)} disabled={!canAct}>
                  tails
                </button>
                <span className="muted">win {fmtAmount(deployment, o.stake * 2n)} on a right call</span>
              </>
            )}
          </div>
        </div>
      ))}
      {expired.map((o) => (
        <div className="card" key={o.offerId.toString()}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span>
              <span className="tag">#{o.offerId.toString()}</span>
              <AddressLink deployment={deployment} address={o.maker} />
              {mine(o.maker) && <span className="tag ok">you</span>}
              <span className="muted"> stakes {fmtAmount(deployment, o.stake)}</span>
              <span className="tag">expired</span>
            </span>
            {mine(o.maker) && (
              <button className="secondary" onClick={() => void cancel(o)} disabled={!canAct}>
                Cancel & refund
              </button>
            )}
          </div>
        </div>
      ))}

      {pending.length > 0 && <h3>Awaiting reveal</h3>}
      {pending.map((o) => {
        const left = (o.revealBy ?? 0) - now
        const secret = flipSecretFor(deployment.chainId, flipBook, o.commit)
        return (
          <div className="card" key={o.offerId.toString()}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span>
                <span className="tag">#{o.offerId.toString()}</span>
                <AddressLink deployment={deployment} address={o.maker} />
                {mine(o.maker) && <span className="tag ok">you</span>}
                <span className="muted"> vs </span>
                <AddressLink deployment={deployment} address={o.taker!} />
                {mine(o.taker) && <span className="tag ok">you</span>}
                <span className="muted"> — called </span>
                <strong>{sideLabel(o.guess === true)}</strong>
                <span className="muted"> for {fmtAmount(deployment, o.stake)}</span>
              </span>
              <span className={left <= 0 ? 'bad' : 'muted'}>
                {left > 0 ? `reveal due in ${fmtLeft(left)}` : 'reveal window over'} · <TxLink deployment={deployment} tx={o.takeTx} />
              </span>
            </div>
            <div className="row">
              {left > 0 && secret && (
                <button onClick={() => void reveal(o)} disabled={!canAct}>
                  Reveal
                </button>
              )}
              {left > 0 && mine(o.maker) && !secret && (
                <span className="bad">secret not in this browser — reveal from the browser that posted this offer</span>
              )}
              {left <= 0 && (
                <>
                  <button onClick={() => void claim(o)} disabled={!canAct}>
                    Claim forfeit
                  </button>
                  <span className="muted">
                    the maker sat out the window — the taker gets the pot + bond ({fmtAmount(deployment, o.stake * 2n + o.bond)})
                  </span>
                </>
              )}
            </div>
          </div>
        )
      })}

      {settled.length > 0 && <h3>Settled</h3>}
      {settled.map((o) => (
        <div className="card" key={o.offerId.toString()}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span>
              <span className="tag">#{o.offerId.toString()}</span>
              {o.status === 'revealed' ? (
                <span>
                  coin was <strong>{sideLabel(o.choice === true)}</strong>, call was{' '}
                  <strong>{sideLabel(o.guess === true)}</strong> —{' '}
                  <span className="ok">
                    <AddressLink deployment={deployment} address={o.winner!} /> takes {fmtAmount(deployment, o.pot ?? 0n)}
                  </span>
                  {mine(o.winner) && <span className="tag gold">you won</span>}
                </span>
              ) : (
                <span>
                  maker <AddressLink deployment={deployment} address={o.maker} /> never revealed —{' '}
                  <span className="ok">
                    <AddressLink deployment={deployment} address={o.winner!} /> claims {fmtAmount(deployment, o.pot ?? 0n)}
                  </span>{' '}
                  <span className="tag">forfeit</span>
                </span>
              )}
            </span>
            <TxLink deployment={deployment} tx={o.settleTx} />
          </div>
        </div>
      ))}
    </div>
  )
}
