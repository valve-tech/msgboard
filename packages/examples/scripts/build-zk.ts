/**
 * build-zk — compile the membership circuit and run a DEV/TEST-ONLY trusted setup,
 * then generate the committed verification key + proof fixtures.
 *
 *   1. circom compile  → r1cs + wasm witness generator
 *   2. powers of tau    → deterministic phase-1 via `powersoftau beacon` (NOT contribute)
 *   3. groth16 setup    → deterministic phase-2 via `zkey beacon`
 *   4. export vkey      → zk/verification_key.json (committed)
 *   5. fixtures         → real proofs for members + an outsider (committed test vectors)
 *
 * WHY A BEACON, NOT `contribute`: `snarkjs ... contribute` mixes in OS randomness even
 * with a fixed entropy string, so the resulting zkey/vkey are NOT reproducible. A fixed
 * public `beacon` hash makes the whole setup deterministic — anyone can re-run this and
 * get the SAME verification key. The tradeoff is that the beacon (and thus the toxic
 * waste) is PUBLIC, so these keys are forgeable and DEV/TEST-ONLY. A real deployment
 * needs a genuine multi-party ceremony. See docs/zk-msgboard.md.
 *
 * Run: npm run zk:build --workspace=packages/examples
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { toHex } from 'viem'
import { buildGroup, proveMembership, type ZkIdentity } from '../src/zk-msgboard.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = resolve(HERE, '..')
const ROOT = resolve(PKG, '..', '..')
const ZK = resolve(PKG, 'zk')
const BUILD = resolve(ZK, 'build')
const FIXTURES = resolve(ZK, 'fixtures')
const CIRCUIT = resolve(PKG, 'circuits', 'membership.circom')
const CIRCOMLIB = resolve(ROOT, 'node_modules', 'circomlib', 'circuits')
const SNARKJS = resolve(ROOT, 'node_modules', '.bin', 'snarkjs')

// A PUBLIC, well-known beacon — this is what makes the setup DEV-only and reproducible.
const BEACON = 'deadbeef'.repeat(8) // 32 bytes / 64 hex chars — a public, well-known value
const POWER = '13' // 2^13 = 8192 > ~3163 constraints

const run = (cmd: string, args: string[]): void => {
  console.log(`\n$ ${cmd} ${args.join(' ')}`)
  execFileSync(cmd, args, { stdio: 'inherit' })
}
const snarkjs = (...args: string[]): void => run(SNARKJS, args)

const wasmPath = resolve(BUILD, 'membership_js', 'membership.wasm')
const zkeyPath = resolve(BUILD, 'membership_final.zkey')

const compileAndSetup = (): void => {
  mkdirSync(BUILD, { recursive: true })

  // 1. compile
  run('circom', [CIRCUIT, '--r1cs', '--wasm', '-l', CIRCOMLIB, '-o', BUILD])

  // 2. phase 1 — deterministic powers of tau
  const pot0 = resolve(BUILD, 'pot_0.ptau')
  const potBeacon = resolve(BUILD, 'pot_beacon.ptau')
  const potFinal = resolve(BUILD, 'pot_final.ptau')
  snarkjs('powersoftau', 'new', 'bn128', POWER, pot0, '-v')
  snarkjs('powersoftau', 'beacon', pot0, potBeacon, BEACON, '10', '-n=dev beacon phase1')
  snarkjs('powersoftau', 'prepare', 'phase2', potBeacon, potFinal, '-v')

  // 3. phase 2 — deterministic groth16 setup
  const zkey0 = resolve(BUILD, 'membership_0.zkey')
  snarkjs('groth16', 'setup', resolve(BUILD, 'membership.r1cs'), potFinal, zkey0)
  snarkjs('zkey', 'beacon', zkey0, zkeyPath, BEACON, '10', '-n=dev beacon phase2')

  // 4. export the verification key (committed)
  snarkjs('zkey', 'export', 'verificationkey', zkeyPath, resolve(ZK, 'verification_key.json'))
}

const generateFixtures = async (): Promise<void> => {
  mkdirSync(FIXTURES, { recursive: true })
  const scope = 'zkarchive'

  // The recognized group — three members with fixed secrets so the root is stable.
  const members: ZkIdentity[] = [
    { nullifier: 111n, trapdoor: 222n },
    { nullifier: 333n, trapdoor: 444n },
    { nullifier: 555n, trapdoor: 666n },
  ]
  const { group, tree } = await buildGroup(members)

  const memberPost = await proveMembership({ identity: members[0], tree, index: 0, payload: toHex('gm from an anonymous member'), scope, wasmPath, zkeyPath })
  const member2Post = await proveMembership({ identity: members[1], tree, index: 1, payload: toHex('the second member checks in'), scope, wasmPath, zkeyPath })

  // An outsider: a genuine member of a DIFFERENT group. Their proof is a valid Groth16
  // proof, but its Merkle root is not the recognized group's — so the archive rejects it.
  const outsiders: ZkIdentity[] = [
    { nullifier: 777n, trapdoor: 888n },
    { nullifier: 999n, trapdoor: 1010n },
  ]
  const outsiderGroup = await buildGroup(outsiders)
  const outsiderPost = await proveMembership({ identity: outsiders[0], tree: outsiderGroup.tree, index: 0, payload: toHex('let me in — I am in *a* group'), scope, wasmPath, zkeyPath })

  const write = (name: string, value: unknown): void => {
    writeFileSync(resolve(FIXTURES, name), `${JSON.stringify(value, null, 2)}\n`)
    console.log(`wrote zk/fixtures/${name}`)
  }
  write('group.json', group)
  write('member-post.json', memberPost)
  write('member2-post.json', member2Post)
  write('outsider-post.json', outsiderPost)
}

const main = async (): Promise<void> => {
  compileAndSetup()
  await generateFixtures()
  console.log('\nzk build complete: verification_key.json + fixtures regenerated.')
  console.log('(DEV/TEST-ONLY setup — the beacon is public, so these keys are forgeable.)')
  process.exit(0)
}

void main()
