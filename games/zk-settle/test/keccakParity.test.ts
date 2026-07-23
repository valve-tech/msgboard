import { describe, it, expect, beforeAll } from 'vitest'
import { keccak256, hexToBigInt, toBytes, toHex, type Hex } from 'viem'
import { roundRandom } from '@msgboard/games'
import { roundRandomPreimage } from '../src/abiEncode'
import { compileCircuit, type Compiled } from '../src/compile'
import { execute } from '../src/execute'
import { prove } from '../src/prove'
import { verify } from '../src/verify'

// --- helpers --------------------------------------------------------------

// bytes32 hex -> [u8; 32] field-hex array for the circuit ABI.
const bytes32ToU8 = (h: Hex): string[] =>
  Array.from(toBytes(h, { size: 32 })).map((b) => '0x' + b.toString(16))

// [u8;32] field-hex array (circuit output) -> 0x-prefixed 32-byte hex.
const recompose = (arr: string[]): Hex =>
  toHex(Uint8Array.from(arr.map((h) => Number(BigInt(h)))))

// Decode the keccakProbe return value: (seedCommit, rBytes, roll, u).
function decodeProbe(rv: unknown) {
  const [seedCommitArr, rArr, rollHex, uHex] = rv as [string[], string[], string, string]
  return {
    seedCommit: recompose(seedCommitArr),
    rBytes: recompose(rArr),
    roll: BigInt(rollHex),
    u: BigInt(uHex),
  }
}

const probeInputs = (serverSeed: Hex, clientSeed: Hex) => ({
  serverSeed: bytes32ToU8(serverSeed),
  clientSeed: bytes32ToU8(clientSeed),
})

// --- fixed parity vectors -------------------------------------------------

const V = {
  serverSeed: ('0x' + '11'.repeat(32)) as Hex,
  clientSeed: ('0x' + '22'.repeat(32)) as Hex,
}

// Three additional fixed vectors for the table-driven r parity check.
const VECTORS: { label: string; serverSeed: Hex; clientSeed: Hex }[] = [
  { label: 'repeated bytes', serverSeed: ('0x' + '11'.repeat(32)) as Hex, clientSeed: ('0x' + '22'.repeat(32)) as Hex },
  { label: 'small ints', serverSeed: ('0x' + '01'.padStart(64, '0')) as Hex, clientSeed: ('0x' + '0a'.padStart(64, '0')) as Hex },
  { label: 'mixed', serverSeed: ('0xdeadbeef' + '00'.repeat(28)) as Hex, clientSeed: ('0x' + 'ab'.repeat(32)) as Hex },
]

describe('keccak parity (Task 2 GATE)', () => {
  let c: Compiled
  beforeAll(async () => {
    c = await compileCircuit('test-circuits/keccakProbe')
  }, 120_000)

  it('TS preimage is exactly 96 bytes and viem-keccak-equal to roundRandom', () => {
    const pre = roundRandomPreimage(V.serverSeed, V.clientSeed)
    // 0x + 96 bytes hex
    expect(pre.length).toBe(2 + 96 * 2)
    expect(hexToBigInt(keccak256(pre))).toBe(roundRandom(V.serverSeed, V.clientSeed, 1n))
  })

  it('preimage layout: serverSeed || clientSeed || uint64(1) left-padded to 32', () => {
    const pre = roundRandomPreimage(V.serverSeed, V.clientSeed)
    const b = toBytes(pre)
    expect(b.length).toBe(96)
    expect(toHex(b.slice(0, 32))).toBe(V.serverSeed)
    expect(toHex(b.slice(32, 64))).toBe(V.clientSeed)
    // third word: 24 zero bytes + 8-byte big-endian 1 => only byte 95 set
    expect(toHex(b.slice(64, 96))).toBe('0x' + '00'.repeat(31) + '01')
  })

  it('in-circuit keccak256(serverSeed) == viem keccak256(serverSeed)', async () => {
    const { seedCommit } = decodeProbe(await execute(c, probeInputs(V.serverSeed, V.clientSeed)))
    expect(seedCommit).toBe(keccak256(V.serverSeed))
  })

  it('seedCommit preimage is DISTINCT from r preimage (single bytes32, no abi wrapper)', async () => {
    const { seedCommit, rBytes } = decodeProbe(await execute(c, probeInputs(V.serverSeed, V.clientSeed)))
    // keccak256(serverSeed) must NOT equal keccak256(abi.encode(seed,client,1)).
    expect(seedCommit).not.toBe(rBytes)
    expect(seedCommit).toBe(keccak256(V.serverSeed))
    expect(rBytes).toBe(keccak256(roundRandomPreimage(V.serverSeed, V.clientSeed)))
  })

  it.each(VECTORS)('in-circuit r == viem r for fixed vector: $label', async ({ serverSeed, clientSeed }) => {
    const { rBytes } = decodeProbe(await execute(c, probeInputs(serverSeed, clientSeed)))
    const viemR = roundRandom(serverSeed, clientSeed, 1n)
    // byte-for-byte: circuit's 32 big-endian bytes == viem's 256-bit r
    expect(hexToBigInt(rBytes)).toBe(viemR)
    expect(rBytes).toBe(toHex(viemR, { size: 32 }))
  })

  it('full prove+verify of the keccakProbe circuit succeeds (public outputs sound)', async () => {
    const { proof, publicInputs } = await prove(c, probeInputs(V.serverSeed, V.clientSeed))
    expect(await verify(c, proof, publicInputs)).toBe(true)
    // the seedCommit (first 32 public outputs) is exposed publicly and matches viem
    const seedCommit = recompose(publicInputs.slice(0, 32))
    expect(seedCommit).toBe(keccak256(V.serverSeed))
  }, 120_000)
})
