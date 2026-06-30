/**
 * Waku source — the READ side of the one-way relay. Abstracted behind an interface so the relay loop is
 * testable without a network (see MockWakuSource) and so the concrete `@waku/sdk` integration is a single
 * swappable module. `@waku/sdk` is an OPTIONAL dependency and imported dynamically: the package builds,
 * type-checks, and unit-tests without it; you only need it installed to run the live relay.
 */

export interface WakuMessage {
  /** the channel/topic NAME (mapped to a MsgBoard category by the relay). */
  channel: string
  /** the raw message payload bytes. */
  payload: Uint8Array
}

export type WakuMessageHandler = (message: WakuMessage) => void

export interface WakuSource {
  /** connect / start the node. */
  start(): Promise<void>
  /** subscribe to the given channels; `onMessage` fires per delivered message. */
  subscribe(channels: string[], onMessage: WakuMessageHandler): Promise<void>
  /** disconnect / stop. */
  stop(): Promise<void>
}

export interface WakuSourceConfig {
  /** app name used to build content topics: `/{appName}/1/{channel}/proto`. */
  appName: string
  /** explicit bootstrap multiaddrs; when empty, `defaultBootstrap: true` is used. */
  bootstrap?: string[]
  /** override the content-topic builder if your channels map differently. */
  contentTopicFor?: (channel: string) => string
  log?: (msg: string, meta?: unknown) => void
}

/** Default content-topic format: `/{appName}/1/{channel}/proto`. */
export function defaultContentTopic(appName: string, channel: string): string {
  return `/${appName}/1/${channel}/proto`
}

/**
 * Live Waku source backed by a `@waku/sdk` light node (Filter for subscribe). The exact `@waku/sdk`
 * surface shifts between releases; this targets the createLightNode + createDecoder + filter.subscribe
 * shape. If your installed version differs, this module is the ONE place to adjust.
 */
export function createWakuSource(config: WakuSourceConfig): WakuSource {
  const log = config.log ?? (() => {})
  const topicFor = config.contentTopicFor ?? ((c: string) => defaultContentTopic(config.appName, c))
  // typed loosely on purpose: @waku/sdk is optional and not present at type-check time.
  let node: any
  let waku: any

  return {
    start: async () => {
      try {
        // non-literal specifier: @waku/sdk is an OPTIONAL dep, so we avoid a static import the type
        // checker would try (and fail) to resolve when it isn't installed.
        const specifier = '@waku/sdk'
        waku = await import(specifier)
      } catch {
        throw new Error('@waku/sdk is not installed — run `npm i @waku/sdk` to use the live Waku source')
      }
      const bootstrap = config.bootstrap ?? []
      node = await waku.createLightNode(
        bootstrap.length > 0 ? { bootstrapPeers: bootstrap } : { defaultBootstrap: true },
      )
      await node.start()
      if (typeof node.waitForPeers === 'function') {
        await node.waitForPeers([waku.Protocols.Filter])
      }
      log('waku node started')
    },
    subscribe: async (channels, onMessage) => {
      if (!node || !waku) throw new Error('waku source not started — call start() first')
      for (const channel of channels) {
        const contentTopic = topicFor(channel)
        const decoder = waku.createDecoder(contentTopic)
        await node.filter.subscribe([decoder], (msg: { payload?: Uint8Array }) => {
          if (!msg?.payload) return
          onMessage({ channel, payload: msg.payload })
        })
        log('subscribed', { channel, contentTopic })
      }
    },
    stop: async () => {
      if (node) await node.stop()
      log('waku node stopped')
    },
  }
}

/** In-memory Waku source for tests and dry-runs: push messages with `emit()`. No network. */
export class MockWakuSource implements WakuSource {
  private handlers: { channels: Set<string>; onMessage: WakuMessageHandler }[] = []
  started = false
  stopped = false

  async start(): Promise<void> {
    this.started = true
  }

  async subscribe(channels: string[], onMessage: WakuMessageHandler): Promise<void> {
    this.handlers.push({ channels: new Set(channels), onMessage })
  }

  async stop(): Promise<void> {
    this.stopped = true
  }

  /** Deliver a message to every subscriber whose channel set includes `channel`. */
  emit(channel: string, payload: Uint8Array): void {
    for (const h of this.handlers) if (h.channels.has(channel)) h.onMessage({ channel, payload })
  }
}
