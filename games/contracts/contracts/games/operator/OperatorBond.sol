// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {SafeTransferLib} from "solady/src/utils/SafeTransferLib.sol";
import {ReentrancyGuard} from "./ReentrancyGuard.sol";

/// @notice Protocol-held per-(operator, token) accountability bond, separate from the funding vault so
/// a harmed player can always be made whole regardless of operator behavior. Slice A ships the custody
/// primitive: operators post/withdraw-when-idle, and an adjudicating game may slash a capped amount to
/// a harmed player. The dispute-LOCK path (freezing bond while a dispute is open) is wired in slice D,
/// where the N-party residual makes it load-bearing; until then `locked` stays 0 and free == total.
///
/// Token-moving entrypoints are `nonReentrant`: `postBond` credits by a measured balance delta, so a
/// hooked token that re-enters mid-transfer could otherwise over-credit the bond (same class of bug as
/// GameEscrow.depositBankroll — see ReentrancyGuard).
contract OperatorBond is ReentrancyGuard {
    using SafeTransferLib for address;

    error BondLocked();
    error InsufficientBond();
    error Unauthorized();

    address public immutable registry;

    struct Bond { uint256 total; uint256 locked; }
    mapping(bytes32 key => Bond) internal bonds;
    mapping(address operator => mapping(address game => bool)) public authorizedGame;

    event BondPosted(address indexed operator, address indexed token, address indexed from, uint256 credited);
    event BondWithdrawn(address indexed operator, address indexed token, uint256 amount);
    event BondSlashed(address indexed operator, address indexed token, address game, address player, uint256 amount);
    event GameAuthorized(address indexed operator, address indexed game, bool allowed);

    constructor(address registry_) { registry = registry_; }

    function _key(address operator, address token) internal pure returns (bytes32) {
        return keccak256(abi.encode(operator, token));
    }

    function bondOf(address operator, address token) external view returns (uint256 total, uint256 locked) {
        Bond storage b = bonds[_key(operator, token)];
        return (b.total, b.locked);
    }

    function postBond(address operator, address token, uint256 amount) external nonReentrant {
        uint256 balBefore = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        uint256 credited = token.balanceOf(address(this)) - balBefore;
        bonds[_key(operator, token)].total += credited;
        emit BondPosted(operator, token, msg.sender, credited);
    }

    /// @notice Operator authorizes (or revokes) a game contract to slash its own bond on adjudication.
    /// Permissionless and self-sovereign: only the operator can authorize slashers of its bond.
    function authorizeGame(address game, bool allowed) external {
        authorizedGame[msg.sender][game] = allowed;
        emit GameAuthorized(msg.sender, game, allowed);
    }

    function withdrawBond(address token, uint256 amount) external nonReentrant {
        Bond storage b = bonds[_key(msg.sender, token)];
        uint256 free = b.total - b.locked;
        if (amount > free) revert BondLocked();
        b.total -= amount;
        token.safeTransfer(msg.sender, amount);
        emit BondWithdrawn(msg.sender, token, amount);
    }

    function slashToPlayer(address operator, address token, address player, uint256 amount) external nonReentrant {
        if (!authorizedGame[operator][msg.sender]) revert Unauthorized();
        Bond storage b = bonds[_key(operator, token)];
        uint256 free = b.total - b.locked;
        if (amount > free) revert InsufficientBond();
        b.total -= amount;
        token.safeTransfer(player, amount);
        emit BondSlashed(operator, token, msg.sender, player, amount);
    }
}
