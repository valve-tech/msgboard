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

    enum Status { None, Pending, Settled, Refunded }

    struct Round {
        bytes32 tableId;
        address player;
        uint8   side;
        uint256 stake;
        uint256 payout;
        bytes32 key;
        uint256 openedAtBlock;
        Status  status;
    }

    uint8 internal constant HEADS = 0;
    uint8 internal constant TAILS = 1;

    mapping(bytes32 roundId => Round) public rounds;
    uint256 internal _roundNonce;

    error TableClosed();
    error StakeTooHigh();
    error ZeroStake();
    error WrongSide();
    error InsufficientBankroll();

    event RoundOpened(
        bytes32 indexed roundId,
        bytes32 indexed tableId,
        address indexed player,
        uint8 side,
        uint256 stake,
        uint256 payout,
        bytes32 subsetHash,
        bytes32 key,
        uint256 openedAtBlock
    );

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

    error NameTooLong();
    event TableNamed(bytes32 indexed tableId, string name);

    /// @notice Set (or change) the table's public display name — an authenticated label the off-chain
    /// index folds into the table's identity so an invite reads like a name, not a hash. Operator-only;
    /// the last TableNamed wins. Capped so one operator can't bloat the event for every viewer. The name
    /// is carried in the event only (not stored) — the indexer already reads events for the table list.
    function setName(bytes32 tableId, string calldata name) external onlyOperator(tableId) {
        if (bytes(name).length > 64) revert NameTooLong();
        emit TableNamed(tableId, name);
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

    error NothingToRefill();

    event Refilled(bytes32 indexed tableId, uint256 amount);

    /// @notice Permissionless top-up of hot from cold, capped at hotTarget. Anyone may call this —
    /// it moves no tokens (pure internal cold->hot accounting) so there is nothing to gate.
    function refillHot(bytes32 tableId) external {
        Table storage t = tables[tableId];
        if (t.operator == address(0)) revert NoTable();
        if (t.hot >= t.hotTarget) revert NothingToRefill();
        uint256 need = t.hotTarget - t.hot;
        uint256 move = need < t.cold ? need : t.cold;
        if (move == 0) revert NothingToRefill();
        t.cold -= move;
        t.hot += move;
        emit Refilled(tableId, move);
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

    /// @notice Player opens a round: picks a side and a stake, pulls the stake into the contract, and
    /// escrows the FULL payout (stake + operator exposure) so settlement never has to re-derive it.
    /// Only the operator's exposure (payout - stake) leaves `hot` — the player's own stake funds the
    /// rest of the escrow. Heats the declared validator subset through GameBase's bound heat so a
    /// later settlement can be driven by validator entropy.
    function open(
        bytes32 tableId,
        uint8 side,
        uint256 stake,
        address[] calldata validatorSubset,
        PreimageLocation.Info[] calldata validatorLocations
    ) external returns (bytes32 roundId) {
        Table storage t = tables[tableId];
        if (t.operator == address(0)) revert NoTable();
        if (!t.open) revert TableClosed();
        if (side > TAILS) revert WrongSide();
        if (stake == 0) revert ZeroStake();
        if (stake > t.maxStake) revert StakeTooHigh();
        _validateSubset(validatorSubset);

        uint256 payout = stake * t.maxMultiplierX100 / 100;
        uint256 exposure = payout - stake; // operator's at-risk portion
        if (t.hot < exposure) revert InsufficientBankroll();

        // Pull the player's stake into the contract, then lock the full payout: exposure leaves hot,
        // the player's own stake is now held as the remainder of the escrow.
        chips.safeTransferFrom(msg.sender, address(this), stake);
        t.hot -= exposure;
        t.escrowed += payout;

        bytes32 key = _heatBound(validatorSubset, validatorLocations);
        roundId = keccak256(abi.encode(address(this), ++_roundNonce, tableId, msg.sender));
        rounds[roundId] = Round({
            tableId: tableId,
            player: msg.sender,
            side: side,
            stake: stake,
            payout: payout,
            key: key,
            openedAtBlock: block.number,
            status: Status.Pending
        });
        instanceByKey[key] = roundId;
        emit RoundOpened(roundId, tableId, msg.sender, side, stake, payout, keccak256(abi.encode(validatorSubset)), key, block.number);
    }

    error AlreadyResolved();
    error TooEarly();

    event RoundSettled(
        bytes32 indexed roundId,
        bytes32 indexed tableId,
        address indexed player,
        bool won,
        uint256 payout,
        bytes32 seed,
        uint256 settledAtBlock
    );

    /// @notice Single settlement path shared by onCast (push) and claim (pull). Guards status before
    /// any transfer (checks-effects-interactions) so a double payout is impossible. No reentrancy
    /// guard — it would block the claim retry after a swallowed onCast (same rationale as
    /// CoinFlip._settle).
    function _settle(bytes32 roundId, bytes32 seed) internal override {
        Round storage r = rounds[roundId];
        if (r.status != Status.Pending) revert AlreadyResolved();
        r.status = Status.Settled;

        Table storage t = tables[r.tableId];
        t.escrowed -= r.payout; // release reservation either way

        bool won = uint8(uint256(seed) & 1) == r.side;
        if (won) {
            // exposure already left hot at open; pay the player the full payout from escrow
            chips.safeTransfer(r.player, r.payout);
        } else {
            // whole reservation (operator exposure + player's forfeited stake) returns to armed balance
            t.hot += r.payout;
        }
        emit RoundSettled(roundId, r.tableId, r.player, won, r.payout, seed, block.number);
    }

    /// @notice Pull fallback when the onCast push did not complete though the seed is finalized.
    function claim(bytes32 roundId) external {
        Round storage r = rounds[roundId];
        if (r.status != Status.Pending) revert AlreadyResolved();
        bytes32 seed = IRandom(random).randomness(r.key).seed;
        if (seed == bytes32(0)) revert TooEarly();
        _settle(roundId, seed);
    }

    event Refunded(
        bytes32 indexed roundId,
        bytes32 indexed tableId,
        address indexed player,
        uint256 stake,
        uint256 payout,
        uint256 refundedAtBlock
    );

    /// @notice Refund a round whose seed never finalized in time. Mirrors CoinFlip.refundStale: a seed
    /// that HAS finalized is value-decided and can only be settled to the parity result, never unwound.
    function refundStale(bytes32 roundId) external {
        Round storage r = rounds[roundId];
        if (r.status != Status.Pending) revert AlreadyResolved();
        bool seedMissing = IRandom(random).randomness(r.key).seed == bytes32(0);
        if (!seedMissing) revert TooEarly();
        if (!choppedInstance[roundId] && !_isStale(r.openedAtBlock)) revert TooEarly();
        r.status = Status.Refunded;

        Table storage t = tables[r.tableId];
        uint256 exposure = r.payout - r.stake;
        t.escrowed -= r.payout;
        t.hot += exposure;                     // operator's at-risk portion returns to armed balance
        chips.safeTransfer(r.player, r.stake); // player reclaims their own stake
        // Mirror RoundSettled so the off-chain index can release the escrow/exposure and surface the
        // refunded state (without this event a refunded round is indistinguishable from a still-pending
        // one — phantom escrow, stuck "waiting on validators").
        emit Refunded(roundId, r.tableId, r.player, r.stake, r.payout, block.number);
    }
}
