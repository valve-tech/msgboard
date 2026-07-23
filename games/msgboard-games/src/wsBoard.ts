import { MsgBoardClient } from '@msgboard/sdk'

export { MsgBoardClient }

/**
 * WebSocket transport for the msgboard client: every msgboard_ and eth_ request rides one socket,
 * and `eth_subscribe(newHeads)` pushes drive event-driven board refreshes (fetch content when a
 * head lands) instead of HTTP polling.
 *
 * Mirror of @msgboard/sdk's MsgBoardWsClient (packages/sdk/src/ws.ts - the canonical, unit- and
 * live-tested implementation); carried here until the next sdk publish, then this file collapses
 * to a re-export. Browser (native WebSocket) + Node >=22 (global WebSocket).
 *
 * Reconnects with a fixed delay and RE-SUBSCRIBES after every drop; in-flight requests at the
 * drop are rejected - the caller owns retry policy, the transport never replays.
 */

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void }

export class WsBoardTransport {
  private ws?: WebSocket
  private nextId = 1
  private pending = new Map<number, Pending>()
  private headSubscribers = new Set<(blockNumber: bigint) => void>()
  private subscriptionId?: string
  private closed = false
  private opening?: Promise<void>

  constructor(
    private url: string,
    private reconnectDelayMs = 1_000,
  ) {}

  async request<T>(arg: { method: string; params: unknown[] }): Promise<T> {
    await this.ensureOpen()
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      this.ws!.send(JSON.stringify({ jsonrpc: '2.0', id, method: arg.method, params: arg.params }))
    })
  }

  async subscribeNewHeads(handler: (blockNumber: bigint) => void): Promise<void> {
    this.headSubscribers.add(handler)
    await this.ensureOpen()
    if (!this.subscriptionId) {
      this.subscriptionId = await this.request<string>({ method: 'eth_subscribe', params: ['newHeads'] })
    }
  }

  close(): void {
    this.closed = true
    this.headSubscribers.clear()
    this.rejectAll(new Error('ws board transport closed'))
    this.ws?.close()
    this.ws = undefined
  }

  private ensureOpen(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('ws board transport closed'))
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
      params?: { subscription: string; result: { number: string } }
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
    setTimeout(() => {
      if (this.closed) return
      void this.ensureOpen()
        .then(() =>
          this.headSubscribers.size > 0 && !this.subscriptionId
            ? this.request<string>({ method: 'eth_subscribe', params: ['newHeads'] }).then((id) => {
                this.subscriptionId = id
              })
            : undefined,
        )
        .catch(() => {
          /* onDrop schedules the next attempt */
        })
    }, this.reconnectDelayMs)
  }

  private rejectAll(err: Error) {
    for (const p of this.pending.values()) p.reject(err)
    this.pending.clear()
  }
}

/** A MsgBoardClient whose provider is the WS transport — drop-in for msgBoardClientAdapter/post. */
export function createWsMsgBoardClient(wsUrl: string): { board: MsgBoardClient; transport: WsBoardTransport } {
  const transport = new WsBoardTransport(wsUrl)
  return { board: new MsgBoardClient(transport), transport }
}

/** https → wss for the standard boardRpc config values (the proxy upgrades in place). */
export const toWsUrl = (httpUrl: string): string => httpUrl.replace(/^http/, 'ws')
