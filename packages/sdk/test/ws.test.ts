import { WebSocketServer, type WebSocket as ServerSocket } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import { MsgBoardWsClient } from '../src/ws.js'

/**
 * The WebSocket pathway for msgboard: request/response for every msgboard_* method over one
 * socket, plus newHeads push subscriptions — so consumers (the games' offer feeds, bots) get
 * event-driven updates instead of HTTP polling.
 *
 * Unit tests run against a local mock JSON-RPC WS server (exact node framing); the live suite
 * runs against the real proxy endpoint by default, same convention as index.test.ts.
 */

const LIVE_WS = process.env.MSGBOARD_WS ?? 'wss://games.msgboard.xyz/rpc/evm/943'

// ── mock node: JSON-RPC over WS with eth_subscribe(newHeads) push support ────────────────────────
type Mock = { wss: WebSocketServer; url: string; pushHead: (n: number) => void; dropAll: () => void; requests: string[] }

const startMock = async (): Promise<Mock> => {
  const wss = new WebSocketServer({ port: 0 })
  const sockets = new Set<ServerSocket>()
  const requests: string[] = []
  const subs = new Map<ServerSocket, string>()
  wss.on('connection', (ws) => {
    sockets.add(ws)
    ws.on('close', () => sockets.delete(ws))
    ws.on('message', (raw) => {
      const m = JSON.parse(String(raw)) as { id: number; method: string; params?: unknown[] }
      requests.push(m.method)
      const reply = (result: unknown) => ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }))
      if (m.method === 'eth_chainId') reply('0x3af')
      else if (m.method === 'msgboard_status') reply({ enabled: true, count: '0x1', size: '0x10', workMultiplier: '0x1' })
      else if (m.method === 'msgboard_content') reply({}) // empty board
      else if (m.method === 'eth_subscribe') {
        const id = `0xsub${Math.floor(Math.random() * 1e9).toString(16)}`
        subs.set(ws, id)
        reply(id)
      } else if (m.method === 'slow_echo') setTimeout(() => reply(m.params?.[0]), 50)
      else ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `no ${m.method}` } }))
    })
  })
  await new Promise<void>((resolve) => wss.on('listening', resolve))
  const { port } = wss.address() as { port: number }
  return {
    wss,
    url: `ws://127.0.0.1:${port}`,
    requests,
    pushHead: (n) => {
      for (const [ws, sub] of subs) {
        ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'eth_subscription', params: { subscription: sub, result: { number: `0x${n.toString(16)}` } } }))
      }
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
