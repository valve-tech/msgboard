import { afterEach, describe, expect, it, vi } from 'vitest'
import { needsProxy, rpcs } from '../src/lib/rpc'

const realLocation = window.location

const setProtocol = (protocol: 'https:' | 'http:') => {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...realLocation, protocol, origin: `${protocol}//localhost` },
  })
}

afterEach(() => {
  Object.defineProperty(window, 'location', { configurable: true, value: realLocation })
  vi.restoreAllMocks()
})

describe('needsProxy', () => {
  it('is true for an http rpc on an https page', () => {
    setProtocol('https:')
    expect(needsProxy('http://rpc.example.com')).toBe(true)
  })

  it('is false for localhost / 127.0.0.1 even on https', () => {
    setProtocol('https:')
    expect(needsProxy('http://localhost:8545')).toBe(false)
    expect(needsProxy('http://127.0.0.1:8545')).toBe(false)
  })

  it('is false for an https rpc', () => {
    setProtocol('https:')
    expect(needsProxy('https://rpc.example.com')).toBe(false)
  })

  it('is false when the page itself is http', () => {
    setProtocol('http:')
    expect(needsProxy('http://rpc.example.com')).toBe(false)
  })
})

describe('rpcs map', () => {
  it('resolves pulsechainV4 rpcUrl to the env override or the valve.city default', () => {
    const cfg = rpcs.get('pulsechainV4')!
    expect(cfg.rpcUrl).toBe(
      import.meta.env.VITE_RPC_943 ?? 'https://one.valve.city/rpc/vk_demo/evm/943',
    )
    expect(cfg.gasSponsor).toBeTruthy()
  })

  it('exposes the three preset chains', () => {
    expect([...rpcs.keys()]).toEqual(['pulsechainV4', 'pulsechain', 'ethereum'])
  })
})
