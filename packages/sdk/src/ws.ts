import type { Hex } from 'viem'
import { MsgBoardClient, type Config } from './index.js'

/**
 * The WebSocket pathway for msgboard: one socket carrying every `msgboard_*` (and `eth_*`)
 * request/response, plus `eth_subscribe(newHeads)` pushes — so consumers get event-driven
 * board updates (fetch content when a head lands) instead of HTTP polling.
 *
 * Runs in browsers (native WebSocket) and Node ≥22 (global WebSocket). Auto-reconnects with a
 * fixed delay and RE-SUBSCRIBES newHeads after every reconnect; in-flight requests at the moment
 * of a drop are rejected (the caller's poll/retry loop owns retry policy — the transport never
 * silently replays a request that may have executed). `close()` is final: no reconnect after it.
 */

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void }
type WsClientOptions = { reconnectDelayMs?: number }

export class MsgBoardWsClient extends MsgBoardClient {
  private url: string
  private ws?: WebSocket
  private nextId = 1
  private pending = new Map<number, Pending>()
  private headSubscribers = new Set<(blockNumber: bigint) => void>()
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

  /** Final close: rejects in-flight requests, stops reconnecting, drops subscribers. */
  async close(): Promise<void> {
    this.closed = true
    this.headSubscribers.clear()
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
    let msg: { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: { subscription: string; result: { number: Hex } } }
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
    if (msg.method === 'eth_subscription' && msg.params?.result?.number) {
      const n = BigInt(msg.params.result.number)
      for (const handler of this.headSubscribers) handler(n)
    }
  }

  private onDrop(rejectOpen: (e: Error) => void) {
    const err = new Error('msgboard websocket dropped')
    this.opening = undefined
    rejectOpen(err)
    this.rejectAll(err)
    this.subscriptionId = undefined
    this.ws = undefined
    if (this.closed) return
    // Reconnect + resubscribe: the board feed must survive node restarts unattended.
    setTimeout(() => {
      if (this.closed) return
      void this.ensureOpen()
        .then(() => (this.headSubscribers.size > 0 ? this.subscribe() : undefined))
        .catch(() => {
          /* onDrop schedules the next attempt */
        })
    }, this.reconnectDelayMs)
  }

  private async subscribe(): Promise<void> {
    this.subscriptionId = await this.wsRequest<string>({ method: 'eth_subscribe', params: ['newHeads'] })
  }

  private rejectAll(err: Error) {
    for (const p of this.pending.values()) p.reject(err)
    this.pending.clear()
  }
}
