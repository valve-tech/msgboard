import type { Target } from './check.js'

// Every endpoint the check asks, in one place, because the list is
// configuration rather than logic and it should be reviewable as a diff.
//
// These are the endpoints a msgboard client actually talks to.

/**
 * The valve fleet, as customers reach it.
 *
 * `one.valve.city` is the gateway, not a node. Its RPC lives at
 * `/rpc/v1/<chainId>`; the site root is a web app and answers `Cannot POST /`.
 * An anonymous call there returns `Invalid or inactive API key`, which is the
 * behaviour this check exists to keep true.
 */
export const FLEET: readonly Target[] = [
  { name: 'one.valve.city 369', url: 'https://one.valve.city/rpc/v1/369', keyGated: true, ours: true },
  { name: 'one.valve.city 1', url: 'https://one.valve.city/rpc/v1/1', keyGated: true, ours: true },
  { name: 'one.valve.city 943', url: 'https://one.valve.city/rpc/v1/943', keyGated: true, ours: true },
]

/**
 * The public endpoints msgboard clients read the board from.
 *
 * These are other people's nodes. A finding here is worth reporting to them and
 * is never our outage, so it does not fail the run.
 */
export const PUBLIC_PEERS: readonly Target[] = [
  { name: 'rpc.pulsechain.com', url: 'https://rpc.pulsechain.com', keyGated: false },
  { name: 'pulsechain-rpc.publicnode.com', url: 'https://pulsechain-rpc.publicnode.com', keyGated: false },
  { name: 'rpc-pulsechain.g4mm4.io', url: 'https://rpc-pulsechain.g4mm4.io', keyGated: false },
  { name: 'rpc.pulsechainrpc.com', url: 'https://rpc.pulsechainrpc.com', keyGated: false },
  { name: 'rpc.pulsechainstats.com', url: 'https://rpc.pulsechainstats.com', keyGated: false },
  { name: 'rpc.v4.testnet.pulsechain.com', url: 'https://rpc.v4.testnet.pulsechain.com', keyGated: false },
  { name: 'pulsechain-testnet-rpc.publicnode.com', url: 'https://pulsechain-testnet-rpc.publicnode.com', keyGated: false },
]

export const ALL_TARGETS: readonly Target[] = [...FLEET, ...PUBLIC_PEERS]

/**
 * Endpoint groups that SHOULD hold the same board, because msgboard gossips.
 *
 * A group is one endpoint of ours plus the public nodes serving the same chain. Our
 * board is not supposed to be an island: if it shares no message with any public node
 * that answered, we are partitioned from the network and the archive is recording a
 * private view.
 *
 * WHAT THIS CANNOT SEE FROM OUTSIDE. `one.valve.city` pins each API key to one upstream
 * and strips client routing headers, so from here we reach exactly one of our replicas
 * and cannot address the other. A replica-versus-replica split is therefore invisible to
 * this job — the mainnet split of 2026-09-08 would NOT have been caught here. To check
 * that, run from inside the fleet with per-replica URLs, which the `CONVERGENCE_<chain>`
 * environment override exists for. This job catches the other half: our view drifting
 * away from the whole network.
 */
export interface ConvergenceGroup {
  chain: string
  /** The endpoint we operate. Its failure fails the run. */
  ours: string
  /** Public nodes on the same chain. Their failures are theirs, not ours. */
  peers: readonly string[]
}

export const CONVERGENCE_GROUPS: readonly ConvergenceGroup[] = [
  {
    chain: '369',
    // vk_demo, not /rpc/v1/. The v1 path is key-gated and answers 401 to an anonymous
    // caller — which is the property the exposure check exists to keep true, so this
    // check must not need a secret to defeat it. vk_demo is the published read key.
    ours: 'https://one.valve.city/rpc/vk_demo/evm/369',
    peers: [
      'https://rpc.pulsechain.com',
      'https://pulsechain-rpc.publicnode.com',
      'https://rpc-pulsechain.g4mm4.io',
    ],
  },
  // No 943 group. Measured 2026-09-08: no public testnet endpoint serves msgboard at
  // all, so an external convergence check there can never pass and would fail hourly
  // forever — noise, not a signal. Testnet replica convergence is real and worth
  // checking; it just needs endpoints that reach different replicas, which only exist
  // inside the fleet. Run with CONVERGENCE_943 set to those URLs. Add a group here if a
  // public testnet node ever serves the board.
]

/**
 * A group with `CONVERGENCE_<chain>` applied, when it is set.
 *
 * Set it to a comma-separated list of per-replica URLs to check OUR replicas against
 * each other — the check that matters and that the public gateway cannot express.
 */
export const groupFromEnv = (
  group: ConvergenceGroup,
  env: Record<string, string | undefined>,
): ConvergenceGroup => {
  const raw = env[`CONVERGENCE_${group.chain}`]
  if (!raw) return group
  const urls = [...new Set(raw.split(',').map((u) => u.trim()).filter(Boolean))]
  if (urls.length < 2) return group
  return { chain: group.chain, ours: urls[0]!, peers: urls.slice(1) }
}
