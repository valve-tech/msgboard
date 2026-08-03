// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {FlipBookX} from "../../contracts/games/FlipBookX.sol";
import {FlipBookBase} from "../../contracts/games/FlipBookBase.sol";
import {MockX402} from "../../contracts/test/MockX402.sol";

/// COVERAGE-ONLY companion to FlipBookX.t.sol / FlipBookXFork.t.sol: no contract changes, just the
/// branches those two files don't reach — the guard errors on the take() precondition chain that
/// revert BEFORE any wrapper call (ZeroStake, the ZeroBond maker-side operand, the three untested
/// BadWindow sub-conditions, AlreadyTaken), the UnknownFlip guard at all four flip-mutating entry
/// points, the ChoiceAlreadyRevealed ordering (revealChoice twice, and claimMakerDefault after an
/// honest reveal even once the window has since lapsed), and revealGuess's own ChoiceNotRevealed
/// check (the existing suite only exercises that error via claimTakerDefault). Closes with three
/// fuzzed value-conservation checks across the settle / makerDefault / takerDefault terminal paths.
/// Setup and helpers mirror FlipBookX.t.sol exactly so the signing path under test is identical.
contract FlipBookXUnitTest is Test {
    MockX402 internal token;
    FlipBookX internal book;

    uint256 internal makerKey = 0xA11CE;
    uint256 internal takerKey = 0xB0B;
    uint256 internal crankKey = 0xC4A2;
    address internal maker;
    address internal taker;
    address internal crank;

    uint256 internal constant STAKE = 10e18;
    uint256 internal constant MAKER_BOND = 2e18;
    uint256 internal constant TAKER_BOND = 1e18;
    uint32 internal constant W1 = 3600; // maker choice window
    uint32 internal constant W2 = 1800; // taker guess window
    bytes32 internal constant SALT = keccak256("maker-salt");
    bytes32 internal constant SALT2 = keccak256("taker-salt");

    bytes32 internal constant RECEIVE_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    function setUp() public {
        token = new MockX402();
        book = new FlipBookX(address(token));
        maker = vm.addr(makerKey);
        taker = vm.addr(takerKey);
        crank = vm.addr(crankKey);
        token.mint(maker, 100e18);
        token.mint(taker, 100e18);
        vm.warp(1_000_000);
    }

    // ── helpers (mirrors FlipBookX.t.sol) ──────────────────────────────────────────────────────

    function _offer(bool choice) internal view returns (FlipBookX.Offer memory o) {
        o = FlipBookX.Offer({
            maker: maker,
            commit: keccak256(abi.encode(maker, choice, SALT)),
            stake: STAKE,
            makerBond: MAKER_BOND,
            takerBond: TAKER_BOND,
            takeDeadline: uint64(block.timestamp + 1 days),
            makerRevealWindow: W1,
            takerRevealWindow: W2
        });
    }

    function _receiveDigest(address from, uint256 value, uint64 validBefore, bytes32 nonce)
        internal
        view
        returns (bytes32)
    {
        bytes32 structHash =
            keccak256(abi.encode(RECEIVE_TYPEHASH, from, address(book), value, uint256(0), validBefore, nonce));
        return keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash));
    }

    function _sign(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _signedOffer(bool choice)
        internal
        view
        returns (FlipBookX.Offer memory o, bytes32 id, bytes memory makerSig)
    {
        o = _offer(choice);
        id = book.offerId(o);
        makerSig = _sign(makerKey, _receiveDigest(maker, STAKE + MAKER_BOND, o.takeDeadline, id));
    }

    function _takerSig(FlipBookX.Offer memory o, bytes32 id) internal view returns (bytes memory) {
        return _sign(takerKey, _receiveDigest(taker, STAKE + TAKER_BOND, o.takeDeadline, book.takerNonce(id, taker)));
    }

    function _guessCommit(bool guess) internal view returns (bytes32) {
        return keccak256(abi.encode(taker, guess, SALT2));
    }

    function _take(bool choice, bool guess) internal returns (bytes32 id) {
        (FlipBookX.Offer memory o, bytes32 id_, bytes memory makerSig) = _signedOffer(choice);
        vm.prank(crank);
        book.take(o, makerSig, taker, _guessCommit(guess), _takerSig(o, id_));
        id = id_;
    }

    // ── take(): guard branches that revert BEFORE any wrapper call ────────────────────────────
    // (so a garbage/empty signature is fine — the check under test fires first)

    function test_take_revertsOnZeroStake() public {
        FlipBookX.Offer memory o = _offer(true);
        o.stake = 0;
        vm.expectRevert(FlipBookBase.ZeroStake.selector);
        book.take(o, "", taker, bytes32(0), "");
    }

    function test_take_revertsOnZeroBond_makerSide() public {
        // The existing suite only zeroes takerBond; this hits the OTHER `||` operand.
        FlipBookX.Offer memory o = _offer(true);
        o.makerBond = 0;
        vm.expectRevert(FlipBookBase.ZeroBond.selector);
        book.take(o, "", taker, bytes32(0), "");
    }

    function test_take_revertsOnMakerWindowTooBig() public {
        FlipBookX.Offer memory o = _offer(true);
        o.makerRevealWindow = book.MAX_REVEAL_WINDOW() + 1;
        vm.expectRevert(FlipBookBase.BadWindow.selector);
        book.take(o, "", taker, bytes32(0), "");
    }

    function test_take_revertsOnTakerWindowTooSmall() public {
        FlipBookX.Offer memory o = _offer(true);
        o.takerRevealWindow = book.MIN_REVEAL_WINDOW() - 1;
        vm.expectRevert(FlipBookBase.BadWindow.selector);
        book.take(o, "", taker, bytes32(0), "");
    }

    function test_take_revertsOnTakerWindowTooBig() public {
        FlipBookX.Offer memory o = _offer(true);
        o.takerRevealWindow = book.MAX_REVEAL_WINDOW() + 1;
        vm.expectRevert(FlipBookBase.BadWindow.selector);
        book.take(o, "", taker, bytes32(0), "");
    }

    function test_take_revertsOnAlreadyTaken() public {
        // The AlreadyTaken check runs BEFORE either escrow pull, so re-submitting the exact same
        // (still-valid) signed offer a second time must die on FlipBookX's own guard, not on the
        // wrapper's nonce-burn (that's a DIFFERENT error, already covered by
        // test_settledOffer_cannotBeReplayed — this flip is still in flight, never settled).
        (FlipBookX.Offer memory o, bytes32 id, bytes memory makerSig) = _signedOffer(true);
        bytes32 gc = _guessCommit(true);
        bytes memory ts = _takerSig(o, id);
        book.take(o, makerSig, taker, gc, ts);

        vm.expectRevert(FlipBookBase.AlreadyTaken.selector);
        book.take(o, makerSig, taker, gc, ts);
    }

    // ── UnknownFlip: all four flip-mutating entry points ───────────────────────────────────────

    function test_revealChoice_revertsOnUnknownFlip() public {
        vm.expectRevert(FlipBookX.UnknownFlip.selector);
        book.revealChoice(keccak256("no-such-flip"), true, SALT);
    }

    function test_revealGuess_revertsOnUnknownFlip() public {
        vm.expectRevert(FlipBookX.UnknownFlip.selector);
        book.revealGuess(keccak256("no-such-flip"), true, SALT2);
    }

    function test_claimMakerDefault_revertsOnUnknownFlip() public {
        vm.expectRevert(FlipBookX.UnknownFlip.selector);
        book.claimMakerDefault(keccak256("no-such-flip"));
    }

    function test_claimTakerDefault_revertsOnUnknownFlip() public {
        vm.expectRevert(FlipBookX.UnknownFlip.selector);
        book.claimTakerDefault(keccak256("no-such-flip"));
    }

    // ── ChoiceAlreadyRevealed: ordering priority over both the reveal window and the default path

    function test_revealChoice_revertsOnChoiceAlreadyRevealed() public {
        bytes32 id = _take(true, true);
        book.revealChoice(id, true, SALT);
        vm.expectRevert(FlipBookX.ChoiceAlreadyRevealed.selector);
        book.revealChoice(id, true, SALT);
    }

    function test_claimMakerDefault_revertsOnChoiceAlreadyRevealed_evenPastTheWindow() public {
        // Maker reveals honestly and on time, then the window lapses anyway (say, because nobody
        // cranked revealGuess yet). claimMakerDefault must still refuse — the maker's liveness
        // duty is done — even though the window-elapsed condition alone would otherwise pass.
        bytes32 id = _take(true, true);
        book.revealChoice(id, true, SALT);
        vm.warp(block.timestamp + W1 + 1);
        vm.expectRevert(FlipBookX.ChoiceAlreadyRevealed.selector);
        book.claimMakerDefault(id);
    }

    // ── ChoiceNotRevealed via revealGuess directly (existing suite only hits it through
    // claimTakerDefault) ────────────────────────────────────────────────────────────────────────

    function test_revealGuess_revertsOnChoiceNotRevealed() public {
        bytes32 id = _take(true, true);
        vm.expectRevert(FlipBookX.ChoiceNotRevealed.selector);
        book.revealGuess(id, true, SALT2);
    }

    // ── value-conservation fuzz: no dust, exact winner delta, total-supply-invariant, across
    // arbitrary stake/bond amounts and every choice/guess combination ─────────────────────────────

    function testFuzz_fullSettle_conservation(
        uint128 stakeSeed,
        uint128 makerBondSeed,
        uint128 takerBondSeed,
        bool choice,
        bool guess
    ) public {
        uint256 stake = bound(uint256(stakeSeed), 1, 1e24);
        uint256 mBond = bound(uint256(makerBondSeed), 1, 1e24);
        uint256 tBond = bound(uint256(takerBondSeed), 1, 1e24);
        token.mint(maker, stake + mBond);
        token.mint(taker, stake + tBond);
        uint256 m0 = token.balanceOf(maker);
        uint256 t0 = token.balanceOf(taker);

        FlipBookX.Offer memory o = FlipBookX.Offer({
            maker: maker,
            commit: keccak256(abi.encode(maker, choice, SALT)),
            stake: stake,
            makerBond: mBond,
            takerBond: tBond,
            takeDeadline: uint64(block.timestamp + 1 days),
            makerRevealWindow: W1,
            takerRevealWindow: W2
        });
        bytes32 id = book.offerId(o);
        bytes memory makerSig = _sign(makerKey, _receiveDigest(maker, stake + mBond, o.takeDeadline, id));
        bytes memory takerSig =
            _sign(takerKey, _receiveDigest(taker, stake + tBond, o.takeDeadline, book.takerNonce(id, taker)));
        bytes32 gc = keccak256(abi.encode(taker, guess, SALT2));

        book.take(o, makerSig, taker, gc, takerSig);
        book.revealChoice(id, choice, SALT);
        book.revealGuess(id, guess, SALT2);

        assertEq(token.balanceOf(address(book)), 0, "no dust for any stake/bond combo");
        assertEq(
            token.balanceOf(maker) + token.balanceOf(taker), m0 + t0, "conservation: no tokens created/destroyed"
        );
        if (guess == choice) {
            assertEq(token.balanceOf(taker), t0 + stake, "taker wins +stake");
            assertEq(token.balanceOf(maker), m0 - stake, "maker loses -stake");
        } else {
            assertEq(token.balanceOf(maker), m0 + stake, "maker wins +stake");
            assertEq(token.balanceOf(taker), t0 - stake, "taker loses -stake");
        }
    }

    function testFuzz_makerDefault_conservation(uint128 stakeSeed, uint128 makerBondSeed, uint128 takerBondSeed)
        public
    {
        uint256 stake = bound(uint256(stakeSeed), 1, 1e24);
        uint256 mBond = bound(uint256(makerBondSeed), 1, 1e24);
        uint256 tBond = bound(uint256(takerBondSeed), 1, 1e24);
        token.mint(maker, stake + mBond);
        token.mint(taker, stake + tBond);
        uint256 m0 = token.balanceOf(maker);
        uint256 t0 = token.balanceOf(taker);

        FlipBookX.Offer memory o = FlipBookX.Offer({
            maker: maker,
            commit: keccak256(abi.encode(maker, true, SALT)),
            stake: stake,
            makerBond: mBond,
            takerBond: tBond,
            takeDeadline: uint64(block.timestamp + 1 days),
            makerRevealWindow: W1,
            takerRevealWindow: W2
        });
        bytes32 id = book.offerId(o);
        bytes memory makerSig = _sign(makerKey, _receiveDigest(maker, stake + mBond, o.takeDeadline, id));
        bytes memory takerSig =
            _sign(takerKey, _receiveDigest(taker, stake + tBond, o.takeDeadline, book.takerNonce(id, taker)));

        book.take(o, makerSig, taker, keccak256(abi.encode(taker, true, SALT2)), takerSig);
        vm.warp(block.timestamp + W1 + 1);
        book.claimMakerDefault(id);

        assertEq(token.balanceOf(address(book)), 0, "no dust");
        assertEq(token.balanceOf(maker) + token.balanceOf(taker), m0 + t0, "conservation");
        assertEq(token.balanceOf(taker), t0 + stake + mBond, "taker nets pot-share + maker bond");
        assertEq(token.balanceOf(maker), m0 - stake - mBond, "maker charged stake + bond");
    }

    function testFuzz_takerDefault_conservation(uint128 stakeSeed, uint128 makerBondSeed, uint128 takerBondSeed)
        public
    {
        uint256 stake = bound(uint256(stakeSeed), 1, 1e24);
        uint256 mBond = bound(uint256(makerBondSeed), 1, 1e24);
        uint256 tBond = bound(uint256(takerBondSeed), 1, 1e24);
        token.mint(maker, stake + mBond);
        token.mint(taker, stake + tBond);
        uint256 m0 = token.balanceOf(maker);
        uint256 t0 = token.balanceOf(taker);

        FlipBookX.Offer memory o = FlipBookX.Offer({
            maker: maker,
            commit: keccak256(abi.encode(maker, true, SALT)),
            stake: stake,
            makerBond: mBond,
            takerBond: tBond,
            takeDeadline: uint64(block.timestamp + 1 days),
            makerRevealWindow: W1,
            takerRevealWindow: W2
        });
        bytes32 id = book.offerId(o);
        bytes memory makerSig = _sign(makerKey, _receiveDigest(maker, stake + mBond, o.takeDeadline, id));
        bytes memory takerSig =
            _sign(takerKey, _receiveDigest(taker, stake + tBond, o.takeDeadline, book.takerNonce(id, taker)));

        book.take(o, makerSig, taker, keccak256(abi.encode(taker, false, SALT2)), takerSig);
        book.revealChoice(id, true, SALT);
        vm.warp(block.timestamp + W2 + 1);
        book.claimTakerDefault(id);

        assertEq(token.balanceOf(address(book)), 0, "no dust");
        assertEq(token.balanceOf(maker) + token.balanceOf(taker), m0 + t0, "conservation");
        assertEq(token.balanceOf(maker), m0 + stake + tBond, "maker nets stake + taker bond");
        assertEq(token.balanceOf(taker), t0 - stake - tBond, "taker charged stake + bond");
    }
}
