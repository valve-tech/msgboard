import type { Hex } from 'viem'
import { MsgBoardClient, type Config, type RPCMessage } from './index.js'

/**
 * The WebSocket pathway for msgboard: one socket carrying every `msgboard_*` (and `eth_*`)
 * request/response, plus push subscriptions — `eth_subscribe(newHeads)` for the board's update
 * clock (a fresh `blockHash` is what `grind` builds a message against) and
 * `msgboard_subscribe(newMessages)` for the messages themselves.
 *
 * Runs in browsers (native WebSocket) and Node ≥22 (global WebSocket). Auto-reconnects with a
 * fixed delay and RE-SUBSCRIBES every live subscription after each reconnect; in-flight requests at
 * the moment of a drop are rejected (the caller's poll/retry loop owns retry policy — the transport
 * never silently replays a request that may have executed). `close()` is final: no reconnect after
 * it.
 *
 * A node without the `msgboard` WS module answers `msgboard_subscribe` with `-32601`, and that
 * error reaches the caller unchanged. The client never falls back to polling: a subscription either
 * works or says why it does not.
 */

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void }
type WsClientOptions = { reconnectDelayMs?: number }

/** The node-side filter for a message subscription. Omit it to receive every message. */
export type MessageFilter = { category?: Hex }

/** A live message subscription. `unsubscribe()` ends it — the handler never fires again. */
export type MessageSubscription = { unsubscribe: () => Promise<void> }

/** One caller's standing intent to receive messages. `id` is the node's id on the CURRENT socket. */
type MessageSub = { handler: (message: RPCMessage) => void; filter?: MessageFilter; id?: string }

export class MsgBoardWsClient extends MsgBoardClient {
  private url: string
  private ws?: WebSocket
  private nextId = 1
  private pending = new Map<number, Pending>()
  private headSubscribers = new Set<(blockNumber: bigint) => void>()
  private messageSubs = new Set<MessageSub>()
  /** Live delivery table: node subscription id → what to do with the notification's `result`. */
  private routes = new Map<string, (result: unknown) => void>()
  private subscriptionId?: string
  private closed = false
  private reconnectDelayMs: number
  private opening?: Promise<void>

  constructor(url: string, options: WsClientOptions = {}, config: Config = {}) {
    // MsgBoardClient delegates to `provider.request`; ours rides the socket.
    super({ request: (arg) => this.wsRequest(arg) }, config)
    this.url = url
    this.reconnectDelayMs = options.reconnectDelayMs ?? 1_000
  }

  /** Subscribe to chain heads (the board's update clock). Resolves once the subscription is live. */
  async subscribeNewHeads(handler: (blockNumber: bigint) => void): Promise<void> {
    this.headSubscribers.add(handler)
    await this.ensureOpen()
    if (!this.subscriptionId) await this.subscribe()
  }

  /**
   * Subscribe to board messages. The node applies the filter, so a message you did not ask for
   * never crosses the network. Resolves once the subscription is live, and survives reconnects.
   * Rejects with the node's own error if it cannot subscribe (`-32601` when the module is absent).
   */
  async subscribeMessages(
    handler: (message: RPCMessage) => void,
    filter?: MessageFilter,
  ): Promise<MessageSubscription> {
    const sub: MessageSub = { handler, filter }
    this.messageSubs.add(sub)
    try {
      await this.ensureOpen()
      await this.openMessageSub(sub)
    } catch (err) {
      this.messageSubs.delete(sub)
      throw err
    }
    return { unsubscribe: () => this.closeMessageSub(sub) }
  }

  /** Final close: rejects in-flight requests, stops reconnecting, drops subscribers. */
  async close(): Promise<void> {
    this.closed = true
    this.headSubscribers.clear()
    this.messageSubs.clear()
    this.routes.clear()
    this.rejectAll(new Error('MsgBoardWsClient closed'))
    this.ws?.close()
    this.ws = undefined
  }

  // ── transport ─────────────────────────────────────────────────────────────────────────────────

  private async wsRequest<T>(arg: { method: string; params: unknown[] }): Promise<T> {
    await this.ensureOpen()
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      this.ws!.send(JSON.stringify({ jsonrpc: '2.0', id, method: arg.method, params: arg.params }))
    })
  }

  private ensureOpen(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('MsgBoardWsClient closed'))
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve()
    this.opening ??= new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.url)
      this.ws = ws
      ws.onopen = () => {
        this.opening = undefined
        resolve()
      }
      ws.onmessage = (event: MessageEvent) => this.onMessage(String(event.data))
      ws.onclose = () => this.onDrop(reject)
      ws.onerror = () => {
        /* the paired close event carries the drop */
      }
    })
    return this.opening
  }

  private onMessage(raw: string) {
    let msg: {
      id?: number
      result?: unknown
      error?: { message: string }
      method?: string
      params?: { subscription?: string; result?: unknown }
    }
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error.message))
      else p.resolve(msg.result)
      return
    }
    // Route on the subscription id, NEVER on the notification's method name. The name is not stable
    // across node builds — reth before v2.5.1-pulse-4 sent `msgboard_subscribe`, pulse-4 and later
    // send `msgboard_subscription` — and a name test fails silently: the subscription opens, the id
    // looks valid, and nothing is ever delivered, so the board reads as idle instead of broken.
    // An id this client did not register has no route, and the notification is dropped.
    if (msg.params?.subscription) this.routes.get(msg.params.subscription)?.(msg.params.result)
  }

  private onDrop(rejectOpen: (e: Error) => void) {
    const err = new Error('msgboard websocket dropped')
    this.opening = undefined
    rejectOpen(err)
    this.rejectAll(err)
    // Subscription ids belong to the socket that issued them; none survives the drop.
    this.subscriptionId = undefined
    this.routes.clear()
    for (const sub of this.messageSubs) sub.id = undefined
    this.ws = undefined
    if (this.closed) return
    // Reconnect + resubscribe: the board feed must survive node restarts unattended.
    setTimeout(() => {
      if (this.closed) return
      void this.ensureOpen()
        .then(() => this.resubscribe())
        .catch(() => {
          /* onDrop schedules the next attempt */
        })
    }, this.reconnectDelayMs)
  }

  /** Re-open every standing subscription on the new socket. */
  private async resubscribe(): Promise<void> {
    const work: Promise<void>[] = []
    if (this.headSubscribers.size > 0 && !this.subscriptionId) work.push(this.subscribe())
    for (const sub of this.messageSubs) work.push(this.openMessageSub(sub))
    // A resubscribe that fails on an OPEN socket gets no second chance from onDrop, so say so
    // loudly rather than leaving a caller with a handler that will never fire again.
    const results = await Promise.allSettled(work)
    for (const r of results) if (r.status === 'rejected') this.log('resubscribe failed: %o', r.reason)
  }

  private async subscribe(): Promise<void> {
    const id = await this.wsRequest<string>({ method: 'eth_subscribe', params: ['newHeads'] })
    this.subscriptionId = id
    this.routes.set(id, (result) => {
      const number = (result as { number?: Hex } | undefined)?.number
      if (!number) return
      const n = BigInt(number)
      for (const handler of this.headSubscribers) handler(n)
    })
  }

  private async openMessageSub(sub: MessageSub): Promise<void> {
    const params = sub.filter ? ['newMessages', sub.filter] : ['newMessages']
    const id = await this.wsRequest<string>({ method: 'msgboard_subscribe', params })
    sub.id = id
    this.routes.set(id, (result) => sub.handler(result as RPCMessage))
  }

  private async closeMessageSub(sub: MessageSub): Promise<void> {
    this.messageSubs.delete(sub)
    const { id } = sub
    sub.id = undefined
    if (!id) return
    this.routes.delete(id)
    // Delivery has already stopped locally; telling the node is a courtesy, and it has nothing to
    // forget if the socket dropped between the two calls.
    await this.wsRequest<boolean>({ method: 'msgboard_unsubscribe', params: [id] }).catch((err) =>
      this.log('msgboard_unsubscribe(%s) failed: %o', id, err),
    )
  }

  private rejectAll(err: Error) {
    for (const p of this.pending.values()) p.reject(err)
    this.pending.clear()
  }
}
