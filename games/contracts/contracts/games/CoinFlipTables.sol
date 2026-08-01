// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {SafeTransferLib} from "solady/src/utils/SafeTransferLib.sol";
import {GameBase} from "../GameBase.sol";
import {IRandom} from "../implementations/IRandom.sol";
import {PreimageLocation} from "../PreimageLocation.sol";

/// @notice Permissionless coin flip against an operator-run Chips bankroll. Anyone opens a table and
/// funds a two-tier (hot/cold) bankroll; players bet a side and a stake; a validator subset's seed
/// parity decides. The operator signs nothing and cannot touch the coin — only supplies capital.
/// This is CoinFlip.sol with the matched opposite player replaced by the table's pooled Chips.
contract CoinFlipTables is GameBase {
    using SafeTransferLib for address;

    error NotOperator();
    error BadMultiplier();
    error NoTable();

    event TableCreated(bytes32 indexed tableId, address indexed operator, uint16 maxMultiplierX100, uint256 maxStake, uint256 hotTarget);
    event ParamsSet(bytes32 indexed tableId, uint16 maxMultiplierX100, uint256 maxStake, uint256 hotTarget);
    event OpenSet(bytes32 indexed tableId, bool open);

    uint16 internal constant MULT_MIN = 150;
    uint16 internal constant MULT_MAX = 200;

    struct Table {
        address operator;
        uint256 hot;              // armed — the only balance a new round can escrow against
        uint256 cold;             // reserve — never at risk until promoted
        uint256 escrowed;         // full payout locked by live rounds
        uint256 stake;            // ranking signal, never touched by settlement
        uint16  maxMultiplierX100;
        uint256 maxStake;
        uint256 hotTarget;
        bool    open;
    }

    address public immutable chips;
    mapping(bytes32 tableId => Table) public tables;
    uint256 internal _tableNonce;

    constructor(address random_, address chips_) GameBase(random_) {
        chips = chips_;
    }

    modifier onlyOperator(bytes32 tableId) {
        if (tables[tableId].operator != msg.sender) revert NotOperator();
        _;
    }

    function _requireMultiplier(uint16 m) internal pure {
        if (m < MULT_MIN || m > MULT_MAX) revert BadMultiplier();
    }

    function createTable(uint16 maxMultiplierX100, uint256 maxStake, uint256 hotTarget)
        external
        returns (bytes32 tableId)
    {
        _requireMultiplier(maxMultiplierX100);
        tableId = keccak256(abi.encode(address(this), msg.sender, ++_tableNonce));
        Table storage t = tables[tableId];
        t.operator = msg.sender;
        t.maxMultiplierX100 = maxMultiplierX100;
        t.maxStake = maxStake;
        t.hotTarget = hotTarget;
        t.open = true;
        emit TableCreated(tableId, msg.sender, maxMultiplierX100, maxStake, hotTarget);
    }

    function setParams(bytes32 tableId, uint16 maxMultiplierX100, uint256 maxStake, uint256 hotTarget)
        external
        onlyOperator(tableId)
    {
        _requireMultiplier(maxMultiplierX100);
        Table storage t = tables[tableId];
        t.maxMultiplierX100 = maxMultiplierX100;
        t.maxStake = maxStake;
        t.hotTarget = hotTarget;
        emit ParamsSet(tableId, maxMultiplierX100, maxStake, hotTarget);
    }

    function setOpen(bytes32 tableId, bool isOpen) external onlyOperator(tableId) {
        tables[tableId].open = isOpen;
        emit OpenSet(tableId, isOpen);
    }

    error InsufficientHot();
    error InsufficientCold();

    event HotFunded(bytes32 indexed tableId, uint256 amount);
    event ColdFunded(bytes32 indexed tableId, uint256 amount);
    event HotWithdrawn(bytes32 indexed tableId, uint256 amount);
    event ColdWithdrawn(bytes32 indexed tableId, uint256 amount);
    event Promoted(bytes32 indexed tableId, uint256 amount);
    event Demoted(bytes32 indexed tableId, uint256 amount);

    function fundHot(bytes32 tableId, uint256 amount) external {
        if (tables[tableId].operator == address(0)) revert NoTable();
        tables[tableId].hot += amount;
        chips.safeTransferFrom(msg.sender, address(this), amount);
        emit HotFunded(tableId, amount);
    }

    function fundCold(bytes32 tableId, uint256 amount) external {
        if (tables[tableId].operator == address(0)) revert NoTable();
        tables[tableId].cold += amount;
        chips.safeTransferFrom(msg.sender, address(this), amount);
        emit ColdFunded(tableId, amount);
    }

    function withdrawHot(bytes32 tableId, uint256 amount) external onlyOperator(tableId) {
        Table storage t = tables[tableId];
        if (t.hot < amount) revert InsufficientHot();
        t.hot -= amount;
        chips.safeTransfer(msg.sender, amount);
        emit HotWithdrawn(tableId, amount);
    }

    function withdrawCold(bytes32 tableId, uint256 amount) external onlyOperator(tableId) {
        Table storage t = tables[tableId];
        if (t.cold < amount) revert InsufficientCold();
        t.cold -= amount;
        chips.safeTransfer(msg.sender, amount);
        emit ColdWithdrawn(tableId, amount);
    }

    function promote(bytes32 tableId, uint256 amount) external onlyOperator(tableId) {
        Table storage t = tables[tableId];
        if (t.cold < amount) revert InsufficientCold();
        t.cold -= amount;
        t.hot += amount;
        emit Promoted(tableId, amount);
    }

    function demote(bytes32 tableId, uint256 amount) external onlyOperator(tableId) {
        Table storage t = tables[tableId];
        if (t.hot < amount) revert InsufficientHot();
        t.hot -= amount;
        t.cold += amount;
        emit Demoted(tableId, amount);
    }

    error InsufficientStake();

    event Staked(bytes32 indexed tableId, uint256 amount);
    event Unstaked(bytes32 indexed tableId, uint256 amount);

    function stakeForRank(bytes32 tableId, uint256 amount) external onlyOperator(tableId) {
        tables[tableId].stake += amount;
        chips.safeTransferFrom(msg.sender, address(this), amount);
        emit Staked(tableId, amount);
    }

    function unstake(bytes32 tableId, uint256 amount) external onlyOperator(tableId) {
        Table storage t = tables[tableId];
        if (t.stake < amount) revert InsufficientStake();
        t.stake -= amount;
        chips.safeTransfer(msg.sender, amount);
        emit Unstaked(tableId, amount);
    }

    /// @notice Rounds/settlement land in a later task in this slice; Task 1 only scaffolds table
    /// storage and admin, so there is nothing to settle yet. Overriding is compile-mandatory —
    /// GameBase declares `_settle` with no body, which otherwise forces this contract abstract.
    function _settle(bytes32 instanceId, bytes32 seed) internal override {}
}
