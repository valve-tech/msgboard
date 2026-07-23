import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { Noir } from '@noir-lang/noir_js'
import { Barretenberg, UltraHonkBackend } from '@aztec/bb.js'
import { compileCircuit } from '../src/compile'
import { diceOnchainInputs, diceOnchainPublics, type DiceOnchainRound } from '../src/diceSettleOnchain'

/**
 * Reproducible generator for the M2 (Track-2, Milestone 2) ON-CHAIN UltraHonk
 * verifier + a Foundry proof fixture.
 *
 * What it does (all in pure JS via bb.js 4.3.1 — no native `bb`/`nargo` binary):
 *   1. Compile the diceSettleOnchain Noir circuit (noir_wasm).
 *   2. Generate a REAL UltraHonk proof for a known dice-WIN round with the EVM
 *      verifier target (`verifierTarget: 'evm'` => keccak oracle hash, the
 *      flavour the Solidity verifier checks). First prove fetches the SRS from
 *      crs.aztec.network into ~/.bb-crs (cached thereafter).
 *   3. Compute the matching verification key and export the Solidity verifier
 *      contract via `UltraHonkBackend.getSolidityVerifier(vk)`.
 *   4. Vendor the verifier into packages/contracts and write the proof fixture
 *      (proof bytes + the 68 public-input field elements + the human-readable
 *      round) into the foundry test tree.
 *
 * Run:  pnpm --filter @msgboard/zk-settle gen:onchain-verifier
 * (a `vitest run` wrapper invokes this so it shares the workspace's bb.js setup.)
 *
 * The EVM verifier target is non-negotiable: a poseidon-flavoured proof (the
 * default off-chain flavour used by M1's prove.ts) will NOT verify against the
 * Solidity contract. We pin 'evm' here and assert the proof verifies in-process
 * before writing the fixture, so a broken toolchain fails loudly at generation
 * rather than silently shipping a fixture the contract rejects.
 */

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, '..')
const repoRoot = resolve(pkgRoot, '../..')

// A known dice-WIN round at target 5000 (== the diceSettle.test.ts WIN vector:
// serverSeed 0x..01, clientSeed 0x..08 -> roll 485 < 5000 -> win). Escrows sized
// so the pot exactly covers the win payout (escrow ceiling met), matching the
// SettleWithSeeds.t.sol convention.
const b32 = (n: bigint) => ('0x' + n.toString(16).padStart(64, '0')) as `0x${string}`
const ROUND: DiceOnchainRound = {
  serverSeed: b32(1n),
  clientSeed: b32(8n),
  targetX100: 5000n,
  escrowPlayer: 1000n, // stake
  // dice@5000: multX100 = 9900*10000/5000/100 = 198 -> payout = 1000*198/100 = 1980.
  // pot must be >= 1980; set escrowHouse so pot == 1980 (ceiling exactly met).
  escrowHouse: 980n,
}

async function main() {
  console.log('[gen] compiling diceSettleOnchain circuit...')
  const compiled = await compileCircuit('test-circuits/diceSettleOnchain')

  console.log('[gen] executing witness...')
  const noir = new Noir(compiled.program)
  const inputs = diceOnchainInputs(ROUND)
  const { witness } = await noir.execute(inputs)

  const api = await Barretenberg.new({ threads: 1 })
  try {
    const backend = new UltraHonkBackend(compiled.program.bytecode, api)

    console.log('[gen] generating EVM (keccak) UltraHonk proof — first run fetches SRS...')
    const { proof, publicInputs } = await backend.generateProof(witness, { verifierTarget: 'evm' })

    console.log('[gen] verifying proof in-process (sanity gate)...')
    const ok = await backend.verifyProof({ proof, publicInputs }, { verifierTarget: 'evm' })
    if (!ok) throw new Error('generated EVM proof failed in-process verify — aborting')

    console.log('[gen] computing verification key...')
    const vk = await backend.getVerificationKey({ verifierTarget: 'evm' })

    console.log('[gen] exporting Solidity verifier...')
    const solidity = await backend.getSolidityVerifier(vk, { verifierTarget: 'evm' })

    // --- write the verifier into packages/contracts (vendored, generated) ---
    const verifierDir = resolve(repoRoot, 'games/contracts/contracts/zk/generated')
    mkdirSync(verifierDir, { recursive: true })
    const verifierPath = resolve(verifierDir, 'DiceSettleHonkVerifier.sol')
    // bb names the contract `HonkVerifier`; keep that (the channel imports it by
    // that symbol). Prepend a provenance banner so it is obviously generated.
    const banner = [
      '// SPDX-License-Identifier: UNLICENSED',
      '// GENERATED FILE — DO NOT EDIT BY HAND.',
      '// Source: examples/games/zk-settle/test-circuits/diceSettleOnchain (Noir 1.0.0-beta.20)',
      '// Regenerate: pnpm --filter @msgboard/zk-settle gen:onchain-verifier',
      '// bb.js 4.3.1 UltraHonkBackend.getSolidityVerifier (verifierTarget: evm => keccak).',
      '',
    ].join('\n')
    // bb's output already carries its own SPDX/pragma; strip a leading SPDX line
    // to avoid a duplicate, then prepend our banner (keep bb's pragma + code).
    let body = solidity.replace(/^\s*\/\/ SPDX-License-Identifier:[^\n]*\n/, '')
    // Pragma normalization (reproducible, documented): bb.js 4.3.1 pins the
    // verifier body at `^0.8.27`. The verifier uses `require(cond, CustomError())`
    // (custom errors in require), a solc 0.8.26+ feature, so it genuinely needs a
    // newer compiler than the games' pinned 0.8.25. We relax the CEILING (drop the
    // `^`, which would forbid 0.8.28+) to a FLOOR `>=0.8.26` so the dedicated
    // `zkverify` Foundry profile (solc 0.8.27, evm_version shanghai — still
    // pre-cancun: no MCOPY/TSTORE emitted) can compile it. This touches only the
    // version range, never verification logic. The games + HouseChannel keep solc
    // 0.8.25 in the default profile; the verifier compiles ONLY in `zkverify`.
    body = body.replace(/pragma solidity \^0\.8\.27;/g, 'pragma solidity >=0.8.26;')
    writeFileSync(verifierPath, banner + body)
    console.log(`[gen] wrote ${verifierPath} (${(body.length / 1024).toFixed(1)} KiB)`) // eslint-disable-line

    // --- write the Foundry fixture ---
    const pubs = diceOnchainPublics(ROUND)
    const toHex = (u: Uint8Array) => '0x' + Buffer.from(u).toString('hex')
    const fixture = {
      _comment:
        'GENERATED by examples/games/zk-settle/scripts/genOnchainVerifier.ts. A real EVM-flavour ' +
        'UltraHonk proof for a dice-WIN round (target 5000, stake 1000, pot 1980, payout 1980). ' +
        'publicInputs are the 68 field elements in the circuit pub-param order: rngCommit[32], ' +
        'clientSeedCommit[32], targetX100, escrowPlayer, escrowHouse, payoutPlayer.',
      round: {
        serverSeed: ROUND.serverSeed,
        clientSeed: ROUND.clientSeed,
        targetX100: ROUND.targetX100.toString(),
        escrowPlayer: ROUND.escrowPlayer.toString(),
        escrowHouse: ROUND.escrowHouse.toString(),
      },
      publics: {
        rngCommit: pubs.rngCommit,
        clientSeedCommit: pubs.clientSeedCommit,
        targetX100: pubs.targetX100.toString(),
        escrowPlayer: pubs.escrowPlayer.toString(),
        escrowHouse: pubs.escrowHouse.toString(),
        payoutPlayer: pubs.payoutPlayer.toString(),
      },
      numPublicInputs: publicInputs.length,
      publicInputs, // bytes32[] hex strings, verifier order
      proof: toHex(proof),
    }
    const fixtureDir = resolve(repoRoot, 'games/contracts/test/foundry/fixtures')
    mkdirSync(fixtureDir, { recursive: true })
    const fixturePath = resolve(fixtureDir, 'diceSettleOnchainProof.json')
    writeFileSync(fixturePath, JSON.stringify(fixture, null, 2) + '\n')
    console.log(`[gen] wrote ${fixturePath} (proof ${proof.length} bytes, ${publicInputs.length} public inputs)`) // eslint-disable-line
  } finally {
    await api.destroy()
  }
  console.log('[gen] done.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
