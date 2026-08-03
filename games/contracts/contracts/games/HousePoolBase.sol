// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {SafeTransferLib} from "solady/src/utils/SafeTransferLib.sol";
import {Ownable} from "solady/src/auth/Ownable.sol";

/// Shared house-bankroll primitive: a single owner-funded/withdrawable Chips (ERC20) pool. Extracted
/// byte-for-byte (same errors/events/functions) from HouseBankroll, HouseChannel, and SkillSettle,
/// which each escrow/settle against `housePool` in their own way but fund/withdraw it identically.
///
/// Only the genuinely-shared trio lives here: `housePool` itself, `InsufficientPool`, the two funding
/// events, and `fundHouse`/`withdrawHouse`. `houseKey` (the off-chain session-signing key) and its
/// `setHouseKey`/`HouseKeySet` plumbing stay in each child even though their bodies also happen to be
/// identical today — they are conceptually child-owned (a settlement-key concern, not a pool concern)
/// and are free to diverge per game backend later. The owner gate (`onlyOwner`) is identical across all
/// three today, so it is reused as-is rather than parameterized.
///
/// STORAGE NOTE: these are all direct (non-proxy) deployments. Inserting this base ahead of a child in
/// its inheritance list moves `housePool` to an EARLIER storage slot than the child's own `houseKey`/
/// mapping vars (Solady's `Ownable` keeps its state in an ERC-7201-style constant slot, not a normal
/// sequential slot, so it doesn't itself shift anything). A fresh deployment gets this layout for free;
/// an already-deployed contract (HouseChannel, live on 943) would need a redeploy to match — its live
/// bytecode keeps the pre-refactor layout until then.
abstract contract HousePoolBase is Ownable {
    using SafeTransferLib for address;

    error InsufficientPool();

    address public immutable chips;
    uint256 public housePool; // house-funded, mintable-backed

    event HouseFunded(uint256 amount);
    event HouseWithdrawn(uint256 amount);

    constructor(address chips_) {
        chips = chips_;
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
}
