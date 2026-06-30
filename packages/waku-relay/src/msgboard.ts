import { MsgBoardClient, type Provider } from '@msgboard/sdk'
import type { Hex } from 'viem'

/**
 * A minimal fetch-based JSON-RPC provider — the only surface MsgBoardClient needs is `request`. Points
 * at a node that runs the `msgboard_` module (e.g. valve.city: https://one.valve.city/rpc/<key>/evm/<id>).
 * Public PulseChain RPCs do NOT expose `msgboard_*`.
 */
export function httpProvider(url: string): Provider {
  return {
    async request<T, U extends unknown[]>(arg: { method: string; params: U }): Promise<T> {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // bigints never appear in the params the relay sends (addMessage -> [hex], block lookups ->
        // ['latest', false]); the replacer is a guard so a stray bigint serializes instead of throwing.
        body: JSON.stringify(
          { jsonrpc: '2.0', id: 1, method: arg.method, params: arg.params },
          (_k, v) => (typeof v === 'bigint' ? `0x${v.toString(16)}` : v),
        ),
      })
      if (!res.ok) throw new Error(`rpc ${arg.method}: HTTP ${res.status}`)
      const json = (await res.json()) as { result?: T; error?: { message?: string } }
      if (json.error) throw new Error(`rpc ${arg.method}: ${json.error.message ?? JSON.stringify(json.error)}`)
      return json.result as T
    },
  }
}

/** Submits a stamped message to the board. The stamp (PoW) is computed per call; no wallet, no gas. */
export interface BoardPoster {
  /** doPoW(category, data) then addMessage; returns the board message hash. */
  post(category: Hex, data: Hex): Promise<Hex>
}

export interface BoardPosterOptions {
  boardRpcUrl: string
  /** override the board difficulty factors (else the SDK defaults / board-supplied values are used). */
  workMultiplier?: bigint
  workDivisor?: bigint
}

export function createBoardClient(options: BoardPosterOptions): MsgBoardClient {
  const client = new MsgBoardClient(httpProvider(options.boardRpcUrl))
  if (options.workMultiplier !== undefined && options.workDivisor !== undefined) {
    client.setDifficultyFactors(options.workMultiplier, options.workDivisor)
  }
  return client
}

export function createBoardPoster(client: MsgBoardClient): BoardPoster {
  return {
    post: async (category, data) => {
      const work = await client.doPoW(category, data)
      return client.addMessage(work.message)
    },
  }
}
