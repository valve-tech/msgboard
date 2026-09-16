// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {OperatorCoinFlip} from "../../contracts/games/operator/OperatorCoinFlip.sol";
import {GameEscrow} from "../../contracts/games/operator/GameEscrow.sol";
import {OperatorRegistry} from "../../contracts/games/operator/OperatorRegistry.sol";
import {PreimageLocation} from "../../contracts/PreimageLocation.sol";
import {ERC20} from "../../contracts/test/ERC20.sol";
import {MockRandomStaking} from "./MockRandomStaking.sol";
import {BurnFeePolicy} from "../../contracts/games/operator/BurnFeePolicy.sol";
import {BonusChips1155} from "../../contracts/games/operator/BonusChips1155.sol";
import {BackingPool} from "../../contracts/games/operator/BackingPool.sol";
import {MintSale} from "../../contracts/games/operator/MintSale.sol";
import {Marketplace} from "../../contracts/games/operator/Marketplace.sol";
import {IFeePolicy} from "../../contracts/games/operator/IFeePolicy.sol";

/// @notice A configurable, kind-aware fee policy for the mint-sale and marketplace fee call-sites — the
/// only mocked piece in this suite. It is not one of the six fund-safety contracts under test (game,
/// escrow, pool, chips, mint-sale, marketplace); it is the pluggable IFeePolicy those contracts call
/// through, exactly the idiom already used by MintSale.t.sol and Marketplace.t.sol.
contract MockFeePolicy is IFeePolicy {
    bytes32 internal constant MINT_KIND = keccak256("mint-sale");
    bytes32 internal constant MKT_KIND = keccak256("marketplace");

    uint16 public mintBps;
    uint16 public mktBps;

    constructor(uint16 mintBps_, uint16 mktBps_) {
        mintBps = mintBps_;
        mktBps = mktBps_;
    }

    function feeBps(bytes32 kind, address, address) external view returns (uint16) {
        return kind == MKT_KIND ? mktBps : mintBps;
    }

    function route(bytes32, address, uint256, bytes calldata) external {}
}

/// @notice S2c-4: the full-stack end-to-end suite. Deploys and wires ALL six real bonus-economy
/// contracts — GameEscrow, OperatorRegistry, OperatorCoinFlip, BonusChips1155, BackingPool, MintSale,
/// Marketplace — plus the real BurnFeePolicy as the game's forfeit sink, against a MockRandomStaking
/// (the same Random test double OperatorCoinFlipBoosted.t.sol uses; nothing about the price/backing
/// accounting depends on real Random's tstore internals). No mock stands in for the game, escrow, pool,
/// chips, mint-sale, or marketplace themselves.
///
/// Every scenario asserts BOTH invariant families after every terminal:
///   Backing (BackingPool):  P1 bankrollOf(pool) == Σearmark + Σhold + Σcredit(op)
///                            P2 earmark[s] == circ(s) * w(s)
///   Price   (MintSale):     V1 escrowed[s] == alive(s) * price[s]
///                            V2 sale balance == Σescrowed + vested(op) + Σrefundable + feeAccrued
contract OperatorAssetsE2ETest is Test {
    OperatorCoinFlip internal game;
    GameEscrow internal esc;
    OperatorRegistry internal reg;
    MockRandomStaking internal rnd;
    ERC20 internal tok;
    BurnFeePolicy internal burnPolicy; // real neutral sink for chop forfeits
    BonusChips1155 internal chips;
    BackingPool internal pool;
    MintSale internal sale;
    Marketplace internal mkt;
    MockFeePolicy internal feePolicy;
    address[] internal subset;

    address internal op = address(0x0B);
    address internal player = address(0x9E7);
    address internal buyerA = address(0xA001);
    address internal buyerB = address(0xB002);

    uint16 internal constant BASE_MULT = 150; // 1.50x table base
    uint16 internal constant BONUS_POINTS = 50; // -> eff 200 (== MULT_MAX, no clamp)
    uint256 internal constant MIN_STAKE = 1 ether;
    uint256 internal constant MAX_STAKE = 8 ether;
    uint256 internal constant SERIES_MAX_STAKE = 8 ether; // w = ceil(8e18*50/100) = 4e18
    uint256 internal constant STAKE = 4 ether; // == its own tier price on the 1/2/4/8 ladder

    // Pinned round-shape numbers at STAKE = 4e18, base 150, eff 200 (clean arithmetic, no rounding):
    uint256 internal constant PB = 6 ether; // P_b = stake*base/100
    uint256 internal constant PT = 8 ether; // P_t = stake*eff/100
    uint256 internal constant D = 2 ether;  // boost delta = P_t - P_b
    uint256 internal constant W = 4 ether;  // per-charge backing = ceil(8e18*50/100)
    uint256 internal constant R = 2 ether;  // residual = w - d

    uint256 internal constant BANKROLL = 1000 ether;
    uint256 internal constant FEES = 1000 ether;

    uint16 internal constant MINT_BPS = 500; // 5% mint-sale fee
    uint16 internal constant MKT_BPS = 300;  // 3% marketplace fee
    uint256 internal constant PRICE = 10 ether; // P, immutable mint price per charge
    uint256 internal constant FEE = 0.5 ether;  // f = floor(P * 500 / 10000)
    uint256 internal constant ASK = 15 ether;   // Q, resale ask per charge

    uint256 internal _nonce;

    uint256[] internal seriesIds;
    mapping(uint256 => bool) internal seriesSeen;
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

        sale = new MintSale(address(chips));
        sale.setPool(address(pool));
        sale.setGame(address(game));

        mkt = new Marketplace(address(chips));

        feePolicy = new MockFeePolicy(MINT_BPS, MKT_BPS);
        sale.setPolicy(address(feePolicy));
        mkt.setPolicy(address(feePolicy));

        // Governance-critical wiring (accounting doc): creator = MintSale, minter = pool,
        // pool.minter = MintSale, burners = exactly {game, pool}, priceLedger = MintSale.
        chips.setCreator(address(sale));
        chips.setMinter(address(pool));
        chips.setBurner(address(game), true);
        chips.setBurner(address(pool), true);
        chips.setPriceLedger(address(sale));
        pool.setMinter(address(sale));

        // Burn series id 0 as a sentinel: the game reserves seriesId == 0 as "no boost", so a real
        // boosted series must have id >= 1 (BonusChips1155.nextSeriesId starts at 0). Mirrors the same
        // sentinel-burn OperatorCoinFlipBoosted.t.sol performs, but routed through the real mint-sale
        // (chips.creator is now the sale, not the test).
        vm.prank(op);
        sale.createSeries(1, 1 ether, uint64(block.timestamp + 3650 days), address(tok), 1);

        _onboardOperator(op);

        address[3] memory actors = [player, buyerA, buyerB];
        for (uint256 i = 0; i < 3; i++) {
            address a = actors[i];
            tok.mint(a, 1_000_000 ether);
            vm.prank(a); tok.approve(address(esc), type(uint256).max);
            vm.prank(a); tok.approve(address(sale), type(uint256).max);
            vm.prank(a); tok.approve(address(mkt), type(uint256).max);
            vm.prank(a); esc.setPlayerGame(address(game), true);
            vm.prank(a); chips.setApprovalForAll(address(game), true);
        }
    }

    // ── setup helpers ────────────────────────────────────────────────────────────────────────────────

    /// @notice Register op, fund bankroll + fee pool, authorize the game, and approve the pool so the
    /// mint-sale's `fundEarmark` can pull op's backing on every `buy`.
    function _onboardOperator(address o) internal {
        vm.prank(o); reg.register();
        tok.mint(o, 10_000_000 ether);
        vm.startPrank(o);
        tok.approve(address(esc), type(uint256).max);
        tok.approve(address(game), type(uint256).max);
        tok.approve(address(pool), type(uint256).max);
        esc.depositBankroll(o, address(tok), BANKROLL);
        game.depositFees(o, address(tok), FEES);
        esc.authorizeGame(address(game), true);
        vm.stopPrank();
    }

    /// @notice Stamp a fresh series through the REAL mint-sale (chips.creator) and attach it to a fresh
    /// boosted table, exactly the S1/F-C wiring: series token == table token, base+bonusPoints <= MULT_MAX.
    function _createSeriesAndTable(uint256 priceP) internal returns (uint256 sid, bytes32 tid) {
        vm.prank(op);
        sid = sale.createSeries(BONUS_POINTS, SERIES_MAX_STAKE, uint64(block.timestamp + 7 days), address(tok), priceP);
        _trackSeries(sid);
        vm.prank(op);
        tid = game.createTable(address(tok), BASE_MULT, MIN_STAKE, MAX_STAKE);
        vm.prank(op);
        game.setBonusSeries(tid, sid);
    }

    function _buy(uint256 sid, address buyer, uint256 n) internal {
        vm.prank(buyer);
        sale.buy(sid, n);
    }

    function _trackSeries(uint256 s) internal {
        if (!seriesSeen[s]) { seriesSeen[s] = true; seriesIds.push(s); }
    }

    function _trackRound(bytes32 r) internal {
        if (!roundSeen[r]) { roundSeen[r] = true; roundIds.push(r); }
    }

    function _locsIdx(uint256 price, uint256 idx) internal view returns (PreimageLocation.Info[] memory L) {
        L = new PreimageLocation.Info[](subset.length);
        for (uint256 i = 0; i < subset.length; i++) {
            L[i] = PreimageLocation.Info({
                provider: subset[i], callAtChange: true, durationIsTimestamp: false,
                duration: 12, token: address(tok), price: price, offset: 0, index: idx
            });
        }
    }

    function _locsAt(uint256 price) internal view returns (PreimageLocation.Info[] memory) {
        return _locsIdx(price, 0);
    }

    function _openBoosted(bytes32 tableId, uint8 side, uint256 stake)
        internal
        returns (bytes32 roundId, bytes32 key, PreimageLocation.Info[] memory locs)
    {
        uint256 tierPrice = game.tierPriceOf(tableId, stake);
        locs = _locsIdx(tierPrice, ++_nonce);
        vm.prank(player);
        roundId = game.openBoosted(tableId, side, stake, 0, subset, locs);
        key = _key(roundId);
    }

    function _key(bytes32 roundId) internal view returns (bytes32 k) {
        (,,,,,, k,,,,,,,) = game.rounds(roundId);
    }

    // ── invariant assertions ─────────────────────────────────────────────────────────────────────────

    /// P1: bankrollOf(pool) == Σearmark[s] + Σhold[r] + credit(op). P2: earmark[s] == circ(s)*w(s).
    function _assertBackingInvariants() internal view {
        uint256 sumEarmark;
        for (uint256 i = 0; i < seriesIds.length; i++) {
            uint256 s = seriesIds[i];
            assertEq(pool.earmark(s), pool.circ(s) * chips.w(s), "P2: earmark != circ*w");
            sumEarmark += pool.earmark(s);
        }
        uint256 sumHold;
        for (uint256 i = 0; i < roundIds.length; i++) sumHold += pool.hold(roundIds[i]);
        assertEq(
            esc.bankrollOf(address(pool), address(tok)),
            sumEarmark + sumHold + pool.credit(op, address(tok)),
            "P1: pool bankroll != earmark + hold + credit"
        );
    }

    /// V1: escrowed[s] == alive(s)*price[s]. V2: sale token balance == Σescrowed + vested(op) +
    /// Σrefundable(all known holders) + feeAccrued.
    function _assertPriceInvariants() internal view {
        uint256 sumEscrowed;
        for (uint256 i = 0; i < seriesIds.length; i++) {
            uint256 s = seriesIds[i];
            assertEq(sale.escrowed(s), sale.alive(s) * sale.price(s), "V1: escrowed != alive*P");
            sumEscrowed += sale.escrowed(s);
        }
        uint256 rhs = sumEscrowed
            + sale.vested(op, address(tok))
            + sale.refundable(player, address(tok))
            + sale.refundable(buyerA, address(tok))
            + sale.refundable(buyerB, address(tok))
            + sale.feeAccrued(address(tok));
        assertEq(tok.balanceOf(address(sale)), rhs, "V2: sale balance != escrowed + vested + refundable + fee");
    }

    function _assertAll() internal view {
        _assertBackingInvariants();
        _assertPriceInvariants();
    }

    // ═══════════════════════════════════════════════════════════════════════════════════════════════
    // Scenario 1: buy -> openBoosted -> settle-WIN
    // ═══════════════════════════════════════════════════════════════════════════════════════════════

    function test_S1_win_playerReceivesPT_operatorVestsPMinusF_feeAccrues_residualReleased() public {
        (uint256 sid, bytes32 tid) = _createSeriesAndTable(PRICE);
        _assertAll();

        _buy(sid, player, 1);
        _assertAll();

        (bytes32 roundId, bytes32 key,) = _openBoosted(tid, 0, STAKE);
        _trackRound(roundId);
        _assertAll();

        uint256 playerBefore = tok.balanceOf(player);
        uint256 vestedBefore = sale.vested(op, address(tok));
        uint256 feeBefore = sale.feeAccrued(address(tok));
        uint256 creditBefore = pool.credit(op, address(tok));

        rnd.pushCast(key, bytes32(uint256(0))); // even seed -> side 0 (HEADS) wins

        assertEq(tok.balanceOf(player), playerBefore + PT, "player receives P_t (both bets)");
        assertEq(sale.vested(op, address(tok)), vestedBefore + (PRICE - FEE), "operator vests P-f");
        assertEq(sale.feeAccrued(address(tok)), feeBefore + FEE, "fee accrues");
        assertEq(pool.credit(op, address(tok)), creditBefore + R, "backing residual released to credit");
        assertEq(pool.hold(roundId), 0, "hold cleared");
        assertEq(chips.balanceOf(address(game), sid), 0, "charge burned");
        assertEq(sale.escrowed(sid), 0, "escrowed drained");
        assertEq(sale.alive(sid), 0, "alive drained");
        _assertAll();
    }

    // ═══════════════════════════════════════════════════════════════════════════════════════════════
    // Scenario 2: buy -> openBoosted -> settle-LOSS
    // ═══════════════════════════════════════════════════════════════════════════════════════════════

    function test_S2_loss_operatorGetsBaseAndBoostBack_vestsPMinusF() public {
        (uint256 sid, bytes32 tid) = _createSeriesAndTable(PRICE);
        _buy(sid, player, 1);
        (bytes32 roundId, bytes32 key,) = _openBoosted(tid, 0, STAKE);
        _trackRound(roundId);
        _assertAll();

        uint256 opBankBefore = esc.bankrollOf(op, address(tok));
        uint256 poolBankBefore = esc.bankrollOf(address(pool), address(tok));
        uint256 vestedBefore = sale.vested(op, address(tok));
        uint256 feeBefore = sale.feeAccrued(address(tok));
        uint256 creditBefore = pool.credit(op, address(tok));

        rnd.pushCast(key, bytes32(uint256(1))); // odd -> TAILS -> player (HEADS) loses

        // Operator regains the base payout P_b (rake 0 by default).
        assertEq(esc.bankrollOf(op, address(tok)), opBankBefore + PB, "operator regains P_b");
        // Bet B returns d to the pool bucket; the pool credits the operator the full w (= d + r).
        assertEq(esc.bankrollOf(address(pool), address(tok)), poolBankBefore + D, "pool bucket +d");
        assertEq(pool.credit(op, address(tok)), creditBefore + W, "pool credits the operator w = d+r");
        assertEq(pool.hold(roundId), 0);
        // Sale side is outcome-blind: loss vests P-f exactly like a win.
        assertEq(sale.vested(op, address(tok)), vestedBefore + (PRICE - FEE), "loss vests P-f, outcome-blind");
        assertEq(sale.feeAccrued(address(tok)), feeBefore + FEE, "fee accrues");
        assertEq(chips.balanceOf(address(game), sid), 0, "charge burned");
        _assertAll();
    }

    // ═══════════════════════════════════════════════════════════════════════════════════════════════
    // Scenario 3: buy -> openBoosted -> CHOP (validator withholds)
    // ═══════════════════════════════════════════════════════════════════════════════════════════════

    function test_S3_chop_playerRefundedStakeAndPrice_operatorVestsZero_chargeBurnedForfeitToSink() public {
        (uint256 sid, bytes32 tid) = _createSeriesAndTable(PRICE);
        _buy(sid, player, 1);
        (bytes32 roundId, bytes32 key, PreimageLocation.Info[] memory locs) = _openBoosted(tid, 0, STAKE);
        _trackRound(roundId);
        _assertAll();

        uint256 playerTokBefore = tok.balanceOf(player); // after open (stake already pulled)
        uint256 poolBankBefore = esc.bankrollOf(address(pool), address(tok));
        uint256 creditBefore = pool.credit(op, address(tok));
        uint256 burnedBefore = burnPolicy.burned(address(tok));
        uint256 vestedBefore = sale.vested(op, address(tok));
        uint256 refundableBefore = sale.refundable(player, address(tok));

        rnd.setRevealed(key, 0x3); // 1 of 3 validators withholds -> forfeit = 1 * tierPrice (== STAKE here)

        vm.expectEmit(true, true, true, true);
        emit OperatorCoinFlip.ForfeitRouted(roundId, op, address(tok), STAKE);
        game.chopAndRoute(roundId, locs);

        // Player made whole on the stake (escrow refund).
        assertEq(tok.balanceOf(player), playerTokBefore + STAKE, "player refunded stake");
        // Player refunded the full purchase price P — the chop-harvest fix; operator vests NOTHING.
        assertEq(sale.refundable(player, address(tok)), refundableBefore + PRICE, "player refunded P");
        assertEq(sale.vested(op, address(tok)), vestedBefore, "operator vests nothing on chop");
        // Bet B returns d to the pool; operator credited the full w; charge BURNED (never returned, F4).
        assertEq(esc.bankrollOf(address(pool), address(tok)), poolBankBefore + D, "pool bucket +d");
        assertEq(pool.credit(op, address(tok)), creditBefore + W, "pool credits the operator w");
        assertEq(chips.balanceOf(address(game), sid), 0, "charge no longer held by the game");
        assertEq(chips.balanceOf(player, sid), 0, "charge never returned to the player");
        // Forfeit routed to the neutral sink (real BurnFeePolicy).
        assertEq(burnPolicy.burned(address(tok)), burnedBefore + STAKE, "forfeit burned to the sink");
        assertEq(sale.escrowed(sid), 0);
        assertEq(sale.alive(sid), 0);
        _assertAll();
    }

    // ═══════════════════════════════════════════════════════════════════════════════════════════════
    // Scenario 4: buy -> openBoosted -> plain-timeout (no chop)
    // ═══════════════════════════════════════════════════════════════════════════════════════════════

    function test_S4_plainTimeout_chargeReturned_priceStaysEscrowed_backingReEarmarked() public {
        (uint256 sid, bytes32 tid) = _createSeriesAndTable(PRICE);
        _buy(sid, player, 1);
        (bytes32 roundId,,) = _openBoosted(tid, 0, STAKE);
        _trackRound(roundId);
        _assertAll();

        uint256 earmarkBefore = pool.earmark(sid); // 0 (consumed at open)
        uint256 circBefore = pool.circ(sid); // 0
        uint256 escrowedBefore = sale.escrowed(sid);
        uint256 aliveBefore = sale.alive(sid);
        uint256 poolBankBefore = esc.bankrollOf(address(pool), address(tok));

        vm.roll(block.number + 201); // past STALE_BLOCKS, no chop -> plain-timeout branch
        game.refundStale(roundId);

        // The charge is RETURNED to the player (never burned) -> the price side sees NO change at all.
        assertEq(chips.balanceOf(player, sid), 1, "charge returned to player");
        assertEq(chips.balanceOf(address(game), sid), 0);
        assertEq(sale.escrowed(sid), escrowedBefore, "price P stays escrowed (no burn)");
        assertEq(sale.alive(sid), aliveBefore, "alive unchanged (no burn)");
        // Bet B returns d to the pool; the pool re-earmarks the full w (funded exactly by d + r).
        assertEq(esc.bankrollOf(address(pool), address(tok)), poolBankBefore + D, "pool bucket +d");
        assertEq(pool.earmark(sid), earmarkBefore + W, "backing re-earmarked");
        assertEq(pool.circ(sid), circBefore + 1, "circ +1 (charge back in circulation)");
        assertEq(pool.hold(roundId), 0);
        assertFalse(game.parkedCharge(roundId));
        _assertAll();
    }

    // ═══════════════════════════════════════════════════════════════════════════════════════════════
    // Scenario 5: buy -> (unused) -> expiry — backing to operator AND price refund, one call
    // ═══════════════════════════════════════════════════════════════════════════════════════════════

    function test_S5_expiry_unusedCharges_backingToOperator_priceRefundedToHolder_oneCall() public {
        (uint256 sid,) = _createSeriesAndTable(PRICE);
        uint256 n = 3;
        _buy(sid, player, n); // player never opens a round with these — pure unused expiry
        _assertAll();

        vm.warp(block.timestamp + 8 days); // past the 7-day series expiry

        uint256 earmarkBefore = pool.earmark(sid);
        uint256 creditBefore = pool.credit(op, address(tok));
        uint256 escrowedBefore = sale.escrowed(sid);
        uint256 aliveBefore = sale.alive(sid);
        uint256 refundableBefore = sale.refundable(player, address(tok));
        uint256 w = chips.w(sid);

        pool.expireCharges(sid, player, n); // ONE call: burns n charges, moves BOTH backing and price

        // Backing: n*w returned to the operator's credit; earmark releases.
        assertEq(pool.earmark(sid), earmarkBefore - n * w, "earmark released");
        assertEq(pool.credit(op, address(tok)), creditBefore + n * w, "operator credited backing");
        // Price: the current holder is refunded n*P (fee-inclusive) in the SAME call.
        assertEq(sale.refundable(player, address(tok)), refundableBefore + n * PRICE, "holder refunded n*P");
        assertEq(sale.escrowed(sid), escrowedBefore - n * PRICE, "escrowed released");
        assertEq(sale.alive(sid), aliveBefore - n, "alive decremented");
        assertEq(chips.balanceOf(player, sid), 0, "charges burned");
        _assertAll();
    }

    // ═══════════════════════════════════════════════════════════════════════════════════════════════
    // Scenario 6: resale — expiry refunds the CURRENT holder, not the seller, not the ask Q
    // ═══════════════════════════════════════════════════════════════════════════════════════════════

    function test_S6_resale_expiryRefundsCurrentHolderNotSellerOrAsk() public {
        (uint256 sid,) = _createSeriesAndTable(PRICE);
        uint256 n = 5;
        _buy(sid, buyerA, n); // buyerA buys from the mint-sale, then resells
        vm.prank(buyerA); chips.setApprovalForAll(address(mkt), true);
        _assertAll();

        vm.prank(buyerA);
        uint256 lid = mkt.list(sid, n, ASK);

        uint256 fillUnits = 3;
        vm.prank(buyerB);
        mkt.fill(lid, fillUnits);

        assertEq(chips.balanceOf(buyerB, sid), fillUnits, "buyerB holds the resold units");
        assertEq(chips.balanceOf(buyerA, sid), n - fillUnits, "buyerA keeps the rest");
        // Resale moves NO price ledger — the claim rides the ERC1155 unit, zero bookkeeping.
        assertEq(sale.refundable(buyerA, address(tok)), 0);
        assertEq(sale.refundable(buyerB, address(tok)), 0);
        _assertAll();

        // buyerB lets its resold units expire.
        vm.warp(block.timestamp + 8 days);
        pool.expireCharges(sid, buyerB, fillUnits);

        // The BUYER — the current holder — is refunded the full MINT price P per unit (not the ask Q).
        assertEq(sale.refundable(buyerB, address(tok)), fillUnits * PRICE, "buyerB refunded fillUnits*P");
        assertEq(sale.refundable(buyerA, address(tok)), 0, "the seller has no claim on resold units");

        uint256 before = tok.balanceOf(buyerB);
        vm.prank(buyerB);
        sale.withdrawRefund(address(tok), fillUnits * PRICE);
        assertEq(tok.balanceOf(buyerB) - before, fillUnits * PRICE, "buyerB withdrew the full P refund");
        _assertAll();
    }

    // ═══════════════════════════════════════════════════════════════════════════════════════════════
    // Mixed randomized sequence — buy / open / settle / chop / timeout / withdraw, all through the
    // real stack, asserting P1/P2/V1/V2 after every step.
    // ═══════════════════════════════════════════════════════════════════════════════════════════════

    function test_e2e_randomizedInvariant(uint256 seed) public {
        (uint256 sid, bytes32 tid) = _createSeriesAndTable(PRICE);
        uint256 w = chips.w(sid);

        vm.prank(op); game.depositFees(op, address(tok), 10_000 ether);
        _buy(sid, player, 6);
        _assertAll();

        uint256 nLive;
        bytes32[32] memory liveRound;
        bytes32[32] memory liveKey;
        uint256[32] memory liveIdx;

        for (uint256 step = 0; step < 30; step++) {
            seed = uint256(keccak256(abi.encode(seed, step)));
            uint256 action = seed % 7;

            if (action == 0) {
                // BUY a small batch.
                uint256 n = (seed >> 8) % 3 + 1;
                _buy(sid, player, n);
            } else if (action == 1) {
                // OPEN BOOSTED — needs a player charge, backing, fee headroom, and live-array room.
                if (chips.balanceOf(player, sid) == 0) continue;
                if (pool.earmark(sid) < w) continue;
                if (game.feeBalance(op, address(tok)) < 3 * STAKE) continue;
                if (nLive >= liveRound.length) continue;
                uint256 idx = ++_nonce;
                vm.prank(player);
                bytes32 rid = game.openBoosted(tid, uint8((seed >> 16) % 2), STAKE, 0, subset, _locsIdx(STAKE, idx));
                _trackRound(rid);
                liveRound[nLive] = rid;
                liveKey[nLive] = _key(rid);
                liveIdx[nLive] = idx;
                nLive++;
            } else if (action >= 2 && action <= 4) {
                if (nLive == 0) continue;
                uint256 pick = (seed >> 24) % nLive;
                if (action == 2) {
                    // SETTLE via pushCast (win or lose — both invariant families must hold either way).
                    rnd.pushCast(liveKey[pick], bytes32(seed));
                } else if (action == 3) {
                    // CHOP — one validator withholds.
                    rnd.setRevealed(liveKey[pick], 0x3);
                    game.chopAndRoute(liveRound[pick], _locsIdx(STAKE, liveIdx[pick]));
                } else {
                    // PLAIN-TIMEOUT — roll past staleness, no chop.
                    vm.roll(block.number + 201);
                    game.refundStale(liveRound[pick]);
                }
                liveRound[pick] = liveRound[nLive - 1];
                liveKey[pick] = liveKey[nLive - 1];
                liveIdx[pick] = liveIdx[nLive - 1];
                nLive--;
            } else if (action == 5) {
                // WITHDRAW a slice of the operator's vested price.
                uint256 c = sale.vested(op, address(tok));
                if (c == 0) continue;
                vm.prank(op);
                sale.withdrawVested(address(tok), (seed >> 8) % c + 1);
            } else {
                // WITHDRAW a slice of the player's refundable price, or a slice of pool credit.
                if ((seed >> 8) % 2 == 0) {
                    uint256 c = sale.refundable(player, address(tok));
                    if (c == 0) continue;
                    vm.prank(player);
                    sale.withdrawRefund(address(tok), (seed >> 16) % c + 1);
                } else {
                    uint256 c = pool.credit(op, address(tok));
                    if (c == 0) continue;
                    vm.prank(op);
                    pool.withdrawCredit(address(tok), (seed >> 16) % c + 1);
                }
            }

            _assertAll();
        }

        // Drain every remaining live round.
        for (uint256 i = 0; i < nLive; i++) {
            rnd.pushCast(liveKey[i], bytes32(seed + i));
        }
        _assertAll();

        // Expire whatever the player still holds unused.
        vm.warp(block.timestamp + 8 days);
        uint256 held = chips.balanceOf(player, sid);
        if (held > 0) pool.expireCharges(sid, player, held);
        _assertAll();
    }
}
