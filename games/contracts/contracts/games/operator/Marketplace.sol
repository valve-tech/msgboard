// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {SafeTransferLib} from "solady/src/utils/SafeTransferLib.sol";
import {ReentrancyGuard} from "./ReentrancyGuard.sol";
import {BonusChips1155} from "./BonusChips1155.sol";
import {IFeePolicy} from "./IFeePolicy.sol";

/// @notice The S2c secondary market for bonus charges — a fixed-price, approval-fill resale desk that
/// NEVER takes custody of a charge (accounting doc §8). Custody is rejected on purpose: a custodial
/// marketplace becomes an ERC1155 holder, and permissionless `BackingPool.expireCharges` could burn its
/// pooled inventory out from under it. Instead the SELLER keeps the charges and grants the marketplace
/// ERC1155 operator approval; the marketplace only moves them, seller -> buyer, inside a single `fill`.
///
/// A listing is `{seller, seriesId, unitsRemaining, askPerUnit (Q), token}`. `token` is the series'
/// settlement token, read from the chips at list time, so the buyer always pays in the same token the
/// backing/refund sit in.
///
/// FILL ORDER (CEI, accounting doc §8): checks (series not expired, units in range) -> effect (decrement
/// `unitsRemaining`) -> measured pull of `units*Q` from the buyer -> accrue the fee `m` -> pay the seller
/// `units*Q - m` -> `chips.safeTransferFrom(seller -> buyer)` LAST. The chips move is the ONLY untrusted
/// callback and every ledger write is already final before it runs. A stale listing (the seller moved the
/// units, revoked approval, or a keeper expiry-burned them) makes that final transfer revert, so the whole
/// `fill` reverts atomically and the buyer loses nothing.
///
/// FEE MODEL: `bps_mkt` is read from the fee policy AT FILL for `kind = "marketplace"`, keyed on the
/// seller, and CAPPED at `MAX_FEE_BPS` (never reverts a fill on a greedy policy — a fill must not be
/// blockable by whoever set the policy). `m = floor(units*Q*bps_mkt/10000)` accrues to `feeAccrued` and is
/// later swept to the policy by the permissionless `sweepFees`, which PARKS (mirrors the coin-flip
/// `unrouted`/`sweepForfeit` idiom) if the policy reverts, so a bad policy can never block fills or strand
/// the accrued fee.
///
/// The refund claim rides the ERC1155 unit itself (bearer stamp): a resold charge carries its `P` refund
/// claim to the buyer automatically, including across partial fills, with ZERO marketplace bookkeeping.
/// The new holder's expiry floor is the mint price `P`, not the resale ask `Q`.
///
/// No transient storage / MCOPY (I7): deploys on pre-Cancun 943/369.
contract Marketplace is ReentrancyGuard {
    using SafeTransferLib for address;

    /// @notice Fee call-site key read from / routed through the fee policy (accounting doc §9).
    bytes32 public constant MKT_KIND = keccak256("marketplace");
    /// @notice Hard cap on the marketplace fee (accounting doc §9: `bps_mkt <= 1000`). A policy quoting
    /// more is clamped to this at fill, so the fee can never exceed 10% of the sale AND a greedy or
    /// misconfigured policy can never revert a fill.
    uint16 public constant MAX_FEE_BPS = 1000;

    BonusChips1155 public immutable chips;

    address public owner;
    IFeePolicy public policy; // quotes bps_mkt at fill; receives swept fees

    struct Listing {
        address seller;         // keeps custody of the charges; grants this contract operator approval
        uint256 seriesId;       // the charge series being resold
        uint256 unitsRemaining; // decremented on each fill; 0 == fully filled / dead
        uint256 askPerUnit;     // Q, in the series token
        address token;          // the series settlement token, pinned at list time
    }

    mapping(uint256 listingId => Listing) public listings;
    uint256 public nextListingId;

    /// @notice Fee accrued per token from fills; swept to the policy by `sweepFees`. A failed sweep parks
    /// the amount right back here for a later retry, so this doubles as the parked-fee ledger.
    mapping(address token => uint256) public feeAccrued;

    error NotOwner();
    error NotSelf();
    error NotSeller();
    error NoListing();
    error ZeroUnits();
    error ZeroAsk();
    error InsufficientUnits();
    error SeriesExpired();
    error PolicyUnset();
    error PullMismatch();

    event OwnerSet(address indexed owner);
    event PolicySet(address indexed policy);
    event Listed(uint256 indexed listingId, address indexed seller, uint256 indexed seriesId, uint256 units, uint256 askPerUnit, address token);
    event Filled(uint256 indexed listingId, address indexed buyer, address indexed seller, uint256 seriesId, uint256 units, uint256 paid, uint256 fee);
    event Cancelled(uint256 indexed listingId);
    event FeesSwept(address indexed token, uint256 amount);
    event FeesParked(address indexed token, uint256 amount);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address chips_) {
        chips = BonusChips1155(chips_);
        owner = msg.sender;
        emit OwnerSet(msg.sender);
    }

    // ── wiring (owner-only; post-deploy) ─────────────────────────────────────────────────────────────

    function setOwner(address o) external onlyOwner {
        owner = o;
        emit OwnerSet(o);
    }

    function setPolicy(address p) external onlyOwner {
        policy = IFeePolicy(p);
        emit PolicySet(p);
    }

    // ── list / cancel ────────────────────────────────────────────────────────────────────────────────

    /// @notice Post a fixed-price listing. The seller keeps custody and must separately grant this
    /// contract ERC1155 operator approval (`chips.setApprovalForAll`). Requires the series is not expired
    /// (`now < expiry`, read from the chips), `units > 0`, and `askPerUnit > 0`. `seriesOf` reverts on an
    /// unknown series, so a listing can only name a real series. Balance/approval are NOT checked here —
    /// a stale listing simply reverts atomically at fill (the buyer is never at risk).
    function list(uint256 seriesId, uint256 units, uint256 askPerUnit) external returns (uint256 id) {
        if (units == 0) revert ZeroUnits();
        if (askPerUnit == 0) revert ZeroAsk();
        (,, uint64 expiry, address token) = chips.seriesOf(seriesId);
        if (block.timestamp >= expiry) revert SeriesExpired();

        id = nextListingId++;
        listings[id] = Listing({
            seller: msg.sender,
            seriesId: seriesId,
            unitsRemaining: units,
            askPerUnit: askPerUnit,
            token: token
        });
        emit Listed(id, msg.sender, seriesId, units, askPerUnit, token);
    }

    /// @notice Cancel a listing. Seller-only; deletes the record. No tokens or charges move (custody never
    /// left the seller). A cancelled listing reads back as empty, so any later fill reverts `NoListing`.
    function cancel(uint256 listingId) external {
        Listing storage l = listings[listingId];
        if (l.seller == address(0)) revert NoListing();
        if (msg.sender != l.seller) revert NotSeller();
        delete listings[listingId];
        emit Cancelled(listingId);
    }

    // ── fill (approval-fill, CEI, nonReentrant) ────────────────────────────────────────────────────────

    /// @notice Buy `units` from a listing at its stamped ask. Sequencing is strict CEI (accounting doc §8):
    /// checks -> decrement `unitsRemaining` -> measured exact pull of `units*Q` from the buyer -> accrue
    /// the fee `m` -> pay the seller `units*Q - m` -> move the charges seller -> buyer LAST. The chips
    /// transfer is the only untrusted callback and every ledger write is final before it fires. If the
    /// listing is stale (seller moved the units, revoked approval, or a keeper expiry-burned them) that
    /// final transfer reverts, reverting the whole fill: the buyer's payment is returned and no state moves.
    function fill(uint256 listingId, uint256 units) external nonReentrant {
        Listing storage l = listings[listingId];
        address seller = l.seller;
        if (seller == address(0)) revert NoListing();
        if (units == 0) revert ZeroUnits();
        if (units > l.unitsRemaining) revert InsufficientUnits();
        if (address(policy) == address(0)) revert PolicyUnset();

        uint256 seriesId = l.seriesId;
        address token = l.token;
        uint256 gross = units * l.askPerUnit;

        // Series must still be live: an expired series cannot be filled (its units are expiry-burnable).
        (,, uint64 expiry,) = chips.seriesOf(seriesId);
        if (block.timestamp >= expiry) revert SeriesExpired();

        // Fee read at fill, CAPPED (never reverts the fill on a greedy policy).
        uint16 bps = policy.feeBps(MKT_KIND, token, seller);
        if (bps > MAX_FEE_BPS) bps = MAX_FEE_BPS;
        uint256 m = (gross * bps) / 10000;

        // Effect: decrement before any interaction. A later revert unwinds this atomically.
        l.unitsRemaining -= units;

        // Measured, exact pull of the buyer's payment. A fee-on-transfer token under-delivers and reverts
        // the whole fill (no under-collected sale is ever committed).
        uint256 balBefore = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), gross);
        if (token.balanceOf(address(this)) - balBefore != gross) revert PullMismatch();

        feeAccrued[token] += m;
        token.safeTransfer(seller, gross - m);

        // Untrusted callback LAST — all state final. A stale listing reverts here, reverting everything.
        chips.safeTransferFrom(seller, msg.sender, seriesId, units, "");

        emit Filled(listingId, msg.sender, seller, seriesId, units, gross, m);
    }

    // ── sweepFees (permissionless; parks on a reverting policy, never blocks fills) ─────────────────────

    /// @notice Sweep the accrued marketplace fee for one token to the fee policy. Permissionless. Zeroes
    /// the ledger, then delivers + routes in one external self-call so a `route()` revert rolls the
    /// transfer back and the amount PARKS (mirrors the coin-flip `unrouted`/`sweepForfeit` idiom): a bad
    /// policy never blocks a fill and never strands the fee — the owner swaps the policy and anyone retries.
    function sweepFees(address token) external nonReentrant {
        if (address(policy) == address(0)) revert PolicyUnset();
        uint256 amount = feeAccrued[token];
        if (amount == 0) return;
        feeAccrued[token] = 0;
        try this._deliverAndRoute(token, amount) {
            emit FeesSwept(token, amount);
        } catch {
            feeAccrued[token] = amount; // restore; still parked for a later retry
            emit FeesParked(token, amount);
        }
    }

    /// @notice External-self-only: transfer `amount` to the policy then call `route`, atomically, so the
    /// caller's try/catch can roll both back together. NOT nonReentrant: it is a self-call from within the
    /// already-nonReentrant `sweepFees`, so guarding it would deadlock; the self-only check plus the outer
    /// mutex protect it.
    function _deliverAndRoute(address token, uint256 amount) external {
        if (msg.sender != address(this)) revert NotSelf();
        address p = address(policy);
        token.safeTransfer(p, amount);
        IFeePolicy(p).route(MKT_KIND, token, amount, abi.encode(address(this)));
    }
}
