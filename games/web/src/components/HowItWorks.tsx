import { createContext, useContext, useEffect } from 'react'
import type { GameDeployment } from '../config'
import type { TrustModel } from './TrustBanner'
import { CryptoShowcase } from './CryptoShowcase'

/**
 * The fairness explainer, demoted from the old lobby `.pitch` block into an on-demand overlay.
 * The copy is unchanged — it now lives behind a "How it works" affordance in the shell top bar
 * and in each migrated table's title bar (via `HowItWorksLink`, which reads the opener off context).
 */

// The opener is threaded through context so any screen's title-bar action can raise the shared modal
// without prop-drilling. Defaults to a no-op so a stray render outside the provider is harmless.
const HowItWorksContext = createContext<() => void>(() => {})
export const HowItWorksProvider = HowItWorksContext.Provider
export const useHowItWorks = () => useContext(HowItWorksContext)

/** The inert `ⓘ How it works` title-bar label, now wired to open the shared explainer. */
export const HowItWorksLink = () => {
  const open = useHowItWorks()
  return (
    <button type="button" className="pf-open" onClick={open}>
      ⓘ How it works
    </button>
  )
}

export const HowItWorksModal = ({
  open,
  onClose,
  deployment,
  model,
}: {
  open: boolean
  onClose: () => void
  deployment?: GameDeployment
  model?: TrustModel | null
}) => {
  // Esc closes the overlay — standard modal affordance.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return (
    <div
      className="hiw-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="How the back room stays honest"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 200,
        background: 'rgba(0, 0, 0, 0.62)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        padding: '6vh 1rem',
        overflowY: 'auto',
      }}
    >
      <div
        className="pitch"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: '720px', width: '100%' }}
      >
        <div className="pitch-body" style={{ borderTop: 'none' }}>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', margin: '0.6rem 0 0.2rem' }}>
            <h3 style={{ margin: 0 }}>How the back room stays honest — and cheap</h3>
            <button className="secondary" onClick={onClose}>
              Close
            </button>
          </div>
          {model && deployment ? (
            <CryptoShowcase deployment={deployment} model={model} />
          ) : (
          <>
          <p className="hero-pitch">
            Every table, one promise: <strong>the draw is sealed before you play</strong>, and your own
            browser re-runs the count on every result. The numbers draws its seed from validator
            secrets locked on{' '}
            <a href="https://msgboard.xyz" target="_blank" rel="noreferrer">
              chain
            </a>
            ; the coin flip needs no seed at all — a peer's sealed choice against your open call, escrowed on chain;
            the dice, limbo, crash, plinko, wheel, monte, keno, mines, baccarat, dragon tiger, towers, chicken,
            firewalk, heist, hi-lo, greed dice and the rest lock their seed before the first hand and settle
            off chain, co-signed, with the trail posted to MsgBoard. A trust-me casino asks you to believe the odds;
            this room hands you the books.
          </p>
          <div className="howit">
            <div className="howit-step">
              <span className="howit-num">1</span>
              <strong>Sealed before you play.</strong> On the chain games, validators ink hashed secrets ahead of the
              draw and your entry pins that exact set. At the tables, the seed is committed before the first hand. Either
              way, nothing can change once you've bet.
            </div>
            <div className="howit-step">
              <span className="howit-num">2</span>
              <strong>The reveal is the draw.</strong> Chain games: the seed is the hash of the validators' revealed
              secrets — one honest validator beats any cartel. Tables: each hand reveals the next sealed seed, co-signed
              by you and the house off chain over MsgBoard — no gas per play.
            </div>
            <div className="howit-step">
              <span className="howit-num">3</span>
              <strong>You keep the books.</strong> Your browser recomputes every outcome — re-verifying the chain draw,
              or replaying the co-signed table transcript — and stamps the slip <em>on the level</em> or calls it
              crooked. Don't trust the room; audit it.
            </div>
          </div>
          <p className="howit-footer">
            <strong>Supercharged by MsgBoard:</strong> coordination rides proof-of-work stamps instead of gas, so fees
            never bleed the odds — every settlement leaves a notice on the board (follow the trail from{' '}
            <em>The record</em>). And if a chain's vault ever runs dry, the tables simply pause; nothing breaks, and
            play resumes the moment it's refilled.
          </p>
          </>
          )}
        </div>
      </div>
    </div>
  )
}
