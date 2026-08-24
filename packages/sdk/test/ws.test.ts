import { WebSocketServer, type WebSocket as ServerSocket } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import { MsgBoardWsClient } from '../src/ws.js'
import type { RPCMessage } from '@msgboard/core'

/**
 * The WebSocket pathway for msgboard: request/response for every msgboard_* method over one
 * socket, plus newHeads and newMessages push subscriptions — so consumers (the games' offer feeds,
 * bots) get event-driven updates instead of HTTP polling.
 *
 * Unit tests run against a local mock JSON-RPC WS server (exact node framing); the live suite
 * runs against the real proxy endpoint by default, same convention as index.test.ts.
 */

const LIVE_WS = process.env.MSGBOARD_WS ?? 'wss://games.msgboard.xyz/rpc/evm/943'

const sampleMessage = (data: string): RPCMessage =>
  ({
    version: '0x1',
    category: `0x${'26'.repeat(32)}`,
    data: `0x${Buffer.from(data).toString('hex')}`,
    hash: `0x${'11'.repeat(32)}`,
    nonce: '0x1',
    blockHash: `0x${'22'.repeat(32)}`,
    blockNumber: '0x1',
    workMultiplier: '0x2710',
    workDivisor: '0xf4240',
  }) as RPCMessage

// ── mock node: JSON-RPC over WS with newHeads + newMessages push support ─────────────────────────
type PushOptions = {
  /** Notification method name — pre-pulse-4 nodes send `msgboard_subscribe` instead. */
  method?: string
  /** Push under this id instead of the live ones (for ids the client never registered). */
  subscription?: string
}
type Mock = {
  wss: WebSocketServer
  url: string
  pushHead: (n: number) => void
  pushMessage: (message: RPCMessage, options?: PushOptions) => void
  /** Ids the mock handed out for msgboard_subscribe, oldest first. */
  messageSubIds: () => string[]
  /** The filter the client sent with each msgboard_subscribe, oldest first. */
  messageSubFilters: () => unknown[]
  dropAll: () => void
  requests: string[]
}
/** `messages: false` mimics a node built without the msgboard WS module (answers -32601). */
type MockOptions = { messages?: boolean }

const startMock = async ({ messages = true }: MockOptions = {}): Promise<Mock> => {
  const wss = new WebSocketServer({ port: 0 })
  const sockets = new Set<ServerSocket>()
  const requests: string[] = []
  const subs = new Map<ServerSocket, string>()
  let msgSubs: { ws: ServerSocket; id: string }[] = []
  const msgSubIds: string[] = []
  const msgSubFilters: unknown[] = []
  const newId = (prefix: string) => `0x${prefix}${Math.floor(Math.random() * 1e9).toString(16)}`
  wss.on('connection', (ws) => {
    sockets.add(ws)
    ws.on('close', () => {
      sockets.delete(ws)
      msgSubs = msgSubs.filter((s) => s.ws !== ws)
    })
    ws.on('message', (raw) => {
      const m = JSON.parse(String(raw)) as { id: number; method: string; params?: unknown[] }
      requests.push(m.method)
      const reply = (result: unknown) => ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }))
      const fail = (code: number, message: string) => ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code, message } }))
      if (m.method === 'eth_chainId') reply('0x3af')
      else if (m.method === 'msgboard_status') reply({ enabled: true, count: '0x1', size: '0x10', workMultiplier: '0x1' })
      else if (m.method === 'msgboard_content') reply({}) // empty board
      else if (m.method === 'eth_subscribe') {
        const id = newId('sub')
        subs.set(ws, id)
        reply(id)
      } else if (m.method === 'msgboard_subscribe') {
        if (!messages) fail(-32601, `the method ${m.method} does not exist/is not available`)
        else if (m.params?.[0] !== 'newMessages') fail(-32602, 'invalid subscription kind')
        else {
          const id = newId('msg')
          msgSubs.push({ ws, id })
          msgSubIds.push(id)
          msgSubFilters.push(m.params?.[1])
          reply(id)
        }
      } else if (m.method === 'msgboard_unsubscribe') {
        const before = msgSubs.length
        msgSubs = msgSubs.filter((s) => !(s.ws === ws && s.id === m.params?.[0]))
        reply(msgSubs.length < before)
      } else if (m.method === 'slow_echo') setTimeout(() => reply(m.params?.[0]), 50)
      else fail(-32601, `no ${m.method}`)
    })
  })
  await new Promise<void>((resolve) => wss.on('listening', resolve))
  const { port } = wss.address() as { port: number }
  const notify = (ws: ServerSocket, method: string, subscription: string, result: unknown) =>
    ws.send(JSON.stringify({ jsonrpc: '2.0', method, params: { subscription, result } }))
  return {
    wss,
    url: `ws://127.0.0.1:${port}`,
    requests,
    messageSubIds: () => [...msgSubIds],
    messageSubFilters: () => [...msgSubFilters],
    pushHead: (n) => {
      for (const [ws, sub] of subs) notify(ws, 'eth_subscription', sub, { number: `0x${n.toString(16)}` })
    },
    pushMessage: (message, options = {}) => {
      const method = options.method ?? 'msgboard_subscription'
      if (options.subscription) {
        for (const ws of sockets) notify(ws, method, options.subscription, message)
        return
      }
      for (const { ws, id } of msgSubs) notify(ws, method, id, message)
    },
    dropAll: () => {
      for (const ws of sockets) ws.terminate()
    },
  }
}

let mock: Mock | undefined
let client: MsgBoardWsClient | undefined
afterEach(async () => {
  await client?.close()
  client = undefined
  mock?.wss.close()
  mock = undefined
})

describe('MsgBoardWsClient (mock node)', () => {
  it('answers requests over the socket', async () => {
    mock = await startMock()
    client = new MsgBoardWsClient(mock.url)
    expect(await client.request<string, []>({ method: 'eth_chainId', params: [] })).toBe('0x3af')
    const status = await client.status()
    expect(status.enabled).toBe(true)
  })

  it('interleaves concurrent requests by id', async () => {
    mock = await startMock()
    client = new MsgBoardWsClient(mock.url)
    // slow_echo answers after 50ms; a fast request fired later must not steal its slot.
    const [slow, fast] = await Promise.all([
      client.request<string, [string]>({ method: 'slow_echo', params: ['tortoise'] }),
      client.request<string, []>({ method: 'eth_chainId', params: [] }),
    ])
    expect(slow).toBe('tortoise')
    expect(fast).toBe('0x3af')
  })

  it('surfaces JSON-RPC errors as rejections', async () => {
    mock = await startMock()
    client = new MsgBoardWsClient(mock.url)
    await expect(client.request({ method: 'nope_nope', params: [] })).rejects.toThrow(/no nope_nope/)
  })

  it('pushes newHeads to the subscriber', async () => {
    mock = await startMock()
    client = new MsgBoardWsClient(mock.url)
    const heads: bigint[] = []
    await client.subscribeNewHeads((n) => {
      heads.push(n)
    })
    mock.pushHead(101)
    mock.pushHead(102)
    await new Promise((r) => setTimeout(r, 100))
    expect(heads).toEqual([101n, 102n])
  })

  it('reconnects after a drop and resubscribes', async () => {
    mock = await startMock()
    client = new MsgBoardWsClient(mock.url, { reconnectDelayMs: 50 })
    const heads: bigint[] = []
    await client.subscribeNewHeads((n) => {
      heads.push(n)
    })
    mock.pushHead(7)
    await new Promise((r) => setTimeout(r, 50))

    mock.dropAll() // the node vanishes mid-session
    await new Promise((r) => setTimeout(r, 300)) // reconnect + resubscribe window
    mock.pushHead(8) // arrives on the NEW socket's subscription
    await new Promise((r) => setTimeout(r, 100))
    expect(heads).toEqual([7n, 8n])
    // requests still work post-reconnect
    expect(await client.request<string, []>({ method: 'eth_chainId', params: [] })).toBe('0x3af')
  })

  it('pushes board messages to the subscriber', async () => {
    mock = await startMock()
    client = new MsgBoardWsClient(mock.url)
    const seen: string[] = []
    await client.subscribeMessages((m) => {
      seen.push(m.data)
    })
    mock.pushMessage(sampleMessage('hello'))
    await new Promise((r) => setTimeout(r, 100))
    expect(seen).toEqual([sampleMessage('hello').data])
  })

  it('pushes board messages named `msgboard_subscribe` (pre-pulse-4 nodes)', async () => {
    // The notification method name changed at reth v2.5.1-pulse-4. Routing on the name delivers
    // nothing against the other build — and the board reads as idle, not broken. Route on the id.
    mock = await startMock()
    client = new MsgBoardWsClient(mock.url)
    const seen: string[] = []
    await client.subscribeMessages((m) => {
      seen.push(m.data)
    })
    mock.pushMessage(sampleMessage('older node'), { method: 'msgboard_subscribe' })
    await new Promise((r) => setTimeout(r, 100))
    expect(seen).toEqual([sampleMessage('older node').data])
  })

  it('drops a notification for an id it never registered', async () => {
    mock = await startMock()
    client = new MsgBoardWsClient(mock.url)
    const seen: string[] = []
    await client.subscribeMessages((m) => {
      seen.push(m.data)
    })
    // Same socket, same method name, a stranger's subscription id: not ours, not delivered.
    mock.pushMessage(sampleMessage('someone else'), { subscription: '0xnotoursatall' })
    mock.pushMessage(sampleMessage('someone else'), { method: 'msgboard_subscribe', subscription: '0xnotoursatall' })
    await new Promise((r) => setTimeout(r, 100))
    expect(seen).toEqual([])
  })

  it('passes the category filter to the node', async () => {
    mock = await startMock()
    client = new MsgBoardWsClient(mock.url)
    const category = `0x${'26'.repeat(32)}` as const
    await client.subscribeMessages(() => {}, { category })
    expect(mock.messageSubFilters()).toEqual([{ category }])
  })

  it('re-establishes a message subscription after a drop', async () => {
    mock = await startMock()
    client = new MsgBoardWsClient(mock.url, { reconnectDelayMs: 50 })
    const seen: string[] = []
    await client.subscribeMessages((m) => {
      seen.push(m.data)
    })
    mock.pushMessage(sampleMessage('before'))
    await new Promise((r) => setTimeout(r, 50))

    mock.dropAll() // the gateway hangs up (valve.city's public tier does this every 60s)
    await new Promise((r) => setTimeout(r, 300)) // reconnect + resubscribe window
    mock.pushMessage(sampleMessage('after')) // arrives on the NEW socket's subscription id
    await new Promise((r) => setTimeout(r, 100))
    expect(seen).toEqual([sampleMessage('before').data, sampleMessage('after').data])
    expect(mock.messageSubIds().length).toBe(2) // a fresh id, not the dead one
  })

  it('stops delivery after unsubscribe', async () => {
    mock = await startMock()
    client = new MsgBoardWsClient(mock.url)
    const seen: string[] = []
    const sub = await client.subscribeMessages((m) => {
      seen.push(m.data)
    })
    mock.pushMessage(sampleMessage('kept'))
    await new Promise((r) => setTimeout(r, 50))
    await sub.unsubscribe()
    expect(mock.requests).toContain('msgboard_unsubscribe')

    // Push on the now-dead id anyway: the client must have forgotten the route, not just the node.
    const [id] = mock.messageSubIds()
    mock.pushMessage(sampleMessage('dropped'), { subscription: id })
    await new Promise((r) => setTimeout(r, 100))
    expect(seen).toEqual([sampleMessage('kept').data])
  })

  it('surfaces -32601 when the node has no msgboard WS module', async () => {
    mock = await startMock({ messages: false })
    client = new MsgBoardWsClient(mock.url)
    // No silent fallback to polling: the caller hears exactly what the node said.
    await expect(client.subscribeMessages(() => {})).rejects.toThrow(/does not exist/)
  })

  it('close() is final — no reconnect afterwards', async () => {
    mock = await startMock()
    client = new MsgBoardWsClient(mock.url, { reconnectDelayMs: 20 })
    await client.request<string, []>({ method: 'eth_chainId', params: [] })
    await client.close()
    const before = mock.requests.length
    await new Promise((r) => setTimeout(r, 150))
    expect(mock.requests.length).toBe(before) // nothing reconnected or re-sent
    client = undefined
  })
})

describe('MsgBoardWsClient (live node via the games proxy)', () => {
  it('serves msgboard_* over the socket and pushes real newHeads', { timeout: 60_000 }, async () => {
    client = new MsgBoardWsClient(LIVE_WS)
    expect(await client.request<string, []>({ method: 'eth_chainId', params: [] })).toBe('0x3af')
    const status = await client.status()
    expect(status.enabled).toBe(true)
    const categories = await client.categories()
    expect(Array.isArray(categories)).toBe(true)

    // A real chain-head push through Caddy → one.valve.city → the node's WS module.
    const head = await new Promise<bigint>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no newHeads push within 45s')), 45_000)
      void client!.subscribeNewHeads((n) => {
        clearTimeout(timer)
        resolve(n)
      })
    })
    expect(head).toBeGreaterThan(24_000_000n)
  })
})
