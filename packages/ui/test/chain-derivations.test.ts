import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  useChainStore,
  selectChain,
  selectName,
  selectRpcUrl,
  selectMustProxy,
  selectIsProxied,
  selectTransportUrl,
  selectFullTransportUrl,
  selectCategories,
  selectMessages,
  selectRpcValid,
  selectFaucetIsActive,
  selectSelectedOption,
} from '../src/stores/chain'

const realLocation = window.location

const setProtocol = (protocol: 'https:' | 'http:') => {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...realLocation, protocol, origin: `${protocol}//localhost` },
  })
}

const reset = () =>
  useChainStore.setState({
    chainOption: 'pulsechainV4',
    customRpcUrl: '',
    forceProxy: false,
    content: null,
    latestBlockNumber: null,
    globalWorkMultiplier: null,
    globalWorkDivisor: null,
    msgboardEnabled: null,
    loading: false,
  })

beforeEach(reset)
afterEach(() => {
  Object.defineProperty(window, 'location', { configurable: true, value: realLocation })
  vi.restoreAllMocks()
})

const s = () => useChainStore.getState()

describe('chain selectors — preset chains', () => {
  it('selectedOption / chain / name / rpcUrl resolve for a preset', () => {
    expect(selectSelectedOption(s())?.rpcUrl).toContain('943')
    expect(selectChain(s())?.id).toBe(943)
    expect(selectName(s())).toBe(selectChain(s())?.name)
    expect(selectRpcUrl(s())).toBe(selectSelectedOption(s())?.rpcUrl)
  })

  it('custom option falls back to defaultCustomChain + the typed url', () => {
    useChainStore.setState({ chainOption: 'custom', customRpcUrl: 'https://my.rpc/abc' })
    expect(selectName(s())).toBe('Custom')
    expect(selectChain(s())?.id).toBe(943) // defaultCustomChain = pulsechainV4
    expect(selectRpcUrl(s())).toBe('https://my.rpc/abc')
  })
})

describe('transportUrl + proxy logic', () => {
  it('returns the raw rpcUrl when not proxied', () => {
    setProtocol('https:')
    // default pulsechainV4 rpc is https → no proxy
    expect(selectIsProxied(s())).toBe(false)
    expect(selectTransportUrl(s())).toBe(selectRpcUrl(s()))
  })

  it('proxies an http rpc on an https page (mixed-content)', () => {
    setProtocol('https:')
    useChainStore.setState({ chainOption: 'custom', customRpcUrl: 'http://rpc.x/evm' })
    expect(selectMustProxy(s())).toBe(true)
    expect(selectIsProxied(s())).toBe(true)
    expect(selectTransportUrl(s())).toBe(
      `/api/rpc-proxy?url=${encodeURIComponent('http://rpc.x/evm')}`,
    )
  })

  it('forceProxy proxies even an https rpc', () => {
    setProtocol('https:')
    useChainStore.setState({
      chainOption: 'custom',
      customRpcUrl: 'https://rpc.x/evm',
      forceProxy: true,
    })
    expect(selectMustProxy(s())).toBe(false)
    expect(selectIsProxied(s())).toBe(true)
    expect(selectTransportUrl(s())).toBe(
      `/api/rpc-proxy?url=${encodeURIComponent('https://rpc.x/evm')}`,
    )
  })

  it('fullTransportUrl prefixes the origin for a relative proxy path', () => {
    setProtocol('https:')
    useChainStore.setState({ chainOption: 'custom', customRpcUrl: 'http://rpc.x/evm' })
    const full = selectFullTransportUrl(s())!
    expect(full.startsWith(window.location.origin)).toBe(true)
    expect(full.endsWith(`/api/rpc-proxy?url=${encodeURIComponent('http://rpc.x/evm')}`)).toBe(true)
  })
})

describe('rpcValid / faucetIsActive', () => {
  it('rpcValid is true for a preset, false for custom with empty/invalid url', () => {
    expect(selectRpcValid(s())).toBe(true)
    useChainStore.setState({ chainOption: 'custom', customRpcUrl: '' })
    expect(selectRpcValid(s())).toBe(false)
    useChainStore.setState({ customRpcUrl: 'not-a-url' })
    expect(selectRpcValid(s())).toBe(false)
    useChainStore.setState({ customRpcUrl: 'https://ok.rpc/x' })
    expect(selectRpcValid(s())).toBe(true)
  })

  it('faucetIsActive is true for custom and for a sponsored preset', () => {
    expect(selectFaucetIsActive(s())).toBe(true) // pulsechainV4 has gasSponsor
    useChainStore.setState({ chainOption: 'ethereum', customRpcUrl: '' })
    expect(selectFaucetIsActive(s())).toBe(false) // no sponsor
    useChainStore.setState({ chainOption: 'custom' })
    expect(selectFaucetIsActive(s())).toBe(true)
  })
})

describe('categories / messages derive from content', () => {
  it('reads keys and flattened values from content', () => {
    useChainStore.setState({
      content: {
        '0xcat1': [{ a: 1 } as never],
        '0xcat2': [{ b: 2 } as never, { c: 3 } as never],
      } as never,
    })
    expect(selectCategories(s())).toEqual(['0xcat1', '0xcat2'])
    expect(selectMessages(s())).toHaveLength(3)
  })

  it('returns empty derivations for null content', () => {
    expect(selectCategories(s())).toEqual([])
    expect(selectMessages(s())).toEqual([])
  })
})

describe('store mutation re-renders subscribers (timer/worker-driven set)', () => {
  it('an out-of-React setState notifies a subscriber', () => {
    const seen: Array<boolean> = []
    const unsub = useChainStore.subscribe((st) => seen.push(st.loading))
    useChainStore.setState({ loading: true })
    unsub()
    expect(seen).toContain(true)
  })
})
