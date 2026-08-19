// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {OperatorRegistry} from "../../contracts/games/operator/OperatorRegistry.sol";
import {GameEscrow} from "../../contracts/games/operator/GameEscrow.sol";
import {BonusChips1155} from "../../contracts/games/operator/BonusChips1155.sol";
import {BackingPool} from "../../contracts/games/operator/BackingPool.sol";
import {MintSale} from "../../contracts/games/operator/MintSale.sol";
import {IFeePolicy} from "../../contracts/games/operator/IFeePolicy.sol";
import {ERC20} from "../../contracts/test/ERC20.sol";

/// @notice A faithful stand-in for the boosted game's price-relevant burns. It performs EXACTLY the
/// paired bet-B escrow + pool-hook dance per terminal (so the REAL BackingPool stays internally
/// consistent), and it burns each used charge through the chips the same way OperatorCoinFlip does:
/// - win / loss  → `chips.burn(...)`                       (beneficiary 0 → the operator vests P-f)
/// - chop        → `chips.burnWithBeneficiary(..., player)` (beneficiary → the player is refunded P)
/// - plain-timeout → the charge is RETURNED, never burned  (no price release)
contract MockBoostGame {
    GameEscrow public immutable escrow;
    BonusChips1155 public immutable chips;
    BackingPool public pool;

    struct R { uint256 seriesId; uint256 d; address player; address token; bool open; }
    mapping(bytes32 => R) public rounds;

    constructor(GameEscrow e, BonusChips1155 c) { escrow = e; chips = c; }
    function setPool(BackingPool p) external { pool = p; }

    function _boostId(bytes32 roundId) internal pure returns (bytes32) {
        return keccak256(abi.encode(roundId, "boost"));
    }

    function open(bytes32 roundId, uint256 seriesId, uint256 d, address player) external {
        (,,, address token) = chips.seriesOf(seriesId);
        chips.safeTransferFrom(player, address(this), seriesId, 1, ""); // exact-pull custody
        pool.consume(roundId, seriesId, d);
        escrow.lockExposure(_boostId(roundId), address(pool), token, player, 0, d); // bet B
        rounds[roundId] = R(seriesId, d, player, token, true);
    }

    function win(bytes32 roundId) external {
        R storage r = rounds[roundId]; r.open = false;
        escrow.settleWin(_boostId(roundId));
        pool.onSettleWin(roundId);
        chips.burn(address(this), r.seriesId, 1); // beneficiary 0 → vest
    }

    function loss(bytes32 roundId) external {
        R storage r = rounds[roundId]; r.open = false;
        escrow.settleLoss(_boostId(roundId));
        pool.onSettleLoss(roundId);
        chips.burn(address(this), r.seriesId, 1); // beneficiary 0 → vest
    }

    function plainRefund(bytes32 roundId) external {
        R storage r = rounds[roundId]; r.open = false;
        escrow.refund(_boostId(roundId));
        pool.onPlainRefund(roundId);
        chips.safeTransferFrom(address(this), r.player, r.seriesId, 1, ""); // return, no burn
    }

    function chopRefund(bytes32 roundId) external {
        R storage r = rounds[roundId]; r.open = false;
        escrow.refund(_boostId(roundId));
        pool.onChopRefund(roundId);
        chips.burnWithBeneficiary(address(this), r.seriesId, 1, r.player); // chop-harvest fix
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC1155Received.selector;
    }
}

/// @notice A configurable fee policy. Quotes a fixed bps for the mint-sale kind and tallies routed fees.
contract MockFeePolicy is IFeePolicy {
    uint16 public bps;
    bool public reverting;
    mapping(address token => uint256) public routed;

    constructor(uint16 b) { bps = b; }
    function setBps(uint16 b) external { bps = b; }
    function setReverting(bool r) external { reverting = r; }

    function feeBps(bytes32, address, address) external view returns (uint16) { return bps; }
    function route(bytes32, address token, uint256 amount, bytes calldata) external {
        require(!reverting, "policy down");
        routed[token] += amount;
    }
}

contract MintSaleTest is Test {
    OperatorRegistry internal reg;
    GameEscrow internal esc;
    BonusChips1155 internal chips;
    BackingPool internal pool;
    MockBoostGame internal game;
    MintSale internal sale;
    MockFeePolicy internal policy;
    ERC20 internal tok;

    address internal operator = address(0x0B);
    address internal player = address(0x9E7); // buys AND plays (so it holds the charge to open a round)
    address internal keeper = address(0xCAFE);

    uint16 internal constant FEE_BPS = 500; // 5%
    uint256 internal constant P = 1000;      // price per charge
    uint256 internal constant F = 50;        // floor(1000 * 500 / 10000)

    uint256[] internal seriesIds;

    function setUp() public {
        reg = new OperatorRegistry();
        esc = new GameEscrow(address(reg));
        chips = new BonusChips1155();
        tok = new ERC20(false);

        game = new MockBoostGame(esc, chips);
        pool = new BackingPool(address(esc), address(chips), address(game));
        game.setPool(pool);

        policy = new MockFeePolicy(FEE_BPS);
        sale = new MintSale(address(chips));
        sale.setPool(address(pool));
        sale.setGame(address(game));
        sale.setPolicy(address(policy));

        // Wiring (governance-critical): creator = MintSale, minter = pool, pool.minter = MintSale,
        // burners = {game, pool}, priceLedger = MintSale.
        chips.setCreator(address(sale));
        chips.setMinter(address(pool));
        chips.setBurner(address(game), true);
        chips.setBurner(address(pool), true);
        chips.setPriceLedger(address(sale));
        pool.setMinter(address(sale));

        vm.prank(operator);
        reg.register();

        // Player consents to the game (bet B checks consent) and approves the game to move its charges.
        vm.prank(player);
        esc.setPlayerGame(address(game), true);
        vm.prank(player);
        chips.setApprovalForAll(address(game), true);

        // Operator funds BACKING through the pool; buyer (player) funds the PRICE through the sale.
        tok.mint(operator, 1_000_000 ether);
        vm.prank(operator);
        tok.approve(address(pool), type(uint256).max);
        tok.mint(player, 1_000_000 ether);
        vm.prank(player);
        tok.approve(address(sale), type(uint256).max);
    }

    // ── helpers ──────────────────────────────────────────────────────────────────────────────────

    function _createSeries() internal returns (uint256 id) {
        vm.prank(operator);
        id = sale.createSeries(25, 999, uint64(block.timestamp + 7 days), address(tok), P); // w = 250
        seriesIds.push(id);
    }

    function _buy(uint256 s, uint256 n) internal {
        vm.prank(player);
        sale.buy(s, n);
    }

    /// V1 (per series) + V2 (token conservation), asserted with EQUALITY (the sale holds only price).
    function _assertV1V2() internal view {
        uint256 sumEscrowed;
        for (uint256 i = 0; i < seriesIds.length; i++) {
            uint256 s = seriesIds[i];
            assertEq(sale.escrowed(s), sale.alive(s) * sale.price(s), "V1: escrowed != alive * P");
            sumEscrowed += sale.escrowed(s);
        }
        uint256 rhs = sumEscrowed
            + sale.vested(operator, address(tok))
            + sale.refundable(player, address(tok))
            + sale.feeAccrued(address(tok));
        assertEq(tok.balanceOf(address(sale)), rhs, "V2: balance != escrowed + vested + refundable + fee");
    }

    // ── S1 buy ─────────────────────────────────────────────────────────────────────────────────────

    function test_buy_deltas() public {
        uint256 id = _createSeries();
        uint256 w = chips.w(id); // 250

        uint256 playerBefore = tok.balanceOf(player);
        uint256 opBefore = tok.balanceOf(operator);

        _buy(id, 3);

        assertEq(sale.escrowed(id), 3 * P, "escrowed");
        assertEq(sale.alive(id), 3, "alive");
        assertEq(chips.balanceOf(player, id), 3, "charges minted to buyer");
        assertEq(playerBefore - tok.balanceOf(player), 3 * P, "buyer paid n*P");
        assertEq(opBefore - tok.balanceOf(operator), 3 * w, "operator funded n*w backing");
        assertEq(tok.balanceOf(address(sale)), 3 * P, "sale holds the price in its own balance");
        _assertV1V2();
    }

    // ── S2 use: win / loss both vest P-f (outcome-blind) ─────────────────────────────────────────────

    function test_settle_win_vests() public {
        uint256 id = _createSeries();
        _buy(id, 1);
        bytes32 rid = keccak256("win");
        game.open(rid, id, 100, player);
        game.win(rid);

        assertEq(sale.vested(operator, address(tok)), P - F, "vest = P - f");
        assertEq(sale.feeAccrued(address(tok)), F, "fee accrued");
        assertEq(sale.escrowed(id), 0, "escrowed drained");
        assertEq(sale.alive(id), 0, "alive drained");
        assertEq(sale.refundable(player, address(tok)), 0, "no refund on a settled round");
        _assertV1V2();
    }

    function test_settle_loss_vests_sameAsWin() public {
        uint256 id = _createSeries();
        _buy(id, 1);
        bytes32 rid = keccak256("loss");
        game.open(rid, id, 100, player);
        game.loss(rid);

        assertEq(sale.vested(operator, address(tok)), P - F, "loss vests P - f, outcome-blind");
        assertEq(sale.feeAccrued(address(tok)), F);
        assertEq(sale.refundable(player, address(tok)), 0);
        _assertV1V2();
    }

    // ── S3 plain-timeout: charge returned, NO price-side change ──────────────────────────────────────

    function test_plain_timeout_noPriceChange() public {
        uint256 id = _createSeries();
        _buy(id, 1);
        bytes32 rid = keccak256("plain");
        game.open(rid, id, 100, player);
        game.plainRefund(rid);

        assertEq(sale.escrowed(id), P, "escrowed unchanged");
        assertEq(sale.alive(id), 1, "alive unchanged (no burn)");
        assertEq(chips.balanceOf(player, id), 1, "charge returned to the player");
        assertEq(sale.vested(operator, address(tok)), 0);
        assertEq(sale.refundable(player, address(tok)), 0);
        _assertV1V2();
    }

    // ── S4 chop: player refunded P, operator vests NOTHING (chop-harvest fix) ────────────────────────

    function test_chop_refundsPlayer_notOperator() public {
        uint256 id = _createSeries();
        _buy(id, 1);
        bytes32 rid = keccak256("chop");
        game.open(rid, id, 100, player);
        game.chopRefund(rid);

        assertEq(sale.refundable(player, address(tok)), P, "player refunded full P");
        assertEq(sale.vested(operator, address(tok)), 0, "operator vests NOTHING on an abort");
        assertEq(sale.feeAccrued(address(tok)), 0, "no fee on an abort");
        assertEq(sale.escrowed(id), 0);
        assertEq(sale.alive(id), 0);
        _assertV1V2();
    }

    // ── S5 expiry: pool burn refunds the holder P (fee-inclusive) ────────────────────────────────────

    function test_expiry_refundsHolder() public {
        uint256 id = _createSeries();
        _buy(id, 3);

        vm.warp(block.timestamp + 8 days);
        pool.expireCharges(id, player, 2); // permissionless; pool is the burner

        assertEq(sale.refundable(player, address(tok)), 2 * P, "holder refunded n*P, fee-inclusive");
        assertEq(sale.vested(operator, address(tok)), 0, "expiry never vests to the operator");
        assertEq(sale.escrowed(id), 1 * P, "one charge still alive");
        assertEq(sale.alive(id), 1);
        _assertV1V2();
    }

    // ── the chop-harvest attack: forcing chops must NEVER vest P to the operator ─────────────────────

    /// An operator running its own validator could force a chop on every boosted round. If a chop vested
    /// P, that would reopen the F5 abort profit. It MUST NOT: every chopped round refunds the player and
    /// vests the operator zero, no matter how many rounds the operator aborts.
    function test_chopHarvest_operatorGetsNothing() public {
        uint256 id = _createSeries();
        _buy(id, 5);

        for (uint256 i = 0; i < 5; i++) {
            bytes32 rid = keccak256(abi.encode("harvest", i));
            game.open(rid, id, 120, player);
            game.chopRefund(rid);
            _assertV1V2();
        }

        assertEq(sale.vested(operator, address(tok)), 0, "operator vested nothing across 5 forced chops");
        assertEq(sale.feeAccrued(address(tok)), 0, "no fee earned on aborts");
        assertEq(sale.refundable(player, address(tok)), 5 * P, "player recovered the full price every time");

        // And the player can actually pull the refund back out.
        uint256 before = tok.balanceOf(player);
        vm.prank(player);
        sale.withdrawRefund(address(tok), 5 * P);
        assertEq(tok.balanceOf(player) - before, 5 * P, "player withdrew the full refunded price");
    }

    // ── fee-at-vest, refunds fee-inclusive: a rugged buyer loses zero ────────────────────────────────

    function test_feeAtVest_refundIsFeeInclusive() public {
        uint256 id = _createSeries();
        _buy(id, 2);

        // One charge is delivered (settled) — the platform earns f on it.
        bytes32 rid = keccak256("delivered");
        game.open(rid, id, 100, player);
        game.win(rid);
        assertEq(sale.vested(operator, address(tok)), P - F);
        assertEq(sale.feeAccrued(address(tok)), F);

        // The other charge expires — the buyer is refunded the FULL P (no fee taken on the refund).
        vm.warp(block.timestamp + 8 days);
        pool.expireCharges(id, player, 1);
        assertEq(sale.refundable(player, address(tok)), P, "refund is fee-inclusive: full P");
        _assertV1V2();
    }

    // ── V3: the operator can reach ONLY vested ───────────────────────────────────────────────────────

    function test_V3_operatorReachesOnlyVested() public {
        uint256 id = _createSeries();
        _buy(id, 2);
        bytes32 rid = keccak256("v3");
        game.open(rid, id, 100, player);
        game.win(rid); // vests P-f to the operator; the other charge's P is still escrowed

        // The operator withdraws its vested share — the only door.
        uint256 before = tok.balanceOf(operator);
        vm.prank(operator);
        sale.withdrawVested(address(tok), P - F);
        assertEq(tok.balanceOf(operator) - before, P - F);

        // The operator cannot reach escrowed or refundable: no vested left, and refundable is 0 for it.
        vm.prank(operator);
        vm.expectRevert(MintSale.InsufficientVested.selector);
        sale.withdrawVested(address(tok), 1);
        vm.prank(operator);
        vm.expectRevert(MintSale.InsufficientRefund.selector);
        sale.withdrawRefund(address(tok), 1);

        // The still-escrowed charge's P is untouched by any operator action.
        assertEq(sale.escrowed(id), P, "escrowed for the live charge is unreachable by the operator");
        _assertV1V2();
    }

    // ── V4: exactly-once release per burned unit ─────────────────────────────────────────────────────

    function test_V4_exactlyOncePerBurn() public {
        uint256 id = _createSeries();
        _buy(id, 1);
        bytes32 rid = keccak256("v4");
        game.open(rid, id, 100, player);

        uint256 escBefore = sale.escrowed(id);
        game.win(rid); // one burn → exactly one P released
        assertEq(escBefore - sale.escrowed(id), P, "exactly one P released on the single burn");

        // The unit is gone; the game cannot burn it again (chips has no balance) → no second release.
        vm.prank(address(game));
        vm.expectRevert(); // ERC1155: insufficient balance
        chips.burn(address(game), id, 1);
        assertEq(sale.escrowed(id), 0, "no second release");
        _assertV1V2();
    }

    // ── onBurn access + hook-safety (no revert on a reachable input) ─────────────────────────────────

    function test_onBurn_revertsForNonChips() public {
        uint256 id = _createSeries();
        vm.prank(address(0xBAD));
        vm.expectRevert(MintSale.NotChips.selector);
        sale.onBurn(address(game), player, id, 1, address(0));
    }

    function test_onBurn_unknownSeries_isNoop() public {
        // Called by the chips with an unstamped id: must NOT revert and must move no ledger.
        vm.prank(address(chips));
        sale.onBurn(address(game), player, 99999, 1, address(0));
        assertEq(sale.escrowed(99999), 0);
        assertEq(sale.refundable(player, address(tok)), 0);
        assertEq(sale.vested(operator, address(tok)), 0);
    }

    // ── withdrawals: CEI + scoping ───────────────────────────────────────────────────────────────────

    function test_withdrawVested_scoping() public {
        uint256 id = _createSeries();
        _buy(id, 1);
        bytes32 rid = keccak256("wv");
        game.open(rid, id, 100, player);
        game.win(rid);

        // A non-operator has zero vested → cannot withdraw.
        vm.prank(address(0xBAD));
        vm.expectRevert(MintSale.InsufficientVested.selector);
        sale.withdrawVested(address(tok), 1);

        // The operator cannot overdraw.
        vm.prank(operator);
        vm.expectRevert(MintSale.InsufficientVested.selector);
        sale.withdrawVested(address(tok), P - F + 1);
    }

    function test_withdrawRefund_scoping() public {
        uint256 id = _createSeries();
        _buy(id, 1);
        bytes32 rid = keccak256("wr");
        game.open(rid, id, 100, player);
        game.chopRefund(rid); // refundable[player] = P

        // Another address cannot pull the player's refund.
        vm.prank(address(0xBAD));
        vm.expectRevert(MintSale.InsufficientRefund.selector);
        sale.withdrawRefund(address(tok), 1);

        // The player pulls exactly its own refund.
        uint256 before = tok.balanceOf(player);
        vm.prank(player);
        sale.withdrawRefund(address(tok), P);
        assertEq(tok.balanceOf(player) - before, P);
        assertEq(sale.refundable(player, address(tok)), 0);
        _assertV1V2();
    }

    // ── sweepFees: permissionless → policy + route ───────────────────────────────────────────────────

    function test_sweepFees_routesToPolicy() public {
        uint256 id = _createSeries();
        _buy(id, 2);
        bytes32 r1 = keccak256("s1");
        bytes32 r2 = keccak256("s2");
        game.open(r1, id, 100, player);
        game.win(r1);
        game.open(r2, id, 100, player);
        game.loss(r2);
        assertEq(sale.feeAccrued(address(tok)), 2 * F);

        uint256 policyBefore = tok.balanceOf(address(policy));
        vm.prank(keeper); // permissionless
        sale.sweepFees(address(tok));

        assertEq(sale.feeAccrued(address(tok)), 0, "fee ledger zeroed");
        assertEq(tok.balanceOf(address(policy)) - policyBefore, 2 * F, "fee delivered to the policy");
        assertEq(policy.routed(address(tok)), 2 * F, "route() called with the swept amount");
        _assertV1V2();
    }

    function test_sweepFees_noopWhenZero() public {
        vm.prank(keeper);
        sale.sweepFees(address(tok)); // nothing accrued → no-op, no revert
        assertEq(policy.routed(address(tok)), 0);
    }

    // ── buy guards ───────────────────────────────────────────────────────────────────────────────────

    function test_buy_revertsForUnknownSeries() public {
        vm.prank(player);
        vm.expectRevert(MintSale.SaleClosed.selector);
        sale.buy(4242, 1);
    }

    function test_buy_revertsForZeroAmount() public {
        uint256 id = _createSeries();
        vm.prank(player);
        vm.expectRevert(MintSale.ZeroAmount.selector);
        sale.buy(id, 0);
    }

    function test_buy_revertsWhenClosed() public {
        uint256 id = _createSeries();
        vm.prank(operator);
        sale.setSaleOpen(id, false);
        vm.prank(player);
        vm.expectRevert(MintSale.SaleClosed.selector);
        sale.buy(id, 1);
    }

    function test_buy_revertsWhenExpired() public {
        uint256 id = _createSeries();
        vm.warp(block.timestamp + 8 days); // past the series expiry
        vm.prank(player);
        vm.expectRevert(MintSale.SaleExpired.selector);
        sale.buy(id, 1);
    }

    // ── Item 4b: owner-set per-token charge-price floor (economic L2) ────────────────────────────────

    function test_setMinSeriesPrice_onlyOwner() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(MintSale.NotOwner.selector);
        sale.setMinSeriesPrice(address(tok), 500);
    }

    /// With a floor set, a series priced below it is rejected; at/above the floor it stamps normally.
    function test_createSeries_belowFloor_reverts() public {
        sale.setMinSeriesPrice(address(tok), P); // floor == P (1000)
        vm.prank(operator);
        vm.expectRevert(MintSale.PriceBelowFloor.selector);
        sale.createSeries(25, 999, uint64(block.timestamp + 7 days), address(tok), P - 1);

        // Exactly at the floor is fine.
        vm.prank(operator);
        uint256 id = sale.createSeries(25, 999, uint64(block.timestamp + 7 days), address(tok), P);
        assertEq(sale.price(id), P);
    }

    /// The floor is per token: a floor on one token never gates a series in a different token.
    function test_minSeriesPrice_isPerToken() public {
        ERC20 other = new ERC20(false);
        sale.setMinSeriesPrice(address(tok), P); // floor only on `tok`
        vm.prank(operator);
        uint256 id = sale.createSeries(25, 999, uint64(block.timestamp + 7 days), address(other), 1);
        assertEq(sale.price(id), 1); // untouched by tok's floor
    }

    /// A zero floor (the default) disables the check — the pre-existing ZeroPrice guard still applies.
    function test_createSeries_zeroFloor_disabled() public {
        // No floor set → any non-zero price stamps.
        vm.prank(operator);
        uint256 id = sale.createSeries(25, 999, uint64(block.timestamp + 7 days), address(tok), 1);
        assertEq(sale.price(id), 1);
        // Zero price is still rejected by the pre-existing guard.
        vm.prank(operator);
        vm.expectRevert(MintSale.ZeroPrice.selector);
        sale.createSeries(25, 999, uint64(block.timestamp + 7 days), address(tok), 0);
    }

    function test_createSeries_revertsWhenFeeTooHigh() public {
        policy.setBps(1001); // above MAX_FEE_BPS
        vm.prank(operator);
        vm.expectRevert(MintSale.FeeTooHigh.selector);
        sale.createSeries(25, 999, uint64(block.timestamp + 7 days), address(tok), P);
    }

    function test_buy_revertsForFeeOnTransferToken() public {
        ERC20 fot = new ERC20(true); // 1% tax
        vm.prank(operator);
        uint256 id = sale.createSeries(25, 999, uint64(block.timestamp + 7 days), address(fot), P);
        fot.mint(operator, 1_000_000 ether);
        vm.prank(operator);
        fot.approve(address(pool), type(uint256).max);
        fot.mint(player, 1_000_000 ether);
        vm.prank(player);
        fot.approve(address(sale), type(uint256).max);

        vm.prank(player);
        vm.expectRevert(MintSale.PullMismatch.selector);
        sale.buy(id, 1);
        assertEq(sale.escrowed(id), 0, "no under-escrowed sale committed");
    }

    // ── randomized sequence: V1 + V2 after EVERY transition ──────────────────────────────────────────

    function test_invariant_random_sequence(uint256 seed) public {
        uint256 id = _createSeries();
        uint256 w = chips.w(id);

        _buy(id, 20);
        _assertV1V2();

        bytes32[] memory live = new bytes32[](64);
        uint256 openCount;
        uint256 nonce;

        for (uint256 step = 0; step < 48; step++) {
            seed = uint256(keccak256(abi.encode(seed, step)));
            uint256 action = seed % 7;

            if (action == 0) {
                // BUY a small batch.
                uint256 n = (seed >> 8) % 4 + 1;
                _buy(id, n);
            } else if (action == 1) {
                // OPEN a round if the player holds a charge and the earmark can cover it.
                if (chips.balanceOf(player, id) == 0 || pool.earmark(id) < w) continue;
                uint256 d = (seed >> 8) % w + 1; // d in [1, w]
                bytes32 rid = keccak256(abi.encode("r", nonce++));
                game.open(rid, id, d, player);
                live[openCount++] = rid;
            } else if (action >= 2 && action <= 4) {
                // TERMINATE an open round: win / loss / chop (all burn the charge).
                if (openCount == 0) continue;
                uint256 pick = (seed >> 8) % openCount;
                bytes32 rid = live[pick];
                if (action == 2) game.win(rid);
                else if (action == 3) game.loss(rid);
                else game.chopRefund(rid);
                live[pick] = live[--openCount];
            } else if (action == 5) {
                // PLAIN-TIMEOUT an open round (returns the charge, no burn).
                if (openCount == 0) continue;
                uint256 pick = (seed >> 8) % openCount;
                bytes32 rid = live[pick];
                game.plainRefund(rid);
                live[pick] = live[--openCount];
            } else {
                // WITHDRAW a slice of whatever the operator/player accrued, or sweep fees.
                uint256 pickWho = (seed >> 8) % 3;
                if (pickWho == 0) {
                    uint256 c = sale.vested(operator, address(tok));
                    if (c == 0) continue;
                    vm.prank(operator);
                    sale.withdrawVested(address(tok), (seed >> 16) % c + 1);
                } else if (pickWho == 1) {
                    uint256 c = sale.refundable(player, address(tok));
                    if (c == 0) continue;
                    vm.prank(player);
                    sale.withdrawRefund(address(tok), (seed >> 16) % c + 1);
                } else {
                    vm.prank(keeper);
                    sale.sweepFees(address(tok));
                }
            }
            _assertV1V2();
        }

        // Expire everything still circulating with the player.
        vm.warp(block.timestamp + 8 days);
        uint256 held = chips.balanceOf(player, id);
        if (held > 0) pool.expireCharges(id, player, held);
        _assertV1V2();
    }
}
