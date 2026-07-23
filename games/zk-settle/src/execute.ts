import { Noir, type InputMap } from '@noir-lang/noir_js'
import type { Compiled } from './compile'

export type AbiValue = string | string[] | AbiValue[]

/**
 * Execute a compiled circuit to its witness and decode the ABI return value
 * (noir_js, no proving). The GATE parity tests assert the circuit's COMPUTATION
 * equals viem's; `execute` exercises exactly that constraint system (the same
 * witness `prove` would feed to bb.js) without the multi-second UltraHonk prove
 * per vector. The full prove+verify path is covered by the toolchain GATE and
 * the settle tests (Task 4+); one prove is also asserted here.
 *
 * `returnValue` mirrors the circuit's `-> pub (...)` shape: tuples become nested
 * arrays, `[u8; N]` becomes an array of 1-byte field hex strings, and scalars
 * (u64) become a single field hex string.
 */
export async function execute(c: Compiled, inputs: InputMap): Promise<AbiValue> {
  const noir = new Noir(c.program)
  const { returnValue } = await noir.execute(inputs)
  return returnValue as AbiValue
}
