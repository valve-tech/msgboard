import { compile, createFileManager } from '@noir-lang/noir_wasm'
import type { CompiledCircuit } from '@noir-lang/noir_js'
import { fileURLToPath } from 'node:url'
import { dirname, isAbsolute, resolve } from 'node:path'

/**
 * A compiled Noir program in the shape noir_js / bb.js consume.
 * `program` is the `{ abi, bytecode }` artifact (bytecode is base64 ACIR).
 */
export type Compiled = { program: CompiledCircuit }

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, '..')

/**
 * Compile a Noir project (a directory containing `Nargo.toml` + `src/main.nr`)
 * to a CompiledCircuit using the pure-JS `noir_wasm` compiler — no `nargo`
 * binary. `projectDir` may be absolute or relative to the package root.
 *
 * Uses the Node file manager so multi-file `.nr` sources and dependencies load
 * from disk exactly as `nargo` would resolve them.
 */
export async function compileCircuit(projectDir: string): Promise<Compiled> {
  const root = isAbsolute(projectDir) ? projectDir : resolve(pkgRoot, projectDir)
  const fm = createFileManager(root)
  const result = await compile(fm)
  return { program: result.program as unknown as CompiledCircuit }
}
