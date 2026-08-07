import { expect } from 'chai'
import hre from 'hardhat'

// EIP-170 REGRESSION GUARD.
//
// ZkTable.sol previously exceeded the EIP-170 deployed-contract-code limit (24,576 bytes) once
// the decoy-deck-challenge feature (deckkey-binding-spec.md B5) landed — 24,633 bytes, 57 over —
// which made it undeployable on mainnet (`hardhat ignition deploy` fails outright with
// `allowUnlimitedContractSize:false`, the production setting). The fix was a mechanical,
// zero-behavior-change dedup: `respondWithShare` and `_verifyAndStoreReveal` each carried a
// byte-identical inline `staticcall`+decode block calling the rules contract's
// `revealVerifier()` — collapsed into ONE shared `DeckChallengeLib.verifyReveal` (an EXTERNAL,
// separately-deployed library function ZkTable already links against for `challengeDeck`), which
// took ZkTable down to ~23.3KB — see DeckChallengeLib.sol's `verifyReveal` header and ZkTable.sol's
// `respondWithShare`/`_verifyAndStoreReveal` call sites for the full rationale.
//
// This test is the tripwire so that regression can't silently come back: it reads the compiled
// ZkTable artifact's OWN `deployedBytecode` (not a harness, not an inherited test contract — the
// exact bytes that would actually get deployed on mainnet) and asserts it stays under the limit,
// with an explicit safety-margin ceiling well below the hard limit so a future small addition
// that creeps close to 24,576 fails loudly here instead of surfacing as a mystifying deploy
// failure. Run: cd games/contracts && npx hardhat test test/ZkTableSize.test.ts
describe('ZkTable EIP-170 deployed-size regression guard', function () {
  const EIP170_LIMIT = 24_576
  // Safety-margin ceiling, comfortably below the hard limit (~276+ bytes headroom requested by
  // the original fix; current measured size is ~23,308 bytes, well inside this). Bump this only
  // alongside a deliberate, reviewed size-budget decision — never just to silence a failure.
  const SAFE_MARGIN_CEILING = 24_300

  it('deployed bytecode stays under the EIP-170 limit with a safety margin', async function () {
    const artifact = await hre.artifacts.readArtifact('ZkTable')
    const deployedBytes = (artifact.deployedBytecode.length - 2) / 2 // strip leading "0x", 2 hex chars/byte

    expect(deployedBytes, `ZkTable deployed bytecode is ${deployedBytes} bytes — EIP-170's hard limit is ${EIP170_LIMIT}`)
      .to.be.lessThan(EIP170_LIMIT)
    expect(
      deployedBytes,
      `ZkTable deployed bytecode is ${deployedBytes} bytes — over the ${SAFE_MARGIN_CEILING}-byte safety-margin ceiling ` +
        `(EIP-170's hard limit is ${EIP170_LIMIT}); a change grew ZkTable enough to eat into its deploy headroom. ` +
        `Move more cold-path logic into an external library (see DeckChallengeLib.sol) before this creeps over the hard limit.`,
    ).to.be.lessThan(SAFE_MARGIN_CEILING)
  })
})
