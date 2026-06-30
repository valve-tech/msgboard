import { parseCategoryEncoding, type CategoryEncoding } from './category.js'
import type { BodyMode } from './relay.js'

/** Fully-resolved relay configuration. */
export interface RelayConfig {
  /** MsgBoard node RPC (must expose the `msgboard_` module, e.g. valve.city). */
  boardRpcUrl: string
  /** informational chain id (369 PulseChain, 943 testnet, 1 mainnet). */
  chainId?: number
  /** channels / Waku topic names to relay. */
  channels: string[]
  /** Waku app name for the content-topic path `/{appName}/1/{channel}/proto`. */
  wakuAppName: string
  /** Waku bootstrap multiaddrs; empty → defaultBootstrap. */
  wakuBootstrap: string[]
  /** channel→category encoding (default 'keccak256'). */
  categoryEncoding: CategoryEncoding
  /** post the origin-tagged envelope (default) or the raw payload. */
  bodyMode: BodyMode
  /** dedup append-log path (persists across restarts); omit to keep dedup in-memory only. */
  seenPath?: string
  /** when true, do not actually stamp+post — log what WOULD be posted (no PoW spent). */
  dryRun: boolean
  /** optional board difficulty overrides. */
  workMultiplier?: bigint
  workDivisor?: bigint
}

const splitList = (value: string | undefined): string[] =>
  (value ?? '').split(',').map((s) => s.trim()).filter(Boolean)

/**
 * Build a config from environment variables (CLI flags in bin/relay.ts override fields after this).
 * Required: MSGBOARD_RPC_URL and RELAY_CHANNELS.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  const boardRpcUrl = env.MSGBOARD_RPC_URL
  if (!boardRpcUrl) throw new Error('MSGBOARD_RPC_URL is required (a node exposing the msgboard_ module)')
  const channels = splitList(env.RELAY_CHANNELS)
  if (channels.length === 0) throw new Error('RELAY_CHANNELS is required (comma-separated channel names)')

  return {
    boardRpcUrl,
    chainId: env.MSGBOARD_CHAIN_ID ? Number(env.MSGBOARD_CHAIN_ID) : undefined,
    channels,
    wakuAppName: env.WAKU_APP_NAME || 'msgboard-relay',
    wakuBootstrap: splitList(env.WAKU_BOOTSTRAP),
    categoryEncoding: parseCategoryEncoding(env.RELAY_CATEGORY_ENCODING),
    bodyMode: env.RELAY_BODY_MODE === 'raw' ? 'raw' : 'envelope',
    seenPath: env.RELAY_SEEN_PATH || undefined,
    dryRun: env.RELAY_DRY_RUN === '1' || env.RELAY_DRY_RUN === 'true',
    workMultiplier: env.MSGBOARD_WORK_MULTIPLIER ? BigInt(env.MSGBOARD_WORK_MULTIPLIER) : undefined,
    workDivisor: env.MSGBOARD_WORK_DIVISOR ? BigInt(env.MSGBOARD_WORK_DIVISOR) : undefined,
  }
}
