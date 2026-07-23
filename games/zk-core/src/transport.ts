export type MessageHandler = (msg: unknown) => void

export interface Transport {
  send(msg: unknown): Promise<void>
  onMessage(handler: MessageHandler): void
}

/** In-process pair with injectable faults, for engine tests. */
export class LocalTransport implements Transport {
  private handler: MessageHandler = () => {}
  private peer!: LocalTransport
  private drops = 0
  delayMs = 0

  static pair(): [LocalTransport, LocalTransport] {
    const a = new LocalTransport()
    const b = new LocalTransport()
    a.peer = b
    b.peer = a
    return [a, b]
  }

  dropNext(n = 1): void {
    this.drops += n
  }

  /**
   * Resolves at hand-off, not delivery.
   *
   * Delivery is async: a microtask when delayMs === 0, or a timer when
   * delayMs > 0. The clone is taken here, at the call site, so non-cloneable
   * payloads throw synchronously even on the delayed path. Fault injection
   * (drops/delay) is the point of this class.
   */
  async send(msg: unknown): Promise<void> {
    const snapshot = structuredClone(msg)
    if (this.drops > 0) {
      this.drops--
      return
    }
    const deliver = () => this.peer.handler(snapshot)
    if (this.delayMs > 0) setTimeout(deliver, this.delayMs)
    else queueMicrotask(deliver)
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler
  }
}
