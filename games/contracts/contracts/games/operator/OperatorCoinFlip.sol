// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {GameBase} from "../../GameBase.sol";
import {PreimageLocation} from "../../PreimageLocation.sol";
import {GameEscrow} from "./GameEscrow.sol";
import {OperatorRegistry} from "./OperatorRegistry.sol";

/// @notice Escrow-backed coin flip — the slice-A reference game. Identical parity mechanics to
/// CoinFlipTables, but every chip lives in GameEscrow (token-agnostic, pre-collateralized) and every
/// table belongs to a registered operator. The operator supplies bankroll and cannot touch the coin;
/// the substrate guarantees the player is paid on a win and refunded on a validator abort, from
/// pre-locked capital. This wiring resolves the CoinFlip validator-abort free-roll: refundStale
/// returns the player's stake from escrow and the operator's exposure to its bankroll — never a split,
/// never a steal.
contract OperatorCoinFlip is GameBase {
    error NotRegisteredOperator();
    error NotOperator();
    error BadMultiplier();
    error TableClosed();
    error WrongSide();
    error DustStake();
    error ZeroStake();
    error StakeTooHigh();
    error AlreadyResolved();
    error TooEarly();

    uint16 internal constant MULT_MIN = 150;
    uint16 internal constant MULT_MAX = 200;
    uint8 internal constant TAILS = 1;

    enum Status { None, Pending, Settled, Refunded }

    struct Table {
        address operator;
        address token;
        uint16  maxMultiplierX100;
        uint256 maxStake;
        bool    open;
    }

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

    address public immutable escrow;
    address public immutable registry;

    mapping(bytes32 tableId => Table) public tables;
    mapping(bytes32 roundId => Round) public rounds;
    uint256 internal _tableNonce;
    uint256 internal _roundNonce;

    event TableCreated(bytes32 indexed tableId, address indexed operator, address indexed token, uint16 maxMultiplierX100, uint256 maxStake);
    event OpenSet(bytes32 indexed tableId, bool open);
    event RoundOpened(bytes32 indexed roundId, bytes32 indexed tableId, address indexed player, uint8 side, uint256 stake, uint256 payout, bytes32 key, uint256 openedAtBlock);
    event RoundSettled(bytes32 indexed roundId, bytes32 indexed tableId, address indexed player, bool won, uint256 payout, bytes32 seed);
    event RoundRefunded(bytes32 indexed roundId, bytes32 indexed tableId, address indexed player, uint256 stake);

    constructor(address random_, address escrow_, address registry_) GameBase(random_) {
        escrow = escrow_;
        registry = registry_;
    }

    modifier onlyOperator(bytes32 tableId) {
        if (tables[tableId].operator != msg.sender) revert NotOperator();
        _;
    }

    function createTable(address token, uint16 maxMultiplierX100, uint256 maxStake) external returns (bytes32 tableId) {
        if (!OperatorRegistry(registry).registered(msg.sender)) revert NotRegisteredOperator();
        if (maxMultiplierX100 < MULT_MIN || maxMultiplierX100 > MULT_MAX) revert BadMultiplier();
        tableId = keccak256(abi.encode(address(this), msg.sender, ++_tableNonce));
        tables[tableId] = Table({operator: msg.sender, token: token, maxMultiplierX100: maxMultiplierX100, maxStake: maxStake, open: true});
        emit TableCreated(tableId, msg.sender, token, maxMultiplierX100, maxStake);
    }

    function setOpen(bytes32 tableId, bool isOpen) external onlyOperator(tableId) {
        tables[tableId].open = isOpen;
        emit OpenSet(tableId, isOpen);
    }

    function open(
        bytes32 tableId,
        uint8 side,
        uint256 stake,
        address[] calldata validatorSubset,
        PreimageLocation.Info[] calldata validatorLocations
    ) external returns (bytes32 roundId) {
        Table storage t = tables[tableId];
        if (t.operator == address(0)) revert TableClosed();
        if (!t.open) revert TableClosed();
        if (side > TAILS) revert WrongSide();
        if (stake == 0) revert ZeroStake();
        if (stake > t.maxStake) revert StakeTooHigh();
        _validateSubset(validatorSubset);

        uint256 payout = stake * t.maxMultiplierX100 / 100;
        // Guard the dust case: at tiny stakes the multiplier truncates to break-even (payout == stake,
        // zero operator exposure), a degenerate round where a "win" pays nothing. Reject it so the
        // advertised 1.5x-2x odds always hold.
        if (payout == stake) revert DustStake();
        bytes32 key = _heatBound(validatorSubset, validatorLocations);
        roundId = keccak256(abi.encode(address(this), ++_roundNonce, tableId, msg.sender));

        // Effects before interaction: record the round + reverse index BEFORE the escrow call. A revert
        // in lockExposure (insufficient bankroll, player not consented, …) unwinds these writes
        // atomically, so nothing dangles; and no external call sits between the id derivation and its
        // local record.
        rounds[roundId] = Round({
            tableId: tableId, player: msg.sender, side: side, stake: stake, payout: payout,
            key: key, openedAtBlock: block.number, status: Status.Pending
        });
        instanceByKey[key] = roundId;

        // custody lives in the escrow: it pulls the player's stake (player approves the escrow) and
        // debits the operator's exposure from its bankroll — reverting if the operator is short.
        GameEscrow(escrow).lockExposure(roundId, t.operator, t.token, msg.sender, stake, payout);
        emit RoundOpened(roundId, tableId, msg.sender, side, stake, payout, key, block.number);
    }

    function _settle(bytes32 roundId, bytes32 seed) internal override {
        Round storage r = rounds[roundId];
        if (r.status != Status.Pending) revert AlreadyResolved();
        r.status = Status.Settled;
        bool won = uint8(uint256(seed) & 1) == r.side;
        if (won) {
            GameEscrow(escrow).settleWin(roundId);
        } else {
            GameEscrow(escrow).settleLoss(roundId);
        }
        emit RoundSettled(roundId, r.tableId, r.player, won, r.payout, seed);
    }

    function claim(bytes32 roundId) external {
        Round storage r = rounds[roundId];
        if (r.status != Status.Pending) revert AlreadyResolved();
        bytes32 seed = _seed(r.key);
        if (seed == bytes32(0)) revert TooEarly();
        _settle(roundId, seed);
    }

    function refundStale(bytes32 roundId) external {
        Round storage r = rounds[roundId];
        if (r.status != Status.Pending) revert AlreadyResolved();
        if (_seed(r.key) != bytes32(0)) revert TooEarly();
        if (!_refundableNow(roundId, r.openedAtBlock)) revert TooEarly();
        r.status = Status.Refunded;
        GameEscrow(escrow).refund(roundId);
        emit RoundRefunded(roundId, r.tableId, r.player, r.stake);
    }
}
