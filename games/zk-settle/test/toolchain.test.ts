import { describe, it, expect, beforeAll } from 'vitest'
import { compileCircuit, type Compiled } from '../src/compile'
import { prove } from '../src/prove'
import { verify } from '../src/verify'

// test-circuits is a Nargo project whose src/main.nr is:
//   fn main(x: Field, y: pub Field) { assert(x + 1 == y); }
// GATE: this proves the pure-JS Noir pipeline (noir_wasm compile + noir_js
// execute + bb.js UltraHonk prove/verify) stands up in THIS monorepo.
describe('toolchain', () => {
  let compiled: Compiled

  beforeAll(async () => {
    compiled = await compileCircuit('test-circuits')
  })

  it('compiles a .nr via noir_wasm and proves+verifies via noir_js+bb.js', async () => {
    const { proof, publicInputs } = await prove(compiled, { x: '3', y: '4' })
    expect(await verify(compiled, proof, publicInputs)).toBe(true)
  })

  it('rejects a proof whose public input was tampered', async () => {
    const { proof } = await prove(compiled, { x: '3', y: '4' })
    // Claim y = 5 (a different, but well-formed, field element).
    const tampered = ['0x' + (5).toString(16).padStart(64, '0')]
    expect(await verify(compiled, proof, tampered)).toBe(false)
  })

  it('refuses to prove an unsatisfiable witness', async () => {
    // x + 1 == y is violated (3 + 1 != 99) -> execution must throw.
    await expect(prove(compiled, { x: '3', y: '99' })).rejects.toThrow()
  })
})
