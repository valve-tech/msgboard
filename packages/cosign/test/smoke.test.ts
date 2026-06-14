import { describe, expect, it } from 'vitest'
import { COSIGN_VERSION } from '../src/index.js'

describe('@msgboard/cosign smoke', () => {
  it('exposes a version constant', () => {
    expect(COSIGN_VERSION).toBe('0.0.31')
  })
})
