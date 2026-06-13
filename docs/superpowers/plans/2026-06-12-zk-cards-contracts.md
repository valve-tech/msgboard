# ZK Cards Contracts (`ZkTable` + `HiLoWarRules` + pinned-uzkge verifiers) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The on-chain side of ZK card games — a game-agnostic two-party state-channel contract (`ZkTable`), a Hi-Lo War rules contract that mirrors `@gibs/hilo-war` exactly (parity-fuzzed), and the Zypher uzkge SNARK verifiers vendored from the pinned commit behind a calldata-shaped wrapper — plus the off-chain encoding changes (abi-encoded hashes replacing JSON hashes) that make channel states and game states adjudicable on-chain.

**Architecture:** ForceMove-style channel adjudication. `ZkTable` owns escrow and the dispute clock and knows nothing about any game: it verifies EIP-712 co-signed `ChannelState`s and delegates transition legality to a per-table `IGameRules` contract chosen at create (the joiner accepts it by joining — no owner, no registry governance). Disputes are answered by a higher-nonce co-signed state, by the demanded game move (validated by the rules contract), or by the demanded reveal share (Groth16 snark-reveal verified by the vendored `RevealVerifier` — the CP-DL on-chain path is banned at 15.6M gas, per the spike addendum). Clock expiry forfeits the disputed pot to the disputant and settles balances from the contested co-signed state. The honest path stays three transactions (create, join, settle) and never pays proof-verification gas.

**Tech Stack:** Solidity ^0.8.24 (hardhat 0.8.25 / shanghai for 943-compat, matching existing overrides), OpenZeppelin ^5.2 (EIP712, ECDSA), solady SafeTransferLib (existing pattern), hardhat-toolbox-viem + mocha for unit/parity tests, Foundry fuzz + handler invariants, vendored uzkge contracts at pinned commit `2ae729dbc1b003733e47783a9a418a7b8a215fc5`. TS side: viem `encodeAbiParameters` in `@gibs/hilo-war` and `@gibs/zk-cards-core`.

**Spec:** `docs/superpowers/specs/2026-06-11-zk-card-games-design.md` ("Contracts", "Testing", dispute/edge-case parts of "First build") + `2026-06-12-zk-cards-sdk-spike-addendum.md` (SIGNED OFF 2026-06-12: ≤12s shuffle budget, GPL-3.0 posture accepted). This plan implements contracts + encoding alignment + parity. The Zypher wasm adapter (TS `MaskedDeckProvider` impl), relay/mirror, web, bots, and 943/369 deploys are later plans.

**Where the code lives / git:** `~/Documents/gibs-finance/random`, branch `games-platform`. Commits are unsigned in this repo (`commit.gpgsign false` already set locally). Push with `git push ssh://git@ssh.github.com:443/gibsfinance/random.git games-platform`; on rejection `git fetch && git rebase origin/games-platform` (a concurrent session may push). NO Co-Authored-By trailers. The spike tree `~/Documents/gibs-finance/spike-zk-shuffle/` is local-only source material (uzkge clone + measured artifacts) — never commit the spike itself.

**Conventions that bite:**
- contracts package: `cd packages/contracts && npm run test` (it is npm-scripted inside a pnpm workspace; `pnpm --filter @gibs/contracts...` may not exist — use the package dir). Foundry: `cd packages/contracts && forge test` (src/test = `test/foundry`, libs at `../../lib`, fresh clones need `forge install foundry-rs/forge-std`).
- Custom errors, not require-strings. SPDX `UNLICENSED` for our contracts (repo convention); vendored uzkge files keep their headers verbatim.
- hardhat solc: 0.8.25, viaIR+cancun default, with per-file shanghai overrides for anything deployed to 943/369. Everything new in this plan targets **shanghai, no viaIR** (vendor parity with the spike's measured gas; 943 has no MCOPY/TSTORE).
- TS packages: pnpm, vitest, run from the package dir.

## Design decisions locked by this plan

1. **Chess clock (answers the spec's open item):** `clockBlocks` chosen by the creator at `create`, bounds `MIN_CLOCK_BLOCKS = 30` (~5 min at PulseChain's ~10s blocks) to `MAX_CLOCK_BLOCKS = 60480` (~1 week). Suggested client default 360 (~1 hour). No dispute bond in v1 — the forfeit of the disputed pot is the griefing deterrent; recorded so the decision isn't relitigated. (Execution includes updating the spec's open item.)
2. **No rules registry, no owner.** The rules-contract address is fixed per table at create. Trust-minimized; the spec's "holds verifier and rules addresses per game id" is satisfied per-table (rules contract exposes `gameId()` and holds its verifier addresses as immutables).
3. **Dispute responses are tx-authenticated** (`msg.sender` must be the owing player or their registered channel key) — envelope signatures are NOT adjudicated on-chain in v1, so the transcript JSON-body debt narrows to body payloads the contract never reads. Co-signed **states** are the on-chain objects and they are EIP-712 (reproducible) already.
4. **Deck commitment on-chain format is the SNARK-era format:** `keccak256(abi.encodePacked(uint256[208]))` — 52 cards × 4 words (c1.x, c1.y, c2.x, c2.y). The v0 `AttestedElGamalDeck` (secp256k1) cannot produce on-chain-checkable decks/shares; that's fine — share-disputes are exercisable in tests via the spike's real Groth16 vector, and the Zypher adapter plan makes them reachable from the engine. Record this in code comments.
5. **`HiLoWarRules.applyMove` mirrors `examples/games/hilo-war/src/rules.ts` move-for-move; rules.ts is normative.** The parity fuzz test (Task 7) is the arbiter — if the Solidity in this plan and rules.ts ever disagree, fix the Solidity.
6. **GPL-3.0 posture (signed off 2026-06-12):** vendoring uzkge verbatim is accepted; `VENDOR.md` records the pin, the license contradiction (source GPL-3.0-only / npm "MIT" / Solidity headers `UNLICENSED`), and the pre-mainnet blockers (SRS regeneration from a public ceremony; upstream license clarification).

## File structure

```
packages/contracts/
  contracts/vendor/uzkge/                vendored @ 2ae729db (verbatim; VENDOR.md beside it)
    shuffle/ShuffleVerifier.sol            abstract verifier (extraVk1/extraVk2 ctor)
    shuffle/VerifierKey_52.sol             vk constants loader (416-word PI)
    shuffle/VerifierKeyExtra1_52.sol       ~43KB generated constants
    shuffle/VerifierKeyExtra2_52.sol       ~43KB generated constants
    shuffle/RevealVerifier.sol             CP-DL + Groth16 snark-reveal
    verifier/PlonkVerifier.sol             ~100KB abstract plonk core
    verifier/Groth16Verifier.sol
    verifier/ChaumPedersenDLVerifier.sol
    libraries/{EdOnBN254,BN254,Transcript,ExternalTranscript,BytesLib,Utils}.sol
  contracts/vendor/VENDOR.md             pin + license + provenance record
  contracts/zk/ChannelState.sol          struct + typehash lib (mirrors zk-core stateSig.ts)
  contracts/zk/IGameRules.sol            rules seam interface
  contracts/zk/ShuffleVerifier52.sol     calldata-shaped wrapper (spike Harness pattern)
  contracts/zk/ZkTable.sol               escrow + channel + dispute machine
  contracts/zk/HiLoWarRules.sol          game id 1 rules, mirrors @gibs/hilo-war
  contracts/test/MockGameRules.sol       trivially-permissive rules for ZkTable units
  contracts/test/MockRevealVerifier.sol  toggleable snark-reveal for dispute units
  test/fixtures/zypher-shuffle-head.json copied spike artifacts (proof/pi/pkc)
  test/fixtures/zypher-reveal-snark.json copied canonical Groth16 reveal vector
  test/ZkVerifiers.test.ts               vendored-verifier wiring (fixtures)
  test/ZkChannelSig.test.ts              TS<->Solidity EIP-712 state-hash parity
  test/ZkTable.test.ts                   create/join/cancel/topUp/settle units
  test/ZkTableDispute.test.ts            dispute machine units (incl. real snark share)
  test/HiLoWarRules.test.ts              rules units
  test/HiLoWarParity.test.ts             seeded random-walk TS-vs-Solidity fuzz
  test/foundry/ZkTable.t.sol             fuzz
  test/foundry/ZkTableInvariant.t.sol    handler + ghost accounting invariants
  ignition/modules/ZkCards.ts            verifiers + ZkTable + HiLoWarRules
examples/games/hilo-war/src/encoding.ts  abi encode/hash for HiLoState + Move (NEW)
examples/games/hilo-war/src/rules.ts     hashGameState delegates to encoding (MOD)
examples/games/zk-core/src/transcript.ts abi-structured entryDigest (MOD)
examples/games/zk-core/src/channel.ts    applyTopUp escrow bump (MOD)
examples/games/zk-core/src/stateSig.ts   makeDomain(chainId, addr) helper (MOD)
```

Canonical encodings pinned by this plan (TS and Solidity MUST match; parity tests enforce):

- **Seats:** `0 = none, 1 = A, 2 = B`. **Bets:** `0 = none, 1 = RAISE, 2 = HOLD`.
- **HiLoState abi tuple** (order is law): `(uint8 phase, uint32 deckIndex, uint256 ante, uint256 pot, uint256 warPot, uint256 contributedA, uint256 contributedB, bytes32 commitA, bytes32 commitB, uint8 betA, uint8 betB, uint8 raiser, uint8 resultWinner, uint256 resultAmount, bool resultSet, bool foldedCardHidden)` — `resultSet=false` encodes rules.ts `result: null` (tie/none); absent commitments are `bytes32(0)`.
- **hashGameState = keccak256(abi.encode(<the tuple>))** on both sides.
- **Move encodings** (`abi.encode(uint8 kind, ...)`): `0 DEAL_DONE ()`, `1 BET_COMMIT (uint8 by, bytes32 commitment)`, `2 BET_OPEN (uint8 by, uint8 bet, bytes32 salt)`, `3 CALL (uint8 by)`, `4 FOLD (uint8 by)`, `5 SHOWDOWN (uint8 cardA, uint8 cardB)`. Encoded as `abi.encode(kind, abi.encode(args...))` — kind first, payload as nested bytes.
- **Bet commitment** stays `keccak256(utf8("hilo-war/bet/RAISE/" | "hilo-war/bet/HOLD/") ‖ salt)` — already Solidity-reproducible via `bytes.concat`.
- **Deck encoding (SNARK era):** `uint256[208]`, card i at words `[4i..4i+3]` = (c1.x, c1.y, c2.x, c2.y); `deckCommitment = keccak256(abi.encodePacked(words))`.

---

### Task 1: Vendor uzkge at the pinned commit

**Files:**
- Create: `packages/contracts/contracts/vendor/uzkge/**` (14 .sol files listed above)
- Create: `packages/contracts/contracts/vendor/VENDOR.md`
- Modify: `packages/contracts/hardhat.config.ts` (per-file overrides)

- [ ] **Step 1: Verify the pin and copy the contracts**

```bash
cd ~/Documents/gibs-finance/spike-zk-shuffle/uzkge && git rev-parse HEAD
# MUST print 2ae729dbc1b003733e47783a9a418a7b8a215fc5 — if not, `git checkout 2ae729dbc1b003733e47783a9a418a7b8a215fc5` first
SRC=~/Documents/gibs-finance/spike-zk-shuffle/uzkge/contracts/solidity/contracts
DST=~/Documents/gibs-finance/random/packages/contracts/contracts/vendor/uzkge
mkdir -p $DST/shuffle $DST/verifier $DST/libraries
cp $SRC/shuffle/{ShuffleVerifier,VerifierKey_52,VerifierKeyExtra1_52,VerifierKeyExtra2_52,RevealVerifier}.sol $DST/shuffle/
cp $SRC/verifier/{PlonkVerifier,Groth16Verifier,ChaumPedersenDLVerifier}.sol $DST/verifier/
cp $SRC/libraries/{EdOnBN254,BN254,Transcript,ExternalTranscript,BytesLib,Utils}.sol $DST/libraries/
```

Copy verbatim — no edits, headers untouched. If any of these files imports a sibling not in the list (check compile errors in Step 4), copy that sibling too and add it to VENDOR.md.

- [ ] **Step 2: Write VENDOR.md**

```markdown
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
- Generated files (VerifierKey_52, VerifierKeyExtra{1,2}_52) come from uzkge's own
  gen-params tooling at the pinned commit.
```

- [ ] **Step 3: Add hardhat overrides for the vendor + zk trees**

In `packages/contracts/hardhat.config.ts`, extend the existing `overrides` map (which already pins CoinFlip/GameBase/Raffle to shanghai). Add an entry per new file — same settings for all of them: `{ version: '0.8.25', settings: { viaIR: false, evmVersion: 'shanghai', optimizer: { enabled: true, runs: 200 } } }` for every file under `contracts/vendor/uzkge/` (all 14) and for `contracts/zk/ShuffleVerifier52.sol`. Hardhat override keys are exact file paths — enumerate them. (`runs: 200`, `viaIR: false` reproduce the spike's measured gas and dodge a viaIR compile of the 100KB PlonkVerifier. The other new `contracts/zk/*.sol` files use shanghai too but keep the package default runs — add them with `runs: 1_000` like the games overrides.)

- [ ] **Step 4: Compile**

Run: `cd ~/Documents/gibs-finance/random/packages/contracts && npx hardhat compile`
Expected: compiles clean (warnings from vendored code are acceptable; errors are not). If an import is missing, return to Step 1's sibling rule.

- [ ] **Step 5: Commit**

```bash
git add contracts/vendor hardhat.config.ts
git commit -m "feat(contracts): vendor uzkge verifiers at pinned commit 2ae729db"
```

---

### Task 2: Calldata-shaped wrapper + fixtures + verifier wiring test

**Files:**
- Create: `packages/contracts/contracts/zk/ShuffleVerifier52.sol`
- Create: `packages/contracts/test/fixtures/zypher-shuffle-head.json`
- Create: `packages/contracts/test/fixtures/zypher-reveal-snark.json`
- Test: `packages/contracts/test/ZkVerifiers.test.ts`

- [ ] **Step 1: Copy the spike artifacts into fixtures**

```bash
mkdir -p ~/Documents/gibs-finance/random/packages/contracts/test/fixtures
cp ~/Documents/gibs-finance/spike-zk-shuffle/zypher-artifacts-head.json \
   ~/Documents/gibs-finance/random/packages/contracts/test/fixtures/zypher-shuffle-head.json
```

Then read `~/Documents/gibs-finance/spike-zk-shuffle/gas-zypher-reveal.js` and copy its hardcoded canonical Groth16 reveal vector (the `pi` 6-array and `zkproof` 8-array literals, around lines 26–30) into `test/fixtures/zypher-reveal-snark.json` as `{ "pi": ["0x..", ...6], "zkproof": ["0x..", ...8] }` (decimal strings are fine too — record them exactly as the bench used them).

Also read the shuffle fixture you copied and note its JSON key names for proof/pi/pkc (the bench wrote them; adapt the test below to the actual keys).

- [ ] **Step 2: Write the wrapper (the spike's Harness, production-named)**

```solidity
// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {ShuffleVerifier} from "../vendor/uzkge/shuffle/ShuffleVerifier.sol";
import {VerifierKey_52} from "../vendor/uzkge/shuffle/VerifierKey_52.sol";

/// @notice Calldata-shaped 52-card shuffle verifier: decks come in as calldata
/// (no storage round-trip like uzkge's demo ShuffleService — that pattern costs
/// 2.09M to verify + 4.76M to stage; this one measured 1,569,952 gas in the spike).
/// pi = flatten(before deck, 208 words) ++ flatten(after deck, 208 words);
/// pkc = the 24-word refresh_joint_key output cached with the table's channel state.
contract ShuffleVerifier52 is ShuffleVerifier {
    error InvalidShuffleProof();

    constructor(address vk1, address vk2) ShuffleVerifier(vk1, vk2) {}

    function verify52(bytes calldata proof, uint256[] calldata pi, uint256[] calldata pkc)
        external
        returns (bool ok)
    {
        _verifyKey = VerifierKey_52.load;
        ok = this.verifyShuffle(proof, pi, pkc);
        if (!ok) revert InvalidShuffleProof();
    }
}
```

- [ ] **Step 3: Write the failing test**

```ts
// packages/contracts/test/ZkVerifiers.test.ts
import * as viem from 'viem'
import { expect } from 'chai'
import hre from 'hardhat'
import * as fs from 'node:fs'
import * as path from 'node:path'

const shuffleFx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/zypher-shuffle-head.json'), 'utf8'))
const revealFx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/zypher-reveal-snark.json'), 'utf8'))

describe('vendored zypher verifiers', () => {
  async function deployVerifiers() {
    const vk1 = await hre.viem.deployContract('VerifierKeyExtra1_52' as any, [])
    const vk2 = await hre.viem.deployContract('VerifierKeyExtra2_52' as any, [])
    const shuffle = await hre.viem.deployContract('ShuffleVerifier52' as any, [vk1.address, vk2.address])
    const reveal = await hre.viem.deployContract('RevealVerifier' as any, [])
    return { shuffle, reveal }
  }

  it('verifies the spike shuffle proof end-to-end', async () => {
    const { shuffle } = await deployVerifiers()
    // adapt key names to the fixture: proof (hex), pi (416 uint strings), pkc (24 uint strings)
    const ok = await shuffle.simulate.verify52([
      shuffleFx.proof, shuffleFx.pi.map(BigInt), shuffleFx.pkc.map(BigInt),
    ])
    expect(ok.result).to.equal(true)
  })

  it('rejects a tampered shuffle proof', async () => {
    const { shuffle } = await deployVerifiers()
    const bad = (shuffleFx.proof.slice(0, -2) + (shuffleFx.proof.endsWith('00') ? '01' : '00')) as viem.Hex
    await expect(
      shuffle.simulate.verify52([bad, shuffleFx.pi.map(BigInt), shuffleFx.pkc.map(BigInt)]),
    ).to.be.rejected
  })

  it('verifies the canonical groth16 snark-reveal vector', async () => {
    const { reveal } = await deployVerifiers()
    const ok = await reveal.read.verifyRevealWithSnark([revealFx.pi.map(BigInt), revealFx.zkproof.map(BigInt)])
    expect(ok).to.equal(true)
  })
})
```

If the fixture's shapes differ (e.g. proof stored as byte array, pi nested per-deck), adapt the marshalling in the test — the bench scripts `gas-zypher-head.js` lines 11–50 show exactly how the spike marshalled them; mirror that.

- [ ] **Step 4: Run — expect FAIL (ShuffleVerifier52 not yet compiled / artifact missing), then compile and re-run to PASS**

Run: `cd packages/contracts && npx hardhat test test/ZkVerifiers.test.ts`
Expected: all 3 pass. This proves the vendored verifiers + wrapper verify a REAL proof produced by the pinned wasm — the consensus-constant check.

- [ ] **Step 5: Commit**

```bash
git add contracts/zk/ShuffleVerifier52.sol test/fixtures test/ZkVerifiers.test.ts hardhat.config.ts
git commit -m "feat(contracts): calldata-shaped ShuffleVerifier52 + spike proof fixtures green"
```

---

### Task 3: `@gibs/hilo-war` abi encoding module (kills the JSON `hashGameState`)

**Files:**
- Create: `examples/games/hilo-war/src/encoding.ts`
- Modify: `examples/games/hilo-war/src/rules.ts` (hashGameState delegates; export unchanged)
- Modify: `examples/games/hilo-war/src/index.ts` (re-export encoding)
- Test: `examples/games/hilo-war/test/encoding.test.ts`

- [ ] **Step 1: Read `src/rules.ts` fully first.** It is normative. Note the exact `HiLoState` fields and `Move` kinds — the encoding below maps them 1:1 onto the canonical tuple pinned in the plan header.

- [ ] **Step 2: Write the failing test**

```ts
// examples/games/hilo-war/test/encoding.test.ts
import { describe, it, expect } from 'vitest'
import { encodeGameState, hashGameStateAbi, encodeMove, SEAT, BET } from '../src/encoding'
import { initialFlipState, applyMove, hashGameState } from '../src/rules'

describe('abi encoding', () => {
  const s0 = initialFlipState({ ante: 5n, deckIndex: 0, warPot: 0n })

  it('encodes a fresh flip state deterministically', () => {
    expect(encodeGameState(s0)).toEqual(encodeGameState(initialFlipState({ ante: 5n, deckIndex: 0, warPot: 0n })))
  })

  it('hash changes when any field changes', () => {
    const h0 = hashGameStateAbi(s0)
    expect(hashGameStateAbi({ ...s0, warPot: 1n })).not.toEqual(h0)
    expect(hashGameStateAbi({ ...s0, foldedCardHidden: true })).not.toEqual(h0)
  })

  it('rules.hashGameState IS the abi hash now', () => {
    expect(hashGameState(s0)).toEqual(hashGameStateAbi(s0))
  })

  it('encodes every move kind without throwing', () => {
    expect(encodeMove({ kind: 'DEAL_DONE' })).toMatch(/^0x/)
    expect(encodeMove({ kind: 'BET_COMMIT', by: 'A', commitment: `0x${'11'.repeat(32)}` })).toMatch(/^0x/)
    expect(encodeMove({ kind: 'BET_OPEN', by: 'B', bet: 'HOLD', salt: `0x${'22'.repeat(32)}` })).toMatch(/^0x/)
    expect(encodeMove({ kind: 'CALL', by: 'B' })).toMatch(/^0x/)
    expect(encodeMove({ kind: 'FOLD', by: 'A' })).toMatch(/^0x/)
    expect(encodeMove({ kind: 'SHOWDOWN', cardA: 51, cardB: 0 })).toMatch(/^0x/)
  })

  it('null result encodes as resultSet=false winner=0 amount=0', () => {
    // drive a tie to FLIP_DONE with result null, then check determinism across re-encode
    let s = initialFlipState({ ante: 1n, deckIndex: 0, warPot: 0n })
    // (use applyMove through a hold/hold tie path as rules.test.ts does)
    expect(s.result).toBeNull()
    expect(encodeGameState(s)).toEqual(encodeGameState({ ...s, result: null }))
  })
})
```

- [ ] **Step 3: Run to verify failure** — `cd examples/games/hilo-war && pnpm test test/encoding.test.ts` → FAIL (module not found).

- [ ] **Step 4: Write `src/encoding.ts`**

```ts
import { encodeAbiParameters, keccak256, type Hex } from 'viem'
import type { HiLoState, Move, Seat, Bet } from './rules'

/** Canonical numeric codes shared with HiLoWarRules.sol — order is consensus. */
export const SEAT: Record<Seat, number> = { A: 1, B: 2 }
export const BET: Record<Bet, number> = { RAISE: 1, HOLD: 2 }
const ZERO32 = `0x${'00'.repeat(32)}` as Hex

export const GAME_STATE_ABI = [
  { type: 'uint8' },   // phase
  { type: 'uint32' },  // deckIndex
  { type: 'uint256' }, // ante
  { type: 'uint256' }, // pot
  { type: 'uint256' }, // warPot
  { type: 'uint256' }, // contributedA
  { type: 'uint256' }, // contributedB
  { type: 'bytes32' }, // commitA (0 = absent)
  { type: 'bytes32' }, // commitB
  { type: 'uint8' },   // betA (0 none / 1 RAISE / 2 HOLD)
  { type: 'uint8' },   // betB
  { type: 'uint8' },   // raiser (0 none / 1 A / 2 B)
  { type: 'uint8' },   // resultWinner
  { type: 'uint256' }, // resultAmount
  { type: 'bool' },    // resultSet (false encodes result: null)
  { type: 'bool' },    // foldedCardHidden
] as const

export function encodeGameState(s: HiLoState): Hex {
  return encodeAbiParameters(GAME_STATE_ABI as any, [
    s.phase, s.deckIndex, s.ante, s.pot, s.warPot,
    s.contributed.A, s.contributed.B,
    s.commits.A ?? ZERO32, s.commits.B ?? ZERO32,
    s.bets.A ? BET[s.bets.A] : 0, s.bets.B ? BET[s.bets.B] : 0,
    s.raiser ? SEAT[s.raiser] : 0,
    s.result ? SEAT[s.result.winner] : 0, s.result?.amount ?? 0n, s.result !== null,
    s.foldedCardHidden,
  ])
}

export function hashGameStateAbi(s: HiLoState): Hex {
  return keccak256(encodeGameState(s))
}

const MOVE_KIND = { DEAL_DONE: 0, BET_COMMIT: 1, BET_OPEN: 2, CALL: 3, FOLD: 4, SHOWDOWN: 5 } as const

export function encodeMove(m: Move): Hex {
  const payload = (() => {
    switch (m.kind) {
      case 'DEAL_DONE': return '0x' as Hex
      case 'BET_COMMIT': return encodeAbiParameters([{ type: 'uint8' }, { type: 'bytes32' }], [SEAT[m.by], m.commitment])
      case 'BET_OPEN': return encodeAbiParameters([{ type: 'uint8' }, { type: 'uint8' }, { type: 'bytes32' }], [SEAT[m.by], BET[m.bet], m.salt])
      case 'CALL': return encodeAbiParameters([{ type: 'uint8' }], [SEAT[m.by]])
      case 'FOLD': return encodeAbiParameters([{ type: 'uint8' }], [SEAT[m.by]])
      case 'SHOWDOWN': return encodeAbiParameters([{ type: 'uint8' }, { type: 'uint8' }], [m.cardA, m.cardB])
    }
  })()
  return encodeAbiParameters([{ type: 'uint8' }, { type: 'bytes' }], [MOVE_KIND[m.kind], payload])
}
```

- [ ] **Step 5: Swap `rules.ts` hashGameState to the abi hash.** Replace the body of the existing `hashGameState` with `return hashGameStateAbi(s)` (import from `./encoding`), delete the old JSON serialization, and DELETE the JSON-debt comment (it is paid here). Update `src/index.ts` to also export `./encoding`. The old hash-stability test vector in `test/rules.test.ts` will change — update that test's expectation logic (it asserts stability + sensitivity, not a literal constant, so it should pass unchanged; if it pinned a literal, re-derive it).

- [ ] **Step 6: Run the whole package** — `cd examples/games/hilo-war && pnpm test && pnpm typecheck` → all 24+ green.

- [ ] **Step 7: Commit**

```bash
git add examples/games/hilo-war
git commit -m "feat(hilo-war): abi-encoded game state + moves; hashGameState now solidity-reproducible"
```

---

### Task 4: `@gibs/zk-cards-core` — abi entryDigest, escrow top-up, real domain helper

**Files:**
- Modify: `examples/games/zk-core/src/transcript.ts`
- Modify: `examples/games/zk-core/src/channel.ts`
- Modify: `examples/games/zk-core/src/stateSig.ts`
- Test: `examples/games/zk-core/test/transcript.test.ts`, `examples/games/zk-core/test/channel.test.ts`

- [ ] **Step 1: Write the failing tests (append to existing files)**

```ts
// append to examples/games/zk-core/test/channel.test.ts (inside the describe)
it('applyTopUp raises escrow and conservation tracks it', async () => {
  // build a channel pair as the existing tests do (helper in this file), escrow E
  // then: chA.applyTopUp(10n); chB.applyTopUp(10n)
  // propose a state with balanceA increased by 10n: accepted
  // a channel WITHOUT the top-up applied must reject the same state (conservation)
})

// append to examples/games/zk-core/test/transcript.test.ts
it('entryDigest is abi-structured (recomputable from parts)', () => {
  const e = { tableId: tid, seq: 0, prev: GENESIS, kind: 'KEYGEN', body: { hello: 1 } }
  const d = entryDigest(e)
  const manual = keccak256(encodeAbiParameters(
    parseAbiParameters('bytes32, uint64, bytes32, bytes32, bytes32'),
    [tid, 0n, GENESIS, keccak256(stringToHex('KEYGEN')), keccak256(stringToHex(JSON.stringify({ hello: 1 })))],
  ))
  expect(d).toEqual(manual)
})
```

Flesh the top-up test out concretely using this file's existing channel-pair helper (read the file; it already constructs A/B channels with a shared escrow — mirror that setup).

- [ ] **Step 2: Run to verify failure** — `cd examples/games/zk-core && pnpm test` → the two new tests FAIL.

- [ ] **Step 3: Implement**

`transcript.ts` — replace `entryDigest` with:

```ts
export function entryDigest(e: Omit<Envelope, 'sig' | 'from'>): Hex {
  // abi-structured: an on-chain adjudicator can recompute this digest and
  // ecrecover the envelope signature given (tableId, seq, prev, kind, bodyBytes).
  // Body payloads remain canonical-JSON bytes for now — the v1 ZkTable dispute
  // machine never reads bodies (responses are tx-authenticated), so per-kind abi
  // body codecs are deferred until a dispute path needs one.
  return keccak256(encodeAbiParameters(
    parseAbiParameters('bytes32, uint64, bytes32, bytes32, bytes32'),
    [e.tableId, BigInt(e.seq), e.prev, keccak256(stringToHex(e.kind)), keccak256(stringToHex(JSON.stringify(e.body)))],
  ))
}
```

(imports: `encodeAbiParameters, parseAbiParameters, stringToHex` from viem). Delete the old DEBT comment block — replace with the comment above, which records the narrowed residue.

`channel.ts` — add to the `Channel` class:

```ts
/** Mirror of ZkTable.topUp: both parties call this when the TopUp event lands;
 *  conservation (A+B+pot == escrow) is checked against the bumped total. */
applyTopUp(amount: bigint): void {
  if (amount <= 0n) throw new Error('channel: top-up must be positive')
  this.cfg.escrow += amount
}
```

(`cfg` is currently `private readonly` — relax to `private` or keep a separate `escrow` field initialized from cfg; pick whichever matches the file's style, and make the conservation check read the live value.)

`stateSig.ts` — add beside TEST_DOMAIN:

```ts
/** The production domain: bind to the deployed ZkTable. Matches EIP712("ZkTable","1") on-chain. */
export function makeDomain(chainId: number, verifyingContract: Hex): ChannelDomain {
  return { name: 'ZkTable', version: '1', chainId, verifyingContract }
}
```

- [ ] **Step 4: Run** — `cd examples/games/zk-core && pnpm test && pnpm typecheck` → all green. Then `cd ../hilo-war && pnpm test` → still green (transcript digest change must not break session/adversarial suites — they only round-trip digests, never pin literals; if one pins a literal, update it).

- [ ] **Step 5: Commit**

```bash
git add examples/games/zk-core examples/games/hilo-war
git commit -m "feat(zk-core): abi-structured entryDigest, channel top-up, production EIP-712 domain"
```

---

### Task 5: `ChannelState.sol` + `IGameRules.sol` + `ZkTable` create/join/cancel/topUp + state-hash parity

**Files:**
- Create: `packages/contracts/contracts/zk/ChannelState.sol`
- Create: `packages/contracts/contracts/zk/IGameRules.sol`
- Create: `packages/contracts/contracts/zk/ZkTable.sol` (lifecycle half; dispute machine lands in Task 8)
- Create: `packages/contracts/contracts/test/MockGameRules.sol`
- Test: `packages/contracts/test/ZkChannelSig.test.ts`, `packages/contracts/test/ZkTable.test.ts`

- [ ] **Step 1: Write `ChannelState.sol`**

```solidity
// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// Mirrors @gibs/zk-cards-core stateSig.ts CHANNEL_STATE_TYPES exactly.
struct ChannelState {
    bytes32 tableId;
    uint64 nonce;
    uint256 balanceA;
    uint256 balanceB;
    uint256 pot;
    bytes32 deckCommitment;
    uint8 phase;
    bytes32 gameStateHash;
}

library ChannelStateLib {
    bytes32 internal constant TYPEHASH = keccak256(
        "ChannelState(bytes32 tableId,uint64 nonce,uint256 balanceA,uint256 balanceB,uint256 pot,bytes32 deckCommitment,uint8 phase,bytes32 gameStateHash)"
    );

    function structHash(ChannelState calldata s) internal pure returns (bytes32) {
        return keccak256(abi.encode(
            TYPEHASH, s.tableId, s.nonce, s.balanceA, s.balanceB, s.pot,
            s.deckCommitment, s.phase, s.gameStateHash
        ));
    }
}
```

- [ ] **Step 2: Write `IGameRules.sol`**

```solidity
// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// The rules seam: ZkTable is game-agnostic and consults one of these per table.
/// gameState/move byte encodings are owned by the implementing game (canonical
/// abi tuples mirrored in the game's TS package; parity-tested).
interface IGameRules {
    function gameId() external pure returns (uint16);
    /// keccak over the game's canonical encoding; must equal ChannelState.gameStateHash.
    function hashGameState(bytes calldata gameState) external pure returns (bytes32);
    /// Bitmask of seats that owe the next protocol action: bit0 = A, bit1 = B, 0 = none.
    function whoseTurn(bytes calldata gameState) external pure returns (uint8);
    /// May a state with this phase settle cooperatively?
    function isFinal(uint8 phase) external pure returns (bool);
    /// Apply a demanded move to a contested game state; MUST revert if illegal
    /// (wrong phase, wrong seat, commitment mismatch, bad cards...). Returns the
    /// new canonical game-state encoding.
    function applyMove(bytes calldata gameState, bytes calldata move) external view returns (bytes memory);
}
```

- [ ] **Step 3: Write the ZkTable lifecycle half**

```solidity
// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {SafeTransferLib} from "solady/src/utils/SafeTransferLib.sol";
import {ChannelState, ChannelStateLib} from "./ChannelState.sol";
import {IGameRules} from "./IGameRules.sol";

/// @notice Two-party state-channel card table. Stakes escrow at create/join, play is
/// off-chain co-signed states, the chain is touched again only to settle, top up, or
/// dispute. Tables are independent structs keyed by id — nothing reads another table,
/// so sessions pipeline (spec: 2026-06-11-zk-card-games-design.md).
contract ZkTable is EIP712 {
    using SafeTransferLib for address;
    using ChannelStateLib for ChannelState;

    error WrongValue();
    error BadClock();
    error BadStatus();
    error NotPlayer();
    error WrongTable();
    error BadSig();
    error NotFinal();
    error PotNotZero();
    error ConservationViolated();
    error StaleNonce();

    enum Status { None, Created, Live, Disputed, Settled, Cancelled }

    struct Table {
        address playerA;
        address playerB;
        address keyA;            // channel signing key (may differ from wallet)
        address keyB;
        uint256 escrowA;
        uint256 escrowB;
        uint256 joinStake;       // exact amount B must escrow
        IGameRules rules;
        uint64 clockBlocks;
        Status status;
        uint64 checkpointNonce;  // highest nonce co-signed on-chain; later submissions must exceed
        bool hasCheckpoint;
        // dispute fields (Task 8)
        uint64 disputeDeadline;
        uint8 disputant;         // 1 = A, 2 = B; 0 alongside Disputed = setup dispute
        uint8 demandKind;        // 0 none (setup), 1 move, 2 reveal share
        uint32 demandSlot;       // deck slot for share demands
        ChannelState disputeState;
    }

    uint64 public constant MIN_CLOCK_BLOCKS = 30;     // ~5 min at 10s blocks
    uint64 public constant MAX_CLOCK_BLOCKS = 60480;  // ~1 week

    uint256 internal _counter;
    mapping(bytes32 => Table) public tables;
    // EdOnBN254 deck pubkeys for snark-reveal disputes: tableId => seat (1/2) => [x, y]
    mapping(bytes32 => mapping(uint8 => uint256[2])) public deckKeys;

    event TableCreated(bytes32 indexed tableId, address indexed playerA, address rules, uint256 escrow, uint256 joinStake, uint64 clockBlocks);
    event TableJoined(bytes32 indexed tableId, address indexed playerB);
    event TableCancelled(bytes32 indexed tableId);
    event ToppedUp(bytes32 indexed tableId, uint8 seat, uint256 amount);
    event TableSettled(bytes32 indexed tableId, uint256 payoutA, uint256 payoutB);

    constructor() EIP712("ZkTable", "1") {}

    function create(IGameRules rules, uint256 joinStake, uint64 clockBlocks, address channelKey, uint256[2] calldata deckKey)
        external
        payable
        returns (bytes32 tableId)
    {
        if (msg.value == 0) revert WrongValue();
        if (clockBlocks < MIN_CLOCK_BLOCKS || clockBlocks > MAX_CLOCK_BLOCKS) revert BadClock();
        tableId = keccak256(abi.encode(block.chainid, address(this), ++_counter));
        Table storage t = tables[tableId];
        t.playerA = msg.sender;
        t.keyA = channelKey == address(0) ? msg.sender : channelKey;
        t.escrowA = msg.value;
        t.joinStake = joinStake;
        t.rules = rules;
        t.clockBlocks = clockBlocks;
        t.status = Status.Created;
        deckKeys[tableId][1] = deckKey;
        emit TableCreated(tableId, msg.sender, address(rules), msg.value, joinStake, clockBlocks);
    }

    function join(bytes32 tableId, address channelKey, uint256[2] calldata deckKey) external payable {
        Table storage t = tables[tableId];
        if (t.status != Status.Created) revert BadStatus();
        if (msg.sender == t.playerA) revert NotPlayer();
        if (msg.value != t.joinStake) revert WrongValue();
        t.playerB = msg.sender;
        t.keyB = channelKey == address(0) ? msg.sender : channelKey;
        t.escrowB = msg.value;
        t.status = Status.Live;
        deckKeys[tableId][2] = deckKey;
        emit TableJoined(tableId, msg.sender);
    }

    /// Creator backs out before anyone joins.
    function cancel(bytes32 tableId) external {
        Table storage t = tables[tableId];
        if (t.status != Status.Created) revert BadStatus();
        if (msg.sender != t.playerA) revert NotPlayer();
        t.status = Status.Cancelled;
        uint256 amount = t.escrowA;
        t.escrowA = 0;
        emit TableCancelled(tableId);
        t.playerA.safeTransferETH(amount);
    }

    /// Spec: top-up only at a flip boundary, reflected in the next co-signed state.
    /// On-chain it just bumps escrow; both clients mirror via Channel.applyTopUp.
    function topUp(bytes32 tableId) external payable {
        Table storage t = tables[tableId];
        if (t.status != Status.Live) revert BadStatus();
        if (msg.value == 0) revert WrongValue();
        uint8 seat = _seatOf(t, msg.sender);
        if (seat == 1) t.escrowA += msg.value;
        else t.escrowB += msg.value;
        emit ToppedUp(tableId, seat, msg.value);
    }

    /// Cooperative settle: either party submits the final co-signed state.
    function settle(bytes32 tableId, ChannelState calldata state, bytes calldata sigA, bytes calldata sigB) external {
        Table storage t = tables[tableId];
        if (t.status != Status.Live) revert BadStatus();
        _seatOf(t, msg.sender); // reverts NotPlayer for strangers
        _checkCoSigned(t, tableId, state, sigA, sigB);
        if (!t.rules.isFinal(state.phase)) revert NotFinal();
        if (state.pot != 0) revert PotNotZero();
        if (state.balanceA + state.balanceB != t.escrowA + t.escrowB) revert ConservationViolated();
        if (t.hasCheckpoint && state.nonce <= t.checkpointNonce) revert StaleNonce();
        _payout(t, tableId, state.balanceA, state.balanceB);
    }

    /// Public so off-chain code can parity-test the EIP-712 digest.
    function stateDigest(ChannelState calldata state) public view returns (bytes32) {
        return _hashTypedDataV4(state.structHash());
    }

    function _checkCoSigned(Table storage t, bytes32 tableId, ChannelState calldata state, bytes calldata sigA, bytes calldata sigB) internal view {
        if (state.tableId != tableId) revert WrongTable();
        bytes32 digest = stateDigest(state);
        if (ECDSA.recover(digest, sigA) != t.keyA) revert BadSig();
        if (ECDSA.recover(digest, sigB) != t.keyB) revert BadSig();
    }

    function _seatOf(Table storage t, address who) internal view returns (uint8) {
        if (who == t.playerA || who == t.keyA) return 1;
        if (who == t.playerB || who == t.keyB) return 2;
        revert NotPlayer();
    }

    function _payout(Table storage t, bytes32 tableId, uint256 toA, uint256 toB) internal {
        t.status = Status.Settled;
        t.escrowA = 0;
        t.escrowB = 0;
        emit TableSettled(tableId, toA, toB);
        if (toA > 0) t.playerA.safeTransferETH(toA);
        if (toB > 0) t.playerB.safeTransferETH(toB);
    }
}
```

Check the solady import path used elsewhere in this package (GameBase.sol imports it) and match it exactly.

- [ ] **Step 4: Write `MockGameRules.sol`**

```solidity
// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {IGameRules} from "../zk/IGameRules.sol";

/// Permissive rules for ZkTable unit tests: every state is final, turn/applyMove configurable.
contract MockGameRules is IGameRules {
    uint8 public turnMask = 3;
    bool public finalAll = true;
    bytes public nextState;
    bool public applyReverts;

    function setTurnMask(uint8 m) external { turnMask = m; }
    function setFinalAll(bool f) external { finalAll = f; }
    function setApply(bytes calldata s, bool revert_) external { nextState = s; applyReverts = revert_; }

    function gameId() external pure returns (uint16) { return 0; }
    function hashGameState(bytes calldata gameState) external pure returns (bytes32) { return keccak256(gameState); }
    function whoseTurn(bytes calldata) external view returns (uint8) { return turnMask; }
    function isFinal(uint8) external view returns (bool) { return finalAll; }
    function applyMove(bytes calldata, bytes calldata) external view returns (bytes memory) {
        require(!applyReverts, "mock: illegal");
        return nextState;
    }
}
```

(`isFinal`/`whoseTurn` are `pure` in the interface but the mock needs storage — make the INTERFACE functions `view`, not `pure`, in Step 2, and HiLoWarRules can still implement them as pure-compatible views. Adjust IGameRules.sol accordingly: `whoseTurn`/`isFinal`/`hashGameState` as `view`.)

- [ ] **Step 5: Write the failing tests**

`test/ZkChannelSig.test.ts` — the TS↔Solidity EIP-712 parity check:

```ts
import { expect } from 'chai'
import hre from 'hardhat'
import { hashState, makeDomain, type ChannelState } from '@gibs/zk-cards-core'

describe('ZkTable EIP-712 parity', () => {
  it('TS hashState equals contract stateDigest', async () => {
    const zk = await hre.viem.deployContract('ZkTable' as any, [])
    const domain = makeDomain(31337, zk.address)
    const state: ChannelState = {
      tableId: `0x${'ab'.repeat(32)}`, nonce: 7n, balanceA: 100n, balanceB: 50n,
      pot: 10n, deckCommitment: `0x${'cd'.repeat(32)}`, phase: 3, gameStateHash: `0x${'ef'.repeat(32)}`,
    }
    const onchain = await zk.read.stateDigest([state])
    expect(onchain).to.equal(hashState(domain, state))
  })
})
```

Add `"@gibs/zk-cards-core": "workspace:*"` and `"@gibs/hilo-war": "workspace:*"` to `packages/contracts/package.json` devDependencies and `pnpm install` from the repo root. If the contracts package's mocha/ts setup chokes on importing the ESM workspace package, mirror however `examples/games/e2e` imports workspace packages in its tests; worst case re-declare the typed-data constants locally in the test and assert against `viem.hashTypedData` directly.

`test/ZkTable.test.ts` — lifecycle units (use the viem wallet clients from `hre.viem.getWalletClients()`; sign states with `walletClient.signTypedData` using the same domain/types as zk-core):

```ts
// describe('ZkTable lifecycle') — cases:
// create: escrow recorded, event emitted, tableId deterministic & unique across two creates
// create with 0 value reverts WrongValue; clockBlocks 10 reverts BadClock
// join: wrong stake reverts WrongValue; joining own table reverts NotPlayer; joins → Live
// cancel: only creator, only before join; refunds full escrow (balance delta assert)
// topUp: bumps the right seat's escrow, emits; stranger reverts NotPlayer; on Created reverts BadStatus
// settle happy path: both sign a final state (phase final per mock, pot 0, balances == escrows) → payouts land (balance delta asserts), Settled
// settle reverts: bad sigB → BadSig; pot != 0 → PotNotZero; balances short → ConservationViolated; non-final phase (mock setFinalAll(false)) → NotFinal; stranger → NotPlayer; wrong tableId in state → WrongTable
// settle twice → second reverts BadStatus
```

Write each as a real `it(...)` with explicit asserts — the existing `test/CoinFlip.test.ts` shows the fixture/balance-assert idioms to copy.

- [ ] **Step 6: Run** — `cd packages/contracts && npx hardhat test test/ZkChannelSig.test.ts test/ZkTable.test.ts` → green after implementation; iterate until so.

- [ ] **Step 7: Commit**

```bash
git add contracts/zk contracts/test package.json ../../pnpm-lock.yaml test/ZkChannelSig.test.ts test/ZkTable.test.ts
git commit -m "feat(contracts): ZkTable lifecycle (create/join/cancel/topUp/settle) + EIP-712 channel states"
```

---

### Task 6: `HiLoWarRules.sol`

**Files:**
- Create: `packages/contracts/contracts/zk/HiLoWarRules.sol`
- Test: `packages/contracts/test/HiLoWarRules.test.ts`

- [ ] **Step 0: Read `examples/games/hilo-war/src/rules.ts` end-to-end.** It is normative (design decision 5). The Solidity below is the best-known mirror; wherever they disagree, rules.ts wins — Task 7's parity fuzz is the arbiter. Pay particular attention to exactly when antes enter the pot (`initialFlipState` vs `DEAL_DONE`) and mirror it.

- [ ] **Step 1: Write the contract**

```solidity
// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {IGameRules} from "./IGameRules.sol";

/// @notice Pure mirror of @gibs/hilo-war src/rules.ts applyMove — consulted only by
/// ZkTable's dispute machine. The TS module is normative; test/HiLoWarParity.test.ts
/// fuzzes the two against each other. Encodings are the canonical abi tuples shared
/// with examples/games/hilo-war/src/encoding.ts.
contract HiLoWarRules is IGameRules {
    error WrongPhase();
    error WrongSeat();
    error AlreadyMoved();
    error CommitMismatch();
    error BadCard();
    error IllegalMove();

    uint8 internal constant PHASE_SETUP = 0;
    uint8 internal constant PHASE_DEAL = 1;
    uint8 internal constant PHASE_BET_COMMIT = 2;
    uint8 internal constant PHASE_BET_OPEN = 3;
    uint8 internal constant PHASE_CALL_OR_FOLD = 4;
    uint8 internal constant PHASE_SHOWDOWN = 5;
    uint8 internal constant PHASE_FLIP_DONE = 6;
    uint8 internal constant PHASE_SETTLED = 7;

    uint8 internal constant SEAT_A = 1;
    uint8 internal constant SEAT_B = 2;
    uint8 internal constant BET_RAISE = 1;
    uint8 internal constant BET_HOLD = 2;

    uint8 internal constant MOVE_DEAL_DONE = 0;
    uint8 internal constant MOVE_BET_COMMIT = 1;
    uint8 internal constant MOVE_BET_OPEN = 2;
    uint8 internal constant MOVE_CALL = 3;
    uint8 internal constant MOVE_FOLD = 4;
    uint8 internal constant MOVE_SHOWDOWN = 5;

    /// Mirrors encoding.ts GAME_STATE_ABI field-for-field.
    struct HiLo {
        uint8 phase;
        uint32 deckIndex;
        uint256 ante;
        uint256 pot;
        uint256 warPot;
        uint256 contributedA;
        uint256 contributedB;
        bytes32 commitA;
        bytes32 commitB;
        uint8 betA;
        uint8 betB;
        uint8 raiser;
        uint8 resultWinner;
        uint256 resultAmount;
        bool resultSet;
        bool foldedCardHidden;
    }

    address public immutable revealVerifierAddr;
    address public immutable shuffleVerifierAddr;

    constructor(address revealVerifier_, address shuffleVerifier_) {
        revealVerifierAddr = revealVerifier_;
        shuffleVerifierAddr = shuffleVerifier_;
    }

    function gameId() external pure returns (uint16) { return 1; }
    function revealVerifier() external view returns (address) { return revealVerifierAddr; }

    function hashGameState(bytes calldata gameState) external pure returns (bytes32) {
        return keccak256(gameState);
    }

    function isFinal(uint8 phase) external pure returns (bool) {
        return phase == PHASE_SETTLED;
    }

    /// bit0 = A owes the next protocol action, bit1 = B.
    function whoseTurn(bytes calldata gameState) external pure returns (uint8 mask) {
        HiLo memory s = abi.decode(gameState, (HiLo));
        if (s.phase == PHASE_SETTLED) return 0;
        if (s.phase == PHASE_BET_COMMIT) {
            if (s.commitA == bytes32(0)) mask |= 1;
            if (s.commitB == bytes32(0)) mask |= 2;
        } else if (s.phase == PHASE_BET_OPEN) {
            if (s.betA == 0) mask |= 1;
            if (s.betB == 0) mask |= 2;
        } else if (s.phase == PHASE_CALL_OR_FOLD) {
            mask = s.raiser == SEAT_A ? 2 : 1; // the non-raiser owes call/fold
        } else {
            // SETUP / DEAL / SHOWDOWN / FLIP_DONE: both parties owe protocol
            // progress (shares or the next co-signed state).
            mask = 3;
        }
    }

    function applyMove(bytes calldata gameState, bytes calldata move) external pure returns (bytes memory) {
        HiLo memory s = abi.decode(gameState, (HiLo));
        (uint8 kind, bytes memory payload) = abi.decode(move, (uint8, bytes));
        if (s.phase == PHASE_FLIP_DONE || s.phase == PHASE_SETTLED) revert WrongPhase();

        if (kind == MOVE_DEAL_DONE) {
            if (s.phase != PHASE_DEAL) revert WrongPhase();
            // both antes enter the pot when the deal completes — VERIFY against
            // rules.ts (Step 0) and mirror exactly
            s.pot += 2 * s.ante;
            s.contributedA += s.ante;
            s.contributedB += s.ante;
            s.phase = PHASE_BET_COMMIT;
        } else if (kind == MOVE_BET_COMMIT) {
            if (s.phase != PHASE_BET_COMMIT) revert WrongPhase();
            (uint8 by, bytes32 commitment) = abi.decode(payload, (uint8, bytes32));
            if (by != SEAT_A && by != SEAT_B) revert WrongSeat();
            if (by == SEAT_A) {
                if (s.commitA != bytes32(0)) revert AlreadyMoved();
                s.commitA = commitment;
            } else {
                if (s.commitB != bytes32(0)) revert AlreadyMoved();
                s.commitB = commitment;
            }
            if (s.commitA != bytes32(0) && s.commitB != bytes32(0)) s.phase = PHASE_BET_OPEN;
        } else if (kind == MOVE_BET_OPEN) {
            if (s.phase != PHASE_BET_OPEN) revert WrongPhase();
            (uint8 by, uint8 bet, bytes32 salt) = abi.decode(payload, (uint8, uint8, bytes32));
            if (by != SEAT_A && by != SEAT_B) revert WrongSeat();
            if (bet != BET_RAISE && bet != BET_HOLD) revert IllegalMove();
            bytes32 expected = by == SEAT_A ? s.commitA : s.commitB;
            if (expected != _betCommitHash(bet, salt)) revert CommitMismatch();
            if (by == SEAT_A) {
                if (s.betA != 0) revert AlreadyMoved();
                s.betA = bet;
            } else {
                if (s.betB != 0) revert AlreadyMoved();
                s.betB = bet;
            }
            if (s.betA != 0 && s.betB != 0) {
                if (s.betA == BET_HOLD && s.betB == BET_HOLD) {
                    s.phase = PHASE_SHOWDOWN;
                } else if (s.betA == BET_RAISE && s.betB == BET_RAISE) {
                    s.pot += 2 * s.ante;
                    s.contributedA += s.ante;
                    s.contributedB += s.ante;
                    s.phase = PHASE_SHOWDOWN;
                } else {
                    s.raiser = s.betA == BET_RAISE ? SEAT_A : SEAT_B;
                    s.pot += s.ante;
                    if (s.raiser == SEAT_A) s.contributedA += s.ante;
                    else s.contributedB += s.ante;
                    s.phase = PHASE_CALL_OR_FOLD;
                }
            }
        } else if (kind == MOVE_CALL) {
            if (s.phase != PHASE_CALL_OR_FOLD) revert WrongPhase();
            (uint8 by) = abi.decode(payload, (uint8));
            if (by != SEAT_A && by != SEAT_B) revert WrongSeat();
            if (by == s.raiser) revert IllegalMove(); // raiser cannot call own raise
            s.pot += s.ante;
            if (by == SEAT_A) s.contributedA += s.ante;
            else s.contributedB += s.ante;
            s.phase = PHASE_SHOWDOWN;
        } else if (kind == MOVE_FOLD) {
            if (s.phase != PHASE_CALL_OR_FOLD) revert WrongPhase();
            (uint8 by) = abi.decode(payload, (uint8));
            if (by != SEAT_A && by != SEAT_B) revert WrongSeat();
            if (by == s.raiser) revert IllegalMove();
            s.resultWinner = s.raiser;
            s.resultAmount = s.pot + s.warPot;
            s.resultSet = true;
            s.foldedCardHidden = true;
            s.pot = 0;
            s.warPot = 0;
            s.phase = PHASE_FLIP_DONE;
        } else if (kind == MOVE_SHOWDOWN) {
            if (s.phase != PHASE_SHOWDOWN) revert WrongPhase();
            (uint8 cardA, uint8 cardB) = abi.decode(payload, (uint8, uint8));
            if (cardA > 51 || cardB > 51 || cardA == cardB) revert BadCard();
            uint8 rankA = cardA / 4; // +2 offset irrelevant for comparison
            uint8 rankB = cardB / 4;
            if (rankA == rankB) {
                s.warPot += s.pot;
                s.pot = 0;
                s.resultSet = false;
                s.resultWinner = 0;
                s.resultAmount = 0;
            } else {
                s.resultWinner = rankA > rankB ? SEAT_A : SEAT_B;
                s.resultAmount = s.pot + s.warPot;
                s.resultSet = true;
                s.pot = 0;
                s.warPot = 0;
            }
            s.phase = PHASE_FLIP_DONE;
        } else {
            revert IllegalMove();
        }
        return abi.encode(s);
    }

    /// Mirrors hilo-war hashBetCommit: keccak256(utf8 prefix ++ salt).
    function _betCommitHash(uint8 bet, bytes32 salt) internal pure returns (bytes32) {
        return keccak256(bytes.concat(
            bet == BET_RAISE ? bytes("hilo-war/bet/RAISE/") : bytes("hilo-war/bet/HOLD/"),
            salt
        ));
    }
}
```

- [ ] **Step 2: Write the failing unit tests**

```ts
// packages/contracts/test/HiLoWarRules.test.ts
// Build states/moves with @gibs/hilo-war's encodeGameState/encodeMove and
// initialFlipState/applyMove from rules.ts (workspace devDep added in Task 5).
// Cases (each a real it() with asserts via rules.read.applyMove([...])):
// - hashGameState(encodeGameState(s)) == hashGameStateAbi(s) for a fresh flip state
// - full happy path: DEAL_DONE → both BET_COMMITs → both BET_OPENs (hold/hold) →
//   SHOWDOWN decisive: decoded result matches TS applyMove over the same moves
// - BET_OPEN with wrong salt reverts CommitMismatch
// - CALL by the raiser reverts IllegalMove
// - FOLD pays raiser pot+warPot, foldedCardHidden true
// - SHOWDOWN tie carries warPot; equal-card and out-of-range revert BadCard
// - any move in FLIP_DONE reverts WrongPhase
// - whoseTurn masks: fresh BET_COMMIT → 3; after A commits → 2; CALL_OR_FOLD
//   with raiser A → 2; SETTLED → 0
// - isFinal: only phase 7
```

Write these as concrete tests (decode returned bytes with viem `decodeAbiParameters` against `GAME_STATE_ABI`).

- [ ] **Step 3: Run** — `cd packages/contracts && npx hardhat test test/HiLoWarRules.test.ts` → green after fixes.

- [x] **Step 4: Commit**

```bash
git add contracts/zk/HiLoWarRules.sol test/HiLoWarRules.test.ts
git commit -m "feat(contracts): HiLoWarRules mirroring @gibs/hilo-war applyMove"
```

---

### Task 7: TS ↔ Solidity parity fuzz

**Files:**
- Test: `packages/contracts/test/HiLoWarParity.test.ts`

- [ ] **Step 1: Write the fuzz test**

```ts
// packages/contracts/test/HiLoWarParity.test.ts
// Seeded random walks: at each step generate a candidate Move (sometimes legal,
// sometimes deliberately illegal), apply to BOTH the TS rules and the contract,
// and require identical outcomes.
import { expect } from 'chai'
import hre from 'hardhat'
import * as viem from 'viem'
import { initialFlipState, applyMove, type HiLoState, type Move } from '@gibs/hilo-war'
import { encodeGameState, encodeMove, hashGameStateAbi, GAME_STATE_ABI } from '@gibs/hilo-war'

function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// genMove(rnd, s): build a move appropriate to s.phase most of the time
// (legal commit/open/call/fold/showdown with correct salts tracked in a local map),
// and with probability ~0.25 an out-of-phase / wrong-seat / bad-salt / bad-card move.
// Keep the salt map keyed by seat so BET_OPEN can be made legal on demand.

describe('HiLoWar TS<->Solidity parity', () => {
  it('500 seeded random walks agree on every transition', async function () {
    this.timeout(120_000)
    const rules = await hre.viem.deployContract('HiLoWarRules' as any, [viem.zeroAddress, viem.zeroAddress])
    for (let seed = 1; seed <= 500; seed++) {
      const rnd = mulberry32(seed)
      let ts: HiLoState = initialFlipState({ ante: 1n + BigInt(Math.floor(rnd() * 5)), deckIndex: 0, warPot: 0n })
      for (let step = 0; step < 12; step++) {
        const move = genMove(rnd, ts)
        const tsOut = applyMove(ts, move)
        let solOk = true
        let solBytes: viem.Hex | undefined
        try {
          const r = await rules.read.applyMove([encodeGameState(ts), encodeMove(move)])
          solBytes = r as viem.Hex
        } catch { solOk = false }
        if ('error' in tsOut) {
          expect(solOk, `seed ${seed} step ${step}: TS rejected (${tsOut.error}) but contract accepted ${move.kind}`).to.equal(false)
        } else {
          expect(solOk, `seed ${seed} step ${step}: contract rejected legal ${move.kind}`).to.equal(true)
          expect(viem.keccak256(solBytes!), `seed ${seed} step ${step}: state hash diverged after ${move.kind}`)
            .to.equal(hashGameStateAbi(tsOut.state))
          ts = tsOut.state
          if (ts.phase >= 6) break // FLIP_DONE/SETTLED: walk ends
        }
      }
    }
  })

  it('whoseTurn agrees with which seats have pending TS moves (spot states)', async () => {
    // assert the mask for: fresh DEAL, half-committed BET_COMMIT, half-open
    // BET_OPEN, CALL_OR_FOLD each raiser, FLIP_DONE, SETTLED
  })
})
```

Implement `genMove` concretely in the file: a switch on `ts.phase` emitting the legal move (with tracked salts), plus the ~25% illegal-mutation branch (random kind, flipped seat, corrupted salt, card 52, duplicate card).

- [ ] **Step 2: Run** — `cd packages/contracts && npx hardhat test test/HiLoWarParity.test.ts`. Expected: any drift between the Task 6 Solidity and rules.ts fails loudly with seed/step — fix the SOLIDITY (rules.ts is normative; the likely first failure is the exact moment antes enter the pot — re-read rules.ts and mirror).

- [ ] **Step 3: Commit**

```bash
git add test/HiLoWarParity.test.ts contracts/zk/HiLoWarRules.sol
git commit -m "test(contracts): seeded parity fuzz — HiLoWarRules == @gibs/hilo-war"
```

---

### Task 8: ZkTable dispute machine

**Files:**
- Modify: `packages/contracts/contracts/zk/ZkTable.sol`
- Create: `packages/contracts/contracts/test/MockRevealVerifier.sol`
- Test: `packages/contracts/test/ZkTableDispute.test.ts`

- [ ] **Step 1: Write `MockRevealVerifier.sol`**

```solidity
// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// Stand-in for the vendored RevealVerifier in dispute-path unit tests.
contract MockRevealVerifier {
    bool public ok = true;
    function setOk(bool v) external { ok = v; }
    function verifyRevealWithSnark(uint256[6] calldata, uint256[8] calldata) external view returns (bool) {
        return ok;
    }
}
```

- [ ] **Step 2: Add the dispute machine to `ZkTable.sol`**

New errors/events plus six functions. Add to the contract:

```solidity
    error ClockRunning();
    error ClockNotExpired();
    error NotYourDispute();
    error NotDemanded();
    error NotYourTurn();
    error BadGameState();
    error BadDeck();
    error BadProof();
    error BadDemand();

    uint8 internal constant DEMAND_MOVE = 1;
    uint8 internal constant DEMAND_SHARE = 2;

    event DisputeOpened(bytes32 indexed tableId, uint8 disputant, uint8 demandKind, uint32 demandSlot, uint64 deadline);
    event SetupDisputeOpened(bytes32 indexed tableId, uint8 disputant, uint64 deadline);
    event DisputeAnsweredWithState(bytes32 indexed tableId, uint64 nonce);
    event DisputeAnsweredWithMove(bytes32 indexed tableId, bytes move, bytes32 newGameStateHash);
    event DisputeAnsweredWithShare(bytes32 indexed tableId, uint32 slot, uint256 revealX, uint256 revealY);
    event DisputeForfeited(bytes32 indexed tableId, uint8 winner, uint256 payoutA, uint256 payoutB);
    event SetupDisputeRefunded(bytes32 indexed tableId);

    /// Stall before state 0 (spec edge case): no co-signed state exists yet.
    /// If the counterparty produces ANY valid co-signed state before the clock
    /// expires the table goes back to Live; otherwise both escrows refund in full.
    function disputeSetup(bytes32 tableId) external {
        Table storage t = tables[tableId];
        if (t.status != Status.Live) revert BadStatus();
        if (t.hasCheckpoint) revert BadDemand(); // a state exists: use openDispute
        uint8 seat = _seatOf(t, msg.sender);
        t.status = Status.Disputed;
        t.disputant = seat;
        t.demandKind = 0;
        t.disputeDeadline = uint64(block.number) + t.clockBlocks;
        emit SetupDisputeOpened(tableId, seat, t.disputeDeadline);
    }

    /// Post your latest co-signed state and demand the owed protocol action.
    /// gameState must be the preimage of state.gameStateHash; the demand must
    /// target a seat that actually owes per the rules (ForceMove-style guard:
    /// you cannot demand from someone whose turn it is not).
    function openDispute(
        bytes32 tableId,
        ChannelState calldata state,
        bytes calldata sigA,
        bytes calldata sigB,
        bytes calldata gameState,
        uint8 demandKind,
        uint32 demandSlot
    ) external {
        Table storage t = tables[tableId];
        if (t.status != Status.Live) revert BadStatus();
        uint8 seat = _seatOf(t, msg.sender);
        _checkCoSigned(t, tableId, state, sigA, sigB);
        if (t.hasCheckpoint && state.nonce < t.checkpointNonce) revert StaleNonce();
        if (t.rules.hashGameState(gameState) != state.gameStateHash) revert BadGameState();
        if (demandKind != DEMAND_MOVE && demandKind != DEMAND_SHARE) revert BadDemand();
        uint8 counterparty = seat == 1 ? 2 : 1;
        if (t.rules.whoseTurn(gameState) & counterparty == 0) revert NotYourTurn();
        t.status = Status.Disputed;
        t.disputant = seat;
        t.demandKind = demandKind;
        t.demandSlot = demandSlot;
        t.disputeState = state;
        t.checkpointNonce = state.nonce;
        t.hasCheckpoint = true;
        t.disputeDeadline = uint64(block.number) + t.clockBlocks;
        emit DisputeOpened(tableId, seat, demandKind, demandSlot, t.disputeDeadline);
    }

    /// Universal answer: a co-signed state newer than the contested one.
    function respondWithState(bytes32 tableId, ChannelState calldata state, bytes calldata sigA, bytes calldata sigB) external {
        Table storage t = tables[tableId];
        if (t.status != Status.Disputed) revert BadStatus();
        _seatOf(t, msg.sender);
        _checkCoSigned(t, tableId, state, sigA, sigB);
        // setup dispute (demandKind 0): any co-signed state proves liveness;
        // move/share disputes need strictly newer than the contested state.
        if (t.demandKind != 0 && state.nonce <= t.disputeState.nonce) revert StaleNonce();
        t.checkpointNonce = state.nonce;
        t.hasCheckpoint = true;
        _clearDispute(t);
        emit DisputeAnsweredWithState(tableId, state.nonce);
    }

    /// Answer a MOVE demand: the owing seat publishes the demanded move on-chain.
    /// The rules contract is the judge; an illegal move reverts there.
    function respondWithMove(bytes32 tableId, bytes calldata gameState, bytes calldata move) external {
        Table storage t = tables[tableId];
        if (t.status != Status.Disputed) revert BadStatus();
        if (t.demandKind != DEMAND_MOVE) revert NotDemanded();
        uint8 seat = _seatOf(t, msg.sender);
        if (seat == t.disputant) revert NotYourDispute();
        if (t.rules.hashGameState(gameState) != t.disputeState.gameStateHash) revert BadGameState();
        bytes memory newState = t.rules.applyMove(gameState, move);
        _clearDispute(t);
        emit DisputeAnsweredWithMove(tableId, move, t.rules.hashGameState(newState));
    }

    /// Answer a SHARE demand: a Groth16 snark-reveal for the demanded deck slot
    /// (the CP-DL form is rejected by design — 15.6M gas; spike addendum risk 5).
    /// deck = 208 words (52 cards x [c1.x, c1.y, c2.x, c2.y]) matching the
    /// contested state's deckCommitment; pi layout per vendored RevealVerifier:
    /// [masked.e1.x, masked.e1.y, reveal.x, reveal.y, pk.x, pk.y].
    function respondWithShare(
        bytes32 tableId,
        uint256[] calldata deck,
        uint256[2] calldata reveal,
        uint256[8] calldata zkproof
    ) external {
        Table storage t = tables[tableId];
        if (t.status != Status.Disputed) revert BadStatus();
        if (t.demandKind != DEMAND_SHARE) revert NotDemanded();
        uint8 seat = _seatOf(t, msg.sender);
        if (seat == t.disputant) revert NotYourDispute();
        if (deck.length != 208) revert BadDeck();
        if (keccak256(abi.encodePacked(deck)) != t.disputeState.deckCommitment) revert BadDeck();
        uint32 slot = t.demandSlot;
        if (slot > 51) revert BadDeck();
        uint256[2] memory pk = deckKeys[tableId][seat];
        uint256[6] memory pi = [deck[4 * slot], deck[4 * slot + 1], reveal[0], reveal[1], pk[0], pk[1]];
        (bool callOk, bytes memory ret) = IGameRulesRevealVerifier(address(t.rules)).revealVerifier()
            .staticcall(abi.encodeWithSignature("verifyRevealWithSnark(uint256[6],uint256[8])", pi, zkproof));
        if (!callOk || ret.length < 32 || !abi.decode(ret, (bool))) revert BadProof();
        _clearDispute(t);
        emit DisputeAnsweredWithShare(tableId, slot, reveal[0], reveal[1]);
    }

    /// Clock expired unanswered: forfeit the disputed pot to the disputant and
    /// settle balances from the contested co-signed state. Setup disputes refund
    /// both escrows in full (no pot exists yet — spec edge case).
    function resolveTimeout(bytes32 tableId) external {
        Table storage t = tables[tableId];
        if (t.status != Status.Disputed) revert BadStatus();
        if (uint64(block.number) <= t.disputeDeadline) revert ClockNotExpired();
        if (t.demandKind == 0) {
            emit SetupDisputeRefunded(tableId);
            _payout(t, tableId, t.escrowA, t.escrowB);
            return;
        }
        uint256 toA = t.disputeState.balanceA;
        uint256 toB = t.disputeState.balanceB;
        if (t.disputant == 1) toA += t.disputeState.pot;
        else toB += t.disputeState.pot;
        emit DisputeForfeited(tableId, t.disputant, toA, toB);
        // top-ups since the contested state would strand: fold any escrow excess
        // back to its contributor so no wei sticks to the contract
        uint256 total = t.escrowA + t.escrowB;
        uint256 stateTotal = toA + toB;
        if (total > stateTotal) {
            // excess is attributable per-seat only off-chain; split it per the
            // recorded escrows' proportions is overkill for v1 — refund excess
            // to each seat's own escrow surplus is impossible to compute here,
            // so REQUIRE conservation instead: see _checkCoSigned note below.
            toA += total - stateTotal; // placeholder — replaced by the check below
        }
        _payout(t, tableId, toA, toB);
    }
```

**Conservation rule replacing that placeholder (implement this, not the placeholder):** add to `_checkCoSigned` (used by settle AND openDispute AND respondWithState) the check `if (state.balanceA + state.balanceB + state.pot != t.escrowA + t.escrowB) revert ConservationViolated();` — every state the contract accepts must conserve the CURRENT escrow total, so at timeout `toA + toB == escrowA + escrowB` always and the excess branch above is deleted entirely. (A top-up between co-signs makes the pre-top-up state unsubmittable, which is correct: the spec requires the next co-signed state to reflect the top-up, and clients call `Channel.applyTopUp` when the event lands. Note: this also means `settle`'s separate conservation check becomes redundant — remove the duplicate.)

Also add the tiny helper interface at the bottom of the file:

```solidity
interface IGameRulesRevealVerifier {
    function revealVerifier() external view returns (address);
}
```

And amend `IGameRules.sol`: add `function revealVerifier() external view returns (address);` to the interface (HiLoWarRules already implements it; add a settable one to `MockGameRules`), then `respondWithShare` can call `t.rules.revealVerifier()` directly instead of the helper interface — prefer that; drop the helper.

`_clearDispute`:

```solidity
    function _clearDispute(Table storage t) internal {
        t.status = Status.Live;
        t.disputant = 0;
        t.demandKind = 0;
        t.demandSlot = 0;
        t.disputeDeadline = 0;
        delete t.disputeState;
    }
```

And allow `settle` while `Disputed` too? NO — keep settle Live-only for v1 (a disputed table must resolve through respondWithState first, which returns it to Live; cooperative settle then proceeds). Record this in a comment on `settle`.

- [ ] **Step 3: Write the failing tests**

```ts
// packages/contracts/test/ZkTableDispute.test.ts — cases (real its, MockGameRules +
// MockRevealVerifier wired via mock.rules.revealVerifier; sign states with viem
// signTypedData as in ZkTable.test.ts):
//
// disputeSetup: opens with deadline = now + clockBlocks; respondWithState with a
//   co-signed nonce-0 state clears to Live and checkpoints; timeout instead →
//   resolveTimeout refunds BOTH escrows in full (balance deltas)
// disputeSetup after a checkpoint exists reverts BadDemand
// openDispute: stores state, Disputed, event; gameState not matching hash →
//   BadGameState; demanding when counterparty owes nothing (mock turnMask = my
//   own seat only) → NotYourTurn; non-conserving state → ConservationViolated;
//   stale nonce vs checkpoint → StaleNonce
// respondWithState: higher nonce clears + checkpoints; equal/lower nonce →
//   StaleNonce; by the disputant themself is fine (any party may submit newer
//   co-signed states) — assert allowed
// respondWithMove: mock applyMove returns bytes → clears, emits new hash; mock
//   set to revert → revert bubbles; disputant calling → NotYourDispute; wrong
//   demand kind → NotDemanded
// respondWithShare (mock verifier): 208-word deck with matching commitment +
//   mock ok → clears + emits; wrong deck length / wrong commitment → BadDeck;
//   mock !ok → BadProof
// respondWithShare (REAL vendored RevealVerifier): deploy RevealVerifier, a
//   HiLoWarRules pointed at it, register deckKeys[seat] = fixture pi[4..5],
//   build a deck whose demanded slot has [c1.x, c1.y] = fixture pi[0..1]
//   (other words arbitrary), deckCommitment = keccak(abi.encodePacked(deck)),
//   reveal = fixture pi[2..3], zkproof = fixture → dispute clears. Tampered
//   zkproof[0] += 1 → BadProof. (This proves the snark path end-to-end against
//   the pinned verifier with the spike's real vector.)
// resolveTimeout: before deadline → ClockNotExpired; after → disputant gets
//   balance + pot, counterparty gets balance (exact balance deltas); Settled;
//   second resolve → BadStatus
// topUp then openDispute with the pre-top-up state → ConservationViolated;
//   with a fresh post-top-up co-signed state → accepted
```

- [ ] **Step 4: Run** — `cd packages/contracts && npx hardhat test test/ZkTableDispute.test.ts` → green. Then the whole hardhat suite: `npm run test` → no regressions (161 legacy + new all green).

- [ ] **Step 5: Commit**

```bash
git add contracts/zk contracts/test test/ZkTableDispute.test.ts
git commit -m "feat(contracts): ZkTable dispute machine — setup refund, move/share/state answers, chess-clock forfeit"
```

---

### Task 9: Foundry fuzz + invariants

**Files:**
- Create: `packages/contracts/test/foundry/ZkTable.t.sol`
- Create: `packages/contracts/test/foundry/ZkTableInvariant.t.sol`

- [ ] **Step 1: Write the fuzz test (`ZkTable.t.sol`)**

Follow `test/foundry/CoinFlip.t.sol`'s shape. Sign states with `vm.sign` over the EIP-712 digest — recompute it in Solidity:

```solidity
// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ZkTable} from "../../contracts/zk/ZkTable.sol";
import {ChannelState} from "../../contracts/zk/ChannelState.sol";
import {MockGameRules} from "../../contracts/test/MockGameRules.sol";

contract ZkTableFuzzTest is Test {
    ZkTable internal zk;
    MockGameRules internal rules;
    uint256 internal pkA = 0xA11CE;
    uint256 internal pkB = 0xB0B;
    address internal a;
    address internal b;

    function setUp() public {
        zk = new ZkTable();
        rules = new MockGameRules();
        a = vm.addr(pkA);
        b = vm.addr(pkB);
        vm.deal(a, 1_000 ether);
        vm.deal(b, 1_000 ether);
    }

    function _coSign(ChannelState memory s) internal view returns (bytes memory sigA, bytes memory sigB) {
        bytes32 digest = zk.stateDigest(_toCalldataHack(s)); // see note below
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(pkA, digest);
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(pkB, digest);
        sigA = abi.encodePacked(r1, s1, v1);
        sigB = abi.encodePacked(r2, s2, v2);
    }

    // stateDigest takes calldata; from a test, call it via this.external helper or
    // make stateDigest `public` with `memory` — simplest: change stateDigest's
    // param to memory in ZkTable (structHash gets a memory overload in the lib).
    // Do that in ZkTable.sol when writing this test.

    // fuzz cases:
    // testFuzz_createJoinSettle(uint96 escrowA, uint96 stake, uint96 potSplit):
    //   bound inputs, full happy path, assert payouts + zero residue
    // testFuzz_settleRejectsNonConserving(uint96 escrowA, uint96 stake, uint96 skim)
    // testFuzz_timeoutPaysDisputantPot(uint96 ... ): open dispute, roll past
    //   deadline, assert balances
    // testFuzz_clockBounds(uint64 blocks): create reverts outside [30, 60480]
}
```

(The lib overload note: add `function structHashMem(ChannelState memory s) internal pure returns (bytes32)` with identical body to `ChannelStateLib` and have `stateDigest(ChannelState memory)` use it — calldata/memory both usable from tests and other contracts.)

- [ ] **Step 2: Write the invariant suite (`ZkTableInvariant.t.sol`)**

Handler pattern copied from `RaffleInvariant.t.sol` (ghost accounting, try/catch everything, `fail_on_revert = false` is already the profile):

```solidity
contract ZkTableHandler is Test {
    ZkTable public zk;
    MockGameRules public rules;
    uint256 public ghostIn;
    uint256 public ghostOut;
    bytes32[] public liveTables;
    uint64 public nonceSeq = 1;
    // pkA/pkB + addresses as in the fuzz test

    // actions (each bound + try/catch, tracking ghostIn on msg.value and
    // ghostOut on every balance delta observed via address(this)-independent
    // recipient probes — simplest: payout recipients are handler-owned EOAs,
    // measure their balance before/after):
    // createTable(uint96 escrow, uint96 stake)
    // joinTable(uint256 idx)
    // topUpTable(uint256 idx, uint96 amount, bool seatA)
    // settleTable(uint256 idx, uint96 cutA) — co-signs a conserving final state
    // disputeTable(uint256 idx, uint96 cutA, uint96 pot) — conserving state
    // respondState(uint256 idx) — higher-nonce co-sign
    // timeoutTable(uint256 idx) — vm.roll past deadline then resolve
    // cancelTable(uint256 idx)
}

contract ZkTableInvariantTest is StdInvariant, Test {
    // invariant_noWeiStuck: address(zk).balance == handler.ghostIn() - handler.ghostOut()
    // invariant_payoutNeverExceedsEscrow: ghostOut <= ghostIn
    // invariant_terminalTablesHoldNothing: for each table the handler marked
    //   Settled/Cancelled, escrowA == escrowB == 0
}
```

Write the handler actions in full — every action signs real EIP-712 states with `vm.sign` (the headline spec invariant: *no interleaving of creates, joins, top-ups, settles, disputes, and responses ever pays out more than the table's total escrow, and every table reaches a terminal state*).

- [ ] **Step 3: Run** — `cd packages/contracts && forge test --match-contract ZkTable -vv` → fuzz + invariants green (512 fuzz runs / 256×64 invariant runs per foundry.toml).

- [ ] **Step 4: Commit**

```bash
git add test/foundry/ZkTable.t.sol test/foundry/ZkTableInvariant.t.sol contracts/zk
git commit -m "test(contracts): foundry fuzz + escrow-conservation invariants for ZkTable"
```

---

### Task 10: Ignition module + package docs

**Files:**
- Create: `packages/contracts/ignition/modules/ZkCards.ts`
- Modify: `packages/contracts/README.md` (if present — else the contracts section of the repo README; check first)

- [x] **Step 1: Write the module** (mirror the style of `ignition/modules/CoinFlip.ts` — read it first):

```ts
import { buildModule } from '@nomicfoundation/hardhat-ignition/modules'

// Deploys the full ZK cards family: vendored uzkge verifiers (pinned 2ae729db),
// the calldata-shaped 52-card shuffle wrapper, ZkTable, and HiLoWarRules.
// ~11.6M one-time gas (spike-measured) — fine under PulseChain's 45M block limit.
export default buildModule('ZkCards', (m) => {
  const vk1 = m.contract('VerifierKeyExtra1_52', [])
  const vk2 = m.contract('VerifierKeyExtra2_52', [])
  const shuffleVerifier = m.contract('ShuffleVerifier52', [vk1, vk2])
  const revealVerifier = m.contract('RevealVerifier', [])
  const zkTable = m.contract('ZkTable', [])
  const hiLoWarRules = m.contract('HiLoWarRules', [revealVerifier, shuffleVerifier])
  return { vk1, vk2, shuffleVerifier, revealVerifier, zkTable, hiLoWarRules }
})
```

- [x] **Step 2: Smoke-deploy on the hardhat network**

Run: `cd packages/contracts && npx hardhat ignition deploy ignition/modules/ZkCards.ts`
Expected: six deploys succeed. (943/369 deploys are the NEXT plan — do not deploy anywhere real here.)

- [x] **Step 3: Document.** Add a short "ZK cards contracts" section wherever this package documents its contract families (check for `packages/contracts/README.md`): the ZkTable/IGameRules/HiLoWarRules split, the vendored-verifier pin + VENDOR.md pointer, the snark-reveal-only dispute rule, the clock bounds, and that the EIP-712 domain is `("ZkTable", "1", chainId, zkTableAddress)` consumed off-chain via `makeDomain`.

- [x] **Step 4: Commit**

```bash
git add ignition/modules/ZkCards.ts README.md
git commit -m "feat(contracts): ZkCards ignition module + docs"
```

---

### Task 11: Full verification + records

- [x] **Step 1: Full test sweep**

```bash
cd ~/Documents/gibs-finance/random/packages/contracts && npm run test && forge test
cd ../../examples/games/zk-core && pnpm test && pnpm typecheck
cd ../hilo-war && pnpm test && pnpm typecheck
cd ../e2e && pnpm test   # if it has tests; at minimum confirm nothing imports the old hashes
```

Expected: everything green (legacy 161 hardhat + foundry suites included).

- [ ] **Step 2: Push the code repo**

```bash
cd ~/Documents/gibs-finance/random
git push ssh://git@ssh.github.com:443/gibsfinance/random.git games-platform
```

- [x] **Step 3: Update the design spec's open item** (msgboard repo): in `docs/superpowers/specs/2026-06-11-zk-card-games-design.md` "Open items", mark the chess-clock item RESOLVED with the chosen mechanism (creator-set `clockBlocks`, bounds 30–60480, suggested default 360, no dispute bond in v1) and a pointer to this plan.

- [ ] **Step 4: Append the progress entry** (msgboard `progress.txt`, newest-first section at top): contracts plan executed — ZkTable/HiLoWarRules/vendored-verifier summary, parity-fuzz + invariant status, the JSON-hash debt paid (entryDigest abi-structured; hashGameState abi-encoded), commit hashes for both repos. Commit + push msgboard (`master`, signed, ssh over 443).

---

## Self-review notes (already applied)

- The conservation check moved INTO `_checkCoSigned` (Task 8) deliberately changes Task 5's `settle` — Task 8's step removes the then-duplicate check. Executors doing tasks in order will write it once in Task 5 and consolidate in Task 8; that's intended.
- `IGameRules` gains `revealVerifier()` in Task 8; Task 5's mock gets the settable address then. `whoseTurn`/`isFinal`/`hashGameState` are declared `view` (not `pure`) in the interface so mocks can be stateful; `HiLoWarRules` implements them `pure`-compatibly (Solidity allows implementing a `view` interface member with `pure`).
- `stateDigest` parameter becomes `memory` in Task 9 (foundry needs to call it with in-memory structs); the lib keeps both `structHash(calldata)` and `structHashMem(memory)`.
- Spec coverage: create/join/settle/top-up/dispute machine (Tasks 5+8), verifiers reached only from disputes (Task 8; honest path never verifies proofs), HiLoWarRules-as-pure-functions (Task 6), parity (Task 7), hardhat + foundry invariant testing incl. the headline escrow invariant (Tasks 5–9), session pipelining (tables independent by construction; invariant handler exercises interleaving), edge cases: setup-stall full refund (Task 8), top-up at boundary (Tasks 4+5+8), war-pot final-tie split lives OFF-chain in the final co-signed state (the contract only checks conservation + finality — matching the spec). NOT in this plan (later plans, per Spec header): acceptance walkthrough on anvil with two live clients (needs the Zypher adapter), relay/mirror, web, bots, 943/369 deploys.
