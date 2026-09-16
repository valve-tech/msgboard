import type { ReactNode } from 'react'
import type { GameDeployment } from '../config'
import { TRUST_ICON, type TrustModel } from './TrustBanner'
import { archiveTrailUrl } from './Meta'
import { useBoardFeed } from '../hooks/useBoardFeed'

/**
 * The hero of every table — the whole reason this venue exists: it SHOWS the cryptography and the
 * proof-of-work that make the play trustless, before you ever place a bet. Always visible (never a
 * collapsed <details>), and specific to the table's actual trust model: what's sealed, what's
 * revealed, and who recomputes the books. Rendered once in App.tsx, keyed by the active tab's model.
 *
 * The through-line under all four models is the same, and it is the point: recompute-your-own-books,
 * sealed-before-you-play, and proof-of-work-not-gas — coordination rides MsgBoard PoW stamps, so fees
 * never bleed the odds. The PoW band carries a live signal off the board when there is one.
 */

type Pillar = { k: string; v: ReactNode }
type Copy = { eyebrow: string; lead: string; body: ReactNode; pillars: [Pillar, Pillar, Pillar] }

const copyFor = (model: TrustModel, validatorCount: number): Copy => {
  switch (model) {
    case 'validator':
      return {
        eyebrow: 'Validator randomness',
        lead: 'One honest validator beats the cartel.',
        body: (
          <>
            The winning seed is the <strong>hash of secrets the validators commit on-chain</strong> and only
            reveal after your entry is locked in — never the house, never this site, never the other players.
            If even one of the {validatorCount} validators is honest, the draw is fair. Don't trust the set?
            Ink your own secret and <strong>be that one</strong>.
          </>
        ),
        pillars: [
          { k: 'Committed', v: 'hashed secrets pinned on-chain before the draw' },
          { k: 'Revealed', v: 'the seed is the hash of the reveals' },
          { k: 'Recomputed', v: 'your browser re-derives the winner' },
        ],
      }
    case 'p2p':
      return {
        eyebrow: 'Peer-vs-peer duel',
        lead: 'No randomness to rig.',
        body: (
          <>
            No house seed, no validators — it's matching pennies. A peer escrows a stake behind a{' '}
            <strong>sealed heads/tails commit</strong>; you match it and call their coin. Calling at random
            wins exactly half against <em>any</em> strategy, so your odds ride your own coin, not theirs. The
            escrow makes an offer un-yankable once taken — refuse to reveal a loss and you forfeit stake and bond.
          </>
        ),
        pillars: [
          { k: 'Sealed', v: "the peer's choice, committed and hidden" },
          { k: 'Open', v: 'your call, made in the clear' },
          { k: 'Escrowed', v: 'both stakes locked on-chain, un-rigable' },
        ],
      }
    case 'zk':
      return {
        eyebrow: 'Zero-knowledge',
        lead: 'Trust only the proof.',
        body: (
          <>
            No house, no validators, no shared seed. You solve the puzzle and your browser produces a{' '}
            <strong>zero-knowledge proof</strong> that the solution is valid, tied to your address — checked
            by the on-chain verifier and by anyone reading the board. It reveals nothing but its own validity;
            a wrong or missing solve simply <strong>can't produce a passing proof</strong>.
          </>
        ),
        pillars: [
          { k: 'Prove', v: 'a ZK proof that your solve is valid' },
          { k: 'Reveal nothing', v: 'the solution itself stays secret' },
          { k: 'Verify', v: 'on-chain verifier + any reader off the board' },
        ],
      }
    default: // cosigned
      return {
        eyebrow: 'Co-signed tables',
        lead: 'Sealed before you play — and no gas per hand.',
        body: (
          <>
            The house commits its whole seed chain <strong>before the first hand</strong> and you commit
            yours, so neither side can grind the outcome once you've bet. Each hand reveals the next sealed
            seed, <strong>co-signed by you and the house</strong> off-chain over MsgBoard, and your browser
            recomputes every payout from the reveals. If the transcript doesn't match, it's provably crooked.
          </>
        ),
        pillars: [
          { k: 'Sealed', v: 'the seed committed before the first bet' },
          { k: 'Revealed', v: 'each hand opens the next seed, co-signed' },
          { k: 'Recomputed', v: 'your browser replays the transcript' },
        ],
      }
  }
}

const ago = (at?: number): string => {
  if (!at) return ''
  const s = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  return `${Math.round(s / 3600)}h ago`
}

export const CryptoShowcase = ({
  deployment,
  model,
}: {
  deployment: GameDeployment
  model: TrustModel
}) => {
  const copy = copyFor(model, deployment.canonicalSubset.length)
  // A genuine live pulse: the house bots stamp every table open/settle onto MsgBoard with proof-of-work.
  // We surface the most recent one as proof the venue really runs on PoW, not just prose. Fails to empty.
  const notices = useBoardFeed(deployment)
  const latest = notices[0]
  const trail = archiveTrailUrl(deployment)

  return (
    <section className="crypto-showcase" aria-label="how this table stays honest">
      <div className="cs-head">
        <span className="cs-seal" aria-hidden>
          {TRUST_ICON[model].icon}
        </span>
        <div>
          <div className="cs-eyebrow">The cryptography · {copy.eyebrow}</div>
          <h3 className="cs-lead">{copy.lead}</h3>
        </div>
      </div>

      <p className="cs-body">{copy.body}</p>

      <div className="cs-pillars">
        {copy.pillars.map((p) => (
          <div className="cs-pillar" key={p.k}>
            <b>{p.k}</b>
            <span>{p.v}</span>
          </div>
        ))}
      </div>

      <div className="cs-pow">
        <span className="cs-pow-glyph" aria-hidden>
          ⛏
        </span>
        <span className="cs-pow-text">
          <strong>Proof-of-work, not gas.</strong> Coordination rides MsgBoard PoW stamps instead of gas, so
          fees never bleed the odds — every settlement leaves a stamped notice on the board.
        </span>
        {latest && (
          <span className="cs-pow-live" title="latest proof-of-work notice on the board">
            ⛏ live — {latest.game ?? 'table'} {latest.kind ?? ''} {ago(latest.at)}
          </span>
        )}
        {trail && (
          <a href={trail} target="_blank" rel="noreferrer">
            see the trail ↗
          </a>
        )}
      </div>
    </section>
  )
}
