import { Icon } from '@iconify/react'
import type { ReactNode } from 'react'

type Card = { icon: string; title: string; body: ReactNode }

const cards: Card[] = [
  {
    icon: 'mdi:shield-check',
    title: 'Censorship-Resistant',
    body: 'Messages flow freely across the peer-to-peer network — unstoppable by any authority.',
  },
  {
    icon: 'mdi:lightning-bolt',
    title: 'Ephemeral',
    body: 'Messages are short-lived and lightweight, aging out without cluttering the network.',
  },
  {
    icon: 'mdi:lock-open-variant',
    title: 'Permissionless',
    body: (
      <>
        No gas, no token, no account. Anyone can post —{' '}
        <span className="font-medium text-emerald-600 dark:text-emerald-400">math</span> is the only
        toll.
      </>
    ),
  },
  {
    icon: 'mdi:postage-stamp',
    title: 'Paid in Work',
    body: (
      <>
        You mint a proof-of-work{' '}
        <span className="font-medium text-emerald-600 dark:text-emerald-400">stamp</span> for each
        message — that stamp regulates what gets on the board.
      </>
    ),
  },
]

/** Ported from `SalesPitch.svelte` — the four-up value-prop grid. */
export function SalesPitch() {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-6 lg:grid-cols-4 px-8 py-12 max-w-7xl mx-auto">
      {cards.map((c) => (
        <div
          key={c.title}
          className="group flex-1 text-center p-6 rounded-xl transition-all duration-200 hover:-translate-y-1 bg-slate-500/[0.03] ring-1 ring-inset ring-slate-200/10 hover:ring-emerald-500/30">
          <div className="flex justify-center mb-4">
            <Icon
              icon={c.icon}
              width="32"
              height="32"
              className="text-slate-600 dark:text-slate-400 transition-colors duration-200 group-hover:text-emerald-500"
            />
          </div>
          <h3 className="text-2xl font-semibold mb-4 text-slate-800 dark:text-gray-100">
            {c.title}
          </h3>
          <p className="text-base leading-relaxed text-slate-600 dark:text-gray-300">{c.body}</p>
        </div>
      ))}
    </div>
  )
}
