import { describe, it, expect, beforeAll } from 'vitest'
import { compileCircuit, type Compiled } from '../src/compile'
import { execute } from '../src/execute'
import { prove } from '../src/prove'
import { verify } from '../src/verify'
import { pedersenCommit } from '../src/pedersen'

// MAX_AMOUNT in test-circuits/pedersenRange/src/main.nr. Keep in sync.
const MAX_AMOUNT = 1_000_000_000_000_000n

const u64 = (v: bigint) => '0x' + v.toString(16)
const field = (v: bigint) => '0x' + v.toString(16)

// Fixed (amount, blinding) vectors for the parity check. Distinct magnitudes,
// including amount=1 and amount=MAX_AMOUNT (the range boundary) and a large
// blinding near the bn254 field size, so the parity is not accidental.
const PARITY_VECTORS: { label: string; amount: bigint; blinding: bigint }[] = [
  { label: 'small amount, small blinding', amount: 12345n, blinding: 67890n },
  { label: 'amount = 1 (range floor)', amount: 1n, blinding: 1n },
  { label: 'amount = MAX_AMOUNT (range ceiling)', amount: MAX_AMOUNT, blinding: 999n },
  {
    label: 'mid amount, large blinding',
    amount: 500_000_000_000n,
    blinding: 21888242871839275222246405745257275088548364400416034343698204186575808495616n, // bn254 r - 1
  },
]

describe('Pedersen commitment + range proof (Task 3)', () => {
  let c: Compiled
  beforeAll(async () => {
    c = await compileCircuit('test-circuits/pedersenRange')
  }, 120_000)

  describe('commitment parity: TS (bb.js) == in-circuit', () => {
    it.each(PARITY_VECTORS)(
      'commit($label) agrees between TS and circuit',
      async ({ amount, blinding }) => {
        // in-circuit commitment (the witness the circuit would prove)
        const rv = (await execute(c, { amount: u64(amount), blinding: field(blinding) })) as [
          string,
          string,
        ]
        const circuitX = BigInt(rv[0])
        const circuitY = BigInt(rv[1])

        // TS-side commitment via bb.js (approach a)
        const ts = await pedersenCommit(amount, blinding)

        expect('0x' + ts.x.toString(16)).toBe('0x' + circuitX.toString(16))
        expect('0x' + ts.y.toString(16)).toBe('0x' + circuitY.toString(16))
      },
    )
  })

  describe('range proof: in-range accepts (real prove + verify)', () => {
    it('a value within range proves and verifies, and the public commitment matches the TS one', async () => {
      const amount = 250_000n
      const blinding = 424242n
      const { proof, publicInputs } = await prove(c, { amount: u64(amount), blinding: field(blinding) })
      // the public inputs are the commitment point (x, y)
      expect(publicInputs).toHaveLength(2)
      const [px, py] = publicInputs as [string, string]
      const ts = await pedersenCommit(amount, blinding)
      expect(BigInt(px)).toBe(ts.x)
      expect(BigInt(py)).toBe(ts.y)
      // real verify of the real proof
      expect(await verify(c, proof, publicInputs)).toBe(true)
    }, 120_000)

    it('amount = MAX_AMOUNT (the upper boundary) still proves and verifies', async () => {
      const { proof, publicInputs } = await prove(c, { amount: u64(MAX_AMOUNT), blinding: field(7n) })
      expect(await verify(c, proof, publicInputs)).toBe(true)
    }, 120_000)
  })

  describe('range proof: out-of-range REJECTS (soundness-critical)', () => {
    it('amount = 0 fails to prove (zero/negative wager is rejected)', async () => {
      await expect(prove(c, { amount: u64(0n), blinding: field(1n) })).rejects.toThrow()
    }, 120_000)

    it('amount = MAX_AMOUNT + 1 fails to prove (over-max is rejected)', async () => {
      await expect(prove(c, { amount: u64(MAX_AMOUNT + 1n), blinding: field(1n) })).rejects.toThrow()
    }, 120_000)

    it('a large over-max amount fails to prove (overflow attack is rejected)', async () => {
      const huge = MAX_AMOUNT * 1000n // still < 2^64, so it reaches the assert
      await expect(prove(c, { amount: u64(huge), blinding: field(1n) })).rejects.toThrow()
    }, 120_000)
  })
})
