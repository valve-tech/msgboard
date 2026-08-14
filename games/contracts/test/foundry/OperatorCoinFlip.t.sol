// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {OperatorCoinFlip} from "../../contracts/games/operator/OperatorCoinFlip.sol";
import {GameBase} from "../../contracts/GameBase.sol";
import {GameEscrow} from "../../contracts/games/operator/GameEscrow.sol";
import {OperatorRegistry} from "../../contracts/games/operator/OperatorRegistry.sol";
import {PreimageLocation} from "../../contracts/PreimageLocation.sol";
import {ERC20} from "../../contracts/test/ERC20.sol";
import {MockRandomStaking} from "./MockRandomStaking.sol";
import {IValidatorPolicy} from "../../contracts/games/operator/IValidatorPolicy.sol";
import {IFeePolicy} from "../../contracts/games/operator/IFeePolicy.sol";
import {BurnFeePolicy} from "../../contracts/games/operator/BurnFeePolicy.sol";

/// @notice Staking-model suite for OperatorCoinFlip: stake-tier ladder, per-operator fee metering,
/// table-token heat at the tier price, and the chopAndRoute validator-forfeit path. Uses the faithful
/// MockRandomStaking double (custody + fee + chop-forfeit accounting), NOT the free-key MockRandom.
contract OperatorCoinFlipTest is Test {
    OperatorCoinFlip internal game;
    GameEscrow internal esc;
    OperatorRegistry internal reg;
    MockRandomStaking internal rnd;
    ERC20 internal tok;
    BurnFeePolicy internal burnPolicy;
    RevertingFeePolicy internal revertingPolicy;
    address[] internal subset;

    address internal op = address(0x0B);
    address internal player = address(0x9E7);
    uint256 internal constant MULT = 196; // 1.96x (uint256 so test-side payout arithmetic stays wide)
    uint256 internal constant MIN_STAKE = 1 ether;
    uint256 internal constant MAX_STAKE = 8 ether;
    uint256 internal constant BANKROLL = 1000 ether;
    uint256 internal constant FEES = 100 ether;

    function setUp() public {
        rnd = new MockRandomStaking();
        reg = new OperatorRegistry();
        esc = new GameEscrow(address(reg));
        tok = new ERC20(false);
        // The forfeit sink menu: the default BurnFeePolicy, plus a reverting policy the park test swaps in.
        burnPolicy = new BurnFeePolicy();
        revertingPolicy = new RevertingFeePolicy();
        address[] memory menu = new address[](2);
        menu[0] = address(burnPolicy);
        menu[1] = address(revertingPolicy);
        game = new OperatorCoinFlip(address(rnd), address(esc), address(reg), menu, address(burnPolicy));
        for (uint256 i = 0; i < 3; i++) {
            address v = address(uint160(0x3000 + i));
            game.addValidator(v);
            subset.push(v);
        }
        _onboardOperator(op);
        // player approves the ESCROW (custodian), then consents to THIS game pulling that allowance.
        tok.mint(player, 100 ether);
        vm.prank(player); tok.approve(address(esc), type(uint256).max);
        vm.prank(player); esc.setPlayerGame(address(game), true);
    }

    // --- helpers ---

    /// @notice Register an operator, fund its bankroll + fee pool, and authorize the game.
    function _onboardOperator(address o) internal {
        vm.prank(o); reg.register();
        tok.mint(o, BANKROLL + FEES);
        vm.startPrank(o);
        tok.approve(address(esc), type(uint256).max);
        tok.approve(address(game), type(uint256).max);
        esc.depositBankroll(o, address(tok), BANKROLL);
        game.depositFees(o, address(tok), FEES);
        esc.authorizeGame(address(game), true);
        vm.stopPrank();
    }

    function _table() internal returns (bytes32 tableId) {
        return _table(MIN_STAKE, MAX_STAKE);
    }

    function _table(uint256 minStake, uint256 maxStake) internal returns (bytes32 tableId) {
        vm.prank(op);
        tableId = game.createTable(address(tok), uint16(MULT), minStake, maxStake);
    }

    /// @notice Build the heated locations bound to (tok, price) for the whole subset.
    function _locsAt(uint256 price) internal view returns (PreimageLocation.Info[] memory L) {
        L = new PreimageLocation.Info[](subset.length);
        for (uint256 i = 0; i < subset.length; i++) {
            L[i] = PreimageLocation.Info({
                provider: subset[i], callAtChange: true, durationIsTimestamp: false,
                duration: 12, token: address(tok), price: price, offset: 0, index: 0
            });
        }
    }

    function _open(bytes32 tableId, uint8 side, uint256 stake)
        internal
        returns (bytes32 roundId, bytes32 key, PreimageLocation.Info[] memory locs)
    {
        uint256 tierPrice = game.tierPriceOf(tableId, stake);
        locs = _locsAt(tierPrice);
        vm.prank(player);
        roundId = game.open(tableId, side, stake, subset, locs);
        key = _key(roundId);
    }

    function _key(bytes32 roundId) internal view returns (bytes32 k) {
        (,,,,,, k,,,,) = game.rounds(roundId);
    }

    function _tierPriceOfRound(bytes32 roundId) internal view returns (uint256 tp) {
        (,,,,, tp,,,,,) = game.rounds(roundId);
    }

    function _status(bytes32 roundId) internal view returns (uint8 s) {
        (,,,,,,,, OperatorCoinFlip.Status st,,) = game.rounds(roundId);
        s = uint8(st);
    }

    // --- Task 2: tier ladder ---

    function test_tierPrice_ladder_roundsUp() public {
        bytes32 tid = _table(1, 8); // raw-unit ladder, matches the brief's 1..8 example
        assertEq(game.tierPriceOf(tid, 1), 1);
        assertEq(game.tierPriceOf(tid, 2), 2);
        assertEq(game.tierPriceOf(tid, 3), 4);
        assertEq(game.tierPriceOf(tid, 5), 8);
        assertEq(game.tierPriceOf(tid, 8), 8);
    }

    function test_tierPrice_outOfRange_reverts() public {
        bytes32 tid = _table(1, 8);
        vm.expectRevert(OperatorCoinFlip.StakeOutOfRange.selector);
        game.tierPriceOf(tid, 9);
        vm.expectRevert(OperatorCoinFlip.StakeOutOfRange.selector);
        game.tierPriceOf(tid, 0);
    }

    function test_createTable_badTier_reverts() public {
        vm.prank(op);
        vm.expectRevert(OperatorCoinFlip.BadTier.selector);
        game.createTable(address(tok), uint16(MULT), 1 ether, 6 ether); // 6 is not a power-of-two multiple of 1
        vm.prank(op);
        vm.expectRevert(OperatorCoinFlip.BadTier.selector);
        game.createTable(address(tok), uint16(MULT), 0, 8 ether); // minStake == 0
    }

    function test_createTable_requiresRegisteredOperator() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(OperatorCoinFlip.NotRegisteredOperator.selector);
        game.createTable(address(tok), uint16(MULT), MIN_STAKE, MAX_STAKE);
    }

    // --- Task 3: per-operator fee metering ---

    function test_depositFees_creditsPoolAndCustody() public view {
        // setUp already deposited FEES for op; invariant: pool == game custody in Random.
        assertEq(game.feeBalance(op, address(tok)), FEES);
        assertEq(rnd.balanceOf(address(game), address(tok)), FEES);
    }

    /// A fee-on-transfer token is taxed on BOTH legs of depositFees (funder→game and game→Random).
    /// Crediting the measured Random-custody delta (not the face amount) keeps the custody invariant
    /// exact — otherwise the pool over-counts custody and one operator could drain shared custody.
    function test_depositFees_feeOnTransfer_invariantHolds() public {
        ERC20 fot = new ERC20(true); // 1% fee-on-transfer
        uint256 amount = 100 ether;
        fot.mint(op, amount);
        vm.startPrank(op);
        fot.approve(address(game), type(uint256).max);
        game.depositFees(op, address(fot), amount);
        vm.stopPrank();
        uint256 pool = game.feeBalance(op, address(fot));
        assertLt(pool, amount); // taxed below the face amount
        assertEq(rnd.balanceOf(address(game), address(fot)), pool); // invariant holds
    }

    function test_withdrawFees_returnsFee_keepsInvariant() public {
        uint256 poolBefore = game.feeBalance(op, address(tok)); // FEES from setUp
        uint256 opBalBefore = tok.balanceOf(op);
        vm.prank(op);
        game.withdrawFees(address(tok), 40 ether);
        assertEq(game.feeBalance(op, address(tok)), poolBefore - 40 ether);
        assertEq(tok.balanceOf(op), opBalBefore + 40 ether);
        assertEq(rnd.balanceOf(address(game), address(tok)), game.feeBalance(op, address(tok)));
    }

    function test_withdrawFees_overWithdraw_reverts() public {
        vm.prank(op);
        vm.expectRevert(OperatorCoinFlip.InsufficientFees.selector);
        game.withdrawFees(address(tok), FEES + 1);
    }

    function test_open_insufficientFees_reverts() public {
        // Drain the pool by opening the largest tier repeatedly is complex; instead onboard a fresh
        // operator with a tiny pool and prove the charge underflow reverts.
        address opB = address(0xB2);
        vm.prank(opB); reg.register();
        tok.mint(opB, BANKROLL + 1 ether);
        vm.startPrank(opB);
        tok.approve(address(esc), type(uint256).max);
        tok.approve(address(game), type(uint256).max);
        esc.depositBankroll(opB, address(tok), BANKROLL);
        game.depositFees(opB, address(tok), 1 ether); // pool 1e18, one round needs 3*tierPrice
        esc.authorizeGame(address(game), true);
        vm.stopPrank();
        vm.prank(opB);
        bytes32 tid = game.createTable(address(tok), uint16(MULT), MIN_STAKE, MAX_STAKE);

        uint256 tierPrice = game.tierPriceOf(tid, 1 ether); // 1e18; fee = 3e18 > pool 1e18
        PreimageLocation.Info[] memory locs = _locsAt(tierPrice);
        vm.prank(player);
        vm.expectRevert(OperatorCoinFlip.InsufficientFees.selector);
        game.open(tid, 0, 1 ether, subset, locs);
    }

    // --- Task 4: open() heats table token at the tier price + charges the fee ---

    function test_open_bindsTier_chargesFee_locksExposure() public {
        bytes32 tid = _table(); // 1e18..8e18
        uint256 feeBefore = game.feeBalance(op, address(tok));
        (bytes32 roundId, bytes32 key, PreimageLocation.Info[] memory locs) = _open(tid, 0, 3 ether);

        // Tier rounds 3e18 up to 4e18.
        assertEq(_tierPriceOfRound(roundId), 4 ether);
        // The heat key binds exactly the locations we passed (token=tok, price=4e18).
        assertEq(key, keccak256(abi.encode(locs)));
        // Fee metered by n * tierPrice = 3 * 4e18.
        assertEq(game.feeBalance(op, address(tok)), feeBefore - 3 * 4 ether);
        // Exposure locked equals the full payout (3e18 * 1.96).
        assertEq(esc.lockedOf(op, address(tok)), 3 ether * MULT / 100);
        // Custody invariant still holds after the heat charge.
        assertEq(rnd.balanceOf(address(game), address(tok)), game.feeBalance(op, address(tok)));
        // Player stake pulled to escrow.
        assertEq(tok.balanceOf(player), 100 ether - 3 ether);
    }

    function test_open_revertsOnDustStake() public {
        // A tiny 1..8 ladder where stake=1 truncates payout to break-even (1*196/100 == 1).
        bytes32 tid = _table(1, 8);
        PreimageLocation.Info[] memory locs = _locsAt(1); // tier price for stake 1 is 1
        vm.prank(player);
        vm.expectRevert(OperatorCoinFlip.DustStake.selector);
        game.open(tid, 0, 1, subset, locs);
    }

    // --- happy-path settle (fee consumed to bonus, invariant holds) ---

    function test_settle_win_paysPlayer_feeToBonus_invariantHolds() public {
        bytes32 tid = _table();
        (, bytes32 key,) = _open(tid, 0, 4 ether); // player picks HEADS (0), tier 4e18
        uint256 feeAfterOpen = game.feeBalance(op, address(tok));
        rnd.setBonusTo(address(0xB0B));
        rnd.pushCast(key, bytes32(uint256(0))); // even → HEADS → player wins

        assertEq(tok.balanceOf(player), 100 ether - 4 ether + (4 ether * MULT / 100));
        assertEq(esc.lockedOf(op, address(tok)), 0);
        // Fee stays debited (spent to the bonus recipient on cast), and the custody invariant holds.
        assertEq(game.feeBalance(op, address(tok)), feeAfterOpen);
        assertEq(rnd.balanceOf(address(game), address(tok)), feeAfterOpen);
        assertEq(rnd.balanceOf(address(0xB0B), address(tok)), 3 * 4 ether); // fee paid out
    }

    function test_settle_loss_returnsToBankroll() public {
        bytes32 tid = _table();
        (, bytes32 key,) = _open(tid, 0, 4 ether);
        rnd.pushCast(key, bytes32(uint256(1))); // odd → TAILS → player loses
        assertEq(tok.balanceOf(player), 100 ether - 4 ether); // stake stays lost
        assertEq(esc.lockedOf(op, address(tok)), 0);
        assertGt(esc.bankrollOf(op, address(tok)), BANKROLL); // operator gained
    }

    // --- Task 5: chopAndRoute routes the withheld stake to the neutral sink ---

    function test_chopAndRoute_forfeitsToSink_refundsPlayer() public {
        bytes32 tid = _table();
        (bytes32 roundId, bytes32 key, PreimageLocation.Info[] memory locs) = _open(tid, 0, 4 ether);
        uint256 feeAfterOpen = game.feeBalance(op, address(tok));

        // One of three validators withholds: mask 0x3 → bits 0,1 revealed, bit 2 withheld.
        rnd.setRevealed(key, 0x3);

        vm.expectEmit(true, true, true, true);
        emit OperatorCoinFlip.ForfeitRouted(roundId, op, address(tok), 4 ether);
        game.chopAndRoute(roundId, locs);

        // (a) player made whole.
        assertEq(tok.balanceOf(player), 100 ether);
        // (b) operator bankroll UNCHANGED — the forfeit no longer credits the house.
        assertEq(esc.bankrollOf(op, address(tok)), BANKROLL);
        // (b') the tier price was burned at the neutral sink instead.
        assertEq(burnPolicy.burned(address(tok)), 4 ether);
        // (c) fee pool restored by n * tierPrice.
        assertEq(game.feeBalance(op, address(tok)), feeAfterOpen + 3 * 4 ether);
        assertEq(game.feeBalance(op, address(tok)), FEES);
        // (d) round refunded.
        assertEq(_status(roundId), uint8(OperatorCoinFlip.Status.Refunded));
        // custody invariant restored.
        assertEq(rnd.balanceOf(address(game), address(tok)), game.feeBalance(op, address(tok)));
    }

    /// A third party front-runs the game by calling the PUBLIC Random.chop directly. chopAndRoute must
    /// still route the forfeit (from the onReverse-recorded credit) instead of reverting and freezing the
    /// operator's fee + forfeit. This is the whole-branch audit's HIGH finding.
    function test_chopAndRoute_afterExternalChop_stillRoutes() public {
        bytes32 tid = _table();
        (bytes32 roundId, bytes32 key, PreimageLocation.Info[] memory locs) = _open(tid, 0, 4 ether);
        rnd.setRevealed(key, 0x3); // bit 2 withheld

        // ATTACKER front-runs: direct public chop. onReverse records the credit; round stays Pending.
        vm.prank(address(0xBEEF));
        rnd.chop(key, locs);
        assertEq(_status(roundId), uint8(OperatorCoinFlip.Status.Pending));

        // chopAndRoute routes from the recorded credit — no re-chop, no revert.
        vm.expectEmit(true, true, true, true);
        emit OperatorCoinFlip.ForfeitRouted(roundId, op, address(tok), 4 ether);
        game.chopAndRoute(roundId, locs);

        assertEq(tok.balanceOf(player), 100 ether);
        assertEq(esc.bankrollOf(op, address(tok)), BANKROLL); // bankroll unchanged; forfeit went to the sink
        assertEq(burnPolicy.burned(address(tok)), 4 ether);
        assertEq(game.feeBalance(op, address(tok)), FEES);
        assertEq(_status(roundId), uint8(OperatorCoinFlip.Status.Refunded));
        assertEq(rnd.balanceOf(address(game), address(tok)), game.feeBalance(op, address(tok)));
    }

    /// Same front-run, but the round is closed by refundStale instead — it too must route the forfeit,
    /// so a stray refundStale after an external chop cannot strand the fee + forfeit.
    function test_refundStale_afterExternalChop_routesForfeit() public {
        bytes32 tid = _table();
        (bytes32 roundId, bytes32 key, PreimageLocation.Info[] memory locs) = _open(tid, 0, 4 ether);
        rnd.setRevealed(key, 0x3);

        vm.prank(address(0xBEEF));
        rnd.chop(key, locs); // external chop → onChop sets choppedInstance, onReverse records credit

        game.refundStale(roundId);

        assertEq(tok.balanceOf(player), 100 ether);
        assertEq(esc.bankrollOf(op, address(tok)), BANKROLL); // bankroll unchanged; forfeit went to the sink
        assertEq(burnPolicy.burned(address(tok)), 4 ether);
        assertEq(game.feeBalance(op, address(tok)), FEES);
        assertEq(_status(roundId), uint8(OperatorCoinFlip.Status.Refunded));
        assertEq(rnd.balanceOf(address(game), address(tok)), game.feeBalance(op, address(tok)));
    }

    /// A reverting sink must NOT freeze the abort: the player refund still succeeds, the round resolves,
    /// and the forfeit parks in `unrouted` for a later sweep. Operator bankroll is untouched throughout.
    function test_forfeit_parks_when_policy_reverts() public {
        // Swap the active sink to the reverting policy (already on the menu from setUp).
        game.setForfeitPolicy(address(revertingPolicy));

        bytes32 tid = _table();
        (bytes32 roundId, bytes32 key, PreimageLocation.Info[] memory locs) = _open(tid, 0, 4 ether);
        rnd.setRevealed(key, 0x3); // one validator withholds → 4 ether forfeit

        // The route reverts inside the self-call; the abort must catch it and park (4th arg 0 = parked).
        vm.expectEmit(true, true, true, true);
        emit OperatorCoinFlip.ForfeitParked(roundId, address(tok), 4 ether);
        game.chopAndRoute(roundId, locs);

        // Player refund SUCCEEDED and the round resolved despite the bad policy.
        assertEq(tok.balanceOf(player), 100 ether);
        assertEq(_status(roundId), uint8(OperatorCoinFlip.Status.Refunded));
        // Forfeit parked, nothing burned, operator bankroll unchanged, fee restored.
        assertEq(game.unrouted(address(tok)), 4 ether);
        assertEq(burnPolicy.burned(address(tok)), 0);
        assertEq(esc.bankrollOf(op, address(tok)), BANKROLL);
        assertEq(game.feeBalance(op, address(tok)), FEES);
    }

    /// After a park, the owner swaps back to a working sink and anyone may sweep: the parked amount
    /// routes exactly once, `unrouted` clears, and the sink burn counter rises by the parked amount.
    function test_sweepForfeit_routes_parked() public {
        game.setForfeitPolicy(address(revertingPolicy));
        bytes32 tid = _table();
        (bytes32 roundId, bytes32 key, PreimageLocation.Info[] memory locs) = _open(tid, 0, 4 ether);
        rnd.setRevealed(key, 0x3);
        game.chopAndRoute(roundId, locs);
        assertEq(game.unrouted(address(tok)), 4 ether); // parked

        // Recover: point back at the burn sink, then a permissionless sweep drains the parked forfeit.
        game.setForfeitPolicy(address(burnPolicy));
        vm.prank(address(0xCAFE));
        game.sweepForfeit(address(tok));

        assertEq(game.unrouted(address(tok)), 0);
        assertEq(burnPolicy.burned(address(tok)), 4 ether);
    }

    /// I5: the forfeit-policy pointer can only ever move within the constructor-fixed menu, and only the
    /// owner may move it — an operator (or anyone else) can never redirect the forfeit sink.
    function test_setForfeitPolicy_rejectsOffMenuAddress() public {
        address offMenu = address(0xBAD);
        vm.expectRevert(OperatorCoinFlip.PolicyRejected.selector);
        game.setForfeitPolicy(offMenu);
        assertEq(game.forfeitPolicy(), address(burnPolicy)); // unchanged
    }

    function test_setForfeitPolicy_revertsForNonOwner() public {
        vm.prank(op);
        vm.expectRevert(GameBase.OnlyOwner.selector);
        game.setForfeitPolicy(address(revertingPolicy));
        assertEq(game.forfeitPolicy(), address(burnPolicy)); // unchanged
    }

    function test_setForfeitPolicy_acceptsMenuMember_emitsAndUpdates() public {
        game.setForfeitPolicy(address(revertingPolicy));
        assertEq(game.forfeitPolicy(), address(revertingPolicy));
    }

    /// Tier-boundary case (F4): stake == minStake so tierPrice == stake. The forfeit routed to the sink
    /// equals exactly tierPrice, and the operator bankroll is unchanged.
    function test_forfeit_tier_boundary() public {
        bytes32 tid = _table(); // MIN_STAKE..MAX_STAKE = 1e18..8e18
        uint256 stake = MIN_STAKE; // on a tier → tierPrice == stake
        uint256 tierPrice = game.tierPriceOf(tid, stake);
        assertEq(tierPrice, stake);

        (bytes32 roundId, bytes32 key, PreimageLocation.Info[] memory locs) = _open(tid, 0, stake);
        rnd.setRevealed(key, 0x3); // one withholds → forfeit == 1 * tierPrice

        vm.expectEmit(true, true, true, true);
        emit OperatorCoinFlip.ForfeitRouted(roundId, op, address(tok), tierPrice);
        game.chopAndRoute(roundId, locs);

        assertEq(burnPolicy.burned(address(tok)), tierPrice);
        assertEq(esc.bankrollOf(op, address(tok)), BANKROLL);
        assertEq(tok.balanceOf(player), 100 ether);
    }

    /// onReverse must be onlyRandom: a forged credit would let a caller route custody the game never
    /// received. A non-Random caller reverts and cannot set chopCredit.
    function test_onReverse_onlyRandom_reverts() public {
        bytes32 tid = _table();
        (bytes32 roundId, bytes32 key,) = _open(tid, 0, 4 ether);
        vm.prank(address(0xBAD));
        vm.expectRevert(GameBase.OnlyRandom.selector);
        game.onReverse(key, address(tok), 1_000_000 ether);
        assertEq(_status(roundId), uint8(OperatorCoinFlip.Status.Pending));
    }

    /// A round whose seed finalized settles via onCast/claim and is value-decided — it can never be
    /// chopped afterward. chopAndRoute must reject it (here the push already settled it → AlreadyResolved).
    function test_chopAndRoute_afterSettle_reverts() public {
        bytes32 tid = _table();
        (bytes32 roundId, bytes32 key, PreimageLocation.Info[] memory locs) = _open(tid, 0, 4 ether);
        rnd.pushCast(key, bytes32(uint256(2))); // seed finalizes → onCast settles the round
        vm.expectRevert(OperatorCoinFlip.AlreadyResolved.selector);
        game.chopAndRoute(roundId, locs);
    }

    function test_refundStale_stillWorks_validatorAbort() public {
        bytes32 tid = _table();
        (bytes32 roundId,,) = _open(tid, 0, 4 ether);
        vm.roll(block.number + 201); // past STALE_BLOCKS, no seed
        game.refundStale(roundId);
        assertEq(tok.balanceOf(player), 100 ether);
        assertEq(esc.bankrollOf(op, address(tok)), BANKROLL);
    }

    // --- Task 6: airtight property + cross-operator custody invariant ---

    /// The staked forfeit (tierPrice) is always >= the player stake, so a selective validator abort is
    /// never a free-roll: the withholder loses at least what the player risked. Checked across pairs.
    function test_forfeit_geq_stake_makes_abort_neg_ev() public {
        bytes32 tid = _table(1 ether, 8 ether);
        uint256[6] memory stakes = [uint256(1 ether), 2 ether, 3 ether, 5 ether, 7 ether, 8 ether];
        for (uint256 i = 0; i < stakes.length; i++) {
            uint256 tp = game.tierPriceOf(tid, stakes[i]);
            assertGe(tp, stakes[i]);
        }
    }

    /// The custody invariant `balanceOf(game, token) == Σ feeBalance` holds across mixed settle/abort
    /// rounds — absent real Random's late-cast half-refund (a seed forming after HEAT_DURATION strands
    /// the operator's own spent fee harmlessly). The mock has no late-cast path, so the equality is exact.
    function test_custody_invariant_holds_across_settle_and_abort() public {
        address opB = address(0xB2);
        _onboardOperator(opB);

        // opA: settle a round (win).
        bytes32 tA = _table();
        (, bytes32 kA,) = _open(tA, 0, 2 ether);
        rnd.pushCast(kA, bytes32(uint256(0))); // player wins

        // opB: chop a round (one validator withholds).
        vm.prank(opB);
        bytes32 tB = game.createTable(address(tok), uint16(MULT), MIN_STAKE, MAX_STAKE);
        uint256 tpB = game.tierPriceOf(tB, 5 ether); // tier 8e18
        PreimageLocation.Info[] memory locsB = _locsAt(tpB);
        vm.prank(player);
        bytes32 rB = game.open(tB, 1, 5 ether, subset, locsB);
        bytes32 kB = _key(rB);
        rnd.setRevealed(kB, 0x3); // one withholds
        game.chopAndRoute(rB, locsB);

        // opA: also chop a round.
        (bytes32 rA2, bytes32 kA2, PreimageLocation.Info[] memory locsA2) = _open(tA, 0, 3 ether);
        rnd.setRevealed(kA2, 0x1); // two withhold
        game.chopAndRoute(rA2, locsA2);

        uint256 sum = game.feeBalance(op, address(tok)) + game.feeBalance(opB, address(tok));
        assertEq(rnd.balanceOf(address(game), address(tok)), sum);
    }

    // --- Task 1: validator-inclusion policy hook ---

    function test_setValidatorPolicy_onlyOperator() public {
        bytes32 tid = _table();
        AllowAllPolicy p = new AllowAllPolicy();
        vm.prank(address(0xBAD));
        vm.expectRevert(OperatorCoinFlip.NotOperator.selector);
        game.setValidatorPolicy(tid, address(p));
        vm.prank(op);
        game.setValidatorPolicy(tid, address(p)); // operator OK
        ( , , , , , , address pol) = game.tables(tid);
        assertEq(pol, address(p));
    }

    function test_open_policyRejects_reverts() public {
        bytes32 tid = _table();
        RejectAllPolicy p = new RejectAllPolicy();
        vm.prank(op); game.setValidatorPolicy(tid, address(p));
        // Build locs BEFORE expectRevert: the inline tierPriceOf staticcall would otherwise be the
        // "next call" expectRevert catches, masking the open() revert.
        PreimageLocation.Info[] memory locs = _locsAt(game.tierPriceOf(tid, 4 ether));
        vm.prank(player);
        vm.expectRevert(OperatorCoinFlip.PolicyRejected.selector);
        game.open(tid, 0, 4 ether, subset, locs);
    }

    function test_open_policyAccepts_succeeds() public {
        bytes32 tid = _table();
        AllowAllPolicy p = new AllowAllPolicy();
        vm.prank(op); game.setValidatorPolicy(tid, address(p));
        (bytes32 roundId,,) = _open(tid, 0, 4 ether); // must not revert
        assertEq(_status(roundId), uint8(OperatorCoinFlip.Status.Pending));
    }

    function test_open_floor_cannot_be_weakened_by_hook() public {
        bytes32 tid = _table();
        TwoIsFinePolicy p = new TwoIsFinePolicy();
        vm.prank(op); game.setValidatorPolicy(tid, address(p));
        address[] memory two = new address[](2);
        two[0] = subset[0]; two[1] = subset[1];
        PreimageLocation.Info[] memory locs = _locsAt(game.tierPriceOf(tid, 4 ether));
        vm.prank(player);
        vm.expectRevert(GameBase.BadSubset.selector); // the floor rejects before/despite the permissive hook
        game.open(tid, 0, 4 ether, two, locs);
    }

    function test_open_revertingHook_bricksOnlyThatTable() public {
        bytes32 bad = _table();
        RevertingPolicy p = new RevertingPolicy();
        vm.prank(op); game.setValidatorPolicy(bad, address(p));
        PreimageLocation.Info[] memory locs = _locsAt(game.tierPriceOf(bad, 4 ether));
        vm.prank(player);
        vm.expectRevert(); // hook revert bubbles → open reverts
        game.open(bad, 0, 4 ether, subset, locs);
        // a different table with no policy still works
        bytes32 ok = _table();
        (bytes32 roundId,,) = _open(ok, 0, 4 ether);
        assertEq(_status(roundId), uint8(OperatorCoinFlip.Status.Pending));
    }

    function test_settle_and_forfeit_unaffected_with_policy() public {
        bytes32 tid = _table();
        AllowAllPolicy p = new AllowAllPolicy();
        vm.prank(op); game.setValidatorPolicy(tid, address(p));
        (bytes32 roundId, bytes32 key, PreimageLocation.Info[] memory locs) = _open(tid, 0, 4 ether);
        rnd.setRevealed(key, 0x3);
        game.chopAndRoute(roundId, locs);
        assertEq(_status(roundId), uint8(OperatorCoinFlip.Status.Refunded));
        assertEq(esc.bankrollOf(op, address(tok)), BANKROLL); // bankroll unchanged; forfeit went to the sink
        assertEq(burnPolicy.burned(address(tok)), 4 ether);
    }

    // --- Task 1 (bankroll): per-table exposure caps ---

    function test_setTableCap_onlyOperator() public {
        bytes32 tid = _table();
        vm.prank(address(0xBAD));
        vm.expectRevert(OperatorCoinFlip.NotOperator.selector);
        game.setTableCap(tid, 5 ether);
        vm.prank(op); game.setTableCap(tid, 5 ether);
        assertEq(game.tableCap(tid), 5 ether);
    }

    function test_tableCap_blocksOverExposure_and_tracksLocked() public {
        bytes32 tid = _table();
        uint256 exposure = 4 ether * MULT / 100 - 4 ether; // payout - stake for a 4e18 stake
        vm.prank(op); game.setTableCap(tid, exposure); // room for exactly one such round
        ( , , PreimageLocation.Info[] memory locs) = _open(tid, 0, 4 ether); // fills the cap
        assertEq(game.tableLocked(tid), exposure);
        // a second open would push tableLocked to 2*exposure > cap → revert. Reuse the already-built
        // locs so no external tierPriceOf staticcall sits inside the expectRevert window.
        vm.prank(player);
        vm.expectRevert(OperatorCoinFlip.TableCapExceeded.selector);
        game.open(tid, 0, 4 ether, subset, locs);
    }

    function test_tableCap_freesOnSettle() public {
        bytes32 tid = _table();
        uint256 exposure = 4 ether * MULT / 100 - 4 ether;
        vm.prank(op); game.setTableCap(tid, exposure);
        (, bytes32 key,) = _open(tid, 0, 4 ether);
        rnd.pushCast(key, bytes32(uint256(0))); // settle → releases exposure
        assertEq(game.tableLocked(tid), 0);
        (bytes32 r2,,) = _open(tid, 0, 4 ether); // now fits again
        assertEq(_status(r2), uint8(OperatorCoinFlip.Status.Pending));
    }

    function test_tableCap_zeroIsUnlimited() public {
        bytes32 tid = _table(); // default cap 0
        for (uint256 i = 0; i < 3; i++) _open(tid, 0, 4 ether); // many rounds, no cap revert
        assertEq(game.tableLocked(tid), 3 * (4 ether * MULT / 100 - 4 ether));
    }

    function test_tableCap_freesOnForfeit_onceOnly() public {
        bytes32 tid = _table();
        uint256 exposure = 4 ether * MULT / 100 - 4 ether;
        vm.prank(op); game.setTableCap(tid, exposure);
        (bytes32 roundId, bytes32 key, PreimageLocation.Info[] memory locs) = _open(tid, 0, 4 ether);
        rnd.setRevealed(key, 0x3);
        game.chopAndRoute(roundId, locs); // forfeit path → releases exposure exactly once
        assertEq(game.tableLocked(tid), 0);
        // a fresh open fits again (proves it wasn't double-decremented into underflow-revert or left stuck)
        (bytes32 r2,,) = _open(tid, 0, 4 ether);
        assertEq(_status(r2), uint8(OperatorCoinFlip.Status.Pending));
    }

    function test_tableCap_freesOnRefundStale() public {
        bytes32 tid = _table();
        uint256 exposure = 4 ether * MULT / 100 - 4 ether;
        vm.prank(op); game.setTableCap(tid, exposure);
        (bytes32 roundId,,) = _open(tid, 0, 4 ether);
        vm.roll(block.number + 201); // past STALE_BLOCKS, no chop → plain refund branch
        game.refundStale(roundId);
        assertEq(game.tableLocked(tid), 0);
    }

    function test_lowerCap_blocksNewButResolvesInflight() public {
        bytes32 tid = _table();
        (bytes32 roundId, bytes32 key, PreimageLocation.Info[] memory locs) = _open(tid, 0, 4 ether); // uncapped open
        vm.prank(op); game.setTableCap(tid, 1); // now below tableLocked
        // Reuse the already-built locs so no external tierPriceOf staticcall sits inside expectRevert.
        vm.prank(player);
        vm.expectRevert(OperatorCoinFlip.TableCapExceeded.selector);
        game.open(tid, 0, 4 ether, subset, locs);
        rnd.pushCast(key, bytes32(uint256(0))); // in-flight round still settles
        assertEq(_status(roundId), uint8(OperatorCoinFlip.Status.Settled));
        assertEq(game.tableLocked(tid), 0);
    }
}

// --- minimal policies for hook tests ---
contract AllowAllPolicy is IValidatorPolicy {
    function validate(address, bytes32, address, address[] calldata) external pure returns (bool) { return true; }
}
contract RejectAllPolicy is IValidatorPolicy {
    function validate(address, bytes32, address, address[] calldata) external pure returns (bool) { return false; }
}
contract RevertingPolicy is IValidatorPolicy {
    function validate(address, bytes32, address, address[] calldata) external pure returns (bool) { revert("policy boom"); }
}
// Accepts even a too-small subset — proves the game floor still rejects regardless of the hook.
contract TwoIsFinePolicy is IValidatorPolicy {
    function validate(address, bytes32, address, address[] calldata s) external pure returns (bool) { return s.length >= 2; }
}

// A fee policy whose route() always reverts — proves the abort parks the forfeit instead of freezing.
contract RevertingFeePolicy is IFeePolicy {
    function feeBps(bytes32, address, address) external pure returns (uint16) { return 0; }
    function route(bytes32, address, uint256, bytes calldata) external pure { revert("route boom"); }
}
