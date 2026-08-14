// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {OperatorRegistry} from "../../contracts/games/operator/OperatorRegistry.sol";
import {GameEscrow} from "../../contracts/games/operator/GameEscrow.sol";
import {BonusChips1155} from "../../contracts/games/operator/BonusChips1155.sol";
import {BackingPool} from "../../contracts/games/operator/BackingPool.sol";
import {MintSale} from "../../contracts/games/operator/MintSale.sol";
import {Marketplace} from "../../contracts/games/operator/Marketplace.sol";
import {ReentrancyGuard} from "../../contracts/games/operator/ReentrancyGuard.sol";
import {IFeePolicy} from "../../contracts/games/operator/IFeePolicy.sol";
import {ERC20} from "../../contracts/test/ERC20.sol";

/// @notice A configurable, KIND-AWARE fee policy: quotes one bps for the mint-sale kind and another for
/// the marketplace kind (so one policy prices each call site differently, per IFeePolicy), and tallies
/// routed fees; can be made to revert on `route` to exercise the sweep-park path.
contract MockFeePolicy is IFeePolicy {
    bytes32 internal constant MINT_KIND = keccak256("mint-sale");
    bytes32 internal constant MKT_KIND = keccak256("marketplace");

    uint16 public mintBps;
    uint16 public mktBps;
    bool public reverting;
    mapping(address token => uint256) public routed;

    constructor(uint16 mintBps_, uint16 mktBps_) { mintBps = mintBps_; mktBps = mktBps_; }
    function setBps(uint16 b) external { mktBps = b; } // the marketplace tests tune the marketplace bps
    function setReverting(bool r) external { reverting = r; }

    function feeBps(bytes32 kind, address, address) external view returns (uint16) {
        return kind == MKT_KIND ? mktBps : mintBps;
    }

    function route(bytes32, address token, uint256 amount, bytes calldata) external {
        require(!reverting, "policy down");
        routed[token] += amount;
    }
}

/// @notice A buyer contract that re-enters `fill` from the ERC1155 receive callback (the LAST, only
/// untrusted callback in `fill`) to prove the `nonReentrant` guard blocks a nested fill.
contract ReentrantBuyer {
    Marketplace internal immutable mkt;
    BonusChips1155 internal immutable chips;
    uint256 internal listingId;
    bool internal armed;

    constructor(Marketplace m, BonusChips1155 c) { mkt = m; chips = c; }

    function approve(ERC20 tok) external { tok.approve(address(mkt), type(uint256).max); }

    function attack(uint256 id, uint256 units) external {
        listingId = id;
        armed = true;
        mkt.fill(id, units);
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external returns (bytes4) {
        if (armed) {
            armed = false;
            mkt.fill(listingId, 1); // re-enter: nonReentrant must revert, bubbling up and reverting the outer fill
        }
        return this.onERC1155Received.selector;
    }
}

contract MarketplaceTest is Test {
    OperatorRegistry internal reg;
    GameEscrow internal esc;
    BonusChips1155 internal chips;
    BackingPool internal pool;
    MintSale internal sale;
    Marketplace internal mkt;
    MockFeePolicy internal policy;
    ERC20 internal tok;

    address internal operator = address(0x0B);
    address internal seller = address(0x5E11E4); // buys from the mint-sale, then resells
    address internal buyer = address(0xB47E4);
    address internal keeper = address(0xCAFE);

    uint16 internal constant MINT_BPS = 500;  // 5% mint fee
    uint16 internal constant MKT_BPS = 300;   // 3% marketplace fee
    uint256 internal constant P = 1000;       // immutable mint price per charge
    uint256 internal constant Q = 1500;       // resale ask per charge

    function setUp() public {
        reg = new OperatorRegistry();
        esc = new GameEscrow(address(reg));
        chips = new BonusChips1155();
        tok = new ERC20(false);

        // A backing pool is needed so the mint-sale can mint real charges to the seller.
        pool = new BackingPool(address(esc), address(chips), address(0x6a3e));
        policy = new MockFeePolicy(MINT_BPS, MKT_BPS);

        sale = new MintSale(address(chips));
        sale.setPool(address(pool));
        sale.setPolicy(address(policy));

        mkt = new Marketplace(address(chips));
        mkt.setPolicy(address(policy));

        // Wiring: creator = MintSale, minter = pool, pool.minter = MintSale, priceLedger = MintSale, and
        // the pool is a burner so expiry refunds the current holder P.
        chips.setCreator(address(sale));
        chips.setMinter(address(pool));
        chips.setBurner(address(pool), true);
        chips.setPriceLedger(address(sale));
        pool.setMinter(address(sale));

        vm.prank(operator);
        reg.register();

        // Operator funds backing; seller funds the PRICE at the mint-sale; buyer funds resale purchases.
        tok.mint(operator, 1_000_000 ether);
        vm.prank(operator);
        tok.approve(address(pool), type(uint256).max);
        tok.mint(seller, 1_000_000 ether);
        vm.prank(seller);
        tok.approve(address(sale), type(uint256).max);
        tok.mint(buyer, 1_000_000 ether);
        vm.prank(buyer);
        tok.approve(address(mkt), type(uint256).max);
    }

    // ── helpers ──────────────────────────────────────────────────────────────────────────────────────

    function _createSeries() internal returns (uint256 id) {
        vm.prank(operator);
        id = sale.createSeries(25, 999, uint64(block.timestamp + 7 days), address(tok), P); // w = 250
    }

    /// The seller buys `n` charges from the mint-sale (now holds them) and grants the marketplace approval.
    function _sellerHolds(uint256 id, uint256 n) internal {
        vm.prank(seller);
        sale.buy(id, n);
        vm.prank(seller);
        chips.setApprovalForAll(address(mkt), true);
    }

    function _fee(uint256 units, uint256 ask, uint16 bps) internal pure returns (uint256) {
        return (units * ask * bps) / 10000;
    }

    // ── list + happy-path fill ─────────────────────────────────────────────────────────────────────────

    function test_list_storesRecord() public {
        uint256 id = _createSeries();
        _sellerHolds(id, 5);

        vm.prank(seller);
        uint256 lid = mkt.list(id, 5, Q);

        (address s, uint256 sid, uint256 rem, uint256 ask, address token) = mkt.listings(lid);
        assertEq(s, seller, "seller");
        assertEq(sid, id, "seriesId");
        assertEq(rem, 5, "unitsRemaining");
        assertEq(ask, Q, "askPerUnit");
        assertEq(token, address(tok), "token pinned to the series token");
    }

    function test_fill_happyPath() public {
        uint256 id = _createSeries();
        _sellerHolds(id, 5);
        vm.prank(seller);
        uint256 lid = mkt.list(id, 5, Q);

        uint256 sellerBefore = tok.balanceOf(seller);
        uint256 buyerBefore = tok.balanceOf(buyer);
        uint256 units = 3;
        uint256 gross = units * Q;
        uint256 m = _fee(units, Q, MKT_BPS);

        vm.prank(buyer);
        mkt.fill(lid, units);

        // Charges moved seller -> buyer.
        assertEq(chips.balanceOf(buyer, id), 3, "buyer received the charges");
        assertEq(chips.balanceOf(seller, id), 2, "seller keeps the unsold charges");
        // Money: buyer paid gross; seller received gross - m; the fee stayed in the marketplace.
        assertEq(buyerBefore - tok.balanceOf(buyer), gross, "buyer paid units*Q");
        assertEq(tok.balanceOf(seller) - sellerBefore, gross - m, "seller paid Q*units - fee");
        assertEq(mkt.feeAccrued(address(tok)), m, "fee accrued to the marketplace");
        assertEq(tok.balanceOf(address(mkt)), m, "marketplace holds only the fee");
        // Listing decremented.
        (,, uint256 rem,,) = mkt.listings(lid);
        assertEq(rem, 2, "unitsRemaining decremented");
    }

    // ── partial fill: decrement + a second fill works ──────────────────────────────────────────────────

    function test_partialFill_thenSecondFill() public {
        uint256 id = _createSeries();
        _sellerHolds(id, 5);
        vm.prank(seller);
        uint256 lid = mkt.list(id, 5, Q);

        vm.prank(buyer);
        mkt.fill(lid, 2);
        (,, uint256 rem1,,) = mkt.listings(lid);
        assertEq(rem1, 3, "3 remaining after first fill");

        vm.prank(buyer);
        mkt.fill(lid, 3);
        (,, uint256 rem2,,) = mkt.listings(lid);
        assertEq(rem2, 0, "0 remaining after second fill");
        assertEq(chips.balanceOf(buyer, id), 5, "buyer holds all 5");
        assertEq(mkt.feeAccrued(address(tok)), _fee(5, Q, MKT_BPS), "fee accrued over both fills");

        // A third fill against an empty listing reverts (units > remaining).
        vm.prank(buyer);
        vm.expectRevert(Marketplace.InsufficientUnits.selector);
        mkt.fill(lid, 1);
    }

    function test_fill_revertsWhenUnitsExceedRemaining() public {
        uint256 id = _createSeries();
        _sellerHolds(id, 2);
        vm.prank(seller);
        uint256 lid = mkt.list(id, 2, Q);

        vm.prank(buyer);
        vm.expectRevert(Marketplace.InsufficientUnits.selector);
        mkt.fill(lid, 3);
    }

    // ── STALE listing reverts atomically: seller moved the units away ───────────────────────────────────

    function test_stale_sellerMovedUnits_revertsAtomically() public {
        uint256 id = _createSeries();
        _sellerHolds(id, 5);
        vm.prank(seller);
        uint256 lid = mkt.list(id, 5, Q);

        // Seller moves ALL units elsewhere after listing — the listing is now stale.
        vm.prank(seller);
        chips.safeTransferFrom(seller, address(0xDEAD00), id, 5, "");

        uint256 buyerBefore = tok.balanceOf(buyer);
        uint256 sellerBefore = tok.balanceOf(seller);

        vm.prank(buyer);
        vm.expectRevert(); // ERC1155 insufficient balance on the final seller->buyer transfer
        mkt.fill(lid, 3);

        // Buyer lost nothing; seller received nothing; no fee accrued; the listing is untouched.
        assertEq(tok.balanceOf(buyer), buyerBefore, "buyer payment fully returned by the revert");
        assertEq(tok.balanceOf(seller), sellerBefore, "seller received nothing");
        assertEq(mkt.feeAccrued(address(tok)), 0, "no fee accrued");
        assertEq(tok.balanceOf(address(mkt)), 0, "marketplace holds nothing");
        (,, uint256 rem,,) = mkt.listings(lid);
        assertEq(rem, 5, "unitsRemaining unchanged (revert undid the decrement)");
    }

    // ── STALE listing reverts atomically: seller revoked approval ──────────────────────────────────────

    function test_stale_approvalRevoked_revertsAtomically() public {
        uint256 id = _createSeries();
        _sellerHolds(id, 5);
        vm.prank(seller);
        uint256 lid = mkt.list(id, 5, Q);

        // Seller still holds the units but revokes the marketplace's operator approval.
        vm.prank(seller);
        chips.setApprovalForAll(address(mkt), false);

        uint256 buyerBefore = tok.balanceOf(buyer);

        vm.prank(buyer);
        vm.expectRevert(); // ERC1155 NotOwnerNorApproved on the final transfer
        mkt.fill(lid, 3);

        assertEq(tok.balanceOf(buyer), buyerBefore, "buyer payment fully returned");
        assertEq(chips.balanceOf(buyer, id), 0, "buyer got no charges");
        assertEq(mkt.feeAccrued(address(tok)), 0, "no fee accrued");
        (,, uint256 rem,,) = mkt.listings(lid);
        assertEq(rem, 5, "unitsRemaining unchanged");
    }

    // ── STALE listing reverts atomically: a keeper expiry-burned the seller's units ────────────────────

    function test_stale_expiryBurned_revertsAtomically() public {
        uint256 id = _createSeries();
        _sellerHolds(id, 5);
        vm.prank(seller);
        uint256 lid = mkt.list(id, 5, Q);

        // A keeper expiry-burns the seller's units after they were listed (series now past expiry).
        vm.warp(block.timestamp + 8 days);
        pool.expireCharges(id, seller, 5);

        // Now the series is expired too, so the fill's expiry check catches it first — still atomic.
        uint256 buyerBefore = tok.balanceOf(buyer);
        vm.prank(buyer);
        vm.expectRevert(Marketplace.SeriesExpired.selector);
        mkt.fill(lid, 3);
        assertEq(tok.balanceOf(buyer), buyerBefore, "buyer payment fully returned");
    }

    // ── cancel: seller-only; deletes ───────────────────────────────────────────────────────────────────

    function test_cancel_sellerOnly_deletes() public {
        uint256 id = _createSeries();
        _sellerHolds(id, 5);
        vm.prank(seller);
        uint256 lid = mkt.list(id, 5, Q);

        // A non-seller cannot cancel.
        vm.prank(buyer);
        vm.expectRevert(Marketplace.NotSeller.selector);
        mkt.cancel(lid);

        // The seller cancels; the record is deleted (no tokens/charges move).
        uint256 sellerChips = chips.balanceOf(seller, id);
        vm.prank(seller);
        mkt.cancel(lid);
        (address s,,,,) = mkt.listings(lid);
        assertEq(s, address(0), "listing deleted");
        assertEq(chips.balanceOf(seller, id), sellerChips, "seller keeps its charges");

        // A fill against a cancelled listing reverts.
        vm.prank(buyer);
        vm.expectRevert(Marketplace.NoListing.selector);
        mkt.fill(lid, 1);
    }

    // ── sweepFees: routes, and parks on a reverting policy (never blocks fills) ─────────────────────────

    function test_sweepFees_routes() public {
        uint256 id = _createSeries();
        _sellerHolds(id, 5);
        vm.prank(seller);
        uint256 lid = mkt.list(id, 5, Q);
        vm.prank(buyer);
        mkt.fill(lid, 4);

        uint256 m = _fee(4, Q, MKT_BPS);
        assertEq(mkt.feeAccrued(address(tok)), m, "fee accrued");

        uint256 policyBefore = tok.balanceOf(address(policy));
        vm.prank(keeper); // permissionless
        mkt.sweepFees(address(tok));

        assertEq(mkt.feeAccrued(address(tok)), 0, "fee ledger zeroed");
        assertEq(tok.balanceOf(address(policy)) - policyBefore, m, "fee delivered to the policy");
        assertEq(policy.routed(address(tok)), m, "route() called with the swept amount");
    }

    function test_sweepFees_parksOnRevertingPolicy() public {
        uint256 id = _createSeries();
        _sellerHolds(id, 5);
        vm.prank(seller);
        uint256 lid = mkt.list(id, 5, Q);
        vm.prank(buyer);
        mkt.fill(lid, 4);
        uint256 m = _fee(4, Q, MKT_BPS);

        // Policy reverts on route → the sweep must PARK, not revert.
        policy.setReverting(true);
        uint256 mktBefore = tok.balanceOf(address(mkt));
        vm.prank(keeper);
        mkt.sweepFees(address(tok)); // no revert
        assertEq(mkt.feeAccrued(address(tok)), m, "fee parked (restored) after a reverting policy");
        assertEq(tok.balanceOf(address(mkt)), mktBefore, "no tokens left the marketplace on a parked sweep");
        assertEq(policy.routed(address(tok)), 0, "nothing routed");

        // Fills still work while the policy is down (a bad policy never blocks fills).
        vm.prank(buyer);
        mkt.fill(lid, 1);
        assertEq(chips.balanceOf(buyer, id), 5, "fill succeeded with the policy down");

        // Owner fixes the policy; a retry now routes everything.
        policy.setReverting(false);
        uint256 total = _fee(5, Q, MKT_BPS);
        vm.prank(keeper);
        mkt.sweepFees(address(tok));
        assertEq(mkt.feeAccrued(address(tok)), 0, "retry drains the parked fee");
        assertEq(policy.routed(address(tok)), total, "route() finally received the full accrued fee");
    }

    function test_sweepFees_noopWhenZero() public {
        vm.prank(keeper);
        mkt.sweepFees(address(tok)); // nothing accrued → no-op, no revert
        assertEq(policy.routed(address(tok)), 0);
    }

    // ── expired series: list AND fill both revert ──────────────────────────────────────────────────────

    function test_list_revertsWhenSeriesExpired() public {
        uint256 id = _createSeries();
        _sellerHolds(id, 5);
        vm.warp(block.timestamp + 8 days);
        vm.prank(seller);
        vm.expectRevert(Marketplace.SeriesExpired.selector);
        mkt.list(id, 5, Q);
    }

    function test_fill_revertsWhenSeriesExpiresAfterListing() public {
        uint256 id = _createSeries();
        _sellerHolds(id, 5);
        vm.prank(seller);
        uint256 lid = mkt.list(id, 5, Q); // listed while live

        vm.warp(block.timestamp + 8 days); // series now expired
        vm.prank(buyer);
        vm.expectRevert(Marketplace.SeriesExpired.selector);
        mkt.fill(lid, 1);
    }

    // ── list guards ────────────────────────────────────────────────────────────────────────────────────

    function test_list_revertsForZeroUnits() public {
        uint256 id = _createSeries();
        vm.prank(seller);
        vm.expectRevert(Marketplace.ZeroUnits.selector);
        mkt.list(id, 0, Q);
    }

    function test_list_revertsForZeroAsk() public {
        uint256 id = _createSeries();
        vm.prank(seller);
        vm.expectRevert(Marketplace.ZeroAsk.selector);
        mkt.list(id, 5, 0);
    }

    // ── fee cap: a policy quoting > MAX_FEE_BPS is clamped at fill (never reverts the fill) ─────────────

    function test_fill_feeCap_clampsToMax() public {
        uint256 id = _createSeries();
        _sellerHolds(id, 5);
        vm.prank(seller);
        uint256 lid = mkt.list(id, 5, Q);

        policy.setBps(2000); // 20% — above the 10% cap

        uint256 units = 4;
        uint256 gross = units * Q;
        uint256 cappedFee = _fee(units, Q, mkt.MAX_FEE_BPS()); // clamped to 1000 bps
        uint256 sellerBefore = tok.balanceOf(seller);

        vm.prank(buyer);
        mkt.fill(lid, units); // must NOT revert on the greedy policy

        assertEq(mkt.feeAccrued(address(tok)), cappedFee, "fee clamped to MAX_FEE_BPS");
        assertEq(tok.balanceOf(seller) - sellerBefore, gross - cappedFee, "seller paid gross - capped fee");
    }

    // ── reentrancy: nonReentrant on fill blocks a nested fill via the receive callback ─────────────────

    function test_fill_reentrancyBlocked() public {
        uint256 id = _createSeries();
        _sellerHolds(id, 5);
        vm.prank(seller);
        uint256 lid = mkt.list(id, 5, Q);

        ReentrantBuyer attacker = new ReentrantBuyer(mkt, chips);
        tok.mint(address(attacker), 1_000_000 ether);
        attacker.approve(tok);

        // The outer fill's LAST step transfers charges to the attacker, whose onERC1155Received re-enters
        // fill; nonReentrant reverts the nested call, bubbling up and reverting the whole outer fill.
        vm.expectRevert();
        attacker.attack(lid, 2);

        // Nothing moved: the listing is intact and no charges reached the attacker.
        (,, uint256 rem,,) = mkt.listings(lid);
        assertEq(rem, 5, "listing untouched after the blocked reentrant fill");
        assertEq(chips.balanceOf(address(attacker), id), 0, "attacker got no charges");
    }

    // ── bearer claim: the resold charge carries its P refund claim to the buyer ────────────────────────

    /// The refund claim rides the ERC1155 unit. After a resale, an expiry burn of the BUYER's units must
    /// refund the BUYER the full mint price P (not the seller, not the ask Q) — a light cross-check that
    /// the bearer stamp survives the marketplace transfer.
    function test_bearerClaim_ridesToBuyer_expiryRefundsBuyerP() public {
        uint256 id = _createSeries();
        _sellerHolds(id, 5);
        vm.prank(seller);
        uint256 lid = mkt.list(id, 5, Q);
        vm.prank(buyer);
        mkt.fill(lid, 3); // buyer now holds 3 charges bought at ask Q

        // The series expires; a keeper burns the BUYER's units.
        vm.warp(block.timestamp + 8 days);
        pool.expireCharges(id, buyer, 3);

        // The buyer — the current holder — is refunded the full mint price P per unit (floor is P, not Q).
        assertEq(sale.refundable(buyer, address(tok)), 3 * P, "buyer refunded 3*P (bearer claim rode the resale)");
        assertEq(sale.refundable(seller, address(tok)), 0, "the seller has no claim on resold units");

        uint256 before = tok.balanceOf(buyer);
        vm.prank(buyer);
        sale.withdrawRefund(address(tok), 3 * P);
        assertEq(tok.balanceOf(buyer) - before, 3 * P, "buyer withdrew the full P refund");
    }
}
