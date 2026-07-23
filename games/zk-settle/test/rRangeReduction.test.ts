import { describe, it, expect, beforeAll } from 'vitest'
import { hexToBigInt, toBytes, toHex, type Hex } from 'viem'
import { roundRandom } from '@msgboard/games'
import { compileCircuit, type Compiled } from '../src/compile'
import { execute } from '../src/execute'

// bn254 scalar field modulus (~2^254). r = uint256(keccak256(...)) is a full
// 256-bit value, so any r whose top 2 bits are set EXCEEDS this field. If the
// circuit carried r as a single Field it would wrap modulo p and r % 10_000 /
// r % 1_000_000 would silently change. These vectors prove the reduction is
// done on the WIDE 256-bit value (via the [u8;32] Horner reduction), not on a
// truncated/wrapped field element.
const BN254_R = 21888242871839275222246405745257275088548364400416034343698204186575808495617n

const bytes32ToU8 = (h: Hex): string[] =>
  Array.from(toBytes(h, { size: 32 })).map((b) => '0x' + b.toString(16))

function decodeProbe(rv: unknown) {
  const [, rArr, rollHex, uHex] = rv as [string[], string[], string, string]
  return {
    rBytes: toHex(Uint8Array.from(rArr.map((h) => Number(BigInt(h))))) as Hex,
    roll: BigInt(rollHex),
    u: BigInt(uHex),
  }
}

// Precomputed FIXED vectors whose `r` lands in specific high-bit regions.
// `region` documents which top bits are set; all three have r > BN254_R.
const HIGH_BIT_VECTORS: { label: string; serverSeed: Hex; clientSeed: Hex; topByte: number }[] = [
  {
    label: 'top 2 bits set (r >= 2^255 + 2^254)',
    serverSeed: '0x0000000000000000000000000000000000000000000000076a99b4b1f77dd0fc',
    clientSeed: '0x00000000000000000000000000000000000000000000000936b6928f7c3281ad',
    topByte: 0xe7,
  },
  {
    label: 'MSB (bit 255) set, bit 254 clear',
    serverSeed: '0x0000000000000000000000000000000000000000000000000000000000000000',
    clientSeed: '0x000000000000000000000000000000000000000000000000165667b19e3779f9',
    topByte: 0xb6,
  },
  {
    label: 'bit 254 set (r between 2^254 and 2^255, just over the field)',
    serverSeed: '0x000000000000000000000000000000000000000000000001daa66d2c7ddf743f',
    clientSeed: '0x0000000000000000000000000000000000000000000000025e6e726915b63be6',
    topByte: 0x6b,
  },
]

describe('256-bit r reduction in a 254-bit field (Task 2 GATE)', () => {
  let c: Compiled
  beforeAll(async () => {
    c = await compileCircuit('test-circuits/keccakProbe')
  }, 120_000)

  it('the fixtures genuinely exceed the bn254 field (a Field would wrap)', () => {
    for (const v of HIGH_BIT_VECTORS) {
      const r = roundRandom(v.serverSeed, v.clientSeed, 1n)
      expect(r).toBeGreaterThan(BN254_R)
      expect(Number(r >> 248n)).toBe(v.topByte) // pin the top byte (endianness guard)
      // a naive Field reduction would change at least one of the moduli
      const wrapped = r % BN254_R
      const changes = wrapped % 10000n !== r % 10000n || wrapped % 1000000n !== r % 1000000n
      expect(changes).toBe(true)
    }
  })

  it.each(HIGH_BIT_VECTORS)('circuit roll/u == viem r%10000 / r%1000000 for $label', async ({ serverSeed, clientSeed }) => {
    const { rBytes, roll, u } = decodeProbe(
      await execute(c, { serverSeed: bytes32ToU8(serverSeed), clientSeed: bytes32ToU8(clientSeed) }),
    )
    const viemR = roundRandom(serverSeed, clientSeed, 1n)
    // circuit's wide r bytes equal viem's full 256-bit r
    expect(hexToBigInt(rBytes)).toBe(viemR)
    // the reduction matches the WIDE value, NOT a 254-bit-wrapped one
    expect(roll).toBe(viemR % 10000n)
    expect(u).toBe(viemR % 1000000n)
  })
})
