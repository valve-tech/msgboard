import { Barretenberg, UltraHonkBackend } from '@aztec/bb.js'
import type { Compiled } from './compile'

/**
 * Verify an UltraHonk proof against a compiled circuit + claimed public inputs.
 * Given only `{ proof, publicInputs }` - never the witness - so a third party
 * can verify without learning any private datum.
 *
 * bb.js 4.x: `UltraHonkBackend(bytecode, api)` takes a `Barretenberg` instance.
 */
export async function verify(
  c: Compiled,
  proof: Uint8Array,
  publicInputs: string[],
): Promise<boolean> {
  const api = await Barretenberg.new({ threads: 1 })
  try {
    const backend = new UltraHonkBackend(c.program.bytecode, api)
    return await backend.verifyProof({ proof, publicInputs })
  } finally {
    await api.destroy()
  }
}
