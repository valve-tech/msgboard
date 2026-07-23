// Off-chain circom -> PLONK proving harness, reusable across circuits.
//
// Pipeline per circuit: circom compile (r1cs + wasm) -> `plonk setup` against the REAL
// universal Hermez powers-of-tau (downloaded + integrity-checked, cached under build/) ->
// zkey -> prove(input) / verify(proof, publicSignals).
//
// WHY PLONK (and why there is no ceremony machinery in this file anymore):
// Groth16 requires a PER-CIRCUIT phase-2 ceremony that must be re-run on EVERY circuit
// change. This package used to fake that phase-2 with a fixed public dev beacon, which made
// the toxic waste effectively public — i.e. anyone could forge a winning proof and drain the
// house. PLONK consumes the SAME universal ptau for any circuit and has NO per-circuit setup,
// so `plonk setup` below IS the complete setup: there is no contribute/beacon step to get
// wrong, and no toxic waste to leak. The dev-beacon apparatus is gone for good.
//
// The one remaining trust assumption is the Hermez ptau itself — a real, audited multi-party
// perpetual-powers-of-tau ceremony output, trusted here as such (we do not generate it).

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// snarkjs ships no type declarations; treat it as `any`.
// eslint-disable-next-line @typescript-eslint/no-var-requires
import * as snarkjs from 'snarkjs'

type PlonkProof = any
type PublicSignals = string[]

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export const PACKAGE_ROOT = path.resolve(__dirname, '..')
export const CIRCUITS_DIR = path.join(PACKAGE_ROOT, 'circuits')
export const BUILD_DIR = path.join(PACKAGE_ROOT, 'build')
// circom's -l include root: npm hoists circomlib to the monorepo root, but a local install (or a
// standalone checkout) keeps it in the package's own node_modules — prefer local, fall back to root.
const localNodeModules = path.join(PACKAGE_ROOT, 'node_modules')
export const NODE_MODULES_DIR = existsSync(path.join(localNodeModules, 'circomlib'))
  ? localNodeModules
  : path.resolve(PACKAGE_ROOT, '../../node_modules')

/**
 * The universal ptau power every circuit in this package uses. PLONK's domain is the next
 * power of two >= (constraints + public inputs), and PLONK expands a circuit relative to its
 * R1CS constraint count, so this is sized for the largest circuit:
 *
 *   sudoku_solve  22,948 R1CS -> 34,245 PLONK constraints -> 2^16 domain  (overflows 2^15)
 *   wordle_solve   ~4.4k R1CS -> well under 2^16
 *   wordle_clue    ~1.5k R1CS -> well under 2^16
 *
 * A LARGER ptau works fine for a smaller circuit, so all three share this one file. If a
 * circuit ever outgrows it, bump to the next Hermez power (18, 20, ...) and update the URL +
 * digest below — the Hermez ptau is universal, so that is the ONLY change required: still no
 * per-circuit ceremony.
 */
export const HERMEZ_PTAU_POWER = 16
const HERMEZ_PTAU_FILE = `powersOfTau28_hez_final_${HERMEZ_PTAU_POWER}.ptau`
const HERMEZ_PTAU_URL = `https://storage.googleapis.com/zkevm/ptau/${HERMEZ_PTAU_FILE}`
/**
 * blake2b-512 of the Hermez ptau, as PUBLISHED BY iden3/snarkjs for power 16:
 *   https://github.com/iden3/snarkjs#7-prepare-phase-2  ("powersOfTau28_hez_final_16.ptau")
 * Verified to match our cached file byte-for-byte.
 *
 * Why blake2b and not a digest of our own choosing: this is the algorithm the ceremony's
 * maintainers publish, so matching it corroborates — against an INDEPENDENT source — that this
 * file is the genuine artifact, not merely that our copy is internally consistent. Checking it
 * on every call means neither a corrupted cache nor a substituted re-download can silently swap
 * the setup out from under the committed verifiers.
 *
 * What this does NOT prove: that the ceremony itself was honest (i.e. that at least one of its 54
 * contributors destroyed their toxic waste). That remains the documented trust assumption above —
 * it is a property of the ceremony, not of the bytes, and no digest can settle it.
 *
 * Separately VERIFIED (2026-07-15): `snarkjs powersoftau verify` was run to completion on this file
 * and returned `Powers of Tau Ok!` (exit 0), cryptographically re-deriving the whole chain — 55
 * contributions: 54 named (weijie #1 .. jarrad #54) plus an unnamed final beacon (#55). So the file
 * is both the genuine published artifact (digest above) AND internally sound. To reproduce:
 *
 *   node node_modules/snarkjs/build/cli.cjs powersoftau verify \
 *     build/powersOfTau28_hez_final_16.ptau -v
 *
 * READ THIS BEFORE YOU RUN IT, or you will kill it thinking it hung (we did, twice):
 *   - It takes on the order of an HOUR, not minutes. Despite the header logging "power: 2**16",
 *     snarkjs hashes the first challenge over the CEREMONY power (2**28 — the original Hermez
 *     ceremony this file is truncated from), which is ~1.34e9 hash iterations, and only THEN
 *     starts checking the contribution chain.
 *   - `-v` is NOT optional for a human: without it the command prints NOTHING at all until it
 *     finishes, which is indistinguishable from a hang. With `-v` it logs steady progress.
 *   - Don't pipe it through `tail`/`head` while watching — that buffers and re-creates the same
 *     "silent hang" illusion. Redirect to a file and tail the file.
 */
const HERMEZ_PTAU_BLAKE2B =
  '6a6277a2f74e1073601b4f9fed6e1e55226917efb0f0db8a07d98ab01df1ccf4' +
  '3eb0e8c3159432acd4960e2f29fe84a4198501fa54c8dad9e43297453efec125'

function circomBin(): string {
  return process.env.CIRCOM_BIN ?? 'circom'
}

function sh(cmd: string, args: string[]) {
  execFileSync(cmd, args, { stdio: 'pipe' })
}

/** blake2b-512 of a file, streamed so the ~76MB ptau never lands in memory whole. */
function blake2bFile(p: string): string {
  const h = createHash('blake2b512')
  const fd = openSync(p, 'r')
  try {
    const buf = Buffer.alloc(1 << 20)
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null)
      if (n === 0) break
      h.update(buf.subarray(0, n))
    }
  } finally {
    closeSync(fd)
  }
  return h.digest('hex')
}

export interface CompiledCircuit {
  name: string
  r1csPath: string
  wasmPath: string
}

/** Compile circuits/<name>.circom -> build/<name>/{name}.r1cs + wasm (cached). */
export function compileCircuit(name: string): CompiledCircuit {
  const outDir = path.join(BUILD_DIR, name)
  const r1csPath = path.join(outDir, `${name}.r1cs`)
  const wasmPath = path.join(outDir, `${name}_js`, `${name}.wasm`)
  if (!existsSync(r1csPath) || !existsSync(wasmPath)) {
    mkdirSync(outDir, { recursive: true })
    const circuitPath = path.join(CIRCUITS_DIR, `${name}.circom`)
    sh(circomBin(), [circuitPath, '--r1cs', '--wasm', '--sym', '-l', NODE_MODULES_DIR, '-o', outDir])
  }
  return { name, r1csPath, wasmPath }
}

/**
 * The REAL universal Hermez powers-of-tau, cached under build/ (fetched on first use, then
 * integrity-checked against HERMEZ_PTAU_BLAKE2B on EVERY call — including cache hits, so a
 * corrupted cache is caught rather than silently used).
 *
 * This is a plain fetch of a published ceremony artifact — there is deliberately no local
 * `powersoftau new/contribute/beacon/prepare phase2` path. Generating our own would recreate
 * exactly the knowable-toxic-waste problem PLONK is here to eliminate.
 */
export function ensurePtau(): string {
  const ptauPath = path.join(BUILD_DIR, HERMEZ_PTAU_FILE)
  if (!existsSync(ptauPath)) {
    mkdirSync(BUILD_DIR, { recursive: true })
    // eslint-disable-next-line no-console
    console.log(`[harness] fetching ${HERMEZ_PTAU_URL} (~76MB, once)...`)
    sh('curl', ['-fsSL', '-o', ptauPath, HERMEZ_PTAU_URL])
  }
  const got = blake2bFile(ptauPath)
  if (got !== HERMEZ_PTAU_BLAKE2B) {
    throw new Error(
      `harness: ${HERMEZ_PTAU_FILE} failed its integrity check (blake2b ${got}, expected the ` +
        `iden3/snarkjs-published ${HERMEZ_PTAU_BLAKE2B}). Refusing to run a setup against an ` +
        `unverified ptau — delete ${ptauPath} to re-fetch it from ${HERMEZ_PTAU_URL}.`,
    )
  }
  return ptauPath
}

export interface CircuitSetup {
  name: string
  wasmPath: string
  zkeyPath: string
  vkey: object
}

/**
 * `plonk setup` for a compiled circuit against the universal Hermez ptau (cached).
 *
 * This is the COMPLETE setup. Unlike groth16, there is no phase-2 contribution/beacon step —
 * PLONK derives the circuit's proving/verifying key deterministically from the universal ptau,
 * so this function has no entropy of its own and nothing to leak.
 */
export function setupCircuit(name: string): CircuitSetup {
  const { r1csPath, wasmPath } = compileCircuit(name)
  const ptauPath = ensurePtau()
  const outDir = path.join(BUILD_DIR, name)
  const zkeyPath = path.join(outDir, `${name}_plonk.zkey`)
  const vkeyPath = path.join(outDir, `${name}_plonk_vkey.json`)
  const bin = path.join(NODE_MODULES_DIR, '.bin', 'snarkjs')
  if (!existsSync(zkeyPath)) {
    sh(bin, ['plonk', 'setup', r1csPath, ptauPath, zkeyPath])
  }
  if (!existsSync(vkeyPath)) {
    sh(bin, ['zkey', 'export', 'verificationkey', zkeyPath, vkeyPath])
  }
  const vkey = JSON.parse(readFileSync(vkeyPath, 'utf8')) as object
  return { name, wasmPath, zkeyPath, vkey }
}

export type CircuitInput = Record<string, unknown>

/** Runs witness generation + PLONK prove. Throws if a constraint fails. */
export async function prove(
  setup: CircuitSetup,
  input: CircuitInput,
): Promise<{ proof: PlonkProof; publicSignals: PublicSignals }> {
  const { proof, publicSignals } = await snarkjs.plonk.fullProve(input, setup.wasmPath, setup.zkeyPath)
  return { proof, publicSignals }
}

export async function verify(
  setup: CircuitSetup,
  publicSignals: PublicSignals,
  proof: PlonkProof,
): Promise<boolean> {
  return snarkjs.plonk.verify(setup.vkey, publicSignals, proof)
}

/**
 * The 24 field elements of a PLONK proof, in the exact order the generated Solidity
 * `verifyProof(uint256[24] _proof, uint256[N] _pubSignals)` expects — i.e. snarkjs's own
 * `plonk.exportSolidityCallData` order. Deriving it from that function (rather than hand-packing
 * proof.A/proof.B/...) is what keeps the fixture and the on-chain verifier from drifting.
 */
export async function proofToCalldata(
  proof: PlonkProof,
  publicSignals: PublicSignals,
): Promise<string[]> {
  const calldata: string = await snarkjs.plonk.exportSolidityCallData(proof, publicSignals)
  const fields = (calldata.match(/0x[0-9a-fA-F]+/g) ?? []).map((h) => BigInt(h).toString())
  const expected = 24 + publicSignals.length
  if (fields.length !== expected) {
    throw new Error(
      `harness: expected ${expected} calldata fields (24 proof + ${publicSignals.length} public), got ${fields.length}`,
    )
  }
  return fields.slice(0, 24)
}

/**
 * Export the generated PLONK Solidity verifier for a zkey, renamed to `contractName` (snarkjs
 * always emits `contract PlonkVerifier`, which would collide across circuits and with the
 * vendored uzkge PlonkVerifier). Returns the source; callers write it next to the fixture they
 * generate from the SAME zkey in the SAME pass — see the generator scripts.
 */
export function exportSolidityVerifier(
  setup: CircuitSetup,
  contractName: string,
  header: string,
): string {
  const bin = path.join(NODE_MODULES_DIR, '.bin', 'snarkjs')
  const raw = path.join(BUILD_DIR, setup.name, `${contractName}.raw.sol`)
  execFileSync(bin, ['zkey', 'export', 'solidityverifier', setup.zkeyPath, raw], { stdio: 'pipe' })
  let sol = readFileSync(raw, 'utf8')
  sol = sol.replace(/contract\s+PlonkVerifier\b/, `contract ${contractName}`)
  // drop snarkjs's leading SPDX line so our header's SPDX is the only one
  sol = sol.replace(/^\/\/ SPDX-License-Identifier:[^\n]*\n/, '')
  return header + sol
}

/** Write `contents` to `outPath`, creating parents. */
export function writeGenerated(outPath: string, contents: string) {
  mkdirSync(path.dirname(outPath), { recursive: true })
  writeFileSync(outPath, contents)
  // eslint-disable-next-line no-console
  console.log(`[gen] wrote ${outPath}`)
}
