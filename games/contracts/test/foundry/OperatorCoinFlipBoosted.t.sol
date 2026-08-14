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
import {BurnFeePolicy} from "../../contracts/games/operator/BurnFeePolicy.sol";
import {BonusChips1155} from "../../contracts/games/operator/BonusChips1155.sol";
import {BackingPool} from "../../contracts/games/operator/BackingPool.sol";

/// @notice S2b end-to-end suite: the paired bet-A/bet-B boosted flow driven by the REAL openBoosted
/// against the REAL GameEscrow + REAL BackingPool + REAL BonusChips1155 (no S2a mock). Proves the T2–T6
/// ledger deltas, the P1/P2 invariants, escrow solvency, and the openBoosted revert guards THROUGH the
/// game — the S2b deliverable.
///
/// Numbers pinned for clean arithmetic: table base = 150 (1.50x), series bonusPoints = 50 -> eff = 200
/// (2.00x, the MULT_MAX cap, no clamp), series maxStake = 8e18 -> w = ceil(8e18*50/100) = 4e18. For a
/// 4e18 stake on a tier: P_b = 6e18, P_t = 8e18, d = 2e18, x = 2e18, r = w - d = 2e18.
contract OperatorCoinFlipBoostedTest is Test {
    OperatorCoinFlip internal game;
    GameEscrow internal esc;
    OperatorRegistry internal reg;
    MockRandomStaking internal rnd;
    ERC20 internal tok;
    BurnFeePolicy internal burnPolicy;
    BonusChips1155 internal chips;
    BackingPool internal pool;
    address[] internal subset;

    address internal op = address(0x0B);
    address internal player = address(0x9E7);
    address internal mintSale = address(0x5A1E); // the mint-sale stand-in (pool minter)

    uint16 internal constant BASE_MULT = 150; // 1.50x table base
    uint16 internal constant BONUS_POINTS = 50; // -> eff 200 (== MULT_MAX, no clamp)
    uint256 internal constant MIN_STAKE = 1 ether;
    uint256 internal constant MAX_STAKE = 8 ether;
    uint256 internal constant SERIES_MAX_STAKE = 8 ether; // w = ceil(8e18*50/100) = 4e18
    uint256 internal constant BANKROLL = 1000 ether;
    uint256 internal constant FEES = 100 ether;

    uint256 internal seriesId; // the live boosted series (id >= 1; id 0 is a burned sentinel)

    // Test-side bookkeeping for the independent circ cross-check and P1 sums.
    bytes32[] internal roundIds;
    mapping(bytes32 => bool) internal roundSeen;

    function setUp() public {
        rnd = new MockRandomStaking();
        reg = new OperatorRegistry();
        esc = new GameEscrow(address(reg));
        tok = new ERC20(false); // plain token (boosted tables reject FOT/rebase; O6)

        burnPolicy = new BurnFeePolicy();
        address[] memory menu = new address[](1);
        menu[0] = address(burnPolicy);
        // Deploy order: game -> pool (references game) -> setBonusInfra.
        game = new OperatorCoinFlip(address(rnd), address(esc), address(reg), menu, address(burnPolicy));
        for (uint256 i = 0; i < 3; i++) {
            address v = address(uint160(0x3000 + i));
            game.addValidator(v);
            subset.push(v);
        }

        chips = new BonusChips1155();
        pool = new BackingPool(address(esc), address(chips), address(game));
        game.setBonusInfra(address(pool), address(chips));

        // Chips roles: pool is the sole minter (fund+mint atomic); game + pool may burn. Creator = test.
        chips.setCreator(address(this));
        chips.setMinter(address(pool));
        chips.setBurner(address(game), true);
        chips.setBurner(address(pool), true);
        pool.setMinter(mintSale);

        // Burn series id 0 as a sentinel: the game reserves seriesId == 0 as "no boost", so a real
        // boosted series must have id >= 1. (BonusChips1155.nextSeriesId starts at 0.)
        chips.createSeries(1, 1 ether, uint64(block.timestamp + 3650 days), address(tok));

        _onboardOperator(op);

        // player approves the ESCROW (custodian), consents to THIS game, and approves the game to move
        // its bonus charges.
        tok.mint(player, 100 ether);
        vm.prank(player); tok.approve(address(esc), type(uint256).max);
        vm.prank(player); esc.setPlayerGame(address(game), true);
        vm.prank(player); chips.setApprovalForAll(address(game), true);

        // Create the live boosted series (id 1) in the table token.
        seriesId = chips.createSeries(BONUS_POINTS, SERIES_MAX_STAKE, uint64(block.timestamp + 7 days), address(tok));
    }

    // --- helpers ---

    /// @notice Register op, fund bankroll + fee pool, authorize the game, and approve the pool so the
    /// mint-sale can pull op's backing on fundEarmark.
    function _onboardOperator(address o) internal {
        vm.prank(o); reg.register();
        tok.mint(o, BANKROLL + FEES + 1_000_000 ether); // extra for bonus backing
        vm.startPrank(o);
        tok.approve(address(esc), type(uint256).max);
        tok.approve(address(game), type(uint256).max);
        tok.approve(address(pool), type(uint256).max);
        esc.depositBankroll(o, address(tok), BANKROLL);
        game.depositFees(o, address(tok), FEES);
        esc.authorizeGame(address(game), true);
        vm.stopPrank();
    }

    function _boostedTable() internal returns (bytes32 tableId) {
        vm.prank(op);
        tableId = game.createTable(address(tok), BASE_MULT, MIN_STAKE, MAX_STAKE);
        vm.prank(op);
        game.setBonusSeries(tableId, seriesId);
    }

    /// @notice Fund + mint `n` charges of the live series to the player (T1).
    function _mintCharges(uint256 n) internal {
        vm.prank(mintSale);
        pool.fundEarmark(seriesId, n, op, player);
    }

    function _locsAt(uint256 price) internal view returns (PreimageLocation.Info[] memory L) {
        L = new PreimageLocation.Info[](subset.length);
        for (uint256 i = 0; i < subset.length; i++) {
            L[i] = PreimageLocation.Info({
                provider: subset[i], callAtChange: true, durationIsTimestamp: false,
                duration: 12, token: address(tok), price: price, offset: 0, index: 0
            });
        }
    }

    function _openBoosted(bytes32 tableId, uint8 side, uint256 stake)
        internal
        returns (bytes32 roundId, bytes32 key, PreimageLocation.Info[] memory locs)
    {
        uint256 tierPrice = game.tierPriceOf(tableId, stake);
        locs = _locsAt(tierPrice);
        vm.prank(player);
        roundId = game.openBoosted(tableId, side, stake, 0, subset, locs);
        key = _key(roundId);
        if (!roundSeen[roundId]) { roundIds.push(roundId); roundSeen[roundId] = true; }
    }

    function _boostId(bytes32 roundId) internal pure returns (bytes32) {
        return keccak256(abi.encode(roundId, "boost"));
    }

    function _key(bytes32 roundId) internal view returns (bytes32 k) {
        (,,,,,, k,,,,,,,) = game.rounds(roundId);
    }

    function _status(bytes32 roundId) internal view returns (uint8 s) {
        (,,,,,,,, OperatorCoinFlip.Status st,,,,,) = game.rounds(roundId);
        s = uint8(st);
    }

    // --- invariants ---

    /// P1: bankrollOf(pool) == earmark + Σhold + credit. P2: earmark == circ * w (pool-enforced).
    function _assertPoolInvariants() internal view {
        assertEq(pool.earmark(seriesId), pool.circ(seriesId) * chips.w(seriesId), "P2: earmark != circ*w");
        uint256 sumHold;
        for (uint256 i = 0; i < roundIds.length; i++) sumHold += pool.hold(roundIds[i]);
        assertEq(
            esc.bankrollOf(address(pool), address(tok)),
            pool.earmark(seriesId) + sumHold + pool.credit(op, address(tok)),
            "P1: pool bankroll != earmark + hold + credit"
        );
    }

    /// Escrow global solvency: the escrow's token balance equals the sum of the two live buckets'
    /// (bankroll + locked + rake). Player stakes in flight live inside `locked`.
    function _assertEscrowSolvent() internal view {
        uint256 opB = esc.bankrollOf(op, address(tok)) + esc.lockedOf(op, address(tok)) + esc.rakeOf(op, address(tok));
        uint256 poolB = esc.bankrollOf(address(pool), address(tok))
            + esc.lockedOf(address(pool), address(tok)) + esc.rakeOf(address(pool), address(tok));
        assertEq(tok.balanceOf(address(esc)), opB + poolB, "escrow solvency");
    }

    // ═══════════════════════════════════════════════════════════════════════════════════════════════
    // Task 1: bonus infra wiring + setBonusSeries
    // ═══════════════════════════════════════════════════════════════════════════════════════════════

    function test_setBonusInfra_ownerOnly() public {
        // Fresh game (infra unset) so we can exercise the setter cleanly.
        address[] memory menu = new address[](1);
        menu[0] = address(burnPolicy);
        OperatorCoinFlip g = new OperatorCoinFlip(address(rnd), address(esc), address(reg), menu, address(burnPolicy));
        vm.prank(address(0xBAD));
        vm.expectRevert(GameBase.OnlyOwner.selector);
        g.setBonusInfra(address(pool), address(chips));
    }

    function test_setBonusInfra_oneTime() public {
        address[] memory menu = new address[](1);
        menu[0] = address(burnPolicy);
        OperatorCoinFlip g = new OperatorCoinFlip(address(rnd), address(esc), address(reg), menu, address(burnPolicy));
        g.setBonusInfra(address(pool), address(chips));
        assertEq(g.backingPool(), address(pool));
        assertEq(address(g.bonusChips()), address(chips));
        vm.expectRevert(OperatorCoinFlip.BonusInfraAlreadySet.selector);
        g.setBonusInfra(address(pool), address(chips));
    }

    function test_setBonusSeries_revertsForNonOperator() public {
        vm.prank(op);
        bytes32 tid = game.createTable(address(tok), BASE_MULT, MIN_STAKE, MAX_STAKE);
        vm.prank(address(0xBAD));
        vm.expectRevert(OperatorCoinFlip.NotOperator.selector);
        game.setBonusSeries(tid, seriesId);
    }

    function test_setBonusSeries_revertsOnTokenMismatch() public {
        // A series in a DIFFERENT token than the table.
        ERC20 other = new ERC20(false);
        uint256 badSeries = chips.createSeries(BONUS_POINTS, SERIES_MAX_STAKE, uint64(block.timestamp + 7 days), address(other));
        vm.prank(op);
        bytes32 tid = game.createTable(address(tok), BASE_MULT, MIN_STAKE, MAX_STAKE);
        vm.prank(op);
        vm.expectRevert(OperatorCoinFlip.SeriesTokenMismatch.selector);
        game.setBonusSeries(tid, badSeries);
    }

    function test_setBonusSeries_revertsWhenClampExceeded() public {
        // base 160 + bonusPoints 50 = 210 > MULT_MAX (200).
        vm.prank(op);
        bytes32 tid = game.createTable(address(tok), 160, MIN_STAKE, MAX_STAKE);
        vm.prank(op);
        vm.expectRevert(OperatorCoinFlip.MultiplierClampExceeded.selector);
        game.setBonusSeries(tid, seriesId);
    }

    function test_setBonusSeries_revertsWhenInfraUnset() public {
        // Fresh game with a table but no infra set.
        address[] memory menu = new address[](1);
        menu[0] = address(burnPolicy);
        OperatorCoinFlip g = new OperatorCoinFlip(address(rnd), address(esc), address(reg), menu, address(burnPolicy));
        vm.prank(op);
        bytes32 tid = g.createTable(address(tok), BASE_MULT, MIN_STAKE, MAX_STAKE);
        vm.prank(op);
        vm.expectRevert(OperatorCoinFlip.BonusInfraUnset.selector);
        g.setBonusSeries(tid, seriesId);
    }

    function test_setBonusSeries_succeeds_storesAndEmits() public {
        vm.prank(op);
        bytes32 tid = game.createTable(address(tok), BASE_MULT, MIN_STAKE, MAX_STAKE);
        vm.expectEmit(true, true, false, true);
        emit OperatorCoinFlip.BonusSeriesSet(tid, seriesId);
        vm.prank(op);
        game.setBonusSeries(tid, seriesId);
        assertEq(game.bonusSeries(tid), seriesId);
    }

    function test_setBonusSeries_disableAlwaysAllowed() public {
        bytes32 tid = _boostedTable();
        assertEq(game.bonusSeries(tid), seriesId);
        vm.prank(op);
        game.setBonusSeries(tid, 0); // disable
        assertEq(game.bonusSeries(tid), 0);
    }

    // ═══════════════════════════════════════════════════════════════════════════════════════════════
    // Task 2: openBoosted (T2)
    // ═══════════════════════════════════════════════════════════════════════════════════════════════

    function test_openBoosted_locksPairedBets_pullsCharge_consumes() public {
        bytes32 tid = _boostedTable();
        _mintCharges(1); // one charge to the player; earmark = w = 4e18
        uint256 w = chips.w(seriesId);
        assertEq(pool.earmark(seriesId), w);
        uint256 feeBefore = game.feeBalance(op, address(tok));

        // roundId is not known ahead, so do not check topic1; verify seriesId (topic2) + data (eff, d).
        vm.expectEmit(false, true, false, true);
        emit OperatorCoinFlip.BoostApplied(bytes32(0), seriesId, 200, 2 ether);
        (bytes32 roundId,,) = _openBoosted(tid, 0, 4 ether);

        // Paired bets in escrow: bet A (operator, stake 4e18, payout P_b 6e18); bet B (pool, 0, d 2e18).
        GameEscrow.Bet memory a = esc.betOf(address(game), roundId);
        assertEq(a.operator, op);
        assertEq(a.stake, 4 ether);
        assertEq(a.payout, 6 ether); // P_b = 4e18 * 150 / 100
        GameEscrow.Bet memory b = esc.betOf(address(game), _boostId(roundId));
        assertEq(b.operator, address(pool));
        assertEq(b.stake, 0);
        assertEq(b.payout, 2 ether); // d = P_t - P_b = 8e18 - 6e18

        // Charge pulled into the game; earmark drained; hold = w - d = 2e18.
        assertEq(chips.balanceOf(address(game), seriesId), 1);
        assertEq(chips.balanceOf(player, seriesId), 0);
        assertEq(pool.earmark(seriesId), 0);
        assertEq(pool.hold(roundId), w - 2 ether);
        assertEq(pool.circ(seriesId), 0);

        // Base-only cap accounting: tableLocked += x = P_b - stake = 2e18.
        assertEq(game.tableLocked(tid), 2 ether);
        // Fee metered n * tierPrice = 3 * 4e18.
        assertEq(game.feeBalance(op, address(tok)), feeBefore - 3 * 4 ether);

        _assertPoolInvariants();
        _assertEscrowSolvent();
    }

    function test_openBoosted_revertsWhenNoSeries() public {
        vm.prank(op);
        bytes32 tid = game.createTable(address(tok), BASE_MULT, MIN_STAKE, MAX_STAKE); // no series attached
        _mintCharges(1);
        PreimageLocation.Info[] memory locs = _locsAt(game.tierPriceOf(tid, 4 ether));
        vm.prank(player);
        vm.expectRevert(OperatorCoinFlip.NoBonusSeries.selector);
        game.openBoosted(tid, 0, 4 ether, 0, subset, locs);
    }

    function test_openBoosted_revertsWhenStakeAboveSeriesMax() public {
        // Table with a wider range than the series' maxStake so the series cap (not the tier) fires.
        vm.prank(op);
        bytes32 tid = game.createTable(address(tok), BASE_MULT, MIN_STAKE, 16 ether);
        vm.prank(op);
        game.setBonusSeries(tid, seriesId); // series maxStake = 8e18
        PreimageLocation.Info[] memory locs = _locsAt(game.tierPriceOf(tid, 16 ether));
        vm.prank(player);
        vm.expectRevert(OperatorCoinFlip.StakeOutOfRange.selector);
        game.openBoosted(tid, 0, 16 ether, 0, subset, locs); // 16e18 > series max 8e18
    }

    function test_openBoosted_revertsWhenExpired() public {
        bytes32 tid = _boostedTable();
        _mintCharges(1);
        vm.warp(block.timestamp + 8 days); // past the 7-day series expiry
        PreimageLocation.Info[] memory locs = _locsAt(game.tierPriceOf(tid, 4 ether));
        vm.prank(player);
        vm.expectRevert(OperatorCoinFlip.SeriesExpired.selector);
        game.openBoosted(tid, 0, 4 ether, 0, subset, locs);
    }

    function test_openBoosted_revertsWhenBelowMinEffMult() public {
        bytes32 tid = _boostedTable();
        _mintCharges(1);
        PreimageLocation.Info[] memory locs = _locsAt(game.tierPriceOf(tid, 4 ether));
        vm.prank(player);
        vm.expectRevert(OperatorCoinFlip.MinEffMultNotMet.selector);
        game.openBoosted(tid, 0, 4 ether, 201, subset, locs); // eff 200 < minEffMult 201
    }

    function test_openBoosted_revertsOnDustBoost() public {
        // Raw-unit ladder + a 1-point series so the boost delta d truncates to zero at stake 1.
        uint256 dustSeries = chips.createSeries(1, 128, uint64(block.timestamp + 7 days), address(tok)); // eff 151
        vm.prank(op);
        bytes32 tid = game.createTable(address(tok), BASE_MULT, 1, 128);
        vm.prank(op);
        game.setBonusSeries(tid, dustSeries);
        PreimageLocation.Info[] memory locs = _locsAt(game.tierPriceOf(tid, 1));
        vm.prank(player);
        // d = floor(1*151/100) - floor(1*150/100) = 1 - 1 = 0 -> DustStake (checked before charge pull).
        vm.expectRevert(OperatorCoinFlip.DustStake.selector);
        game.openBoosted(tid, 0, 1, 0, subset, locs);
    }

    function test_openBoosted_operatorShort_rollsBackEverything() public {
        // A fresh operator with a bankroll too small for the base exposure x. Bet A (locked LAST) reverts
        // with InsufficientBankroll, unwinding the charge pull, pool.consume, and the fee meter atomically.
        address opB = address(0xB2);
        vm.prank(opB); reg.register();
        tok.mint(opB, 1_000_000 ether);
        vm.startPrank(opB);
        tok.approve(address(esc), type(uint256).max);
        tok.approve(address(game), type(uint256).max);
        tok.approve(address(pool), type(uint256).max);
        esc.depositBankroll(opB, address(tok), 1 ether); // too small: x for a 4e18 stake is 2e18
        game.depositFees(opB, address(tok), 100 ether);
        esc.authorizeGame(address(game), true);
        vm.stopPrank();
        vm.prank(opB);
        bytes32 tid = game.createTable(address(tok), BASE_MULT, MIN_STAKE, MAX_STAKE);
        vm.prank(opB);
        game.setBonusSeries(tid, seriesId);

        // Mint one charge (funded by opB) to the player.
        vm.prank(mintSale);
        pool.fundEarmark(seriesId, 1, opB, player);
        uint256 w = chips.w(seriesId);
        uint256 earmarkBefore = pool.earmark(seriesId);
        uint256 feeBefore = game.feeBalance(opB, address(tok));
        uint256 chargeBefore = chips.balanceOf(player, seriesId);

        PreimageLocation.Info[] memory locs = _locsAt(game.tierPriceOf(tid, 4 ether));
        vm.prank(player);
        vm.expectRevert(); // EscrowLib.InsufficientBankroll on bet A (the last interaction)
        game.openBoosted(tid, 0, 4 ether, 0, subset, locs);

        // Everything rolled back: pool earmark intact, charge still with the player, fee untouched.
        assertEq(pool.earmark(seriesId), earmarkBefore, "earmark moved");
        assertEq(pool.earmark(seriesId), w);
        assertEq(chips.balanceOf(player, seriesId), chargeBefore, "charge moved");
        assertEq(game.feeBalance(opB, address(tok)), feeBefore, "fee moved");
        assertEq(game.tableLocked(tid), 0, "tableLocked moved");
    }
}
