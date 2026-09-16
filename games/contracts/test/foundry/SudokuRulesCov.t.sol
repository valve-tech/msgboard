// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {SudokuRules} from "../../contracts/zk/SudokuRules.sol";
import {SudokuSolvePlonkVerifier} from "../../contracts/zk/generated/SudokuSolvePlonkVerifier.sol";

/// Coverage-gap closer for SudokuRules._packPuzzle's `require(cell <= 9, ...)` guard, reached only
/// through the external `packPuzzle` wrapper. SudokuRules.t.sol already has ONE out-of-range-cell
/// revert (mid-array, "lo" word) plus many all-legal packings, but forge's branch instrumentation
/// under `--ir-minimum` reports the require's branch node as still unhit either way — see the probe
/// below. This file pins the require's actual on/off-boundary behavior with exact values (not just
/// "reverts somewhere"), across both packed words and both loop edges, so the guard's semantics stay
/// asserted even where the coverage tool's branch counter is blind.
contract SudokuRulesCovTest is Test {
    SudokuRules internal rules;

    function setUp() public {
        SudokuSolvePlonkVerifier verifier = new SudokuSolvePlonkVerifier();
        rules = new SudokuRules(address(verifier));
    }

    /// The all-zero puzzle is the minimum legal input: every cell is exactly the require's lower
    /// bound (0 <= 9), so both packed words must come out zero.
    function test_packPuzzle_allZeros_packsToZero() public view {
        uint256[81] memory p; // zero-initialized
        (uint256 lo, uint256 hi) = rules.packPuzzle(p);
        assertEq(lo, 0, "all-zero puzzle must pack lo=0");
        assertEq(hi, 0, "all-zero puzzle must pack hi=0");
    }

    /// The all-nine puzzle is the maximum LEGAL input (cell == 9, the require's upper bound):
    /// must NOT revert, and must pack to the closed-form all-nibbles-are-9 value on both words.
    function test_packPuzzle_allNines_isLegalBoundary() public view {
        uint256[81] memory p;
        for (uint256 i = 0; i < 81; i++) p[i] = 9;
        (uint256 lo, uint256 hi) = rules.packPuzzle(p);

        uint256 expectedLo;
        for (uint256 i = 0; i < 63; i++) expectedLo |= uint256(9) << (4 * i);
        uint256 expectedHi;
        for (uint256 i = 0; i < 18; i++) expectedHi |= uint256(9) << (4 * i);

        assertEq(lo, expectedLo, "cell==9 (the require's upper bound) must pack, not revert");
        assertEq(hi, expectedHi, "cell==9 (the require's upper bound) must pack, not revert");
    }

    /// One past the boundary (cell == 10) on the very FIRST iteration (i=0, before either packed
    /// word has accumulated anything) must revert with the exact guard message.
    function test_packPuzzle_firstCellOverTen_reverts() public {
        uint256[81] memory p;
        p[0] = 10;
        vm.expectRevert(bytes("SudokuRules: cell > 9"));
        rules.packPuzzle(p);
    }

    /// The LAST cell of the "lo" word (index 62, i < PACK_SPLIT==63) out of range must revert —
    /// pins the guard on the lo/hi split boundary from the low side.
    function test_packPuzzle_lastLoCellOverTen_reverts() public {
        uint256[81] memory p;
        p[62] = 16;
        vm.expectRevert(bytes("SudokuRules: cell > 9"));
        rules.packPuzzle(p);
    }

    /// The FIRST cell of the "hi" word (index 63, i == PACK_SPLIT) out of range must revert —
    /// pins the guard on the lo/hi split boundary from the high side.
    function test_packPuzzle_firstHiCellOverTen_reverts() public {
        uint256[81] memory p;
        p[63] = 16;
        vm.expectRevert(bytes("SudokuRules: cell > 9"));
        rules.packPuzzle(p);
    }

    /// The very LAST cell (index 80, the final loop iteration) out of range must revert — pins the
    /// guard fires on every iteration, not just early-exit ones.
    function test_packPuzzle_lastCellOverTen_reverts() public {
        uint256[81] memory p;
        p[80] = 255;
        vm.expectRevert(bytes("SudokuRules: cell > 9"));
        rules.packPuzzle(p);
    }

    /// A large out-of-range value must revert identically to a barely-over-range one — the guard
    /// is a plain `<= 9` bound, not a masked/truncated check that would silently wrap large inputs.
    function test_packPuzzle_farOverRange_stillReverts() public {
        uint256[81] memory p;
        p[40] = type(uint256).max;
        vm.expectRevert(bytes("SudokuRules: cell > 9"));
        rules.packPuzzle(p);
    }
}
