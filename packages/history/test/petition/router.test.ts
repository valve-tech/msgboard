import { describe, expect, it } from 'vitest'
import { matchPetitionRoute } from '../../src/petition/router.js'

describe('matchPetitionRoute', () => {
  it('parses the three endpoint shapes', () => {
    expect(matchPetitionRoute('/petition/index')).toEqual({ kind: 'index' })
    expect(matchPetitionRoute('/petition/0xdead/signatures')).toEqual({
      kind: 'signatures',
      id: '0xdead',
    })
    expect(matchPetitionRoute('/petition/0xdead/tally')).toEqual({ kind: 'tally', id: '0xdead' })
  })

  it('URL-decodes segments', () => {
    expect(matchPetitionRoute('/petition/%30xdead/tally')).toEqual({
      kind: 'tally',
      id: '0xdead',
    })
  })

  it('returns null for non-petition / malformed paths', () => {
    expect(matchPetitionRoute('/messages')).toBeNull()
    expect(matchPetitionRoute('/cosign/cosign/wonderland/signatures')).toBeNull()
    expect(matchPetitionRoute('/petition')).toBeNull()
    expect(matchPetitionRoute('/petition/0xdead')).toBeNull() // missing sub-route
    expect(matchPetitionRoute('/petition/0xdead/owners')).toBeNull() // no owners concept
    expect(matchPetitionRoute('/petition//signatures')).toBeNull() // empty id
  })
})
