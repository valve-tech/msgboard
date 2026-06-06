// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {MsgPow} from "../src/MsgPow.sol";

/// @title PoWMint — example: onboard users by minting tokens in exchange for proof of work.
/// @notice Instead of a whitelist, a sale, or a faucet drip, a user mints by presenting a
/// msgboard message whose proof of work clears a difficulty threshold. Each unique work stamp
/// mints exactly once — for anyone — so a stamp cannot be reused to farm balances. This turns
/// "burn some CPU" into the cost of entry, which is sybil-resistant without payment rails.
///
/// @dev Verification costs ~700k gas (a secp256k1 ecMul), so this suits onboarding-style mints
/// rather than high-frequency claims. A minimal ERC-20 surface is inlined to keep the example
/// dependency-free.
contract PoWMint {
    string public constant name = "Proof of Work Token";
    string public constant symbol = "POW";
    uint8 public constant decimals = 18;

    /// @dev minimum difficulty a presented message must satisfy to mint.
    uint256 public immutable minDifficulty;
    /// @dev tokens minted per valid, unclaimed work stamp.
    uint256 public immutable mintAmount;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;

    /// @dev work hashes already redeemed, to stop a stamp minting more than once.
    mapping(bytes32 => bool) public claimed;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Onboarded(address indexed user, bytes32 indexed workHash, uint256 amount);

    constructor(uint256 minDifficulty_, uint256 mintAmount_) {
        require(minDifficulty_ != 0, "PoWMint: zero difficulty");
        minDifficulty = minDifficulty_;
        mintAmount = mintAmount_;
    }

    /// @notice Mint `mintAmount` to the caller if `m` carries valid, unclaimed work.
    /// @param m a msgboard message whose proof of work is verified on chain
    /// @return minted the amount minted to the caller
    function mintWithWork(MsgPow.Message calldata m) external returns (uint256 minted) {
        require(MsgPow.verify(m, minDifficulty), "PoWMint: invalid work");
        bytes32 workHash = MsgPow.workHash(m);
        require(!claimed[workHash], "PoWMint: work already claimed");
        claimed[workHash] = true;

        minted = mintAmount;
        totalSupply += minted;
        balanceOf[msg.sender] += minted;

        emit Transfer(address(0), msg.sender, minted);
        emit Onboarded(msg.sender, workHash, minted);
    }
}
