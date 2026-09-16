// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {DeckConstants} from "./DeckConstants.sol";
import {ChannelTableBase} from "./ChannelTableBase.sol";

/// One co-signed shuffle-chain link (deckkey-binding-spec.md B2). Free-standing (not nested in
/// ZkTable) so BOTH `ZkTable.sol` and this library can reference the identical type without a
/// circular import — `DeckChallengeLib` needs to accept `DeckShuffleStep[]` in its own signature,
/// and `ZkTable.challengeDeck` needs the exact same type in ITS external signature (the ABI tuple
/// shape must be byte-identical either way; this only affects the Solidity-level type name, not
/// calldata encoding). See ZkTable.sol's `Step` alias / `challengeDeck` for how callers see it.
struct DeckShuffleStep {
    uint8 authorSeat; // 1 or 2 — validated inside `verify`, never trusted bare
    bytes32 beforeHash; // keccak256(abi.encodePacked(uint256[208])) of the deck entering this step
    bytes32 afterHash; // keccak256(abi.encodePacked(uint256[208])) of the deck leaving this step
    bytes32 proofHash; // keccak256(the verify52 proof bytes for this step)
}

/// The vendored calldata-shaped 52-card PLONK shuffle verifier (ShuffleVerifier52.sol),
/// re-declared here (identically to ZkTable.sol's own copy) so this library needs no import of
/// the full vendor dependency graph. NON-VIEW — see ZkTable.sol's `IShuffleVerifier52` header.
interface IShuffleVerifier52DCL {
    function verify52(bytes calldata proof, uint256[] calldata pi, uint256[] calldata pkc) external returns (bool);
}

/// @notice EXTERNAL (separately-deployed) library housing `challengeDeck`'s full cryptographic
/// verification pipeline — deckkey-binding-spec.md B5/§3.3 checks 3 through 8. Extracted out of
/// ZkTable.sol for the SAME reason `ShowdownDecodeLib`/`DeckConstants` are external (see their
/// headers): this is a large, loop-heavy, one-time-per-dispute code path that does not need to
/// live in ZkTable's own deployed bytecode, and keeping it there pushed ZkTable over EIP-170's
/// 24576-byte deployed-code limit. Holds no storage; every input it needs is passed explicitly by
/// `ZkTable._challengeDeck`, which alone decides what to DO with the result (attribution ->
/// `_adjudicateDecoy`) — this library only ever reverts (structural mismatch) or returns
/// (culprit, badStep) from the verify52 attribution loop.
library DeckChallengeLib {
    /// Mirrors ZkTable.BadTranscript exactly (same selector name) — see that error's header for
    /// the "one error for the whole class of transcript-binding failures" rationale.
    error BadTranscript();
    /// Mirrors ChannelTableBase.BadStatus / ChannelTableBase.NotDemanded exactly (same selector
    /// names — a Solidity custom error's 4-byte selector is purely a function of its signature
    /// text, not which contract/library declares it, so off-chain/test code matching on
    /// `ChannelTableBase.BadStatus.selector` etc. still works whichever side actually reverts).
    /// Check 1 of `_challengeDeck`'s ordered checklist (the phase gate) is folded into THIS
    /// function's entry, alongside 2-7, rather than staying inline in ZkTable — since
    /// `_challengeDeck` already makes exactly one external call here regardless, moving a few
    /// more comparisons into it costs NO additional CALL overhead, unlike extracting small logic
    /// into its OWN separate external call would.
    error BadStatus();
    error NotDemanded();

    /// See ZkTable.sol's `VERIFY_GAS_FLOOR` for the full rationale (EIP-150 gas-starvation
    /// framing guard). Duplicated here (not imported) since this library holds no dependency on
    /// ZkTable itself.
    ///
    /// `public` (not `internal`) so this is externally readable off the deployed library address
    /// — see test/ZkGas.test.ts's "VERIFY_GAS_FLOOR" regression guard, which asserts this stays
    /// safely above the measured verify52 execution cost (a real-world figure only obtainable
    /// off-chain via GasProbe) rather than trusting the magic number forever. `public` on a
    /// library constant costs nothing extra in ZkTable's own bytecode — it only adds a getter to
    /// DeckChallengeLib's OWN deployed code, a separate external library already excluded from
    /// ZkTable's EIP-170 budget (see this file's header).
    uint256 public constant VERIFY_GAS_FLOOR = 2_500_000;

    /// Runs the FULL `_challengeDeck` ordered checklist (checks 1-7 — phase gates, transcript
    /// shape/root/head/chain/hash pins, and the verify52 attribution loop) and returns the
    /// attribution result. Reverts on any check failure (see the error list above); `culprit == 0`
    /// on return means every step's `verify52` call succeeded — this does NOT mean the challenge
    /// was frivolous, only that the deck was masked under whatever `pkc` was co-signed (see the
    /// `jointKeyCommit` note below for why that pkc is not provably `Σregistered`'s
    /// `refresh_joint_key` output on-chain); the caller settles this outcome as an unattributable
    /// SPLIT, never a penalty. Otherwise `culprit` is the `authorSeat` of the first failing step
    /// (`badStep`, 0-indexed) — a real, attributable forfeiture.
    ///
    /// `status`/`demandKind` are the table's OWN fields (must be Disputed / DEMAND_DECOY — `4` is
    /// ZkTable.DEMAND_DECOY, hardcoded here since this library has no ZkTable dependency to
    /// import it from). `k1`/`k2` are the table's two REGISTERED `deckKeys` — `agg`/`D0` are
    /// derived from them ON-CHAIN via `DeckConstants.initialDeckAndAgg`, never from a
    /// caller-supplied aggregate (C1). `jointKeyCommit`/`shuffleRoot`/`deckCommitment` are the
    /// three commitments from the table's co-signed `disputeState`. A zero `verifier` (see
    /// ZkTable.sol's deploy-time degradation note) fails closed via `BadTranscript` before any
    /// verify52 call is attempted.
    function verify(
        IShuffleVerifier52DCL verifier,
        ChannelTableBase.Status status,
        uint8 demandKind,
        uint256[2] memory k1,
        uint256[2] memory k2,
        uint256[24] calldata pkc,
        DeckShuffleStep[] calldata steps,
        uint256[][] calldata afterDecks,
        bytes[] calldata proofs,
        bytes32 jointKeyCommit,
        bytes32 shuffleRoot,
        bytes32 deckCommitment
    ) external returns (uint8 culprit, uint8 badStep) {
        // (0) zero verifier: an explicit, cheap fail-closed rather than relying on the try/catch
        // below to fall through correctly. Belt-and-braces, not load-bearing — a call to a
        // codeless address still succeeds with empty returndata, but Solidity's `try` does NOT
        // catch the subsequent ABI-decode failure (decoding `returns (bool)` out of zero bytes);
        // that decode failure itself reverts the whole external call, which the surrounding
        // `catch` below already handles as a step failure. This guard exists purely to give a
        // clearer revert reason (and skip the wasted call) at deploy-time verifier misconfig.
        if (address(verifier) == address(0)) revert BadTranscript();
        // (1) phase gates
        if (status != ChannelTableBase.Status.Disputed) revert BadStatus();
        if (demandKind != 4) revert NotDemanded(); // 4 == ZkTable.DEMAND_DECOY

        // (2) transcript shape
        uint256 n = steps.length;
        if (n == 0 || afterDecks.length != n || proofs.length != n) revert BadTranscript();

        // (3) root pins order + author + proofHash (C2)
        if (keccak256(abi.encode(steps)) != shuffleRoot) revert BadTranscript();

        // (4)-(5) derive agg = Σ registered deckKeys + the canonical head D0 ON-CHAIN (C1) — no
        // caller-supplied aggregate ever enters this computation.
        (uint256[] memory d0, uint256 aggX, uint256 aggY) = DeckConstants.initialDeckAndAgg(k1, k2);
        // jointKeyCommit binds the PAIR (derived agg, supplied pkc) to what was co-signed — one
        // keccak over (agg, pkc). This is NOT proof that `pkc == refresh_joint_key(agg)`: nothing
        // on-chain can recompute that refresh from `agg` alone (Mechanism A — proving the pkc/agg
        // relationship on-chain — was struck; see deckkey-binding-spec.md). So "the pinned pkc
        // matches what was co-signed" only tells us the deck was masked under whatever pkc both
        // seats agreed to at co-sign time — it does NOT tell us that pkc was honestly derived from
        // `agg`. A mismatch between the two is co-sign-time binding fraud the contract cannot
        // attribute to a seat, which is exactly why every-step-verifies (`culprit == 0`) settles
        // as a split, not a frivolous-challenge penalty. NB fixed-size uint256[24] abi.encode (24
        // inline words, no offset/length) — an off-chain encoder MUST encode `pkc` as
        // `uint256[24]`, never a dynamic `uint256[]`, or this recomputes a different hash.
        if (keccak256(abi.encode(aggX, aggY, pkc)) != jointKeyCommit) revert BadTranscript();

        // (6) head + per-step chain + tail binding
        if (steps[0].beforeHash != keccak256(abi.encodePacked(d0))) revert BadTranscript();
        for (uint256 i = 0; i < n; i++) {
            if (steps[i].authorSeat != 1 && steps[i].authorSeat != 2) revert BadTranscript();
            if (i > 0 && steps[i].beforeHash != steps[i - 1].afterHash) revert BadTranscript();
            if (afterDecks[i].length != 208) revert BadTranscript();
            if (keccak256(abi.encodePacked(afterDecks[i])) != steps[i].afterHash) revert BadTranscript();
            if (keccak256(proofs[i]) != steps[i].proofHash) revert BadTranscript();
        }
        if (steps[n - 1].afterHash != deckCommitment) revert BadTranscript();

        // (7) verify each step vs the PINNED pkc; first failure attributes its author. Culprit
        // stays 0 (no real seat) if every step verifies — an UNATTRIBUTABLE outcome (see this
        // function's header: it does not prove the challenge was frivolous, only that the deck
        // decoded under whatever pkc was co-signed), which the caller settles as a split.
        uint256[] memory pkcDyn = new uint256[](24);
        for (uint256 i = 0; i < 24; i++) pkcDyn[i] = pkc[i];
        uint256[] memory prev = d0;
        for (uint256 i = 0; i < n; i++) {
            // verify52's PLONK circuit was generated against the Zypher WASM prover's OWN masked-
            // card word order — [e2.x, e2.y, e1.x, e1.y] per card (confirmed empirically: the
            // ShuffleVerifier52Positive fixture feeds `pi` straight from the WASM's raw tuples,
            // unreordered, and verifies true on-chain) — the OPPOSITE per-card half-order from
            // ZkTable's own deck-commitment convention, [e1.x, e1.y, e2.x, e2.y] (see
            // DeckConstants' layout note / ShowdownDecodeLib / _verifyAndStoreReveal). `prev` and
            // `afterDecks[i]` arrive here in ZkTable's convention (that's what their hashes were
            // pinned against above); swap each card's two halves when building `pi` so the real
            // circuit sees the word order it expects. Getting this backwards would make every
            // genuine proof fail verification.
            uint256[] memory pi = new uint256[](416);
            for (uint256 c = 0; c < 52; c++) {
                uint256 base = 4 * c;
                pi[base] = prev[base + 2];
                pi[base + 1] = prev[base + 3];
                pi[base + 2] = prev[base];
                pi[base + 3] = prev[base + 1];
                pi[208 + base] = afterDecks[i][base + 2];
                pi[208 + base + 1] = afterDecks[i][base + 3];
                pi[208 + base + 2] = afterDecks[i][base];
                pi[208 + base + 3] = afterDecks[i][base + 1];
            }
            if (gasleft() < VERIFY_GAS_FLOOR) revert BadTranscript();
            try verifier.verify52(proofs[i], pi, pkcDyn) returns (bool ok) {
                if (!ok) {
                    culprit = steps[i].authorSeat;
                    badStep = uint8(i);
                    break;
                }
                prev = afterDecks[i];
            } catch {
                culprit = steps[i].authorSeat;
                badStep = uint8(i);
                break;
            }
        }
    }

    /// Shared Groth16 reveal-share verification, moved here VERBATIM from what used to be two
    /// byte-identical inline copies in ZkTable.sol (`respondWithShare` and
    /// `_verifyAndStoreReveal`): a raw `staticcall` into the rules contract's `revealVerifier()`
    /// at `verifyRevealWithSnark(uint256[6],uint256[8])`, low-level-decoded exactly as before.
    /// Returns `false` (never reverts itself) on every failure mode the original inline code
    /// treated as rejection — a failed call, short returndata, or a decoded `false` — so both
    /// call sites' own `if (!ok) revert BadProof()` (unchanged there) preserves the exact same
    /// checks, order, and revert selector as before this dedup.
    function verifyReveal(address revealVerifier, uint256[6] memory pi, uint256[8] calldata zkproof)
        external
        view
        returns (bool ok)
    {
        (bool callOk, bytes memory ret) = revealVerifier.staticcall(
            abi.encodeWithSignature("verifyRevealWithSnark(uint256[6],uint256[8])", pi, zkproof)
        );
        ok = callOk && ret.length >= 32 && abi.decode(ret, (bool));
    }
}
