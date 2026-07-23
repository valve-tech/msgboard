// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {ECDSA} from "solady/src/utils/ECDSA.sol";
import {SafeTransferLib} from "solady/src/utils/SafeTransferLib.sol";
import {Ownable} from "solady/src/auth/Ownable.sol";
import {SessionState, SessionStateLib, SessionStateEIP712} from "./SessionState.sol";

/// Optimistic settlement backend (spec 6.1). Players hold a shared deposit (keyed by their
/// session signing key); the house funds a mintable-backed pool. settle() pays only the net
/// delta of a session, proven by the open + final co-signed states.
contract HouseBankroll is SessionStateEIP712, Ownable {
    using SafeTransferLib for address;
    using SessionStateLib for SessionState;

    error WrongTable();
    error BadMode();
    error BadGenesis();
    error StaleNonce();
    error ConservationViolated();
    error BadSig();
    error NotPlayer();
    error InsufficientPool();
    error InsufficientDeposit();

    address public immutable chips;
    address public houseKey;             // the house's session signing key
    uint256 public housePool;            // house-funded, mintable-backed
    mapping(address signer => uint256) public deposits;          // player deposit by session key
    mapping(bytes32 tableId => uint64) public settledNonce;      // highest-nonce-wins
    mapping(bytes32 tableId => uint256) public settledBalancePlayer; // last-settled player balance (incremental baseline)

    event Deposited(address indexed signer, uint256 amount);
    event Withdrawn(address indexed signer, uint256 amount);
    event HouseFunded(uint256 amount);
    event HouseWithdrawn(uint256 amount);
    event HouseKeySet(address indexed key);
    event Settled(bytes32 indexed tableId, address indexed player, uint64 nonce, int256 playerDelta);

    constructor(address chips_) {
        chips = chips_;
        _initializeOwner(msg.sender);
    }

    function setHouseKey(address key) external onlyOwner {
        houseKey = key;
        emit HouseKeySet(key);
    }

    // -- player + house funding --

    function deposit(uint256 amount) external {
        deposits[msg.sender] += amount;
        chips.safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(msg.sender, amount);
    }

    function withdraw(uint256 amount) external {
        if (deposits[msg.sender] < amount) revert InsufficientDeposit();
        deposits[msg.sender] -= amount;
        chips.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    function fundHouse(uint256 amount) external onlyOwner {
        housePool += amount;
        chips.safeTransferFrom(msg.sender, address(this), amount);
        emit HouseFunded(amount);
    }

    function withdrawHouse(uint256 amount) external onlyOwner {
        if (housePool < amount) revert InsufficientPool();
        housePool -= amount;
        chips.safeTransfer(msg.sender, amount);
        emit HouseWithdrawn(amount);
    }

    // -- settlement --

    /// Settle a finished optimistic session. `openState` is the both-signed genesis (nonce 0)
    /// fixing the session's starting balances; `finalState` is the both-signed latest. The net
    /// player delta moves between the player's deposit and the house pool. Both states must be
    /// signed by the SAME player key (recovered) and the configured houseKey. Anyone may submit.
    function settle(
        SessionState calldata openState,
        SessionState calldata finalState,
        bytes calldata openSigPlayer,
        bytes calldata openSigHouse,
        bytes calldata finalSigPlayer,
        bytes calldata finalSigHouse
    ) external {
        bytes32 tableId = finalState.tableId;
        if (openState.tableId != tableId) revert WrongTable();
        if (openState.settlementMode != 0 || finalState.settlementMode != 0) revert BadMode();
        if (openState.gameId != finalState.gameId) revert BadMode();
        if (openState.nonce != 0) revert BadGenesis();
        if (finalState.nonce <= openState.nonce) revert StaleNonce();
        if (finalState.nonce <= settledNonce[tableId]) revert StaleNonce();
        if (openState.balancePlayer + openState.balanceHouse
            != finalState.balancePlayer + finalState.balanceHouse) revert ConservationViolated();

        bytes32 openDigest = _hashTypedData(openState.structHash());
        bytes32 finalDigest = _hashTypedData(finalState.structHash());
        address player = ECDSA.recoverCalldata(openDigest, openSigPlayer);
        if (player == address(0) || player == houseKey) revert NotPlayer();
        if (ECDSA.recoverCalldata(finalDigest, finalSigPlayer) != player) revert BadSig();
        if (ECDSA.recoverCalldata(openDigest, openSigHouse) != houseKey) revert BadSig();
        if (ECDSA.recoverCalldata(finalDigest, finalSigHouse) != houseKey) revert BadSig();

        // Incremental baseline: the first settle of a session measures from the genesis open
        // balance; a later settle of the same continuing session measures from the LAST-settled
        // balance, so re-settling at a higher nonce moves only the incremental delta and never
        // re-applies the whole genesis->final delta (which would over-pay / over-debit). prevNonce
        // == 0 marks "never settled" (a final nonce is always >= 1, so this is unambiguous).
        uint64 prevNonce = settledNonce[tableId];
        uint256 baseline = prevNonce == 0 ? openState.balancePlayer : settledBalancePlayer[tableId];
        settledNonce[tableId] = finalState.nonce;
        settledBalancePlayer[tableId] = finalState.balancePlayer;

        if (finalState.balancePlayer >= baseline) {
            uint256 win = finalState.balancePlayer - baseline;
            if (housePool < win) revert InsufficientPool();
            housePool -= win;
            deposits[player] += win;
            emit Settled(tableId, player, finalState.nonce, int256(win));
        } else {
            uint256 loss = baseline - finalState.balancePlayer;
            if (deposits[player] < loss) revert InsufficientDeposit();
            deposits[player] -= loss;
            housePool += loss;
            emit Settled(tableId, player, finalState.nonce, -int256(loss));
        }
    }
}
