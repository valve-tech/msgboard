import { Icon } from '@iconify/react'

type Product = {
  title: string
  description: string
  icon: string
  href: string
  cta: string
  /** External links open in a new tab; in-app hash links stay in the SPA. */
  external: boolean
  /** Products without a live hosted app are labelled so nobody mistakes them for one. */
  badge?: string
}

const products: Product[] = [
  {
    title: 'Cosign',
    description:
      'Off-chain co-signing for Safe multi-sigs. Owners share their signatures over the board and assemble the set once the threshold is met — nothing partial is written on chain until the transaction executes.',
    icon: 'mdi:signature-freehand',
    href: 'https://cosign.msgboard.xyz/',
    cta: 'Open Cosign',
    external: true,
  },
  {
    title: 'The archive',
    description:
      'The board keeps only the last ~120 blocks, so history is captured off to the side. The archive is the durable, read-only GraphQL record of every message that has crossed the board — query it by category, content, or time.',
    icon: 'mdi:database-clock-outline',
    href: 'https://archive.msgboard.xyz',
    cta: 'Query the archive',
    external: true,
  },
  {
    title: 'ZK-filtered subset archive',
    description:
      'A provably-gated slice of board traffic. Members prove — in zero knowledge — that they belong to an allowed group before they post, so every message is attributable to the group but never to the individual. The archive is only the messages whose membership proof checks out.',
    icon: 'mdi:shield-lock-outline',
    href: '#/examples',
    cta: 'See the example',
    external: false,
    badge: 'Example',
  },
  {
    title: 'MsgBoard Games',
    description:
      'A provably-fair game venue built on the board: coin flips and a numbers draw settled by validator entropy (never the house), plus ZK skill games. Coordination rides proof-of-work stamps instead of gas, and every result ships a receipt your browser re-checks against the chain.',
    icon: 'mdi:cards-playing-outline',
    href: 'https://games.msgboard.xyz',
    cta: 'Enter the venue',
    external: true,
  },
]

/** A grid of things built on the board: three live apps (Cosign, the archive, Games) + one ZK pattern. */
export function Ecosystem() {
  return (
    <div className="flex flex-col gap-4 text-center py-16 px-4">
      <h2 className="text-3xl font-bold text-slate-900 dark:text-gray-100 pb-1">The ecosystem</h2>
      <p className="mx-auto max-w-2xl text-slate-600 dark:text-gray-300 pb-4">
        Apps and archives built on the board — live today, or runnable as a pattern.
      </p>
      <div className="mx-auto grid w-full max-w-5xl gap-6 sm:grid-cols-2">
        {products.map((product) => (
          <a
            key={product.title}
            href={product.href}
            target={product.external ? '_blank' : undefined}
            rel={product.external ? 'noopener noreferrer' : undefined}
            className="group flex h-full flex-col rounded-xl border border-slate-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-6 text-left shadow-sm transition-all duration-200 hover:-translate-y-1 hover:border-blue-300 dark:hover:border-blue-500">
            <div className="mb-4 flex items-center justify-between">
              <Icon
                icon={product.icon}
                width="32"
                height="32"
                className="text-slate-600 dark:text-gray-300 transition-colors duration-200 group-hover:text-blue-600 dark:group-hover:text-blue-400"
              />
              {product.badge ? (
                <span className="rounded-full bg-slate-100 dark:bg-gray-700 px-2.5 py-0.5 text-xs font-medium text-slate-500 dark:text-gray-300">
                  {product.badge}
                </span>
              ) : null}
            </div>
            <h3 className="mb-2 text-xl font-semibold text-slate-900 dark:text-gray-100">
              {product.title}
            </h3>
            <p className="text-slate-600 dark:text-gray-300">{product.description}</p>
            <span className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-blue-600 dark:text-blue-400">
              {product.cta}
              <span aria-hidden="true" className="transition-transform duration-200 group-hover:translate-x-0.5">
                {product.external ? '↗' : '→'}
              </span>
            </span>
          </a>
        ))}
      </div>
    </div>
  )
}
