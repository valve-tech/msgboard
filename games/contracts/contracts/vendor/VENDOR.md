# Vendored: Zypher uzkge Solidity verifiers

- Upstream: https://github.com/zypher-game/uzkge
- Pinned commit: 2ae729dbc1b003733e47783a9a418a7b8a215fc5 (HEAD as of spike, Jan 2025)
- Copied verbatim from `contracts/solidity/contracts/` — NO local modifications.
- THE PIN IS A CONSENSUS CONSTANT: prover wasm and these verifiers must come from the
  same uzkge commit. Proofs from the npm wasm 0.0.7 are REJECTED by these contracts
  (proven on anvil during the spike). The wasm adapter plan must build
  `wasm-pack build shuffle/wasm --release` from this same commit.
- License: upstream Rust/wasm source is GPL-3.0-only; the npm package claims MIT and
  these Solidity headers say UNLICENSED — a known upstream contradiction. Posture
  signed off 2026-06-12 (msgboard spec addendum 2026-06-12): treat GPL-3.0 as
  governing; acceptable for this non-commercial venue; revisit before any
  monetization. PRE-MAINNET BLOCKERS: regenerate the KZG SRS from a public ceremony
  and re-derive these VerifierKey constants with uzkge's gen-params; get upstream
  license clarification. No audit exists.
- Generated files (VerifierKey_20, VerifierKey_52, VerifierKeyExtra{1,2}_52) come from uzkge's own
  gen-params tooling at the pinned commit.
- Extra sibling files copied to satisfy imports (not in original task list):
  `uzkge/shuffle/ExternalTranscript.sol` (imported by ShuffleVerifier.sol),
  `uzkge/shuffle/VerifierKey_20.sol` (imported by ShuffleVerifier.sol).
