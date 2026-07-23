import { describe, it, expect } from 'vitest'
import { PACKAGE } from '../src/index'

describe('package', () => {
  it('loads', () => {
    expect(PACKAGE).toBe('@msgboard/games')
  })
})
