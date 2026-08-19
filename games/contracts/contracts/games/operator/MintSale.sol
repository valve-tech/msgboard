// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {SafeTransferLib} from "solady/src/utils/SafeTransferLib.sol";
import {ReentrancyGuard} from "./ReentrancyGuard.sol";
import {BonusChips1155} from "./BonusChips1155.sol";
import {BackingPool} from "./BackingPool.sol";
import {IFeePolicy} from "./IFeePolicy.sol";
import {IPriceLedger} from "./IPriceLedger.sol";

/// @notice The S2c primary sale + purchase-price vesting escrow. It is the price side of the operator
/// bonus economy; the backing side lives entirely in `BackingPool`/`GameEscrow` and is never touched
/// here. The mint-sale sells bonus charges at an immutable per-series price `P`, holds every buyer's
/// gross `P` in its OWN token balance (NEVER a GameEscrow bucket — those are operator-withdrawable, which
/// would void O4), and releases that `P` only when the charge burns, routed by the burn hook.
///
/// It holds two roles: `chips.creator` (to stamp new series with their price/fee/operator) and
/// `pool.minter` (so `buy` funds backing and mints the charge atomically). It is also `chips.priceLedger`
/// — the burn hook target.
///
/// PRICE RELEASE (accounting doc §4), all inside `onBurn`, exactly once per burned unit:
/// - pool burn (expiry)             → refund the holder `n*P`.
/// - game burn with a beneficiary   → chop: refund the round's player `n*P` (chop-harvest fix, never
///                                    vests to the operator on an abort).
/// - game burn with no beneficiary  → settled win/loss: vest `n*(P-f)` to the operator, accrue `n*f`.
///
/// FEE MODEL (pinned): fee-at-vest, refunds fee-inclusive. The buyer pays gross `P`; the platform cut `f`
/// (stamped per unit at series creation from `IFeePolicy.feeBps`, capped at `MAX_FEE_BPS`) comes out of
/// the operator's vested share on each settled round; every refund returns the full `P`. A rugged buyer
/// loses nothing; the platform earns only on delivered boosts.
///
/// INVARIANTS (per series s / token τ):
///   V1  escrowed[s] == alive[s] * price[s]
///   V2  price token balance >= Σ escrowed(τ) + Σ vested[*][τ] + Σ refundable[*][τ] + feeAccrued[τ]
///   V3  the operator can reach ONLY vested[op][τ] (no function moves escrowed/refundable to it)
///   V4  every burned unit releases exactly one P, in onBurn, once
///
/// No transient storage / MCOPY (I7): deploys on pre-Cancun 943/369.
contract MintSale is IPriceLedger, ReentrancyGuard {
    using SafeTransferLib for address;

    /// @notice The fee call-site key read from / routed through the fee policy. Matches the doc's
    /// `feeBps("mint-sale", ...)` / `route("mint-sale", ...)`.
    bytes32 public constant MINT_KIND = keccak256("mint-sale");
    /// @notice Hard cap on the stamped mint fee (accounting doc: `bps_mint <= 1000`). A policy quoting
    /// more than this is rejected at series creation, so a stamped `f` can never exceed 10% of `P`.
    uint16 public constant MAX_FEE_BPS = 1000;

    BonusChips1155 public immutable chips;

    address public owner;
    BackingPool public pool; // holds pool.minter; funds backing + mints on buy
    address public game;      // the boosted game; its burns route the vest/chop branch of onBurn
    IFeePolicy public policy; // quotes the mint fee at series creation; receives swept fees

    /// @notice Owner-set per-token minimum charge price `P` (0 = disabled). A platform floor that stops an
    /// operator setting a near-zero `P` that drains its OWN fee pool at a fair (eff = 200) table: at eff =
    /// 200 the only house margin is `P - f`, but the operator still pays validator heat per round out of
    /// its fee pool, so a too-cheap `P` bleeds that pool (economic L2). The floor is a PLATFORM control,
    /// not an operator one, because the operator is the party being protected from its own misprice.
    /// Token-denominated, so it MUST be owner-set per token (decimals differ, e.g. 6 vs 18); there is no
    /// safe token-agnostic default, so it ships at 0 (disabled). OWNER REVIEW: set a floor for every
    /// supported token before enabling real-money (369) series.
    mapping(address token => uint256) public minSeriesPrice;

    // ── per-series stamp (immutable after createSeries) ──────────────────────────────────────────────
    mapping(uint256 series => bool) public stamped;
    mapping(uint256 series => uint256) public price;      // P, in the series token
    mapping(uint256 series => uint256) public feePerUnit; // f = floor(P * bps_mint / 10000)
    mapping(uint256 series => address) public operatorOf; // vest key; also the backing funding source
    mapping(uint256 series => address) public tokenOf;    // τ, stamped so onBurn needs no external call
    mapping(uint256 series => uint64) public saleExpiry;  // no buy at/after this ts
    mapping(uint256 series => bool) public saleOpen;      // operator/owner sale toggle

    // ── ledgers (all pull-withdrawn) ─────────────────────────────────────────────────────────────────
    mapping(uint256 series => uint256) public escrowed;
    mapping(uint256 series => uint256) public alive; // minted - burned, moved in lockstep with escrowed
    mapping(address operator => mapping(address token => uint256)) public vested;
    mapping(address holder => mapping(address token => uint256)) public refundable;
    mapping(address token => uint256) public feeAccrued;

    error NotOwner();
    error NotChips();
    error NotSaleAdmin();
    error PoolUnset();
    error PolicyUnset();
    error AlreadyStamped();
    error ZeroPrice();
    error PriceBelowFloor();
    error ZeroAmount();
    error FeeTooHigh();
    error SaleClosed();
    error SaleExpired();
    error PullMismatch();
    error InsufficientVested();
    error InsufficientRefund();

    event OwnerSet(address indexed owner);
    event PoolSet(address indexed pool);
    event GameSet(address indexed game);
    event PolicySet(address indexed policy);
    event SeriesStamped(uint256 indexed series, address indexed operator, address indexed token, uint256 price, uint256 feePerUnit);
    event SaleOpenSet(uint256 indexed series, bool open);
    event MinSeriesPriceSet(address indexed token, uint256 minPrice);
    event Bought(uint256 indexed series, address indexed buyer, uint256 units, uint256 paid);
    event Refunded(uint256 indexed series, address indexed beneficiary, uint256 amount);
    event Vested(uint256 indexed series, address indexed operator, uint256 vestedAmount, uint256 fee);
    event VestedWithdrawn(address indexed operator, address indexed token, uint256 amount);
    event RefundWithdrawn(address indexed holder, address indexed token, uint256 amount);
    event FeesSwept(address indexed token, uint256 amount);

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

    function setPool(address p) external onlyOwner {
        pool = BackingPool(p);
        emit PoolSet(p);
    }

    function setGame(address g) external onlyOwner {
        game = g;
        emit GameSet(g);
    }

    function setPolicy(address p) external onlyOwner {
        policy = IFeePolicy(p);
        emit PolicySet(p);
    }

    /// @notice Set (or, with 0, disable) the per-token minimum charge price floor. Owner-only, because it
    /// is a platform protection against an operator underpricing a fair table (economic L2). It gates only
    /// NEW series; existing stamped series keep their immutable price.
    function setMinSeriesPrice(address token, uint256 minPrice) external onlyOwner {
        minSeriesPrice[token] = minPrice;
        emit MinSeriesPriceSet(token, minPrice);
    }

    // ── series creation (stamps the price + fee + operator) ──────────────────────────────────────────

    /// @notice Register a new charge series on the chips (this contract holds `chips.creator`) and stamp
    /// its immutable price side: price `P`, per-unit fee `f = floor(P * bps_mint / 10000)` with `bps_mint`
    /// read once from the fee policy (capped at `MAX_FEE_BPS`), the operator (the vest key AND the backing
    /// funding source on `buy`), and the token. The caller becomes the operator: only you can create a
    /// series whose backing is later pulled from you. Repricing is a new series (P is immutable, O-price).
    function createSeries(uint16 bonusPoints, uint256 maxStake, uint64 expiry, address token, uint256 seriesPrice)
        external
        returns (uint256 id)
    {
        if (address(policy) == address(0)) revert PolicyUnset();
        if (seriesPrice == 0) revert ZeroPrice();
        // Platform price floor (economic L2): reject a near-zero `P` that would drain the operator's own
        // fee pool at a fair table. Disabled (0) = no floor for this token.
        uint256 floorPrice = minSeriesPrice[token];
        if (floorPrice != 0 && seriesPrice < floorPrice) revert PriceBelowFloor();
        uint16 bps = policy.feeBps(MINT_KIND, token, msg.sender);
        if (bps > MAX_FEE_BPS) revert FeeTooHigh();

        id = chips.createSeries(bonusPoints, maxStake, expiry, token);
        // The chips id is fresh (nextSeriesId++), so this can never collide with a stamped series.
        stamped[id] = true;
        price[id] = seriesPrice;
        feePerUnit[id] = (seriesPrice * bps) / 10000;
        operatorOf[id] = msg.sender;
        tokenOf[id] = token;
        saleExpiry[id] = expiry;
        saleOpen[id] = true;
        emit SeriesStamped(id, msg.sender, token, seriesPrice, feePerUnit[id]);
    }

    /// @notice Open or close the primary sale of a series. The series operator or the owner may toggle it.
    /// Closing never touches escrow/vested/refundable — it only gates new `buy`s.
    function setSaleOpen(uint256 series, bool open) external {
        if (msg.sender != operatorOf[series] && msg.sender != owner) revert NotSaleAdmin();
        saleOpen[series] = open;
        emit SaleOpenSet(series, open);
    }

    // ── buy (primary sale) ───────────────────────────────────────────────────────────────────────────

    /// @notice Buy `n` charges of series `s` at the stamped price. Sequencing (accounting doc §5):
    /// checks -> measured exact pull of `n*P` from the buyer into THIS contract's balance -> ledger
    /// (`escrowed += n*P`, `alive += n`) -> `pool.fundEarmark` LAST (it pulls the operator's `n*w` backing
    /// and mints the `n` charges to the buyer). The price never enters escrow — it stays in this
    /// contract's own balance until a burn releases it.
    function buy(uint256 s, uint256 n) external nonReentrant {
        if (!stamped[s]) revert SaleClosed();
        if (address(pool) == address(0)) revert PoolUnset();
        if (!saleOpen[s]) revert SaleClosed();
        if (n == 0) revert ZeroAmount();
        if (block.timestamp >= saleExpiry[s]) revert SaleExpired();

        address token = tokenOf[s];
        uint256 gross = n * price[s];

        // Measured, exact pull of the purchase price into this contract's OWN balance. A fee-on-transfer
        // token under-delivers and reverts the whole buy (no under-escrowed sale is ever committed).
        uint256 balBefore = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), gross);
        if (token.balanceOf(address(this)) - balBefore != gross) revert PullMismatch();

        escrowed[s] += gross;
        alive[s] += n;

        // Fund backing + mint the charges LAST: pulls the operator's `n*w` and mints `n` to the buyer.
        // A revert here (operator short on backing) unwinds the price pull + ledger writes atomically.
        pool.fundEarmark(s, n, operatorOf[s], msg.sender);
        emit Bought(s, msg.sender, n, gross);
    }

    // ── onBurn (the price-release hook; SSTORE-only, must never revert on a reachable input) ──────────

    /// @notice The burn hook the chips fires after every `_burn`. Routes the release of the burned unit's
    /// stamped price per `(burner, beneficiary)`. SSTORE-only, NO external calls; it reverts ONLY for a
    /// non-chips caller (never reachable in the real burn flow). An unknown/over-burned series is a no-op,
    /// so a reverting hook can never freeze a settle or an expiry.
    function onBurn(address burner, address from, uint256 id, uint256 amount, address beneficiary)
        external
        override
    {
        if (msg.sender != address(chips)) revert NotChips();
        // No-op guards (never revert): unknown series, zero burn, or an over-burn the ledger cannot cover.
        // Lockstep `alive`/`escrowed` accounting makes an over-burn unreachable; the guard is defense only.
        if (!stamped[id] || amount == 0 || alive[id] < amount) return;

        uint256 p = price[id];
        uint256 release = amount * p;
        address token = tokenOf[id];

        escrowed[id] -= release;
        alive[id] -= amount;

        if (burner == address(pool)) {
            // Expiry: the pool burned the holder's expired charge; refund the full (fee-inclusive) price.
            refundable[from][token] += release;
            emit Refunded(id, from, release);
        } else if (burner == game && beneficiary != address(0)) {
            // Chop: refund the round's player; the operator vests NOTHING on an abort (chop-harvest fix).
            refundable[beneficiary][token] += release;
            emit Refunded(id, beneficiary, release);
        } else if (burner == game) {
            // Settled win/loss: the operator earned P because a fair round settled. Fee comes out here.
            uint256 fee = amount * feePerUnit[id];
            uint256 vestAmt = release - fee; // f <= P by the MAX_FEE_BPS cap, so this never underflows
            address op = operatorOf[id];
            vested[op][token] += vestAmt;
            feeAccrued[token] += fee;
            emit Vested(id, op, vestAmt, fee);
        } else {
            // Unknown burner: the chips burner allowlist is exactly {game, pool}, so this is unreachable.
            // Undo the escrow/alive moves rather than strand `release`, keeping V1/V2 exact. No revert.
            escrowed[id] += release;
            alive[id] += amount;
        }
    }

    // ── withdrawals (each CEI + nonReentrant) ────────────────────────────────────────────────────────

    /// @notice The operator withdraws its vested price for one token. V3: this is the ONLY door the
    /// operator can reach — it never touches escrowed or refundable.
    function withdrawVested(address token, uint256 amount) external nonReentrant {
        uint256 c = vested[msg.sender][token];
        if (amount > c) revert InsufficientVested();
        unchecked { vested[msg.sender][token] = c - amount; }
        token.safeTransfer(msg.sender, amount);
        emit VestedWithdrawn(msg.sender, token, amount);
    }

    /// @notice A holder/player withdraws its refundable price for one token (msg.sender-scoped: you can
    /// only pull your own refund). Funded by an expiry or a chop refund routed in `onBurn`.
    function withdrawRefund(address token, uint256 amount) external nonReentrant {
        uint256 c = refundable[msg.sender][token];
        if (amount > c) revert InsufficientRefund();
        unchecked { refundable[msg.sender][token] = c - amount; }
        token.safeTransfer(msg.sender, amount);
        emit RefundWithdrawn(msg.sender, token, amount);
    }

    /// @notice Permissionless: sweep the accrued platform fee for one token to the fee policy. CEI: zero
    /// the ledger, transfer to the policy, then `route`. A reverting policy reverts the whole sweep (the
    /// fee stays accrued for a later retry after the owner swaps the policy) — fees are not time-critical.
    function sweepFees(address token) external nonReentrant {
        if (address(policy) == address(0)) revert PolicyUnset();
        uint256 amount = feeAccrued[token];
        if (amount == 0) return;
        feeAccrued[token] = 0;
        token.safeTransfer(address(policy), amount);
        policy.route(MINT_KIND, token, amount, abi.encode(address(this)));
        emit FeesSwept(token, amount);
    }
}
