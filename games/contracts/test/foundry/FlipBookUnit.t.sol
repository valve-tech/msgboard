// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {FlipBook} from "../../contracts/games/FlipBook.sol";
import {RejectingTaker} from "../../contracts/test/RejectingTaker.sol";

/// Coverage-only Foundry suite for FlipBook (native-ETH P2P coin flip, variant A). FlipBook
/// shipped with only a Hardhat suite (test/FlipBook.test.ts) and zero Foundry tests; this suite
/// exercises every external/public function, all 15 custom errors, and the reveal/take window
/// boundaries, and mirrors the Hardhat suite's scenarios (including the RejectingTaker
/// pull-fallback case) in Foundry so `forge coverage` sees the contract.
///
/// Sibling shape: test/foundry/FlipBookX.t.sol (variant B, off-chain-signed, ERC-20). FlipBook
/// itself needs no randomness engine (no MockRandom import) — the "randomness" here is each
/// side's own hidden coin, not a validator oracle.
contract FlipBookUnitTest is Test {
    FlipBook internal book;

    address internal maker = makeAddr("maker");
    address internal taker = makeAddr("taker");
    address internal cranker = makeAddr("cranker");
    address internal stranger = makeAddr("stranger");

    uint256 internal constant STAKE = 1 ether;
    uint256 internal constant BOND = 0.2 ether;
    uint32 internal constant REVEAL_WINDOW = 3600;
    uint256 internal constant DAY = 1 days;

    bytes32 internal constant SALT = keccak256("flip-salt-1");

    function setUp() public {
        book = new FlipBook();
        vm.deal(maker, 100 ether);
        vm.deal(taker, 100 ether);
        vm.deal(cranker, 100 ether);
        vm.deal(stranger, 100 ether);
        vm.warp(1_000_000);
    }

    function _commit(address who, bool choice, bytes32 salt) internal pure returns (bytes32) {
        return keccak256(abi.encode(who, choice, salt));
    }

    /// Post a standard offer (choice fixed by caller); returns its id.
    function _post(bool choice) internal returns (uint256 id) {
        bytes32 c = _commit(maker, choice, SALT);
        vm.prank(maker);
        id = book.post{value: STAKE + BOND}(c, BOND, uint64(block.timestamp + DAY), REVEAL_WINDOW);
    }

    function _take(uint256 id, bool guess) internal {
        vm.prank(taker);
        book.take{value: STAKE}(id, guess);
    }

    // ── constants / getters ────────────────────────────────────────────────────────────────────

    function test_constants() public view {
        assertEq(book.MIN_REVEAL_WINDOW(), 5 minutes);
        assertEq(book.MAX_REVEAL_WINDOW(), 7 days);
        assertEq(book.nextOfferId(), 1);
    }

    // ── post ────────────────────────────────────────────────────────────────────────────────────

    function test_post_escrowsAndRecords() public {
        uint256 id = _post(true);
        assertEq(id, 1);
        assertEq(book.nextOfferId(), 2);
        assertEq(address(book).balance, STAKE + BOND);

        (
            address o_maker,
            bytes32 o_commit,
            uint256 o_stake,
            uint256 o_bond,
            uint64 o_takeDeadline,
            uint32 o_revealWindow,
            address o_taker,
            uint64 o_takenAt,
            bool o_guess
        ) = book.offers(id);
        assertEq(o_maker, maker);
        assertEq(o_commit, _commit(maker, true, SALT));
        assertEq(o_stake, STAKE);
        assertEq(o_bond, BOND);
        assertEq(o_takeDeadline, block.timestamp + DAY);
        assertEq(o_revealWindow, REVEAL_WINDOW);
        assertEq(o_taker, address(0));
        assertEq(o_takenAt, 0);
        assertEq(o_guess, false);
    }

    function test_post_zeroBond_reverts() public {
        vm.expectRevert(FlipBook.ZeroBond.selector);
        vm.prank(maker);
        book.post{value: STAKE}(SALT, 0, uint64(block.timestamp + DAY), REVEAL_WINDOW);
    }

    function test_post_zeroStake_reverts() public {
        // msg.value <= bond_ leaves no stake to flip; boundary case msg.value == bond_.
        vm.expectRevert(FlipBook.ZeroStake.selector);
        vm.prank(maker);
        book.post{value: BOND}(SALT, BOND, uint64(block.timestamp + DAY), REVEAL_WINDOW);
    }

    function test_post_badDeadline_reverts() public {
        // takeDeadline == now is rejected (must be strictly in the future).
        vm.expectRevert(FlipBook.BadDeadline.selector);
        vm.prank(maker);
        book.post{value: STAKE + BOND}(SALT, BOND, uint64(block.timestamp), REVEAL_WINDOW);
    }

    function test_post_badWindow_belowMin_reverts() public {
        vm.expectRevert(FlipBook.BadWindow.selector);
        vm.prank(maker);
        book.post{value: STAKE + BOND}(SALT, BOND, uint64(block.timestamp + DAY), 60);
    }

    function test_post_badWindow_aboveMax_reverts() public {
        vm.expectRevert(FlipBook.BadWindow.selector);
        vm.prank(maker);
        book.post{value: STAKE + BOND}(SALT, BOND, uint64(block.timestamp + DAY), 8 * uint32(DAY));
    }

    function test_post_windowBoundaries_accepted() public {
        vm.prank(maker);
        uint256 id1 = book.post{value: STAKE + BOND}(SALT, BOND, uint64(block.timestamp + DAY), book.MIN_REVEAL_WINDOW());
        (,,,,, uint32 w1,,,) = book.offers(id1);
        assertEq(w1, book.MIN_REVEAL_WINDOW());

        vm.prank(maker);
        uint256 id2 = book.post{value: STAKE + BOND}(SALT, BOND, uint64(block.timestamp + DAY), book.MAX_REVEAL_WINDOW());
        (,,,,, uint32 w2,,,) = book.offers(id2);
        assertEq(w2, book.MAX_REVEAL_WINDOW());
    }

    // ── cancel ──────────────────────────────────────────────────────────────────────────────────

    function test_cancel_refundsAndDeletes() public {
        uint256 id = _post(true);
        uint256 before = maker.balance;
        vm.prank(maker);
        book.cancel(id);
        assertEq(maker.balance, before + STAKE + BOND);
        assertEq(address(book).balance, 0);

        vm.expectRevert(FlipBook.UnknownOffer.selector);
        vm.prank(taker);
        book.take{value: STAKE}(id, true);
    }

    function test_cancel_unknownOffer_reverts() public {
        vm.expectRevert(FlipBook.UnknownOffer.selector);
        book.cancel(999);
    }

    function test_cancel_notMaker_reverts() public {
        uint256 id = _post(true);
        vm.expectRevert(FlipBook.NotMaker.selector);
        vm.prank(stranger);
        book.cancel(id);
    }

    function test_cancel_alreadyTaken_reverts() public {
        uint256 id = _post(true);
        _take(id, false);
        vm.expectRevert(FlipBook.AlreadyTaken.selector);
        vm.prank(maker);
        book.cancel(id);
    }

    // ── take ────────────────────────────────────────────────────────────────────────────────────

    function test_take_locksAtomically() public {
        uint256 id = _post(true);
        _take(id, true);
        assertEq(address(book).balance, STAKE * 2 + BOND);
        (,,,,,, address o_taker,, bool o_guess) = book.offers(id);
        assertEq(o_taker, taker);
        assertEq(o_guess, true);
    }

    function test_take_unknownOffer_reverts() public {
        vm.expectRevert(FlipBook.UnknownOffer.selector);
        vm.prank(taker);
        book.take{value: STAKE}(999, true);
    }

    function test_take_alreadyTaken_reverts() public {
        uint256 id = _post(true);
        _take(id, true);
        vm.expectRevert(FlipBook.AlreadyTaken.selector);
        vm.prank(stranger);
        book.take{value: STAKE}(id, false);
    }

    function test_take_selfTake_reverts() public {
        uint256 id = _post(true);
        vm.expectRevert(FlipBook.SelfTake.selector);
        vm.prank(maker);
        book.take{value: STAKE}(id, true);
    }

    function test_take_wrongValue_reverts() public {
        uint256 id = _post(true);
        vm.expectRevert(FlipBook.WrongValue.selector);
        vm.prank(taker);
        book.take{value: STAKE - 1}(id, true);
    }

    function test_take_expiredBoundary() public {
        uint256 id = _post(true);
        (,,,, uint64 takeDeadline,,,,) = book.offers(id);

        // exactly AT the deadline still succeeds (only `>` reverts).
        vm.warp(takeDeadline);
        vm.prank(taker);
        book.take{value: STAKE}(id, true);

        // a fresh offer, one second past its deadline reverts.
        uint256 id2 = _post(true);
        (,,,, uint64 takeDeadline2,,,,) = book.offers(id2);
        vm.warp(takeDeadline2 + 1);
        vm.expectRevert(FlipBook.OfferExpired.selector);
        vm.prank(taker);
        book.take{value: STAKE}(id2, true);
    }

    // ── reveal ──────────────────────────────────────────────────────────────────────────────────

    function test_reveal_takerWins_potToTaker_bondToMaker() public {
        uint256 id = _post(true); // maker's hidden choice = heads
        _take(id, true); // taker guesses heads → matches → taker wins
        uint256 takerBefore = taker.balance;
        uint256 makerBefore = maker.balance;
        vm.prank(cranker);
        book.reveal(id, true, SALT);
        assertEq(taker.balance, takerBefore + STAKE * 2);
        assertEq(maker.balance, makerBefore + BOND);
        assertEq(address(book).balance, 0);
    }

    function test_reveal_makerWins_potPlusBondToMaker() public {
        uint256 id = _post(true);
        _take(id, false); // guess misses → maker wins
        uint256 makerBefore = maker.balance;
        vm.prank(cranker);
        book.reveal(id, true, SALT);
        assertEq(maker.balance, makerBefore + STAKE * 2 + BOND);
        assertEq(address(book).balance, 0);
    }

    function test_reveal_unknownOffer_reverts() public {
        vm.expectRevert(FlipBook.UnknownOffer.selector);
        book.reveal(999, true, SALT);
    }

    function test_reveal_notTaken_reverts() public {
        uint256 id = _post(true);
        vm.expectRevert(FlipBook.NotTaken.selector);
        book.reveal(id, true, SALT);
    }

    function test_reveal_badReveal_wrongChoice_reverts() public {
        uint256 id = _post(true);
        _take(id, true);
        vm.expectRevert(FlipBook.BadReveal.selector);
        book.reveal(id, false, SALT);
    }

    function test_reveal_badReveal_wrongSalt_reverts() public {
        uint256 id = _post(true);
        _take(id, true);
        vm.expectRevert(FlipBook.BadReveal.selector);
        book.reveal(id, true, keccak256("wrong-salt"));
    }

    function test_reveal_windowOver_reverts() public {
        uint256 id = _post(true);
        _take(id, true);
        vm.warp(block.timestamp + REVEAL_WINDOW + 1);
        vm.expectRevert(FlipBook.RevealWindowOver.selector);
        book.reveal(id, true, SALT);
    }

    function test_reveal_doubleReveal_deletedOffer_reverts() public {
        uint256 id = _post(true);
        _take(id, true);
        book.reveal(id, true, SALT);
        vm.expectRevert(FlipBook.UnknownOffer.selector);
        book.reveal(id, true, SALT);
    }

    // ── claim (forfeit) ─────────────────────────────────────────────────────────────────────────

    function test_claim_paysTakerPotPlusBond() public {
        uint256 id = _post(true);
        _take(id, false); // taker guessed wrong, but the maker bails anyway
        vm.warp(block.timestamp + REVEAL_WINDOW + 1);
        uint256 takerBefore = taker.balance;
        vm.prank(cranker);
        book.claim(id);
        assertEq(taker.balance, takerBefore + STAKE * 2 + BOND);
        assertEq(address(book).balance, 0);

        vm.expectRevert(FlipBook.UnknownOffer.selector);
        book.claim(id);
    }

    function test_claim_unknownOffer_reverts() public {
        vm.expectRevert(FlipBook.UnknownOffer.selector);
        book.claim(999);
    }

    function test_claim_notTaken_reverts() public {
        uint256 id = _post(true);
        vm.expectRevert(FlipBook.NotTaken.selector);
        book.claim(id);
    }

    function test_claim_windowOpen_reverts() public {
        uint256 id = _post(true);
        _take(id, true);
        vm.expectRevert(FlipBook.RevealWindowOpen.selector);
        book.claim(id);
    }

    /// The reveal/claim window boundary from both sides: reveal works AT the edge (takenAt +
    /// revealWindow, inclusive), claim only strictly after it.
    function test_revealClaim_windowBoundary() public {
        uint256 id = _post(true);
        _take(id, true);
        (,,,,,,, uint64 takenAt,) = book.offers(id);
        uint256 edge = uint256(takenAt) + REVEAL_WINDOW;

        vm.warp(edge);
        vm.expectRevert(FlipBook.RevealWindowOpen.selector);
        book.claim(id);
        // still at the edge — reveal succeeds (only `>` reverts, and this is `==`).
        book.reveal(id, true, SALT);

        // a second offer, warped one second PAST the edge: reveal now reverts, claim succeeds.
        uint256 id2 = _post(true);
        _take(id2, true);
        (,,,,,,, uint64 takenAt2,) = book.offers(id2);
        vm.warp(uint256(takenAt2) + REVEAL_WINDOW + 1);
        vm.expectRevert(FlipBook.RevealWindowOver.selector);
        book.reveal(id2, true, SALT);
        book.claim(id2);
    }

    // ── withdraw / pull fallback ────────────────────────────────────────────────────────────────

    function test_withdraw_nothingOwed_reverts() public {
        vm.expectRevert(FlipBook.NothingOwed.selector);
        vm.prank(stranger);
        book.withdraw();
    }

    function test_withdraw_pullFallback_hostileWinner() public {
        RejectingTaker rejector = new RejectingTaker(book);
        vm.deal(address(rejector), 10 ether);

        uint256 id = _post(true); // maker's choice = heads
        vm.prank(address(rejector));
        rejector.take{value: STAKE}(id, true); // guesses heads → rejector (taker) wins

        // settlement must succeed even though paying the winner reverts.
        book.reveal(id, true, SALT);
        assertEq(book.owed(address(rejector)), STAKE * 2);
        assertEq(address(book).balance, STAKE * 2);

        // withdraw still fails while the receive path is broken, and the credit survives
        // (the FlipBook-side revert bubbles through the rejector's passthrough).
        vm.expectRevert(FlipBook.NothingOwed.selector);
        rejector.withdraw();
        assertEq(book.owed(address(rejector)), STAKE * 2);

        // flip the receiver on and collect.
        rejector.setAccept(true);
        rejector.withdraw();
        assertEq(book.owed(address(rejector)), 0);
        assertEq(address(book).balance, 0);
    }

    // ── commit binding ──────────────────────────────────────────────────────────────────────────

    function test_commitBinding_copiedCommitIsUseless() public {
        bytes32 commit = _commit(maker, true, SALT);
        uint256 id1 = _post(true);
        assertEq(id1, 1);

        // a copier posts the SAME commit bytes as their own offer.
        address copier = makeAddr("copier");
        vm.deal(copier, 100 ether);
        vm.prank(copier);
        uint256 id2 = book.post{value: STAKE + BOND}(commit, BOND, uint64(block.timestamp + DAY), REVEAL_WINDOW);

        vm.prank(taker);
        book.take{value: STAKE}(id2, true);

        // even knowing (choice, salt), the commit hashes with THIS offer's maker (the copier).
        vm.expectRevert(FlipBook.BadReveal.selector);
        book.reveal(id2, true, SALT);

        // the copier's only exit: never reveal → forfeit to the taker.
        vm.warp(block.timestamp + REVEAL_WINDOW + 1);
        uint256 takerBefore = taker.balance;
        vm.prank(copier);
        book.claim(id2);
        assertEq(taker.balance, takerBefore + STAKE * 2 + BOND);
    }

    // ── fuzz: pot conservation across arbitrary stakes/bonds/outcomes ─────────────────────────────

    function testFuzz_reveal_conservation(uint96 stakeSeed, uint96 bondSeed, bool choice, bool guess) public {
        uint256 stake = bound(uint256(stakeSeed), 1, 1000 ether);
        uint256 bond = bound(uint256(bondSeed), 1, 1000 ether);
        vm.deal(maker, stake + bond);
        vm.deal(taker, stake);

        bytes32 c = _commit(maker, choice, SALT);
        vm.prank(maker);
        uint256 id = book.post{value: stake + bond}(c, bond, uint64(block.timestamp + DAY), REVEAL_WINDOW);
        vm.prank(taker);
        book.take{value: stake}(id, guess);

        uint256 makerBefore = maker.balance;
        uint256 takerBefore = taker.balance;
        vm.prank(cranker);
        book.reveal(id, choice, SALT);

        if (guess == choice) {
            assertEq(taker.balance, takerBefore + stake * 2, "taker wins the pot");
            assertEq(maker.balance, makerBefore + bond, "maker only recovers the bond");
        } else {
            assertEq(maker.balance, makerBefore + stake * 2 + bond, "maker wins pot + bond");
            assertEq(taker.balance, takerBefore, "taker gets nothing");
        }
        assertEq(address(book).balance, 0, "no dust left behind, ever");
    }

    function testFuzz_claim_conservation(uint96 stakeSeed, uint96 bondSeed, bool choice, bool guess) public {
        uint256 stake = bound(uint256(stakeSeed), 1, 1000 ether);
        uint256 bond = bound(uint256(bondSeed), 1, 1000 ether);
        vm.deal(maker, stake + bond);
        vm.deal(taker, stake);

        bytes32 c = _commit(maker, choice, SALT);
        vm.prank(maker);
        uint256 id = book.post{value: stake + bond}(c, bond, uint64(block.timestamp + DAY), REVEAL_WINDOW);
        vm.prank(taker);
        book.take{value: stake}(id, guess);

        vm.warp(block.timestamp + REVEAL_WINDOW + 1);
        uint256 takerBefore = taker.balance;
        vm.prank(cranker);
        book.claim(id);
        assertEq(taker.balance, takerBefore + stake * 2 + bond, "bailing always costs the maker stake + bond");
        assertEq(address(book).balance, 0, "no dust");
    }
}

/// Ghost-accounting handler driving random post/take/reveal/claim/cancel/warp sequences so the
/// invariant test below can assert ETH conservation over arbitrarily long, arbitrarily-ordered
/// call sequences (not just the hand-picked scenarios above). All actors are plain EOAs (no
/// rejecting payees), so `owed` stays at zero and the whole contract balance must equal the
/// ghost-tracked sum of live escrow (open offers' stake+bond, plus taken offers' extra stake).
contract FlipBookHandler is Test {
    struct Commit {
        address maker;
        bool choice;
        bytes32 salt;
        uint256 stake;
        uint256 bond;
        uint32 revealWindow;
    }

    FlipBook public book;
    uint256[] internal openIds; // posted, not yet taken/cancelled
    uint256[] internal pendingIds; // taken, not yet settled
    mapping(uint256 => Commit) internal commits;
    address[] internal actors;

    uint256 public ghostLocked;

    constructor(FlipBook book_) {
        book = book_;
        for (uint256 i = 0; i < 5; i++) {
            actors.push(address(uint160(0xA000 + i)));
        }
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function _removeAt(uint256[] storage arr, uint256 idx) internal {
        uint256 last = arr.length - 1;
        arr[idx] = arr[last];
        arr.pop();
    }

    function post(uint256 makerSeed, uint96 stakeSeed, uint96 bondSeed, uint256 windowSeed, bool choice, bytes32 salt)
        external
    {
        address maker_ = _actor(makerSeed);
        uint256 stake = bound(uint256(stakeSeed), 0.001 ether, 100 ether);
        uint256 bond = bound(uint256(bondSeed), 0.001 ether, 50 ether);
        uint32 window = uint32(bound(windowSeed, book.MIN_REVEAL_WINDOW(), book.MAX_REVEAL_WINDOW()));

        bytes32 commit = keccak256(abi.encode(maker_, choice, salt));
        vm.deal(maker_, stake + bond);
        vm.prank(maker_);
        uint256 id = book.post{value: stake + bond}(commit, bond, uint64(block.timestamp + 1 days), window);

        openIds.push(id);
        commits[id] = Commit(maker_, choice, salt, stake, bond, window);
        ghostLocked += stake + bond;
    }

    function cancelOpen(uint256 idxSeed) external {
        if (openIds.length == 0) return;
        uint256 idx = idxSeed % openIds.length;
        uint256 id = openIds[idx];
        Commit memory c = commits[id];
        _removeAt(openIds, idx);

        vm.prank(c.maker);
        book.cancel(id);
        ghostLocked -= (c.stake + c.bond);
    }

    function takeOpen(uint256 idxSeed, uint256 takerSeed, bool guess) external {
        if (openIds.length == 0) return;
        uint256 idx = idxSeed % openIds.length;
        uint256 id = openIds[idx];
        Commit memory c = commits[id];

        (,,,, uint64 takeDeadline,,,,) = book.offers(id);
        if (block.timestamp > takeDeadline) {
            // dead weight past its deadline — drop it, nothing left to do with it.
            _removeAt(openIds, idx);
            return;
        }

        address taker_ = _actor(takerSeed);
        if (taker_ == c.maker) taker_ = _actor(takerSeed + 1);

        vm.deal(taker_, c.stake);
        vm.prank(taker_);
        book.take{value: c.stake}(id, guess);

        _removeAt(openIds, idx);
        pendingIds.push(id);
        ghostLocked += c.stake;
    }

    function revealPending(uint256 idxSeed) external {
        if (pendingIds.length == 0) return;
        uint256 idx = idxSeed % pendingIds.length;
        uint256 id = pendingIds[idx];
        Commit memory c = commits[id];

        (,,,,,,, uint64 takenAt,) = book.offers(id);
        if (block.timestamp > uint256(takenAt) + c.revealWindow) return; // window lapsed, only claim can settle now

        _removeAt(pendingIds, idx);
        book.reveal(id, c.choice, c.salt);
        ghostLocked -= (c.stake * 2 + c.bond);
    }

    function claimPending(uint256 idxSeed) external {
        if (pendingIds.length == 0) return;
        uint256 idx = idxSeed % pendingIds.length;
        uint256 id = pendingIds[idx];
        Commit memory c = commits[id];

        (,,,,,,, uint64 takenAt,) = book.offers(id);
        if (block.timestamp <= uint256(takenAt) + c.revealWindow) return; // window still open, only reveal can settle now

        _removeAt(pendingIds, idx);
        book.claim(id);
        ghostLocked -= (c.stake * 2 + c.bond);
    }

    function warp(uint256 secondsSeed) external {
        uint256 delta = bound(secondsSeed, 0, 8 days);
        vm.warp(block.timestamp + delta);
    }
}

/// ETH is native and pushed/pulled by FlipBook itself (no ERC-20 to query): the contract's raw
/// balance must, at every point in every random call sequence, equal exactly the sum of what is
/// still escrowed for live (open or taken-but-unsettled) offers. No actor in this suite has a
/// reverting receive function, so the `owed` pull-fallback bucket never accrues — the dedicated
/// hostile-winner unit test above covers that path precisely instead.
contract FlipBookInvariantTest is Test {
    FlipBook internal book;
    FlipBookHandler internal handler;

    function setUp() public {
        book = new FlipBook();
        handler = new FlipBookHandler(book);
        targetContract(address(handler));
    }

    function invariant_ethConservation() public view {
        assertEq(
            address(book).balance,
            handler.ghostLocked(),
            "contract balance must equal the sum of all live offers' escrowed stake+bond"
        );
    }
}
