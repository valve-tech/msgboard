// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

// NOTE ON PROOF PROVENANCE (GPL): the fixture this test consumes is generated live (via vm.ffi)
// by games/zk-core/scripts/gen-deck-round-trip.mts, which uses the GPLv3-derived
// @zypher-game/secret-engine WASM prover — PoC only, pending license review (same posture as
// ZkTableShowdownDispute.t.sol / gen-showdown-dispute.mts). The vendored EdOnBN254 library and
// the generated DeckConstants.sol are unchanged; only off-chain deck GENERATION is GPL-derived.

import {Test} from "forge-std/Test.sol";
import {DeckConstants} from "../../contracts/zk/DeckConstants.sol";
import {EdOnBN254} from "../../contracts/vendor/uzkge/libraries/EdOnBN254.sol";

/// @notice Round-trip proof that DeckConstants.initialDeck(agg) reproduces the REAL Zypher
/// secret-engine's init_masked_cards(agg, 52) output, word-for-word, in ZkTable's on-chain
/// 208-word deck layout. This is the test that guarantees BOTH:
///   (a) the extracted M_i constants are correct (gen-deck-constants.mts's cross-checks already
///       argue this off-chain, against CardTable52.sol and an independent anchor), and
///   (b) the on-chain WORD LAYOUT DeckConstants.initialDeck emits matches what
///       ZkTable._verifyAndStoreReveal / ShowdownDecodeLib actually consume — a wrong word order
///       would silently break the dispute verifier without this test.
///
/// Fresh random 2-party joint keys are generated PER RUN by gen-deck-round-trip.mts (no static
/// fixture), so this is a live, repeatable proof against whatever secret-engine version is
/// installed — not a frozen snapshot that could silently drift from the real engine.
///
/// Requires --ffi (run via the `ffi` profile):
///   FOUNDRY_PROFILE=ffi forge test --match-contract DeckConstants --ffi
contract DeckConstantsTest is Test {
    function _genRoundTrip() internal returns (uint256 aggX, uint256 aggY, uint256[] memory deck) {
        string[] memory cmd = new string[](2);
        cmd[0] = "../../node_modules/.bin/tsx";
        cmd[1] = "../zk-core/scripts/gen-deck-round-trip.mts";
        bytes memory res = vm.ffi(cmd);
        (aggX, aggY, deck) = abi.decode(res, (uint256, uint256, uint256[]));
    }

    /// The headline assertion: DeckConstants.initialDeck(agg) == the REAL WASM's masked initial
    /// deck, word-for-word, for a fresh random 2-party joint key.
    function test_initialDeck_matchesRealZypherDeck() public {
        (uint256 aggX, uint256 aggY, uint256[] memory wasmDeck) = _genRoundTrip();
        assertEq(wasmDeck.length, 208, "fixture deck length");

        uint256[208] memory onchainDeck = DeckConstants.initialDeck(EdOnBN254.Point(aggX, aggY));

        for (uint256 i = 0; i < 208; i++) {
            assertEq(onchainDeck[i], wasmDeck[i], string.concat("deck word mismatch at index ", vm.toString(i)));
        }
    }

    /// Repeats the round-trip under an INDEPENDENT fresh random joint key (a second `vm.ffi`
    /// invocation, new keys), to rule out a coincidental match against the fixed anchor and to
    /// re-confirm agg-independence end-to-end (not just at the M_i-extraction layer).
    function test_initialDeck_matchesRealZypherDeck_secondIndependentKey() public {
        (uint256 aggX, uint256 aggY, uint256[] memory wasmDeck) = _genRoundTrip();
        assertEq(wasmDeck.length, 208, "fixture deck length");

        uint256[208] memory onchainDeck = DeckConstants.initialDeck(EdOnBN254.Point(aggX, aggY));

        for (uint256 i = 0; i < 208; i++) {
            assertEq(onchainDeck[i], wasmDeck[i], string.concat("deck word mismatch at index ", vm.toString(i)));
        }
    }

    /// Sanity: every card's e1 half of the on-chain-recomputed deck is the fixed generator G,
    /// matching the empirical structure the regen script confirmed (r=1 globally).
    function test_initialDeck_e1IsGeneratorForEveryCard() public {
        (uint256 aggX, uint256 aggY, ) = _genRoundTrip();
        uint256[208] memory onchainDeck = DeckConstants.initialDeck(EdOnBN254.Point(aggX, aggY));
        EdOnBN254.Point memory g = EdOnBN254.generator();
        for (uint256 i = 0; i < 52; i++) {
            assertEq(onchainDeck[4 * i], g.x, "e1.x != G.x");
            assertEq(onchainDeck[4 * i + 1], g.y, "e1.y != G.y");
        }
    }
}
