import { createPublicClient, http } from 'viem'
import { MsgBoardClient, type Provider } from '@msgboard/sdk'
import { resolveChain } from './chains.js'
import { defaultLogger, type Logger } from './logger.js'
import type { RelayerConfig, RelayerContext, RelayerMode, TickReport } from './types.js'

const DEFAULT_INTERVAL_MS = 30_000
const DEFAULT_PRUNE_EVERY_TICKS = 30

/** Builds the runtime context (viem + SDK clients) for a relayer config. */
const buildContext = <T>(config: RelayerConfig<T>, logger: Logger): RelayerContext => {
  const chain = resolveChain(config.node.chainId)
  const publicClient = createPublicClient({
    chain,
    transport: http(config.node.rpcUrl, { timeout: 30_000 }),
  })
  const client = new MsgBoardClient(publicClient as unknown as Provider)
  return {
    node: config.node,
    mode: config.mode ?? 'observe',
    chain,
    publicClient,
    client,
    logger,
  }
}

/** Resolves after `ms`, or immediately if the signal aborts. */
const sleep = (ms: number, signal: AbortSignal): Promise<void> => {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * A controllable pool-watcher. Safe by default: in `observe` mode it records and
 * logs what it would do, but performs no outbound side effect.
 */
export class Relayer<T> {
  private readonly config: RelayerConfig<T>
  private readonly logger: Logger
  private readonly context: RelayerContext
  private readonly intervalMs: number
  private readonly pruneEveryTicks: number
  private tickCount = 0
  private running = false
  private loopPromise: Promise<void> | null = null
  private abort: AbortController | null = null

  constructor(config: RelayerConfig<T>) {
    this.config = config
    this.logger = config.logger ?? defaultLogger('relayer')
    this.context = buildContext(config, this.logger)
    this.intervalMs = config.intervalMs ?? DEFAULT_INTERVAL_MS
    this.pruneEveryTicks = config.pruneEveryTicks ?? DEFAULT_PRUNE_EVERY_TICKS
  }

  get mode(): RelayerMode {
    return this.context.mode
  }

  /** Runs a single tick and returns a report. Used by tests and one-shot runs. */
  async runOnce(): Promise<TickReport> {
    const report: TickReport = {
      polled: 0,
      recorded: 0,
      eligible: 0,
      executed: 0,
      described: 0,
      deduped: 0,
    }
    const items = await this.config.source.poll(this.context)
    report.polled = items.length
    for (const item of items) {
      await this.handleItem(item, report)
    }
    this.tickCount += 1
    await this.maybePrune()
    return report
  }

  /** Begins the poll loop. Idempotent — a second call is a no-op while running. */
  start(): void {
    if (this.running) return
    this.running = true
    this.abort = new AbortController()
    const signal = this.abort.signal
    this.loopPromise = this.loop(signal)
  }

  /** Stops the loop and awaits the in-flight tick. */
  async stop(): Promise<void> {
    if (!this.running) return
    this.running = false
    this.abort?.abort()
    await this.loopPromise
    this.loopPromise = null
    this.abort = null
  }

  private async loop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.runOnce()
      } catch (error) {
        this.logger('tick failed: %o', error instanceof Error ? error.message : error)
      }
      if (signal.aborted) return
      await sleep(this.intervalMs, signal)
    }
  }

  private async handleItem(item: T, report: TickReport): Promise<void> {
    await this.recordItem(item, report)
    const eligible = await this.isEligible(item)
    if (!eligible.proceed) {
      if (eligible.reason === 'deduped') report.deduped += 1
      return
    }
    report.eligible += 1
    await this.actOnItem(item, report)
  }

  private async recordItem(item: T, report: TickReport): Promise<void> {
    if (!this.config.sink) return
    await this.config.sink.record(item, this.context)
    report.recorded += 1
  }

  private async isEligible(
    item: T,
  ): Promise<{ proceed: boolean; reason?: 'condition' | 'deduped' }> {
    if (this.config.condition) {
      const ok = await this.config.condition(item, this.context)
      if (!ok) return { proceed: false, reason: 'condition' }
    }
    if (this.config.store) {
      const seen = await this.config.store.has(this.config.key(item))
      if (seen) return { proceed: false, reason: 'deduped' }
    }
    return { proceed: true }
  }

  private async actOnItem(item: T, report: TickReport): Promise<void> {
    if (this.context.mode === 'observe') {
      this.logger('observe: %s', this.config.action.describe(item, this.context))
      report.described += 1
      return
    }
    try {
      const result = await this.config.action.execute(item, this.context)
      report.executed += 1
      if (this.config.store) {
        await this.config.store.remember(this.config.key(item), result)
      }
    } catch (error) {
      this.logger('action failed: %o', error instanceof Error ? error.message : error)
    }
  }

  private async maybePrune(): Promise<void> {
    if (this.tickCount % this.pruneEveryTicks !== 0) return
    await this.config.store?.prune?.()
    await this.config.sink?.prune?.()
  }
}
