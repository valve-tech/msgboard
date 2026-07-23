import { stringToHex, hexToString, type Hex } from 'viem'
import { categoryHash } from '@msgboard/sdk'
import type { MessageHandler, Transport } from './transport'

/** The subset of @msgboard/sdk's MsgBoardClient this adapter needs. Keeps the adapter
 *  testable with a fake and decoupled from the full client type. */
export interface BoardClient {
  addMessage(seed: { category: Hex; data: Hex }): Promise<unknown>
  content(filter: { category?: Hex }): Promise<Record<string, Array<{ data: Hex }>>>
}

/** Broadcasts/reads session messages over MsgBoard under a category.
 *  Ephemeral by design (spec §2): callers retain their own transcript; this is transport only. */
export class MsgBoardTransport implements Transport {
  readonly category: Hex
  private handler: MessageHandler = () => {}
  private seen = new Set<string>()

  /** Bind to a category. Pass a table id (Hex) for the per-table feed
   *  `games.msgboard.xyz:table:<id>`, or `{ category }` for an explicit shared category — e.g. the
   *  discoverable lobby `games.msgboard.xyz:lobby:<chain>`. `categoryHash` keccak-hashes the name, so
   *  the poster and any reader that compute the same name land on the same category. */
  constructor(private client: BoardClient, table: Hex | { category: string }) {
    this.category = categoryHash(typeof table === 'string' ? `games.msgboard.xyz:table:${table}` : table.category)
  }

  encode(msg: unknown): Hex {
    return stringToHex(JSON.stringify(msg))
  }

  async send(msg: unknown): Promise<void> {
    await this.client.addMessage({ category: this.category, data: this.encode(msg) })
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler
  }

  /** Pull inbound messages once; new (unseen) ones are delivered to the handler. */
  async poll(): Promise<void> {
    const content = await this.client.content({ category: this.category })
    const entries = content[this.category] ?? []
    for (const e of entries) {
      if (this.seen.has(e.data)) continue
      this.seen.add(e.data)
      this.handler(JSON.parse(hexToString(e.data)))
    }
  }
}
