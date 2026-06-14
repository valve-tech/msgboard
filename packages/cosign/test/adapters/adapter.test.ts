import { describe, expect, it } from 'vitest'
import type { Hex } from 'viem'
import { SCHEME, type SignatureRecord } from '../../src/record.js'
import type { CosignAdapter } from '../../src/adapters/adapter.js'
import { aggregate } from '../../src/client.js'

const signer = (n: string): Hex => `0x${n.repeat(40).slice(0, 40)}` as Hex
const sig = `0x${'33'.repeat(65)}` as Hex
const rec = (signerAddr: Hex): SignatureRecord => ({
  digest: `0x${'11'.repeat(32)}` as Hex,
  signer: signerAddr,
  signature: sig,
  scheme: SCHEME.ECDSA,
  meta: '0x',
})

describe('CosignAdapter interface', () => {
  it('a fake adapter satisfies the interface and drives aggregate', async () => {
    // Type-level lock: this object must be assignable to CosignAdapter.
    const adapter: CosignAdapter = {
      verify: async (record) => record.signer !== signer('2'),
      order: (records) => [...records].sort((a, b) => (a.signer < b.signer ? -1 : 1)),
      owners: async () => [signer('1'), signer('3')],
      threshold: async () => 2,
    }
    const out = await aggregate([rec(signer('3')), rec(signer('2')), rec(signer('1'))], adapter)
    expect(out.map((o) => o.signer)).toEqual([signer('1'), signer('3')])
  })

  it('the optional owners/threshold methods may be omitted', async () => {
    const minimal: CosignAdapter = {
      verify: async () => true,
      order: (records) => records,
    }
    const out = await aggregate([rec(signer('1'))], minimal)
    expect(out).toHaveLength(1)
  })
})
