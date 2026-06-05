import type { MsgBoardClient } from '@msgboard/sdk'
import type { Chain, PublicClient, Transport } from 'viem'
import type { Logger } from './logger.js'

/** The two operating modes. `observe` never produces an outbound side effect. */
export type RelayerMode = 'observe' | 'live'

/** Identifies the msgboard node a relayer watches. */
export type RelayerNode = {
  /** viem Transport for the node (e.g. `http('https://...')`). */
  transport: Transport
  /**
   * viem Chain definition. When omitted, the chain id is detected automatically
   * via `eth_chainId` on the first tick. Pass explicitly for custom networks.
   */
  chain?: Chain
}

/** Everything a source, action, or sink may need at runtime. */
export type RelayerContext = {
  node: RelayerNode
  mode: RelayerMode
  chain: Chain
  /** A viem public client backed by `node.transport`. */
  publicClient: PublicClient
  /** A msgboard SDK client wrapping `publicClient`. */
  client: MsgBoardClient
  logger: Logger
}

/** The outcome of a live action. */
export type ActionResult = {
  /** True if the action's effect succeeded. */
  ok: boolean
  /** An identifying reference, e.g. a transaction hash or message hash. */
  ref?: string
  /** Optional structured detail for logging or storage. */
  meta?: Record<string, unknown>
}

/** Reads the current batch of candidate items from the watched pool. */
export type RelayerSource<T> = {
  poll(context: RelayerContext): Promise<readonly T[]>
}

/** A side-effecting operation, split so observe mode can describe without doing. */
export type RelayerAction<T> = {
  /** Pure description of the intended effect; used for observe-mode logging. */
  describe(item: T, context: RelayerContext): string
  /** The real outbound effect; only ever called in live mode. */
  execute(item: T, context: RelayerContext): Promise<ActionResult>
}

/** Action-level idempotency: "have I already acted on this?". Short retention. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export type RelayerStore<_T> = {
  has(key: string): Promise<boolean>
  remember(key: string, result: ActionResult): Promise<void>
  prune?(): Promise<void>
}

/** Unconditional recording for history/observability. Long retention. Runs in BOTH modes. */
export type RelayerSink<T> = {
  record(item: T, context: RelayerContext): Promise<void>
  prune?(): Promise<void>
}

/** Derives a stable dedup key for an item. */
export type RelayerKey<T> = (item: T) => string

/** Decides whether a candidate should be acted on, beyond dedup. */
export type RelayerCondition<T> = (item: T, context: RelayerContext) => boolean | Promise<boolean>

/** Construction options for a Relayer. */
export type RelayerConfig<T> = {
  node: RelayerNode
  /** Safety switch. Defaults to 'observe' — performs no outbound side effect. */
  mode?: RelayerMode
  /** Poll cadence in milliseconds. Defaults to 30_000. */
  intervalMs?: number
  source: RelayerSource<T>
  action: RelayerAction<T>
  key: RelayerKey<T>
  /** Action-level dedup. Defaults to an in-memory time-to-live store. */
  store?: RelayerStore<T>
  /** Historical recording; runs in observe and live modes. */
  sink?: RelayerSink<T>
  condition?: RelayerCondition<T>
  logger?: Logger
  /** Run `store.prune` / `sink.prune` every N ticks. Defaults to 30. */
  pruneEveryTicks?: number
}

/** What happened during one tick — returned by `runOnce()` for tests and one-shots. */
export type TickReport = {
  /** Total items polled from the source. */
  polled: number
  /** Items recorded to the sink. */
  recorded: number
  /** Items that passed the condition and were not deduped. */
  eligible: number
  /** Items whose action executed (live mode only). */
  executed: number
  /** Items whose action was only described (observe mode). */
  described: number
  /** Items skipped by the dedup store. */
  deduped: number
}
