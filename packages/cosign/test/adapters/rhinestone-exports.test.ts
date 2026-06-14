import { describe, expect, it } from 'vitest'
import * as pkg from '../../src/index.js'

describe('package re-exports the rhinestone adapter', () => {
  it('exposes the adapter factory + helpers', () => {
    for (const name of [
      'makeRhinestoneOwnableAdapter', 'buildOwnableSignature', 'userOpHash',
      'encodeStatelessData', 'encodeOwnableMeta', 'decodeOwnableMeta',
      'OWNABLE_VALIDATOR_ADDRESS', 'OWNABLE_VALIDATOR_ABI', 'EIP1271_SUCCESS',
    ]) {
      expect(name in pkg).toBe(true)
    }
  })
})
