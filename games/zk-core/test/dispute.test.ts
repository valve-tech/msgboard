import { describe, it, expect } from 'vitest'
import { buildEvidence, type DisputeEvidence } from '../src/dispute'
import { Transcript, makeEnvelope } from '../src/transcript'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import type { CoSignedState } from '../src/channel'

const A = privateKeyToAccount(generatePrivateKey())
const tableId = ('0x' + 'ef'.repeat(32)) as `0x${string}`
const coSigned: CoSignedState = {
  state: {
    tableId, nonce: 4n, balanceA: 90n, balanceB: 100n, pot: 10n,
    deckCommitment: ('0x' + '11'.repeat(32)) as `0x${string}`,
    phase: 2, gameStateHash: ('0x' + '22'.repeat(32)) as `0x${string}`,
  },
  sigA: '0xaa', sigB: '0xbb',
}

describe('dispute evidence', () => {
  it('packages latest co-signed state + post-state messages + the demand', async () => {
    const t = new Transcript(tableId)
    t.append(await makeEnvelope(A, tableId, 0, t.head, 'BET_COMMIT', { c: '0x01' }))
    const ev: DisputeEvidence = buildEvidence({
      coSigned, transcript: t, sinceSeq: 0,
      demand: { from: 'B', kind: 'DEAL_SHARE', detail: 'share for slot 9' },
    })
    expect(ev.state.nonce).toBe(4n)
    expect(ev.messages).toHaveLength(1)
    expect(ev.demand.from).toBe('B')
    expect(JSON.parse(ev.serialized).demand.kind).toBe('DEAL_SHARE')
    expect(JSON.parse(ev.serialized).state.nonce).toBe('4')
    expect(ev.transcriptHead).toBe(t.head)
    expect(ev.tableId).toBe(tableId)
  })
  it('refuses to build evidence from a half-signed state', () => {
    expect(() => buildEvidence({
      coSigned: { ...coSigned, sigB: undefined }, transcript: new Transcript(tableId),
      sinceSeq: 0, demand: { from: 'A', kind: 'X', detail: '' },
    })).toThrow(/co-signed/)
  })
  it('rejects sinceSeq out of range', async () => {
    const t = new Transcript(tableId)
    t.append(await makeEnvelope(A, tableId, 0, t.head, 'X', {}))
    expect(() => buildEvidence({
      coSigned, transcript: t, sinceSeq: -1,
      demand: { from: 'A', kind: 'X', detail: '' },
    })).toThrow(/range/)
    expect(() => buildEvidence({
      coSigned, transcript: t, sinceSeq: t.entries.length + 1,
      demand: { from: 'A', kind: 'X', detail: '' },
    })).toThrow(/range/)
  })
})
