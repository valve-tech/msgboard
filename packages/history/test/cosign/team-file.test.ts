import { describe, expect, it } from 'vitest'
import { loadTeamFile, type TeamFileInput } from '../../src/cosign/team-file.js'

const VALID: TeamFileInput = {
  version: 1,
  namespace: 'cosign',
  windowDays: 7,
  teams: [
    { scope: 'wonderland', label: 'Wonderland multisig' },
    { scope: '1:0xSAFE', label: 'Safe on mainnet' },
  ],
  adapter: { kind: 'none' },
}

describe('loadTeamFile', () => {
  it('accepts a well-formed team-file object and defaults windowDays to 7 when omitted', () => {
    const tf = loadTeamFile({ ...VALID, windowDays: undefined })
    expect(tf.windowDays).toBe(7)
    expect(tf.namespace).toBe('cosign')
    expect(tf.adapter.kind).toBe('none')
  })

  it('rejects a non-version-1 file', () => {
    expect(() => loadTeamFile({ ...VALID, version: 2 })).toThrow(/version/i)
  })

  it('rejects a file with no teams and no wildcard', () => {
    expect(() => loadTeamFile({ ...VALID, teams: [] })).toThrow(/teams/i)
  })

  describe('resolve', () => {
    it('resolves a listed scope under the matching namespace', () => {
      const tf = loadTeamFile(VALID)
      expect(tf.resolve('cosign', 'wonderland')?.scope).toBe('wonderland')
      expect(tf.resolve('cosign', '1:0xSAFE')?.label).toBe('Safe on mainnet')
    })

    it('returns undefined for an unlisted scope', () => {
      const tf = loadTeamFile(VALID)
      expect(tf.resolve('cosign', 'unknown')).toBeUndefined()
    })

    it('returns undefined for a mismatched namespace', () => {
      const tf = loadTeamFile(VALID)
      expect(tf.resolve('other', 'wonderland')).toBeUndefined()
    })

    it('a "*" team entry matches any scope under the namespace', () => {
      const tf = loadTeamFile({ ...VALID, teams: [{ scope: '*', label: 'all' }] })
      expect(tf.resolve('cosign', 'anything')?.scope).toBe('*')
    })
  })

  describe('clampDays', () => {
    it('clamps days above windowDays down to windowDays', () => {
      const tf = loadTeamFile(VALID)
      expect(tf.clampDays(30)).toBe(7)
    })
    it('keeps a valid days within the window', () => {
      const tf = loadTeamFile(VALID)
      expect(tf.clampDays(3)).toBe(3)
    })
    it('floors days to at least 1 (and defaults when missing/NaN)', () => {
      const tf = loadTeamFile(VALID)
      expect(tf.clampDays(0)).toBe(1)
      expect(tf.clampDays(Number.NaN)).toBe(7)
      expect(tf.clampDays(undefined)).toBe(7)
    })
  })
})

it('loadTeamFile reads from a JSON file path', async () => {
  const { writeFileSync, mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'cosign-tf-'))
  const path = join(dir, 'team.json')
  writeFileSync(path, JSON.stringify({ ...VALID, resolve: undefined, clampDays: undefined }))
  const tf = loadTeamFile(path)
  expect(tf.resolve('cosign', 'wonderland')?.scope).toBe('wonderland')
})
