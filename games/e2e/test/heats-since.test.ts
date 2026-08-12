import { describe, expect, it } from 'vitest'
import * as viem from 'viem'
import { heatsSince, heatsSincePriced, type Deployment } from '../scripts/actor-common'
import type { makePublicClient } from '@msgboard/games-core'

/**
 * Guard against the desync bug fixed in this file: OperatorCoinFlip (validator-forfeit build) heats its
 * OWN `(token, price)` pool ladder, not the shared native/price-0 ladder that CoinFlip/Raffle/
 * CoinFlipTables use. If its `RoundOpened` heats ever leak back into `heatsSince`, the shared price-0
 * slot counter desyncs and every shared-pool game starts casting against the wrong preimage
 * (SecretMismatch). This fixture proves the two counters stay on separate ladders.
 *
 * The chain is stubbed at the `PublicClient` boundary (`getBlockNumber`/`getContractEvents`/
 * `readContract`) that `chunkedEvents` and `heatsSincePriced` read through, so the test is deterministic
 * and makes no network calls.
 */

const COIN_FLIP = '0x1111111111111111111111111111111111111111' as viem.Hex
const RAFFLE = '0x2222222222222222222222222222222222222222' as viem.Hex
const OPERATOR = '0x3333333333333333333333333333333333333333' as viem.Hex
// bytes32 table ids — derived via keccak256 rather than hand-padded hex, so they are always valid
// 32-byte values (a hand-padded literal here previously silently ran 2 bytes short).
const TABLE_A = viem.keccak256(viem.toHex('table-a'))
const TABLE_B = viem.keccak256(viem.toHex('table-b'))
// TABLE_C shares TABLE_A's tierPrice but sits on a DIFFERENT token — the fixture case that exercises
// the token half of the (token, price) filter, not just the price half.
const TABLE_C = viem.keccak256(viem.toHex('table-c'))
const TOKEN_A = '0x4444444444444444444444444444444444444444' as viem.Hex
const TOKEN_B = '0x5555555555555555555555555555555555555555' as viem.Hex
const TOKEN_C = '0x7777777777777777777777777777777777777777' as viem.Hex
const PRICE_A = viem.parseEther('1')
const PRICE_B = viem.parseEther('2')

const K1 = viem.keccak256(viem.toHex('k1'))
const K2 = viem.keccak256(viem.toHex('k2'))
const K3 = viem.keccak256(viem.toHex('k3'))
const K4 = viem.keccak256(viem.toHex('k4'))
const K5 = viem.keccak256(viem.toHex('k5'))
const K6 = viem.keccak256(viem.toHex('k6'))

const heatedLog = (key: viem.Hex, blockNumber: bigint, logIndex: number) => ({
  address: COIN_FLIP,
  args: { key },
  blockNumber,
  logIndex,
})

const roundOpenedLog = (
  key: viem.Hex,
  tableId: viem.Hex,
  tierPrice: bigint,
  blockNumber: bigint,
  logIndex: number,
) => ({
  address: OPERATOR,
  args: { tableId, tierPrice, key },
  blockNumber,
  logIndex,
})

/** A stub PublicClient exposing only the three methods heatsSince/heatsSincePriced read through. */
const fakePublicClient = (params: {
  coinFlipHeated: ReturnType<typeof heatedLog>[]
  operatorRoundOpened: ReturnType<typeof roundOpenedLog>[]
  tables: Record<string, viem.Hex> // tableId -> token
}): ReturnType<typeof makePublicClient> => {
  const client = {
    getBlockNumber: async () => 1_000n,
    getContractEvents: async (args: { address: viem.Hex; eventName: string }) => {
      if (args.address.toLowerCase() === COIN_FLIP.toLowerCase() && args.eventName === 'Heated') {
        return params.coinFlipHeated
      }
      if (args.address.toLowerCase() === OPERATOR.toLowerCase() && args.eventName === 'RoundOpened') {
        return params.operatorRoundOpened
      }
      // Raffle/CoinFlipTables: no fixture logs for this test.
      return []
    },
    readContract: async (args: { functionName: string; args: readonly unknown[] }) => {
      if (args.functionName === 'tables') {
        const tableId = args.args[0] as viem.Hex
        const token = params.tables[tableId]
        if (!token) throw new Error(`no fixture table for ${tableId}`)
        // Table struct tuple: [operator, token, maxMultiplierX100, minStake, maxStake, open]
        return ['0x0000000000000000000000000000000000000000', token, 175, 0n, 0n, true] as const
      }
      throw new Error(`unexpected readContract call: ${args.functionName}`)
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
  return client as ReturnType<typeof makePublicClient>
}

const deployment: Deployment = {
  chainId: 943,
  coinFlip: COIN_FLIP,
  raffle: RAFFLE,
  operatorCoinFlip: OPERATOR,
  random: '0x6666666666666666666666666666666666666666' as viem.Hex,
  canonicalSubset: [],
  poolOffsets: {},
  poolSize: 64,
  deployBlock: '0',
}

describe('heatsSince / heatsSincePriced — slot-counter separation', () => {
  const coinFlipHeated = [heatedLog(K1, 10n, 0), heatedLog(K2, 11n, 0)]
  const operatorRoundOpened = [
    roundOpenedLog(K3, TABLE_A, PRICE_A, 12n, 0),
    roundOpenedLog(K4, TABLE_B, PRICE_B, 13n, 0),
    roundOpenedLog(K5, TABLE_A, PRICE_A, 14n, 0),
    // Same tierPrice as TABLE_A (PRICE_A), but a DIFFERENT token — only the token filter, not the price
    // filter, keeps this out of TOKEN_A's counter.
    roundOpenedLog(K6, TABLE_C, PRICE_A, 15n, 0),
  ]
  const tables = { [TABLE_A]: TOKEN_A, [TABLE_B]: TOKEN_B, [TABLE_C]: TOKEN_C }
  const client = fakePublicClient({ coinFlipHeated, operatorRoundOpened, tables })

  it('heatsSince counts ONLY the shared price-0 CoinFlip heats, never the operator priced heats', async () => {
    const heats = await heatsSince(client, deployment)
    expect(heats.map((h) => h.key)).toEqual([K1, K2])
  })

  it('heatsSincePriced counts ONLY the operator heats for the requested (token, price) tier, chronological', async () => {
    const tierA = await heatsSincePriced(client, deployment, TOKEN_A, PRICE_A)
    expect(tierA.map((h) => h.key)).toEqual([K3, K5])

    const tierB = await heatsSincePriced(client, deployment, TOKEN_B, PRICE_B)
    expect(tierB.map((h) => h.key)).toEqual([K4])
  })

  it('heatsSincePriced returns nothing for a (token, price) tier no round used', async () => {
    const none = await heatsSincePriced(client, deployment, TOKEN_A, viem.parseEther('99'))
    expect(none).toEqual([])
  })

  it('heatsSincePriced discriminates by TOKEN, not just price: a different-token table at the same tierPrice is excluded', async () => {
    const tierA = await heatsSincePriced(client, deployment, TOKEN_A, PRICE_A)
    expect(tierA.map((h) => h.key)).toEqual([K3, K5]) // NOT K6 — K6 is TABLE_C's heat, same price, different token
    expect(tierA.map((h) => h.key)).not.toContain(K6)

    const tierC = await heatsSincePriced(client, deployment, TOKEN_C, PRICE_A)
    expect(tierC.map((h) => h.key)).toEqual([K6])
  })
})
