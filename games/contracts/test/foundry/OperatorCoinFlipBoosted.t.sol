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
        return _locsIdx(price, 0);
    }

    /// @notice Like `_locsAt` but stamps a distinct preimage `index` so concurrent rounds at the SAME
    /// stake tier get DISTINCT Random keys (the key is keccak of the locations; the game binds only
    /// provider/token/price, so a fresh index is a legal way to model distinct preimages per round).
    function _locsIdx(uint256 price, uint256 idx) internal view returns (PreimageLocation.Info[] memory L) {
        L = new PreimageLocation.Info[](subset.length);
        for (uint256 i = 0; i < subset.length; i++) {
            L[i] = PreimageLocation.Info({
                provider: subset[i], callAtChange: true, durationIsTimestamp: false,
                duration: 12, token: address(tok), price: price, offset: 0, index: idx
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

    function _openPlain(bytes32 tableId, uint8 side, uint256 stake)
        internal
        returns (bytes32 roundId, bytes32 key)
    {
        uint256 tierPrice = game.tierPriceOf(tableId, stake);
        PreimageLocation.Info[] memory locs = _locsAt(tierPrice);
        vm.prank(player);
        roundId = game.open(tableId, side, stake, subset, locs);
        key = _key(roundId);
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
        // L4: the pool must point back at `g` (BackingPool.game() is set once, in its constructor), so a
        // fresh game needs a fresh pool wired to IT — the shared setUp `pool` points at `game`, not `g`.
        BackingPool gPool = new BackingPool(address(esc), address(chips), address(g));
        g.setBonusInfra(address(gPool), address(chips));
        assertEq(g.backingPool(), address(gPool));
        assertEq(address(g.bonusChips()), address(chips));
        vm.expectRevert(OperatorCoinFlip.BonusInfraAlreadySet.selector);
        g.setBonusInfra(address(gPool), address(chips));
    }

    /// L4: a pool wired to a DIFFERENT game (the mismatch case) must be rejected at set time, not left to
    /// fail later mid-round.
    function test_setBonusInfra_revertsForMismatchedPoolGame() public {
        address[] memory menu = new address[](1);
        menu[0] = address(burnPolicy);
        OperatorCoinFlip g = new OperatorCoinFlip(address(rnd), address(esc), address(reg), menu, address(burnPolicy));
        // The shared setUp `pool` was constructed against `game`, not `g`.
        vm.expectRevert(OperatorCoinFlip.BonusInfraMismatch.selector);
        g.setBonusInfra(address(pool), address(chips));
    }

    /// L4: a pool wired to the right game but the WRONG chips registry must also be rejected.
    function test_setBonusInfra_revertsForMismatchedChips() public {
        address[] memory menu = new address[](1);
        menu[0] = address(burnPolicy);
        OperatorCoinFlip g = new OperatorCoinFlip(address(rnd), address(esc), address(reg), menu, address(burnPolicy));
        BonusChips1155 otherChips = new BonusChips1155();
        BackingPool gPool = new BackingPool(address(esc), address(otherChips), address(g));
        vm.expectRevert(OperatorCoinFlip.BonusInfraMismatch.selector);
        g.setBonusInfra(address(gPool), address(chips)); // gPool references otherChips, not chips
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

    // ═══════════════════════════════════════════════════════════════════════════════════════════════
    // Task 3: boosted settle (win + lose) (T3/T4)
    // ═══════════════════════════════════════════════════════════════════════════════════════════════

    function test_boosted_settleWin_paysPT_releasesResidual_burnsCharge() public {
        bytes32 tid = _boostedTable();
        _mintCharges(1);
        uint256 w = chips.w(seriesId);
        uint256 r = w - 2 ether; // hold residual
        (bytes32 roundId, bytes32 key,) = _openBoosted(tid, 0, 4 ether); // player picks HEADS (0)
        uint256 playerAfterOpen = tok.balanceOf(player); // 100 - 4 stake

        rnd.pushCast(key, bytes32(uint256(0))); // even -> HEADS -> player wins

        // Player received P_t = P_b + d = 6e18 + 2e18 = 8e18 (both bets paid).
        assertEq(tok.balanceOf(player), playerAfterOpen + 8 ether);
        // Residual released to the operator's credit; charge burned; hold cleared.
        assertEq(pool.hold(roundId), 0);
        assertEq(pool.credit(op, address(tok)), r);
        assertEq(chips.balanceOf(address(game), seriesId), 0);
        // Base exposure returned to zero on this table.
        assertEq(game.tableLocked(tid), 0);
        assertEq(esc.lockedOf(op, address(tok)), 0);
        assertEq(esc.lockedOf(address(pool), address(tok)), 0);
        assertEq(_status(roundId), uint8(OperatorCoinFlip.Status.Settled));
        _assertPoolInvariants();
        _assertEscrowSolvent();
    }

    function test_boosted_claim_isGuardedAndConsistent() public {
        // claim() carries the new nonReentrant guard (accounting §6). Behaviorally: it reverts TooEarly
        // before a seed and AlreadyResolved after the round settled — the exactly-once discipline holds.
        bytes32 tid = _boostedTable();
        _mintCharges(1);
        (bytes32 roundId, bytes32 key,) = _openBoosted(tid, 0, 4 ether);
        uint256 playerAfterOpen = tok.balanceOf(player);

        vm.expectRevert(OperatorCoinFlip.TooEarly.selector);
        game.claim(roundId); // no seed yet

        rnd.pushCast(key, bytes32(uint256(0))); // finalize (delivers onCast -> settles the win)
        assertEq(tok.balanceOf(player), playerAfterOpen + 8 ether);

        vm.expectRevert(OperatorCoinFlip.AlreadyResolved.selector);
        game.claim(roundId); // already settled
    }

    function test_boosted_settleLoss_returnsD_creditsW_burnsCharge() public {
        bytes32 tid = _boostedTable();
        _mintCharges(1);
        uint256 w = chips.w(seriesId);
        (bytes32 roundId, bytes32 key,) = _openBoosted(tid, 0, 4 ether); // player picks HEADS (0)
        uint256 opBankAfterOpen = esc.bankrollOf(op, address(tok)); // BANKROLL - x

        rnd.pushCast(key, bytes32(uint256(1))); // odd -> TAILS -> player loses

        // Operator regains P_b (rake 0): bankroll += P_b = exposure x + player's lost stake.
        assertEq(esc.bankrollOf(op, address(tok)), opBankAfterOpen + 6 ether);
        assertEq(esc.bankrollOf(op, address(tok)), BANKROLL - 2 ether + 6 ether); // 1004e18
        // Bet B returned d to the pool bucket; the pool credits the operator the full w (= d + r).
        assertEq(esc.bankrollOf(address(pool), address(tok)), w);
        assertEq(pool.credit(op, address(tok)), w);
        assertEq(pool.hold(roundId), 0);
        // Charge burned; player keeps only the lost stake gone.
        assertEq(chips.balanceOf(address(game), seriesId), 0);
        assertEq(tok.balanceOf(player), 100 ether - 4 ether);
        assertEq(game.tableLocked(tid), 0);
        _assertPoolInvariants();
        _assertEscrowSolvent();
    }

    // ═══════════════════════════════════════════════════════════════════════════════════════════════
    // Task 4: boosted refunds (chop burns charge; plain returns w/ park) (T5/T6)
    // ═══════════════════════════════════════════════════════════════════════════════════════════════

    function test_boosted_chopRefund_burnsCharge_routesForfeit_refundsPlayer() public {
        bytes32 tid = _boostedTable();
        _mintCharges(1);
        uint256 w = chips.w(seriesId);
        (bytes32 roundId, bytes32 key, PreimageLocation.Info[] memory locs) = _openBoosted(tid, 0, 4 ether);

        rnd.setRevealed(key, 0x3); // one of three validators withholds -> forfeit = 1 * tierPrice = 4e18

        vm.expectEmit(true, true, true, true);
        emit OperatorCoinFlip.ForfeitRouted(roundId, op, address(tok), 4 ether);
        game.chopAndRoute(roundId, locs);

        // Player made whole; operator bankroll unchanged (forfeit went to the sink, not the house).
        assertEq(tok.balanceOf(player), 100 ether);
        assertEq(esc.bankrollOf(op, address(tok)), BANKROLL);
        assertEq(burnPolicy.burned(address(tok)), 4 ether);
        // Fee restored (Slice 0 behavior intact).
        assertEq(game.feeBalance(op, address(tok)), FEES);
        // Bet B returned d to the pool; operator credited the full w; charge BURNED (never returned, F4).
        assertEq(esc.bankrollOf(address(pool), address(tok)), w);
        assertEq(pool.credit(op, address(tok)), w);
        assertEq(pool.hold(roundId), 0);
        assertEq(chips.balanceOf(address(game), seriesId), 0);
        assertEq(chips.balanceOf(player, seriesId), 0);
        assertEq(_status(roundId), uint8(OperatorCoinFlip.Status.Refunded));
        assertEq(game.tableLocked(tid), 0);
        _assertPoolInvariants();
        _assertEscrowSolvent();
    }

    function test_boosted_plainTimeout_refunds_returnsCharge_reEarmarks() public {
        bytes32 tid = _boostedTable();
        _mintCharges(1);
        uint256 w = chips.w(seriesId);
        (bytes32 roundId,,) = _openBoosted(tid, 0, 4 ether);
        uint256 feeAfterOpen = game.feeBalance(op, address(tok));

        vm.roll(block.number + 201); // past STALE_BLOCKS, no chop -> plain-timeout branch
        game.refundStale(roundId);

        // Player refunded stake; bet B returned d; pool re-earmarked the full w; charge RETURNED.
        assertEq(tok.balanceOf(player), 100 ether);
        assertEq(esc.bankrollOf(op, address(tok)), BANKROLL);
        assertEq(esc.bankrollOf(address(pool), address(tok)), w);
        assertEq(pool.earmark(seriesId), w);
        assertEq(pool.circ(seriesId), 1);
        assertEq(pool.hold(roundId), 0);
        assertEq(chips.balanceOf(player, seriesId), 1); // charge back to the player
        assertEq(chips.balanceOf(address(game), seriesId), 0);
        assertFalse(game.parkedCharge(roundId));
        // Fee is NOT restored on a pure timeout (matches the plain-round behavior today).
        assertEq(game.feeBalance(op, address(tok)), feeAfterOpen);
        assertEq(game.feeBalance(op, address(tok)), FEES - 3 * 4 ether);
        assertEq(_status(roundId), uint8(OperatorCoinFlip.Status.Refunded));
        assertEq(game.tableLocked(tid), 0);
        _assertPoolInvariants();
        _assertEscrowSolvent();
    }

    function test_boosted_plainTimeout_parksChargeOnReceiverFailure_thenClaims() public {
        RejectableReceiver rcv = new RejectableReceiver();
        // Onboard the contract-player: fund tok, consent to the game, approve chip moves.
        tok.mint(address(rcv), 100 ether);
        vm.prank(address(rcv)); tok.approve(address(esc), type(uint256).max);
        vm.prank(address(rcv)); esc.setPlayerGame(address(game), true);
        vm.prank(address(rcv)); chips.setApprovalForAll(address(game), true);

        bytes32 tid = _boostedTable();
        uint256 w = chips.w(seriesId);
        vm.prank(mintSale);
        pool.fundEarmark(seriesId, 1, op, address(rcv)); // accepted (rejecting = false)

        PreimageLocation.Info[] memory locs = _locsAt(game.tierPriceOf(tid, 4 ether));
        vm.prank(address(rcv));
        bytes32 roundId = game.openBoosted(tid, 0, 4 ether, 0, subset, locs);
        roundIds.push(roundId);

        vm.roll(block.number + 201);
        rcv.setRejecting(true); // the receiver now rejects the incoming charge return

        game.refundStale(roundId); // fund refund MUST still succeed; the charge return parks

        // The token refund landed despite the parked charge.
        assertEq(tok.balanceOf(address(rcv)), 100 ether);
        assertTrue(game.parkedCharge(roundId), "charge should be parked");
        assertEq(chips.balanceOf(address(game), seriesId), 1); // still held by the game, parked
        assertEq(chips.balanceOf(address(rcv), seriesId), 0);
        // Pool ledger already reflects the plain refund (re-earmarked, circ up) regardless of the park.
        assertEq(pool.earmark(seriesId), w);
        assertEq(pool.circ(seriesId), 1);
        assertEq(_status(roundId), uint8(OperatorCoinFlip.Status.Refunded));
        _assertPoolInvariants();
        _assertEscrowSolvent();

        // Fix the receiver; a permissionless claim delivers the parked charge exactly once.
        rcv.setRejecting(false);
        vm.prank(address(0xCAFE));
        game.claimParkedCharge(roundId);
        assertFalse(game.parkedCharge(roundId));
        assertEq(chips.balanceOf(address(rcv), seriesId), 1);
        assertEq(chips.balanceOf(address(game), seriesId), 0);
        // A second claim is a no-op (already delivered).
        game.claimParkedCharge(roundId);
        assertEq(chips.balanceOf(address(rcv), seriesId), 1);
        _assertPoolInvariants();
    }

    // ═══════════════════════════════════════════════════════════════════════════════════════════════
    // Task 5: end-to-end randomized invariant — mixed boosted + plain through the REAL stack
    // ═══════════════════════════════════════════════════════════════════════════════════════════════

    // Loop-scoped tracking (state vars so the assertion helper can read them without stack juggling).
    uint256 internal _minted;   // charges funded+minted (T1)
    uint256 internal _burned;   // charges destroyed (boosted win/loss/chop terminals + expiry)
    uint256 internal _gameHeld; // charges consumed by currently-open boosted rounds
    uint256 internal _openNonce; // gives each fuzz round a distinct preimage index -> distinct Random key

    /// Independent circ cross-check: circ = minted - burned - gameHeld. Must equal the pool's own
    /// counter, on top of P1/P2 and escrow solvency.
    function _assertE2EInvariants() internal view {
        assertEq(pool.circ(seriesId), _minted - _burned - _gameHeld, "independent circ != pool.circ");
        _assertPoolInvariants();
        _assertEscrowSolvent();
    }

    /// A bounded random legal sequence of mixed boosted + plain rounds driven THROUGH the real
    /// openBoosted/open/settle/chop/refund, asserting P1 + P2 + independent circ + escrow solvency after
    /// every step, and tableLocked == 0 whenever no round (plain or boosted) is open. This is the S2b
    /// deliverable: the paired-bet flow proven through the real game, not the S2a mock.
    function test_e2e_randomizedInvariant(uint256 seed) public {
        bytes32 tid = _boostedTable();
        uint256 w = chips.w(seriesId);

        // A deep fee pool so opens never starve mid-sequence, and a starting batch of charges.
        vm.prank(op); game.depositFees(op, address(tok), 5000 ether);
        _mintCharges(6); _minted += 6;
        _assertE2EInvariants();

        uint256[3] memory tiers = [uint256(1 ether), 2 ether, 4 ether];

        uint256 nLive;
        bytes32[64] memory liveRound;
        bytes32[64] memory liveKey;
        uint256[64] memory liveTier;
        uint256[64] memory liveIdx;
        bool[64] memory liveBoosted;

        for (uint256 step = 0; step < 40; step++) {
            seed = uint256(keccak256(abi.encode(seed, step)));
            uint256 action = seed % 7;
            uint256 stake = tiers[(seed >> 8) % 3];
            uint8 side = uint8((seed >> 16) % 2);

            if (action == 0) {
                uint256 n = (seed >> 24) % 3 + 1;
                _mintCharges(n); _minted += n;
            } else if (action == 1) {
                // OPEN BOOSTED — needs a player charge, backing, and fee headroom.
                if (chips.balanceOf(player, seriesId) == 0) continue;
                if (pool.earmark(seriesId) < w) continue;
                if (game.feeBalance(op, address(tok)) < 3 * stake) continue;
                uint256 idx = ++_openNonce;
                vm.prank(player);
                bytes32 rid = game.openBoosted(tid, side, stake, 0, subset, _locsIdx(stake, idx));
                if (!roundSeen[rid]) { roundIds.push(rid); roundSeen[rid] = true; }
                liveRound[nLive] = rid; liveKey[nLive] = _key(rid); liveTier[nLive] = stake;
                liveIdx[nLive] = idx; liveBoosted[nLive] = true;
                nLive++; _gameHeld++;
            } else if (action == 2) {
                // OPEN PLAIN — no charge, just fee + bankroll.
                if (game.feeBalance(op, address(tok)) < 3 * stake) continue;
                uint256 idx = ++_openNonce;
                vm.prank(player);
                bytes32 rid = game.open(tid, side, stake, subset, _locsIdx(stake, idx));
                liveRound[nLive] = rid; liveKey[nLive] = _key(rid); liveTier[nLive] = stake;
                liveIdx[nLive] = idx; liveBoosted[nLive] = false;
                nLive++;
            } else if (action >= 3 && action <= 5) {
                if (nLive == 0) continue;
                uint256 pick = (seed >> 24) % nLive;
                if (action == 3) {
                    // SETTLE via pushCast (win or lose — invariants hold either way).
                    rnd.pushCast(liveKey[pick], bytes32(seed));
                    if (liveBoosted[pick]) { _burned++; _gameHeld--; }
                } else if (action == 4) {
                    // CHOP — one validator withholds.
                    rnd.setRevealed(liveKey[pick], 0x3);
                    game.chopAndRoute(liveRound[pick], _locsIdx(liveTier[pick], liveIdx[pick]));
                    if (liveBoosted[pick]) { _burned++; _gameHeld--; }
                } else {
                    // PLAIN-TIMEOUT — roll past staleness, no chop.
                    vm.roll(block.number + 201);
                    game.refundStale(liveRound[pick]);
                    if (liveBoosted[pick]) { _gameHeld--; } // charge RETURNED (circ +1), not burned
                }
                liveRound[pick] = liveRound[nLive - 1];
                liveKey[pick] = liveKey[nLive - 1];
                liveTier[pick] = liveTier[nLive - 1];
                liveIdx[pick] = liveIdx[nLive - 1];
                liveBoosted[pick] = liveBoosted[nLive - 1];
                nLive--;
                if (nLive == 0) assertEq(game.tableLocked(tid), 0, "tableLocked != 0 with no open round");
            } else {
                uint256 c = pool.credit(op, address(tok));
                if (c == 0) continue;
                uint256 amt = (seed >> 24) % c + 1;
                vm.prank(op); pool.withdrawCredit(address(tok), amt);
            }

            _assertE2EInvariants();
        }

        // Drain: settle every remaining live round, then the table must be fully unlocked.
        for (uint256 i = 0; i < nLive; i++) {
            rnd.pushCast(liveKey[i], bytes32(seed + i));
            if (liveBoosted[i]) { _burned++; _gameHeld--; }
        }
        assertEq(game.tableLocked(tid), 0, "tableLocked != 0 after draining all rounds");
        _assertE2EInvariants();

        // Expire everything left circulating with the player, and settle the operator's backing out.
        vm.warp(block.timestamp + 8 days);
        uint256 held = chips.balanceOf(player, seriesId);
        if (held > 0) {
            pool.expireCharges(seriesId, player, held);
            _burned += held;
        }
        _assertE2EInvariants();
    }
}

/// @notice A contract-player whose 1155 receiver can be toggled to reject — proves a boosted plain-timeout
/// parks the charge (and never freezes the fund refund) when the player's receiver fails.
contract RejectableReceiver {
    bool public rejecting;

    function setRejecting(bool v) external {
        rejecting = v;
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external view returns (bytes4) {
        if (rejecting) revert("receiver rejects");
        return this.onERC1155Received.selector;
    }
}
