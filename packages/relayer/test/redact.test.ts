import { afterEach, describe, expect, it, vi } from 'vitest'
import { installConsoleRedactor, redactSecrets, sourceLabel } from '../src/redact.js'

// A realistic keyed endpoint, shaped like the ones the fleet uses. Not a real key.
const KEYED = 'https://one.example.test/rpc/vk_TestKey_0123456789abcdef/evm/943'

describe('redactSecrets', () => {
  it('removes the key segment from an RPC URL', () => {
    const out = redactSecrets(KEYED)
    expect(out).not.toContain('vk_TestKey_0123456789abcdef')
    expect(out).toBe('https://one.example.test/rpc/<redacted>/evm/943')
  })

  it('removes a bare vk_ token with no URL around it', () => {
    expect(redactSecrets('using vk_TestKey_0123456789abcdef now')).toBe('using vk_<redacted> now')
  })

  it('scrubs the key out of a viem-shaped error message', () => {
    // This is the actual leak path: viem repeats the whole request URL in the
    // message of every error it throws, and the indexer logged those.
    const message = `HTTP request failed.\n\nURL: ${KEYED}\nRequest body: {"method":"eth_chainId"}`
    expect(redactSecrets(message)).not.toContain('vk_TestKey_0123456789abcdef')
  })

  it('scrubs every key in a string, not only the first', () => {
    const out = redactSecrets(`${KEYED} then https://b.example.test/rpc/vk_Second_abcdef/evm/1`)
    expect(out).not.toMatch(/vk_[A-Za-z0-9_-]{4,}/)
  })

  it('leaves a URL with no key alone', () => {
    expect(redactSecrets('https://rpc.example.test/')).toBe('https://rpc.example.test/')
  })
})

describe('installConsoleRedactor', () => {
  const original = { log: console.log, error: console.error, warn: console.warn, info: console.info }
  afterEach(() => {
    Object.assign(console, original)
    delete (console as Console & { __msgboardRedacted?: true }).__msgboardRedacted
  })

  it('scrubs a keyed URL out of console.log', () => {
    const spy = vi.fn()
    console.log = spy
    installConsoleRedactor()
    console.log(`indexing chain 1 via ${KEYED}`)
    expect(spy.mock.calls[0]![0]).not.toContain('vk_TestKey_0123456789abcdef')
  })

  it('scrubs an Error passed to console.error, not only a string', () => {
    const spy = vi.fn()
    console.error = spy
    installConsoleRedactor()
    console.error(new Error(`HTTP request failed. URL: ${KEYED}`))
    expect(String(spy.mock.calls[0]![0])).not.toContain('vk_TestKey_0123456789abcdef')
  })

  it('leaves a non-string argument intact, so structured logging still works', () => {
    const spy = vi.fn()
    console.log = spy
    installConsoleRedactor()
    const payload = { chainId: 943 }
    console.log('tick %o', payload)
    expect(spy.mock.calls[0]![1]).toBe(payload)
  })

  it('is idempotent, so a second call does not double-wrap the console', () => {
    const spy = vi.fn()
    console.log = spy
    installConsoleRedactor()
    const wrapped = console.log
    installConsoleRedactor()
    expect(console.log).toBe(wrapped)
  })
})

describe('sourceLabel', () => {
  it('distinguishes two endpoints that differ ONLY by key', () => {
    // The bug this exists for. Two replicas of one chain are most naturally reached
    // through the same gateway host with different keys; both redact identically, so
    // anything keyed on the redacted url merges them. In the heartbeat table that
    // means two relayers sharing one row and overwriting each other, which hides the
    // replica split the table was added to reveal.
    const a = sourceLabel('https://one.example.test/rpc/vk_KeyOne_aaaa/evm/1')
    const b = sourceLabel('https://one.example.test/rpc/vk_KeyTwo_bbbb/evm/1')
    expect(redactSecrets('https://one.example.test/rpc/vk_KeyOne_aaaa/evm/1')).toBe(
      redactSecrets('https://one.example.test/rpc/vk_KeyTwo_bbbb/evm/1'),
    )
    expect(a).not.toBe(b)
  })

  it('never contains the key', () => {
    const label = sourceLabel('https://one.example.test/rpc/vk_TestKey_0123456789abcdef/evm/1')
    expect(label).not.toContain('vk_TestKey_0123456789abcdef')
    expect(label).not.toMatch(/vk_[A-Za-z0-9_-]{4,}/)
  })

  it('stays the same across calls, so a restart keeps the same row', () => {
    const url = 'https://one.example.test/rpc/vk_Stable_abcd/evm/369'
    expect(sourceLabel(url)).toBe(sourceLabel(url))
  })

  it('stays readable — the redacted url is still the visible part', () => {
    expect(sourceLabel('https://one.example.test/rpc/vk_Abc_1234/evm/943')).toMatch(
      /^https:\/\/one\.example\.test\/rpc\/<redacted>\/evm\/943#[0-9a-f]{8}$/,
    )
  })

  it('distinguishes different chains on the same host and key', () => {
    const a = sourceLabel('https://one.example.test/rpc/vk_Same_abcd/evm/1')
    const b = sourceLabel('https://one.example.test/rpc/vk_Same_abcd/evm/369')
    expect(a).not.toBe(b)
  })
})
