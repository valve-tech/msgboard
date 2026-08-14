// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {ERC1155} from "solady/src/tokens/ERC1155.sol";

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
    mapping(address account => bool allowed) public isBurner;

    mapping(uint256 id => Series) internal _series;
    mapping(uint256 id => string) internal _seriesURI;
    uint256 public nextSeriesId;

    error NotOwner();
    error NotCreator();
    error NotMinter();
    error NotBurner();
    error UnknownSeries();

    event OwnerSet(address indexed owner);
    event CreatorSet(address indexed creator);
    event MinterSet(address indexed minter);
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

    function setBurner(address account, bool allowed) external onlyOwner {
        isBurner[account] = allowed;
        emit BurnerSet(account, allowed);
    }

    // ── series registry ──────────────────────────────────────────────────────────────────────────

    /// @notice Register a new charge series. Creator-gated (the mint-sale in S2c). The F-C token pin
    /// and the `base + bonusPoints <= MULT_MAX` clamp are enforced by the game's `setBonusSeries` when
    /// the series is attached to a table (S2b); here we only store the parameters.
    function createSeries(uint16 bonusPoints, uint256 maxStake, uint64 expiry, address token)
        external
        returns (uint256 id)
    {
        if (msg.sender != creator) revert NotCreator();
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

    function burn(address from, uint256 id, uint256 amount) external {
        if (!isBurner[msg.sender]) revert NotBurner();
        _burn(from, id, amount);
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
