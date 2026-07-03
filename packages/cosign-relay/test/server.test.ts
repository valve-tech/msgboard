import { describe, expect, it } from 'vitest'
import { encodeFunctionData, zeroAddress } from 'viem'
import { SAFE_SETUP_ABI, SAFE_V141 } from '../src/constants.js'
import { createApp } from '../src/server.js'

// No RELAY_KEY_943 / RELAY_KEY_369 is set in this test process, so `enabledChains()` is empty and
// gate (1) always rejects before submit.ts ever touches the network — these tests never submit
// a real transaction.

const OWNER_A = '0x1111111111111111111111111111111111111111' as const

function plainInitializer() {
  return encodeFunctionData({
    abi: SAFE_SETUP_ABI,
    functionName: 'setup',
    args: [[OWNER_A], 1n, zeroAddress, '0x', SAFE_V141.fallbackHandler, zeroAddress, 0n, zeroAddress],
  })
}

describe('GET /health', () => {
  it('returns ok: true', async () => {
    const app = createApp()
    const res = await app.request('/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })
})

describe('GET /config', () => {
  it('reports the enabled chains and PoW difficulty', async () => {
    const app = createApp()
    const res = await app.request('/config')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveProperty('chains')
    expect(body).toHaveProperty('powBits')
    expect(Array.isArray(body.chains)).toBe(true)
  })
})

describe('POST /deploy-safe', () => {
  it('rejects a malformed body with 400 before touching any gate', async () => {
    const app = createApp()
    const res = await app.request('/deploy-safe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chainId: 'not-a-number' }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body).toHaveProperty('error')
  })

  it('rejects a disabled/unknown chainId (no relay key configured) without submitting anything', async () => {
    const app = createApp()
    const res = await app.request('/deploy-safe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chainId: 943,
        singleton: SAFE_V141.singletonL2,
        initializer: plainInitializer(),
        saltNonce: '1',
        signature: '0x' + '00'.repeat(65),
        powNonce: '0x' + '00'.repeat(32),
      }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/not enabled/i)
  })

  it('rejects a non-JSON body with 400', async () => {
    const app = createApp()
    const res = await app.request('/deploy-safe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    })
    expect(res.status).toBe(400)
  })
})
