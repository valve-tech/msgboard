import { Icon } from '@iconify/react'

/**
 * Ported from `GamesCallout.svelte` — the felt-table venue callout on the landing page.
 */
export function GamesCallout() {
  return (
    <div className="flex w-full justify-center px-4 py-16">
      <div
        className="relative w-full max-w-5xl overflow-hidden rounded-2xl text-white shadow-xl ring-1 ring-amber-400/30"
        style={{ background: 'linear-gradient(180deg, #11301d, #0b2014)' }}>
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              'radial-gradient(70% 60% at 50% 0%, rgba(224,168,52,0.16), transparent 70%)',
          }}
        />
        <div className="relative flex flex-col items-center gap-5 px-6 py-12 text-center sm:px-12">
          <div className="grid size-12 place-items-center rounded-full bg-amber-400/10 ring-1 ring-amber-400/40">
            <Icon icon="mdi:cards-playing-outline" className="size-7 text-amber-400" />
          </div>
          <h2 className="text-3xl font-bold">
            MsgBoard{' '}
            <span className="bg-gradient-to-br from-amber-200 via-amber-400 to-orange-500 bg-clip-text text-transparent">
              Games
            </span>
          </h2>
          <p className="max-w-2xl text-gray-300">
            A provably fair venue, supercharged by MsgBoard: coin flips and a numbers game settled
            by validator entropy, never by the house — and the validators coordinate with
            proof-of-work stamps instead of gas, so fees don't bleed the odds. Every draw ships with
            a receipt your browser re-checks against the chain —{' '}
            <em className="not-italic font-semibold text-amber-300">
              don't trust the table, audit it
            </em>
            . Live on PulseChain testnet v4 with free test PLS.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3 pt-1">
            <a
              href="https://games.msgboard.xyz"
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-full bg-amber-400 px-6 py-2.5 text-sm font-semibold text-gray-950 shadow-lg shadow-amber-500/20 transition hover:bg-amber-300">
              Enter the venue →
            </a>
            <a
              href="#/games"
              className="rounded-full px-5 py-2.5 text-sm text-gray-300 ring-1 ring-white/15 transition hover:text-white hover:ring-white/30">
              How the fairness works
            </a>
          </div>
        </div>
      </div>
    </div>
  )
}
