// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {MsgPow} from "../src/MsgPow.sol";

/// @title PoWGate — example: gate an on-chain action behind a valid msgboard proof of work.
/// @notice A contract can require a caller to present a message whose proof of work clears a
/// difficulty threshold before allowing an action (mint, claim, vote, ...). Note that
/// verification costs ~700k gas (a secp256k1 ecMul), so this fits high-value / low-frequency
/// gates rather than hot paths.
contract PoWGate {
    /// @dev minimum difficulty a presented message must satisfy.
    uint256 public immutable minDifficulty;

    /// @dev message hashes already used, to prevent replay of the same stamp.
    mapping(bytes32 => bool) public used;

    event Passed(address indexed caller, bytes32 indexed workHash);

    constructor(uint256 minDifficulty_) {
        require(minDifficulty_ != 0, "PoWGate: zero difficulty");
        minDifficulty = minDifficulty_;
    }

    /// @notice Perform the gated action if `m` carries valid work at or above `minDifficulty`.
    function enter(MsgPow.Message calldata m) external returns (bytes32 workHash) {
        require(MsgPow.verify(m, minDifficulty), "PoWGate: invalid work");
        workHash = MsgPow.workHash(m);
        require(!used[workHash], "PoWGate: stamp already used");
        used[workHash] = true;
        emit Passed(msg.sender, workHash);
        // ... the gated action would go here ...
    }
}
