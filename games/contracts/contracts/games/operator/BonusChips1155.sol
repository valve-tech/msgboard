// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {ERC1155} from "solady/src/tokens/ERC1155.sol";
import {SafeTransferLib} from "solady/src/utils/SafeTransferLib.sol";
import {IPriceLedger} from "./IPriceLedger.sol";

/// @notice The consumable bonus-charge token of the operator bonus economy. Each series is a distinct
/// ERC-1155 id that pins the boost it grants: `bonusPoints` (added to a table's base multiplier),
/// `maxStake` (the largest stake the boost applies to), `expiry`, and the settlement `token` the
/// backing sits in. A single charge is burned per boosted round.
///
/// The safety-critical view is `w(id)` — the per-charge collateral the BackingPool must hold:
/// `w = ceil(maxStake * bonusPoints / 100)`. It MUST be a ceil (F-B): a floor under-backs the largest
/// possible boost delta by one unit at a tier boundary (e.g. maxStake=999, bp=25 → floor 249 but the
/// max delta is 250), which would let a round pay out more than the pool earmarked.
///
/// Roles are deliberately minimal and separated:
/// - `owner` sets the other roles.
/// - `creator` registers series (the mint-sale, S2c).
/// - `minter` mints charges (the mint-sale, S2c).
/// - `burner` allowlist burns charges (the game on a used round, and the pool on expiry).
/// No transient storage, no MCOPY — deploys on pre-Cancun 943/369 (I7).
contract BonusChips1155 is ERC1155 {
    using SafeTransferLib for address;

    struct Series {
        uint16 bonusPoints; // added to the table base multiplier for a boosted round
        uint64 expiry;      // unix ts; openBoosted (S2b) reverts once now >= expiry
        address token;      // the settlement token the backing is denominated in
        uint256 maxStake;   // the largest stake the boost applies to; w is derived from it
        bool exists;
    }

    address public owner;
    address public creator;
    address public minter;
    /// @notice The S2c price ledger (the MintSale). Every burn fires `priceLedger.onBurn(...)` AFTER the
    /// `_burn`, so a burned charge releases its stamped purchase price in the same call. Unset (address 0)
    /// keeps the pre-S2c behavior — the pool never needs to know about the price side. Set once at wiring.
    address public priceLedger;
    mapping(address account => bool allowed) public isBurner;

    mapping(uint256 id => Series) internal _series;
    mapping(uint256 id => string) internal _seriesURI;
    uint256 public nextSeriesId;

    error NotOwner();
    error NotCreator();
    error NotMinter();
    error NotBurner();
    error UnknownSeries();
    error InvalidBonusPoints();
    error InvalidMaxStake();
    error InvalidExpiry();
    error UnsupportedToken();
    error NotSelf();

    /// @notice Ceiling on `maxStake`. Keeps `w = ceil(maxStake * bonusPoints / 100)` far from any
    /// uint256 overflow (`maxStake * bonusPoints` with `bonusPoints <= type(uint16).max` stays tiny
    /// against 2^256) and is orders of magnitude above any real token stake. Defense-in-depth only.
    uint256 public constant MAX_STAKE = 1e36;

    event OwnerSet(address indexed owner);
    event CreatorSet(address indexed creator);
    event MinterSet(address indexed minter);
    event PriceLedgerSet(address indexed priceLedger);
    event BurnerSet(address indexed account, bool allowed);
    event SeriesCreated(uint256 indexed id, uint16 bonusPoints, uint256 maxStake, uint64 expiry, address token);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor() {
        owner = msg.sender;
        emit OwnerSet(msg.sender);
    }

    // ── roles ────────────────────────────────────────────────────────────────────────────────────

    function setOwner(address o) external onlyOwner {
        owner = o;
        emit OwnerSet(o);
    }

    function setCreator(address c) external onlyOwner {
        creator = c;
        emit CreatorSet(c);
    }

    function setMinter(address m) external onlyOwner {
        minter = m;
        emit MinterSet(m);
    }

    /// @notice Point the burn hook at the S2c price ledger (the MintSale). Owner-only. Leaving it unset
    /// disables the price side entirely; setting it makes every burn release the charge's stamped price.
    function setPriceLedger(address p) external onlyOwner {
        priceLedger = p;
        emit PriceLedgerSet(p);
    }

    function setBurner(address account, bool allowed) external onlyOwner {
        isBurner[account] = allowed;
        emit BurnerSet(account, allowed);
    }

    // ── series registry ──────────────────────────────────────────────────────────────────────────

    /// @notice Register a new charge series. Creator-gated (the mint-sale in S2c). The F-C token pin
    /// and the `base + bonusPoints <= MULT_MAX` clamp are enforced by the game's `setBonusSeries` when
    /// the series is attached to a table (S2b); here we only store the parameters.
    ///
    /// O6 token policy (accounting doc §6) — a boosted table's bet B is locked with stake 0, and on a
    /// chop/plain-timeout refund `GameEscrow` calls `token.safeTransfer(player, 0)` — a zero-value
    /// transfer. A token that REVERTS on a zero-value transfer would revert that whole refund and
    /// freeze the player's stake (M1). This is enforced HERE, on-chain, at series creation: a zero-value
    /// self-transfer probe MUST succeed, or the token is rejected. The other two O6 cases are NOT probed
    /// here: fee-on-transfer is already rejected downstream by `fundEarmark`'s measured-delta check
    /// (a short delivery reverts the mint), and rebasing tokens are documented-unsupported (no probe can
    /// catch a balance that moves on its own). ERC777/callback-style tokens are not probed either — the
    /// game's `_settle`/refund paths rely on CEI (status set terminal before any external payout, every
    /// terminal `AlreadyResolved`-gated), which already tolerates a token-triggered reentry; see
    /// `OperatorCoinFlip._settle`'s CEI note (L1).
    function createSeries(uint16 bonusPoints, uint256 maxStake, uint64 expiry, address token)
        external
        returns (uint256 id)
    {
        if (msg.sender != creator) revert NotCreator();
        // Cheap defense-in-depth on the series parameters (LOW). A zero bonus/stake mints charges that
        // back nothing; a past expiry is already dead; an oversized stake risks `w()` overflow.
        if (bonusPoints == 0) revert InvalidBonusPoints();
        if (maxStake == 0 || maxStake > MAX_STAKE) revert InvalidMaxStake();
        if (expiry <= block.timestamp) revert InvalidExpiry();
        // M1: reject a token that reverts on a zero-value transfer, before this series can ever back a
        // round. try/catch needs an external call, so the probe runs through a self-only external hop.
        try this._zeroValueTransferProbe(token) {} catch { revert UnsupportedToken(); }
        id = nextSeriesId++;
        _series[id] = Series({
            bonusPoints: bonusPoints,
            expiry: expiry,
            token: token,
            maxStake: maxStake,
            exists: true
        });
        emit SeriesCreated(id, bonusPoints, maxStake, expiry, token);
    }

    /// @notice M1 probe: a zero-value self-transfer of `token`, called only by `createSeries` (self-only,
    /// via `this._zeroValueTransferProbe`) so the call can be wrapped in a try/catch. No state changes and
    /// no value moves (amount is 0); it exists purely to observe whether `token` reverts on amount == 0.
    function _zeroValueTransferProbe(address token) external {
        if (msg.sender != address(this)) revert NotSelf();
        token.safeTransfer(address(this), 0);
    }

    function seriesOf(uint256 id)
        external
        view
        returns (uint16 bonusPoints, uint256 maxStake, uint64 expiry, address token)
    {
        Series storage s = _series[id];
        if (!s.exists) revert UnknownSeries();
        return (s.bonusPoints, s.maxStake, s.expiry, s.token);
    }

    function seriesExists(uint256 id) external view returns (bool) {
        return _series[id].exists;
    }

    /// @notice Per-charge backing = ceil(maxStake * bonusPoints / 100). CEIL, never floor (F-B).
    function w(uint256 id) public view returns (uint256) {
        Series storage s = _series[id];
        if (!s.exists) revert UnknownSeries();
        return (s.maxStake * uint256(s.bonusPoints) + 99) / 100;
    }

    // ── mint / burn (role-gated) ─────────────────────────────────────────────────────────────────

    function mint(address to, uint256 id, uint256 amount) external {
        if (msg.sender != minter) revert NotMinter();
        if (!_series[id].exists) revert UnknownSeries();
        _mint(to, id, amount, "");
    }

    /// @notice Burn `amount` of series `id` from `from` (burner-allowlist-gated). ABI unchanged from
    /// pre-S2c, so the pool's `expireCharges` burn needs no edit. The price release routes with
    /// `beneficiary == address(0)`: a pool burn refunds the holder, a game burn vests to the operator
    /// (see the ledger's routing). The hook fires AFTER `_burn`, so a burned unit releases exactly once.
    function burn(address from, uint256 id, uint256 amount) external {
        if (!isBurner[msg.sender]) revert NotBurner();
        _burn(from, id, amount);
        _fireOnBurn(msg.sender, from, id, amount, address(0));
    }

    /// @notice Burn with an explicit price-refund `beneficiary` (burner-allowlist-gated). The game uses
    /// this for the chop terminal: `burnWithBeneficiary(game, sid, 1, player)` refunds the round's price
    /// to the player instead of vesting it to the operator — the chop-harvest fix (accounting doc §S4).
    function burnWithBeneficiary(address from, uint256 id, uint256 amount, address beneficiary) external {
        if (!isBurner[msg.sender]) revert NotBurner();
        _burn(from, id, amount);
        _fireOnBurn(msg.sender, from, id, amount, beneficiary);
    }

    /// @notice Fire the price-release hook after a burn. No-op when the ledger is unset. `burner` is the
    /// allowlisted caller (the game or the pool) — the ledger routes on it.
    function _fireOnBurn(address burner, address from, uint256 id, uint256 amount, address beneficiary) internal {
        address ledger = priceLedger;
        if (ledger != address(0)) {
            IPriceLedger(ledger).onBurn(burner, from, id, amount, beneficiary);
        }
    }

    // ── metadata ─────────────────────────────────────────────────────────────────────────────────

    /// @notice Optional per-series metadata pointer. Art/theming is System 1's concern; this is just a
    /// stored URI the creator may set. Defaults to the empty string.
    function setSeriesURI(uint256 id, string calldata u) external {
        if (msg.sender != creator) revert NotCreator();
        if (!_series[id].exists) revert UnknownSeries();
        _seriesURI[id] = u;
        emit URI(u, id);
    }

    function uri(uint256 id) public view override returns (string memory) {
        return _seriesURI[id];
    }
}
