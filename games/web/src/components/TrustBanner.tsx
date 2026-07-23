import { useState } from 'react'
import type { GameDeployment } from '../config'
import { InfoDot } from './Meta'

const ackKey = (chainId: number) => `msgboard-games:${chainId}:trust-acknowledged`

export const isTrustAcknowledged = (chainId: number) => localStorage.getItem(ackKey(chainId)) === 'true'

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

/**
 * Which fairness assumption a game actually rests on — the "1 honest validator" line is only true
 * for the two entropy-validator games (coin flip / the numbers). The tables are commit-before-bet +
 * co-signed recompute (no validators), and the ZK games trust only the proof. Keyed per game in App.
 */
export type TrustModel = 'validator' | 'cosigned' | 'zk' | 'p2p'

// Ack is per (chain, model): the claim differs per model, so acknowledging one shouldn't silently
// vouch for another. Coin flip's validator set ≠ Sudoku's zero-knowledge proof.
const modelAckKey = (chainId: number, model: TrustModel) => `${ackKey(chainId)}:${model}`

export const isTrustAcknowledgedFor = (chainId: number, model: TrustModel) =>
  localStorage.getItem(modelAckKey(chainId, model)) === 'true'

/** One icon per fairness model — shown as the strip's seal and as a badge beside each game in the menu. */
export const TRUST_ICON: Record<TrustModel, { icon: string; title: string }> = {
  validator: { icon: '🛡️', title: 'validator randomness — safe if one validator is honest' },
  cosigned: { icon: '🤝', title: 'sealed seed, co-signed over MsgBoard, replayed by your browser' },
  zk: { icon: '🔏', title: 'zero-knowledge proven — no one to trust' },
  p2p: { icon: '🎭', title: 'peer-vs-peer guessing duel — your own coin protects your odds' },
}

/**
 * The disclosed trust assumption, compacted to a single "provably fair" strip: the load-bearing
 * sentence is always visible; the full explanation lives behind the info dot so it doesn't stack a
 * wall of text above the table. The sentence + detail are chosen by the game's actual trust model
 * (validator randomness / co-signed tables / zero-knowledge). Entering a game stays disabled until
 * the player taps "Got it" (the spec's open item: the assumption must be surfaced).
 */
export const TrustBanner = ({
  deployment,
  model,
  onAcknowledged,
}: {
  deployment: GameDeployment
  model: TrustModel
  onAcknowledged: () => void
}) => {
  const storeKey = modelAckKey(deployment.chainId, model)
  const [acknowledged, setAcknowledged] = useState(() => localStorage.getItem(storeKey) === 'true')
  const n = deployment.canonicalSubset.length

  const acknowledge = () => {
    localStorage.setItem(storeKey, 'true')
    setAcknowledged(true)
    onAcknowledged()
  }

  const line =
    model === 'validator' ? (
      <>
        Provably fair — safe as long as <strong>one</strong> of the {n} validators is honest
      </>
    ) : model === 'zk' ? (
      <>
        Provably fair — every solve is proven in <strong>zero knowledge</strong>; no one to trust
      </>
    ) : model === 'p2p' ? (
      <>
        Provably fair — a pure guessing duel; <strong>your own coin</strong> protects your odds, not theirs
      </>
    ) : (
      <>
        Provably fair — seed <strong>sealed before you bet</strong>, co-signed, replayed by your browser
      </>
    )

  const detail =
    model === 'validator' ? (
      <>
        <p>
          Every draw is decided by secrets held by the validators below — never by the house, the other
          player, or this website. <strong>One honest validator beats any cartel.</strong> The contracts pin
          the validator set when you enter, so it can't be swapped afterwards, and every settled round below
          comes with a receipt you can verify yourself. Don't trust this set? Anyone can ink secrets and
          contribute randomness — even you — and if the honest one is <em>you</em>, the draw is safe for you
          by construction.
        </p>
        <p className="trust-validators">
          Validators:{' '}
          {deployment.canonicalSubset.map((v, i) => (
            <span key={v}>
              {i > 0 && ' · '}
              {deployment.explorer ? (
                <a className="mono" href={`${deployment.explorer}/address/${v}`} target="_blank" rel="noreferrer">
                  {short(v)}
                </a>
              ) : (
                <span className="mono">{short(v)}</span>
              )}
            </span>
          ))}
        </p>
      </>
    ) : model === 'zk' ? (
      <p>
        This table trusts <strong>no one</strong> — not the house, not a validator set, not this website. You
        solve the puzzle and your browser produces a <strong>zero-knowledge proof</strong> that the solution is
        valid, tied to your address. The proof is checked by the on-chain verifier (and by any reader off
        MsgBoard); it reveals nothing but its own validity. A wrong or missing solve simply can't produce a
        passing proof — there is nothing to grind and nothing to take on faith.
      </p>
    ) : model === 'p2p' ? (
      <p>
        This table has <strong>no randomness at all</strong> — no validators, no house, no shared seed. It's matching
        pennies: a maker escrows a stake behind a hidden heads/tails commit, you match the stake and{' '}
        <strong>call their coin</strong>. Calling at random wins exactly half against <em>any</em> strategy, so your
        odds come from your own coin — nothing your opponent (or this website) does can tilt them. The escrow makes
        offers un-yankable once taken, and a maker who refuses to reveal a loss forfeits their stake <em>and</em> a
        bond to you. Every offer, take, and reveal is a public transaction you can audit.
      </p>
    ) : (
      <p>
        No randomness validators here: the house commits its seed chain <strong>before the first hand</strong>{' '}
        and you commit yours, so neither side can grind the outcome once you've bet. Each hand reveals the next
        sealed seed, <strong>co-signed by you and the house</strong> off chain over MsgBoard — no gas per play —
        and your browser recomputes every result from the revealed seeds. Every settled round leaves a receipt
        you can replay; if the transcript doesn't match, it's provably crooked.
      </p>
    )

  return (
    <div className="trust-strip">
      <span className="trust-seal" title={TRUST_ICON[model].title} aria-hidden>
        {TRUST_ICON[model].icon}
      </span>
      <span className="trust-line">
        {line}
        <InfoDot label="how the fairness works">{detail}</InfoDot>
      </span>
      {acknowledged ? (
        <span className="rules-ack">✓ understood</span>
      ) : (
        <button className="secondary trust-ack" onClick={acknowledge}>
          Got it
        </button>
      )}
    </div>
  )
}
