import { describe, it, expect } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { makeEnvelope, Transcript } from '../src/transcript'

const player = privateKeyToAccount(`0x${'11'.repeat(32)}`)
const house = privateKeyToAccount(`0x${'22'.repeat(32)}`)
const tableId = `0x${'ab'.repeat(32)}` as const

async function build(): Promise<Transcript> {
  const t = new Transcript(tableId)
  const e0 = await makeEnvelope(player, tableId, 0, t.head, 'OPEN', { stake: 100 })
  t.append(e0)
  const e1 = await makeEnvelope(house, tableId, 1, t.head, 'ROUND', { round: 1 })
  t.append(e1)
  return t
}

describe('Transcript', () => {
  it('verifies a well-formed transcript', async () => {
    const t = await build()
    expect(await t.verify({ player: player.address, house: house.address })).toBe(true)
  })

  it('survives a board outage: toJSON -> fromJSON re-derives the head', async () => {
    const t = await build()
    const restored = Transcript.fromJSON(t.toJSON())
    expect(restored.head).toBe(t.head)
    expect(await restored.verify({ player: player.address, house: house.address })).toBe(true)
  })

  it('rejects a chain break', async () => {
    const t = new Transcript(tableId)
    const e0 = await makeEnvelope(player, tableId, 0, t.head, 'OPEN', {})
    t.append(e0)
    const bad = await makeEnvelope(house, tableId, 1, `0x${'99'.repeat(32)}`, 'ROUND', {})
    expect(() => t.append(bad)).toThrow()
  })
})
