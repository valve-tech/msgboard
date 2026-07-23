import { describe, it, expect } from 'vitest'
import * as viem from 'viem'
import { saveSalt, loadSalt, exportBackup, importBackup, type SaltStore } from '../src/model/salts'

const RAFFLE = '0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0' as viem.Hex
const salt = viem.keccak256(viem.toHex('salt-1'))

const makeStore = (): SaltStore => {
  const map = new Map<string, string>()
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  }
}

describe('salt custody', () => {
  it('round-trips a salt record keyed by chain, contract, and ticket', () => {
    const store = makeStore()
    saveSalt(store, 31337, RAFFLE, 7n, { guess: 42n, salt })
    expect(loadSalt(store, 31337, RAFFLE, 7n)).to.deep.equal({ guess: 42n, salt })
    expect(loadSalt(store, 31337, RAFFLE, 8n)).to.equal(null)
    expect(loadSalt(store, 943, RAFFLE, 7n)).to.equal(null) // chain-scoped
  })

  it('export/import backup carries every ticket for a chain+contract and survives a fresh store', () => {
    const store = makeStore()
    saveSalt(store, 31337, RAFFLE, 1n, { guess: 10n, salt })
    saveSalt(store, 31337, RAFFLE, 2n, { guess: 250n, salt: viem.keccak256(viem.toHex('salt-2')) })
    const backup = exportBackup(store, 31337, RAFFLE)
    expect(typeof backup).to.equal('string')

    const fresh = makeStore()
    const imported = importBackup(fresh, backup)
    expect(imported).to.equal(2)
    expect(loadSalt(fresh, 31337, RAFFLE, 2n)?.guess).to.equal(250n)
  })

  it('importBackup rejects garbage without writing anything', () => {
    const store = makeStore()
    expect(() => importBackup(store, 'not-a-backup')).to.throw()
    expect(loadSalt(store, 31337, RAFFLE, 1n)).to.equal(null)
  })
})
