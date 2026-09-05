import type { Target } from './check.js'

// Every endpoint the check asks, in one place, because the list is
// configuration rather than logic and it should be reviewable as a diff.

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
 * The public endpoints msgboard clients actually use.
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
