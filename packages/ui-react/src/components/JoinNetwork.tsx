import { Icon } from '@iconify/react'

type Support = 'supported' | 'pending' | 'unsupported'
/** `node` links to the team's open-source node code (only teams that publish one are listed) */
type Team = { name: string; url: string; node: string; support: Record<string, Support> }

/** chain coin logo from gib.show — network endpoint, 2x webp for crisp small icons */
const icon = (chainId: string) => `https://gib.show/image/${chainId}?w=48&h=48&format=webp`

/** networks are a shared dimension; support is tracked per network */
const networks = [
  { key: '369', label: 'PulseChain' },
  { key: '1', label: 'Ethereum' },
  { key: '943', label: 'v4 testnet' },
]

const teams: Team[] = [
  {
    name: 'valve.city',
    url: 'https://valve.city',
    node: 'https://github.com/valve-tech/reth',
    support: { '369': 'supported', '1': 'supported', '943': 'supported' },
  },
  {
    name: 'PulseChain',
    url: 'https://pulsechain.com',
    node: 'https://gitlab.com/pulsechaincom/erigon-pulse',
    support: { '369': 'pending', '1': 'pending', '943': 'pending' },
  },
  {
    name: 'g4mm4',
    url: 'https://g4mm4.io',
    node: 'https://gitlab.com/pulsechaincom/erigon-pulse',
    support: { '369': 'pending', '1': 'pending', '943': 'pending' },
  },
]

const statuses: Support[] = ['supported', 'pending', 'unsupported']
const label: Record<Support, string> = {
  supported: 'Supported',
  pending: 'Pending',
  unsupported: 'Unsupported',
}
const dot: Record<Support, string> = {
  supported: 'bg-green-500',
  pending: 'bg-amber-500',
  unsupported: 'bg-gray-400',
}
const seg: Record<Support, string> = {
  supported: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200',
  pending: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
  unsupported: 'bg-gray-100 text-gray-400 dark:bg-gray-800 dark:text-gray-500',
}

/** Ported from `JoinNetwork.svelte` — the per-network provider support matrix. */
export function JoinNetwork() {
  return (
    <div className="max-w-3xl mx-auto py-16 px-4">
      <h2 className="text-center text-3xl font-bold text-gray-800 dark:text-gray-100 mb-2">
        Join the Network
      </h2>
      <p className="text-center text-gray-600 dark:text-gray-300 mb-6">
        Any node with the{' '}
        <code className="font-mono text-indigo-600 dark:text-indigo-400">msgboard_</code> module can
        serve the board.
      </p>

      <div className="flex justify-center gap-5 text-xs text-gray-500 dark:text-gray-400 mb-8">
        {statuses.map((s) => (
          <span key={s} className="inline-flex items-center gap-1.5">
            <span
              className={`size-2 rounded-full ${dot[s]} ${s === 'pending' ? 'animate-pulse' : ''}`}
            />
            {label[s]}
          </span>
        ))}
      </div>

      <div className="space-y-3">
        {teams.map((team) => (
          <div key={team.name} className="flex items-center gap-3 sm:gap-4">
            <div className="w-24 sm:w-28 shrink-0 flex flex-col items-end gap-0.5">
              <a
                href={team.url}
                target="_blank"
                rel="noopener noreferrer"
                className="font-semibold text-indigo-600 dark:text-indigo-400 hover:underline truncate max-w-full">
                {team.name}
              </a>
              {team.node && (
                <a
                  href={team.node}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="Open-source node code"
                  aria-label="Open-source node code"
                  className="inline-flex text-gray-400 hover:text-indigo-500 dark:text-gray-500 dark:hover:text-indigo-400">
                  <Icon icon="mdi:git" className="size-4" />
                </a>
              )}
            </div>
            <div className="flex flex-1 rounded-lg overflow-hidden border border-gray-200 dark:border-gray-700 divide-x divide-gray-200 dark:divide-gray-700">
              {networks.map((net) => {
                const s = team.support[net.key]
                return (
                  <div
                    key={net.key}
                    className={`flex flex-1 items-center justify-center gap-2 px-3 py-2.5 transition-colors ${seg[s]}`}
                    title={`${net.label} · ${label[s]}`}>
                    <img
                      src={icon(net.key)}
                      alt=""
                      className="size-5 rounded-full ring-1 ring-black/10 dark:ring-white/10"
                      loading="lazy"
                    />
                    <span className="text-xs font-medium hidden xs:inline sm:inline">
                      {net.label}
                    </span>
                    <span
                      className={`size-1.5 rounded-full shrink-0 ${dot[s]} ${s === 'pending' ? 'animate-pulse' : ''}`}
                    />
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>

      <p className="text-center text-sm text-gray-500 dark:text-gray-400 mt-8">
        Run a node with the module, or point the app at a{' '}
        <span className="text-green-600 dark:text-green-400 font-medium">supported</span> provider.
      </p>
    </div>
  )
}
