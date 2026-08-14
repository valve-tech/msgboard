import { describe, it, expect, vi } from 'vitest'
import { resolveSkin, buildGenerativeSrcDoc, GENERATIVE_CSP, type RenderInstruction, type Verifier } from './resolve'
import type { AssetRef } from './assetRef'

const HASH = ('0x' + 'cd'.repeat(32)) as `0x${string}`
const FALLBACK: RenderInstruction = { tier: 'declarative', pointer: 'house-default' }

describe('resolveSkin — fail-safe fallback (a theme can never block or break a surface)', () => {
  it('resolves a declarative ref inline, without touching the verifier (no fetch, no execution)', async () => {
    const verify = vi.fn<Verifier>()
    const ref: AssetRef = { kind: 'declarative', pointer: '#0a3121' }
    const out = await resolveSkin(ref, FALLBACK, { verify })
    expect(out).toEqual({ tier: 'declarative', pointer: '#0a3121' })
    expect(verify).not.toHaveBeenCalled()
  })

  it('renders a hash-verified media ref as an <img> instruction', async () => {
    const verify: Verifier = async () => ({ ok: true, kind: 'image', src: 'blob:verified' })
    const ref: AssetRef = { kind: 'media', pointer: 'ipfs://Qm', contentHash: HASH }
    const out = await resolveSkin(ref, FALLBACK, { verify })
    expect(out).toEqual({ tier: 'image', src: 'blob:verified' })
  })

  it('renders a verified erc1155 ref as media (an <img> instruction)', async () => {
    const verify: Verifier = async () => ({ ok: true, kind: 'image', src: 'blob:token' })
    const ref: AssetRef = { kind: 'erc1155', pointer: 'eip155:943/erc1155:0xabc/7', contentHash: HASH }
    const out = await resolveSkin(ref, FALLBACK, { verify })
    expect(out).toEqual({ tier: 'image', src: 'blob:token' })
  })

  it('renders a verified generative ref as a sandboxed-iframe srcDoc instruction', async () => {
    const verify: Verifier = async () => ({ ok: true, kind: 'generative', srcDoc: '<html>art</html>' })
    const ref: AssetRef = { kind: 'generative', pointer: 'eip155:943/0xabc', contentHash: HASH }
    const out = await resolveSkin(ref, FALLBACK, { verify })
    expect(out).toEqual({ tier: 'generative', srcDoc: '<html>art</html>' })
  })

  it('falls back to the house default on a hash mismatch (verify returns ok:false)', async () => {
    const verify: Verifier = async () => ({ ok: false })
    const ref: AssetRef = { kind: 'media', pointer: 'ipfs://Qm', contentHash: HASH }
    expect(await resolveSkin(ref, FALLBACK, { verify })).toEqual(FALLBACK)
  })

  it('falls back to the house default on a fetch error (verify throws)', async () => {
    const verify: Verifier = async () => {
      throw new Error('network down')
    }
    const ref: AssetRef = { kind: 'generative', pointer: 'eip155:943/0xabc', contentHash: HASH }
    expect(await resolveSkin(ref, FALLBACK, { verify })).toEqual(FALLBACK)
  })

  it('falls back to the house default on an unknown kind', async () => {
    const verify = vi.fn<Verifier>(async () => ({ ok: true, kind: 'image', src: 'x' }))
    const bogus = { kind: 'wasm', pointer: 'x', contentHash: HASH } as unknown as AssetRef
    expect(await resolveSkin(bogus, FALLBACK, { verify })).toEqual(FALLBACK)
    expect(verify).not.toHaveBeenCalled()
  })
})

describe('buildGenerativeSrcDoc — the generative sandbox is locked down', () => {
  const doc = buildGenerativeSrcDoc('<canvas></canvas>')
  it('stamps a CSP that starts from default-src none and cuts the network', () => {
    expect(GENERATIVE_CSP).toContain("default-src 'none'")
    expect(GENERATIVE_CSP).toContain("connect-src 'none'")
    expect(doc).toContain('Content-Security-Policy')
    expect(doc).toContain(GENERATIVE_CSP)
  })
  it('keeps the frame static under prefers-reduced-motion', () => {
    expect(doc).toContain('prefers-reduced-motion')
  })
  it('never grants the frame a same origin (that would be granted by the iframe, not the doc)', () => {
    expect(doc).not.toContain('allow-same-origin')
  })
})
