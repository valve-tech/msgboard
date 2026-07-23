import { Noir, type InputMap } from '@noir-lang/noir_js'
import { Barretenberg, UltraHonkBackend } from '@aztec/bb.js'
import type { Compiled } from './compile'

export interface Proof {
  proof: Uint8Array
  publicInputs: string[]
}

/**
 * Execute the circuit to a witness (noir_js), then prove with bb.js UltraHonk.
 *
 * bb.js 4.x: `UltraHonkBackend(bytecode, api)` takes an already-initialized
 * `Barretenberg` instance (NOT a `{threads}` options bag — that older shape is
 * the #1 cause of `this.api.circuitProve is not a function`). We init it
 * single-threaded: under Node/vitest there is no cross-origin-isolated worker
 * pool / SharedArrayBuffer setup for the multi-threaded path. UltraHonk is
 * transparent (no per-circuit trusted setup); bb.js derives/fetches its SRS.
 */
export async function prove(c: Compiled, inputs: InputMap): Promise<Proof> {
  const noir = new Noir(c.program)
  const { witness } = await noir.execute(inputs)
  const api = await Barretenberg.new({ threads: 1 })
  try {
    const backend = new UltraHonkBackend(c.program.bytecode, api)
    const { proof, publicInputs } = await backend.generateProof(witness)
    return { proof, publicInputs }
  } finally {
    await api.destroy()
  }
}
