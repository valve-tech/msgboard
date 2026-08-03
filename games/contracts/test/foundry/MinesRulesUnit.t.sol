// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MinesRules} from "../../contracts/games/MinesRules.sol";
import {MinesRulesHarness} from "./MinesRules.t.sol";

/// External wrapper exposing the two fixed-point-multiplier pure functions and hashBoard so
/// vm.expectRevert can catch the `require` in fairMultiplierX100 (an internal call within the
/// test's own frame is not a "next call" boundary; routing through an external call is), and so
/// fuzzers can call them without touching `settle`'s replay machinery.
contract MinesRulesPureHarness {
    function fairMultiplierX100(uint256 tiles, uint256 mines, uint256 safeRevealed)
        external
        pure
        returns (uint256)
    {
        return MinesRules.fairMultiplierX100(tiles, mines, safeRevealed);
    }

    function multiplierX100At(uint256 tiles, uint256 mines, uint256 safeRevealed)
        external
        pure
        returns (uint256)
    {
        return MinesRules.multiplierX100At(tiles, mines, safeRevealed);
    }
}

/// Coverage-closing unit + fuzz suite for MinesRules.sol. MinesRules.t.sol already pins TS parity
/// for the happy paths (win/bust) and a handful of rejections (CommitMismatch, MultiplierMismatch,
/// two IllegalMove shapes). This file closes out the remaining error surface — BadConfig, BadBoard,
/// BadReveal, PayoutExceedsPot — and adds fuzz coverage of the board-validation and reveal-replay
/// branches (_validateConfig, _validateBoard, the settle() reveal loop, fairMultiplierX100). It
/// reuses MinesRulesHarness (external wrapper, needed so vm.expectRevert can see reverts of the
/// inlined-internal library) from MinesRules.t.sol rather than redefining it.
contract MinesRulesUnitTest is Test {
    MinesRulesHarness internal h;
    MinesRulesPureHarness internal ph;

    function setUp() public {
        h = new MinesRulesHarness();
        ph = new MinesRulesPureHarness();
    }

    // Same fixture board as MinesRules.t.sol: 25 tiles, 3 mines at {5,12,20}, salt = 0x22..22.
    uint256 internal constant STAKE = 200;
    uint256 internal constant ESCROW_HOUSE = 455200; // pot = 455400 = ceiling payout (227700 * 200/100)
    bytes32 internal constant SALT =
        bytes32(uint256(0x2222222222222222222222222222222222222222222222222222222222222222));
    bytes32 internal constant COMMIT = 0x1365a47735e9e864602b454bcc43a563c87d5e99e34dcc3fca31f8428b9c61e3;
    uint16 internal constant TILES = 25;
    uint16 internal constant MINES = 3;
    uint256 internal constant MULT_WIN = 198;
    uint256 internal constant PAYOUT_WIN = 396;

    // ---------------------------------------------------------------------------
    // helpers
    // ---------------------------------------------------------------------------

    function _mineTiles() internal pure returns (uint16[] memory a) {
        a = new uint16[](3);
        a[0] = 5;
        a[1] = 12;
        a[2] = 20;
    }

    function _claim(uint16 tiles_, uint16 mines_, bytes32 commit_, uint16[] memory reveals_, bool cashedOut_, uint256 mult_)
        internal
        pure
        returns (MinesRules.MinesClaim memory c)
    {
        c.tiles = tiles_;
        c.mines = mines_;
        c.commit = commit_;
        c.reveals = reveals_;
        c.cashedOut = cashedOut_;
        c.claimedMultiplierX100 = mult_;
    }

    function _defaultClaim(uint16[] memory reveals_, bool cashedOut_, uint256 mult_)
        internal
        pure
        returns (MinesRules.MinesClaim memory)
    {
        return _claim(TILES, MINES, COMMIT, reveals_, cashedOut_, mult_);
    }

    function _arr1(uint16 a) internal pure returns (uint16[] memory r) {
        r = new uint16[](1);
        r[0] = a;
    }

    function _arr2(uint16 a, uint16 b) internal pure returns (uint16[] memory r) {
        r = new uint16[](2);
        r[0] = a;
        r[1] = b;
    }

    function _arr5(uint16 a, uint16 b, uint16 c, uint16 d, uint16 e) internal pure returns (uint16[] memory r) {
        r = new uint16[](5);
        r[0] = a;
        r[1] = b;
        r[2] = c;
        r[3] = d;
        r[4] = e;
    }

    function _empty() internal pure returns (uint16[] memory r) {
        r = new uint16[](0);
    }

    /// The first `k` SAFE (non-mine) tile indices of the fixture board (mines at {5,12,20}), in
    /// ascending order. Used to build well-formed reveal prefixes of any length up to safe=22.
    function _firstKSafeTiles(uint256 k) internal pure returns (uint16[] memory r) {
        r = new uint16[](k);
        uint16 t = 0;
        uint256 filled = 0;
        while (filled < k) {
            if (t != 5 && t != 12 && t != 20) {
                r[filled] = t;
                filled++;
            }
            t++;
        }
    }

    function _appendTile(uint16[] memory base, uint16 tile) internal pure returns (uint16[] memory r) {
        r = new uint16[](base.length + 1);
        for (uint256 i = 0; i < base.length; i++) r[i] = base[i];
        r[base.length] = tile;
    }

    // ---------------------------------------------------------------------------
    // BadConfig — _validateConfig, all four range checks
    // ---------------------------------------------------------------------------

    function test_reject_badConfig_tilesTooSmall() public {
        vm.expectRevert(MinesRules.BadConfig.selector);
        h.settle(_claim(1, 1, bytes32(0), _empty(), false, 0), _empty(), SALT, STAKE, ESCROW_HOUSE);
    }

    function test_reject_badConfig_tilesTooLarge() public {
        vm.expectRevert(MinesRules.BadConfig.selector);
        h.settle(_claim(257, 1, bytes32(0), _empty(), false, 0), _empty(), SALT, STAKE, ESCROW_HOUSE);
    }

    function test_reject_badConfig_minesZero() public {
        vm.expectRevert(MinesRules.BadConfig.selector);
        h.settle(_claim(25, 0, bytes32(0), _empty(), false, 0), _empty(), SALT, STAKE, ESCROW_HOUSE);
    }

    function test_reject_badConfig_minesTooLarge() public {
        // mines must be <= tiles-1; mines == tiles is one past the ceiling.
        vm.expectRevert(MinesRules.BadConfig.selector);
        h.settle(_claim(25, 25, bytes32(0), _empty(), false, 0), _empty(), SALT, STAKE, ESCROW_HOUSE);
    }

    /// Boundary: tiles == MIN_TILES (2) and mines == tiles-1 (the max allowed) both pass
    /// _validateConfig — proven by reaching _validateBoard (BadBoard on the empty board) rather
    /// than BadConfig.
    function test_boundary_minTiles_configPasses_thenBadBoard() public {
        vm.expectRevert(MinesRules.BadBoard.selector);
        h.settle(_claim(2, 1, bytes32(0), _empty(), false, 0), _empty(), SALT, STAKE, ESCROW_HOUSE);
    }

    /// Boundary: tiles == MAX_TILES (256) passes _validateConfig.
    function test_boundary_maxTiles_configPasses_thenBadBoard() public {
        vm.expectRevert(MinesRules.BadBoard.selector);
        h.settle(_claim(256, 1, bytes32(0), _empty(), false, 0), _empty(), SALT, STAKE, ESCROW_HOUSE);
    }

    /// Full fuzz of _validateConfig's range logic. Given an empty mineTiles board, the outcome is
    /// fully determined: BadConfig for any out-of-range (tiles,mines), else — since mines>=1 in the
    /// valid region and the board is empty — BadBoard (length mismatch), never CommitMismatch or
    /// beyond. This nails down both branches of both range checks across the full uint16 domain.
    function testFuzz_validateConfig(uint256 tilesRaw, uint256 minesRaw) public {
        uint16 tiles = uint16(bound(tilesRaw, 0, type(uint16).max));
        uint16 mines = uint16(bound(minesRaw, 0, type(uint16).max));
        MinesRules.MinesClaim memory c = _claim(tiles, mines, bytes32(0), _empty(), false, 0);

        if (tiles < 2 || tiles > 256) {
            vm.expectRevert(MinesRules.BadConfig.selector);
            h.settle(c, _empty(), SALT, STAKE, ESCROW_HOUSE);
            return;
        }
        if (mines < 1 || mines > tiles - 1) {
            vm.expectRevert(MinesRules.BadConfig.selector);
            h.settle(c, _empty(), SALT, STAKE, ESCROW_HOUSE);
            return;
        }
        vm.expectRevert(MinesRules.BadBoard.selector);
        h.settle(c, _empty(), SALT, STAKE, ESCROW_HOUSE);
    }

    // ---------------------------------------------------------------------------
    // BadBoard — _validateBoard, all three shape checks
    // ---------------------------------------------------------------------------

    function test_reject_badBoard_wrongLength() public {
        // mines=3 but only 2 mine tiles supplied.
        vm.expectRevert(MinesRules.BadBoard.selector);
        h.settle(_claim(TILES, MINES, COMMIT, _empty(), false, 0), _arr2(5, 12), SALT, STAKE, ESCROW_HOUSE);
    }

    function test_reject_badBoard_tileOutOfRange() public {
        vm.expectRevert(MinesRules.BadBoard.selector);
        h.settle(_claim(10, 1, bytes32(0), _empty(), false, 0), _arr1(10), SALT, STAKE, ESCROW_HOUSE);
    }

    function test_reject_badBoard_notSorted() public {
        uint16[] memory bad = new uint16[](3);
        bad[0] = 12;
        bad[1] = 5;
        bad[2] = 20; // descending pair
        vm.expectRevert(MinesRules.BadBoard.selector);
        h.settle(_defaultClaim(_empty(), false, 0), bad, SALT, STAKE, ESCROW_HOUSE);
    }

    /// Fuzz the strictly-ascending/distinct check directly: a 2-mine board on a 50-tile config
    /// where the two mine indices are NOT strictly ascending (b <= a) must always revert BadBoard,
    /// covering both the "duplicate" (b == a) and "descending" (b < a) sub-cases.
    function testFuzz_validateBoard_notAscending(uint256 aRaw, uint256 bRaw) public {
        uint16 tiles = 50;
        uint16 a = uint16(bound(aRaw, 0, tiles - 1));
        uint16 b = uint16(bound(bRaw, 0, a)); // b <= a ⇒ not strictly ascending
        vm.expectRevert(MinesRules.BadBoard.selector);
        h.settle(_claim(tiles, 2, bytes32(0), _empty(), false, 0), _arr2(a, b), SALT, STAKE, ESCROW_HOUSE);
    }

    /// Fuzz the length check in isolation: any board length other than `mines` (25) reverts
    /// BadBoard, regardless of the (well-formed, ascending, in-range) contents supplied.
    function testFuzz_validateBoard_wrongLength(uint256 lenRaw) public {
        uint16 tiles = 50;
        uint16 mines = 25;
        uint256 providedLen = bound(lenRaw, 0, tiles - 1);
        vm.assume(providedLen != mines);
        uint16[] memory board = new uint16[](providedLen);
        for (uint256 i = 0; i < providedLen; i++) board[i] = uint16(i); // ascending, in-range
        vm.expectRevert(MinesRules.BadBoard.selector);
        h.settle(_claim(tiles, mines, bytes32(0), _empty(), false, 0), board, SALT, STAKE, ESCROW_HOUSE);
    }

    // ---------------------------------------------------------------------------
    // CommitMismatch — fuzzed on top of the one hand-picked vector in MinesRules.t.sol
    // ---------------------------------------------------------------------------

    function testFuzz_reject_commitMismatch_wrongSalt(bytes32 wrongSalt) public {
        vm.assume(wrongSalt != SALT);
        vm.expectRevert(MinesRules.CommitMismatch.selector);
        h.settle(_defaultClaim(_arr5(0, 1, 2, 3, 4), true, MULT_WIN), _mineTiles(), wrongSalt, STAKE, ESCROW_HOUSE);
    }

    // ---------------------------------------------------------------------------
    // BadReveal — reveal tile index out of [0, tiles)
    // ---------------------------------------------------------------------------

    function test_reject_badReveal_outOfRange() public {
        vm.expectRevert(MinesRules.BadReveal.selector);
        h.settle(_defaultClaim(_arr1(25), false, 0), _mineTiles(), SALT, STAKE, ESCROW_HOUSE);
    }

    function testFuzz_reject_badReveal_outOfRange(uint256 tileRaw) public {
        uint16 tile = uint16(bound(tileRaw, TILES, type(uint16).max));
        vm.expectRevert(MinesRules.BadReveal.selector);
        h.settle(_defaultClaim(_arr1(tile), false, 0), _mineTiles(), SALT, STAKE, ESCROW_HOUSE);
    }

    // ---------------------------------------------------------------------------
    // IllegalMove — duplicate reveal, cash-out/bust contradictions, cash-out-before-any-reveal
    // ---------------------------------------------------------------------------

    /// Duplicate check fires on the SECOND occurrence of a repeated tile. Fuzzed over any safe
    /// (non-mine) tile — a repeated MINE tile can never reach the duplicate check because the loop
    /// busts-and-breaks on the first occurrence, before a second iteration is ever examined.
    function testFuzz_reject_duplicateReveal(uint256 tileRaw) public {
        uint16 tile = uint16(bound(tileRaw, 0, TILES - 1));
        vm.assume(tile != 5 && tile != 12 && tile != 20);
        uint256 mult = MinesRules.multiplierX100At(TILES, MINES, 1);
        vm.expectRevert(MinesRules.IllegalMove.selector);
        h.settle(_defaultClaim(_arr2(tile, tile), true, mult), _mineTiles(), SALT, STAKE, ESCROW_HOUSE);
    }

    /// Claiming cash-out with zero reveals — revealedCount == 0 branch.
    function test_reject_illegalMove_cashOutWithNoReveals() public {
        vm.expectRevert(MinesRules.IllegalMove.selector);
        h.settle(_defaultClaim(_empty(), true, 100), _mineTiles(), SALT, STAKE, ESCROW_HOUSE);
    }

    /// Fuzzed "claimed bust but never hit a mine": any prefix of 1..22 safe reveals, claiming a bust.
    function testFuzz_reject_illegalMove_bustClaimWithoutMine(uint256 kRaw) public {
        uint256 k = bound(kRaw, 1, 22);
        vm.expectRevert(MinesRules.IllegalMove.selector);
        h.settle(_defaultClaim(_firstKSafeTiles(k), false, 0), _mineTiles(), SALT, STAKE, ESCROW_HOUSE);
    }

    /// Fuzzed "claimed cash-out but a reveal sequence that actually hit a mine": any prefix of
    /// 0..22 safe reveals followed by one of the three mine tiles, claiming cash-out.
    function testFuzz_reject_illegalMove_cashOutAfterBust(uint256 kRaw, uint256 mineIdxRaw) public {
        uint256 k = bound(kRaw, 0, 22);
        uint256 mineIdx = bound(mineIdxRaw, 0, 2);
        uint16[] memory mines_ = _mineTiles();
        uint16[] memory reveals = _appendTile(_firstKSafeTiles(k), mines_[mineIdx]);
        vm.expectRevert(MinesRules.IllegalMove.selector);
        h.settle(_defaultClaim(reveals, true, 0), mines_, SALT, STAKE, ESCROW_HOUSE);
    }

    // ---------------------------------------------------------------------------
    // MultiplierMismatch — fuzzed claimed value vs. the honest replay
    // ---------------------------------------------------------------------------

    function testFuzz_reject_multiplierMismatch(uint256 otherRaw) public {
        uint256 other = bound(otherRaw, 0, 1_000_000);
        vm.assume(other != MULT_WIN);
        vm.expectRevert(MinesRules.MultiplierMismatch.selector);
        h.settle(_defaultClaim(_arr5(0, 1, 2, 3, 4), true, other), _mineTiles(), SALT, STAKE, ESCROW_HOUSE);
    }

    // ---------------------------------------------------------------------------
    // PayoutExceedsPot — escrowHouse too small to cover the honest payout
    // ---------------------------------------------------------------------------

    function test_reject_payoutExceedsPot() public {
        // stake=200, mult=198 -> payout=396; pot=stake+0=200 < 396.
        vm.expectRevert(MinesRules.PayoutExceedsPot.selector);
        h.settle(_defaultClaim(_arr5(0, 1, 2, 3, 4), true, MULT_WIN), _mineTiles(), SALT, STAKE, 0);
    }

    /// Fuzzed boundary either side of payout == pot (payout = 396 needs escrowHouse >= 196).
    function testFuzz_payoutExceedsPot_boundary(uint256 escrowHouseRaw) public {
        uint256 escrowHouse = bound(escrowHouseRaw, 0, 1_000_000);
        MinesRules.MinesClaim memory c = _defaultClaim(_arr5(0, 1, 2, 3, 4), true, MULT_WIN);
        if (STAKE + escrowHouse < PAYOUT_WIN) {
            vm.expectRevert(MinesRules.PayoutExceedsPot.selector);
            h.settle(c, _mineTiles(), SALT, STAKE, escrowHouse);
        } else {
            (uint256 bP, uint256 bH) = h.settle(c, _mineTiles(), SALT, STAKE, escrowHouse);
            assertEq(bP, PAYOUT_WIN);
            assertEq(bP + bH, STAKE + escrowHouse);
        }
    }

    // ---------------------------------------------------------------------------
    // reveal-count / replay logic — fuzzed cash-out at every possible depth (1..22 safe reveals)
    // ---------------------------------------------------------------------------

    function testFuzz_settle_cashOutAtEveryDepth(uint256 kRaw) public {
        uint256 k = bound(kRaw, 1, 22); // 22 == safe tiles on the fixture board
        uint256 mult = MinesRules.multiplierX100At(TILES, MINES, k);
        (uint256 bP, uint256 bH) =
            h.settle(_defaultClaim(_firstKSafeTiles(k), true, mult), _mineTiles(), SALT, STAKE, ESCROW_HOUSE);
        assertEq(bP, (STAKE * mult) / 100);
        assertEq(bP + bH, STAKE + ESCROW_HOUSE); // conservation at every depth
    }

    /// Smallest legal board (MIN_TILES=2, mines=1): full settle round-trip, computing the commit
    /// via hashBoard directly rather than a pre-baked vector.
    function test_settle_minimalBoard_win() public {
        uint16[] memory board = _arr1(1); // tile 1 is the mine; tile 0 is safe
        bytes32 commit = MinesRules.hashBoard(2, 1, board, SALT);
        uint256 mult = MinesRules.multiplierX100At(2, 1, 1); // fair = 2/1 = 2.00x -> edged 198
        assertEq(mult, 198);
        (uint256 bP, uint256 bH) =
            h.settle(_claim(2, 1, commit, _arr1(0), true, mult), board, SALT, 100, 100);
        assertEq(bP, 198); // 100 * 198 / 100
        assertEq(bP + bH, 200);
    }

    // ---------------------------------------------------------------------------
    // fairMultiplierX100 / multiplierX100At — direct pure-function coverage
    // ---------------------------------------------------------------------------

    function test_fairMultiplierX100_zeroReveals() public pure {
        assertEq(MinesRules.fairMultiplierX100(TILES, MINES, 0), 100); // 1.00x at k=0, any board
    }

    function test_fairMultiplierX100_matchesEdgedVector() public pure {
        // fair = 25*24*23*22*21*100 / (22*21*20*19*18) = 637560000/3160080 = 201 (floor);
        // 201*99/100 = 198 (floor) == the TS-pinned edged vector in MinesRules.t.sol.
        assertEq(MinesRules.fairMultiplierX100(TILES, MINES, 5), 201);
    }

    /// The require(safeRevealed <= safe) guard. Routed through the external pure-harness so
    /// vm.expectRevert can observe it (an unguarded internal call in the same frame is not a
    /// call boundary the cheatcode can intercept).
    function testFuzz_fairMultiplier_revertsWhenSafeRevealedExceedsSafe(
        uint256 tilesRaw,
        uint256 minesRaw,
        uint256 safeRevealedRaw
    ) public {
        uint16 tiles = uint16(bound(tilesRaw, 2, 256));
        uint16 mines = uint16(bound(minesRaw, 1, tiles - 1));
        uint256 safe = uint256(tiles) - mines;
        uint256 safeRevealed = bound(safeRevealedRaw, safe + 1, safe + 1_000_000);
        vm.expectRevert(bytes("mines: safeRevealed out of range"));
        ph.fairMultiplierX100(tiles, mines, safeRevealed);
    }

    /// fairMultiplierX100 in-range never reverts and multiplierX100At is exactly its 99%-edged
    /// counterpart, across fuzzed (tiles, mines, safeRevealed) triples.
    function testFuzz_fairMultiplier_edgeRelation(uint256 tilesRaw, uint256 minesRaw, uint256 safeRevealedRaw)
        public
    {
        // tiles capped at 40: fair's numerator is a falling factorial of `tiles`, worst case
        // (mines=1, safeRevealed=tiles-1) == tiles!; tiles=40 -> ~8.16e47, comfortably inside
        // uint256, whereas tiles ~58+ would genuinely overflow the product (a real limitation of
        // the fixed-point formula on very thin, very large boards — not something this coverage
        // pass changes, just avoided here so the fuzzer explores valid, non-overflowing inputs).
        uint16 tiles = uint16(bound(tilesRaw, 2, 40));
        uint16 mines = uint16(bound(minesRaw, 1, tiles - 1));
        uint256 safe = uint256(tiles) - mines;
        uint256 safeRevealed = bound(safeRevealedRaw, 0, safe);

        uint256 fair = ph.fairMultiplierX100(tiles, mines, safeRevealed);
        uint256 edged = ph.multiplierX100At(tiles, mines, safeRevealed);
        assertEq(edged, (fair * 99) / 100);
        if (safeRevealed == 0) assertEq(fair, 100);
    }

    // ---------------------------------------------------------------------------
    // hashBoard — board-derivation coverage: salt sensitivity + the zero-length loop edge
    // ---------------------------------------------------------------------------

    function testFuzz_hashBoard_saltSensitivity(bytes32 salt1, bytes32 salt2) public pure {
        vm.assume(salt1 != salt2);
        bytes32 h1 = MinesRules.hashBoard(TILES, MINES, _mineTiles(), salt1);
        bytes32 h2 = MinesRules.hashBoard(TILES, MINES, _mineTiles(), salt2);
        assertTrue(h1 != h2);
    }

    /// mines >= 1 is enforced everywhere settle() reaches hashBoard, so the mineTiles-loop always
    /// runs >=1 iteration on that path. Exercise the zero-iteration edge by calling hashBoard
    /// directly (bypassing settle/_validateConfig entirely, which is fine — hashBoard itself does
    /// not constrain tiles/mines).
    function test_hashBoard_emptyMineTiles_loopSkipped() public pure {
        bytes32 out = MinesRules.hashBoard(1000, 0, _empty(), SALT);
        assertTrue(out != bytes32(0));
    }
}
