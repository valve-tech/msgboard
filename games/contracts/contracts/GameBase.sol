// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {SafeTransferLib} from "solady/src/utils/SafeTransferLib.sol";
import {ConsumerReceiver} from "./implementations/ConsumerReceiver.sol";
import {IRandom} from "./implementations/IRandom.sol";
import {PreimageLocation} from "./PreimageLocation.sol";

/// @notice Shared base for the games platform. Holds everything CoinFlip and Raffle share and
/// nothing game-specific: the core Random reference, native-token escrow helpers, an owner-managed
/// validator allowlist (read through a swappable seam), the binding-plus-membership heat helper,
/// the onCast dispatch reverse index with its guards, and the timeout-recovery surface. The games
/// ink nothing and contribute nothing to the seed — entropy is validator-only and pinned.
abstract contract GameBase is ConsumerReceiver {
    using SafeTransferLib for address;

    error OnlyRandom();
    error OnlyOwner();
    error NotAllowlisted();
    error BadSubset();
    error SubsetMismatch();
    error StakeMismatch();

    event OwnerTransferred(address indexed previousOwner, address indexed newOwner);
    event ValidatorAdded(address indexed validator);
    event ValidatorRemoved(address indexed validator);

    /// @notice core Random.
    address public immutable random;
    /// @notice owner address controlling the validator allowlist and fees (a plain address in v1).
    address public owner;

    /// @notice the owner-managed allowlist (the validator "universe"). Read through _isAllowlisted
    /// so a future version can override to delegate to an external IValidatorRegistry.
    mapping(address validator => bool allowed) public isValidator;
    uint256 public validatorCount;

    /// @notice minimum distinct validators a game instance's declared subset must span. The
    /// safety floor: a subset with at least one honest validator defeats selection-grinding.
    uint256 public constant MIN_SUBSET = 3;

    /// @notice blocks after a draw is armed before its escrow becomes reclaimable if the seed
    /// never finalizes (the liveness timeout). Matches the prior CoinFlip constant.
    uint256 public constant STALE_BLOCKS = 200;

    /// @notice canonical heat settings: native token, price 0, fixed duration. The duration is the
    /// expiry window the cast must land within.
    bool internal constant DURATION_IS_TIMESTAMP = false;
    uint256 public constant HEAT_DURATION = 12;
    address internal constant HEAT_TOKEN = address(0);

    /// @notice reverse index from a Random request key to the game instance it settles.
    mapping(bytes32 key => bytes32 instanceId) public instanceByKey;
    /// @notice instances whose draw was chopped at expiry (seed never formed) — a liveness failure.
    mapping(bytes32 instanceId => bool chopped) public choppedInstance;

    constructor(address _random) {
        random = _random;
        owner = msg.sender;
        emit OwnerTransferred(address(0), msg.sender);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        emit OwnerTransferred(owner, newOwner);
        owner = newOwner;
    }

    function addValidator(address validator) external onlyOwner {
        if (!isValidator[validator]) {
            isValidator[validator] = true;
            unchecked { ++validatorCount; }
            emit ValidatorAdded(validator);
        }
    }

    function removeValidator(address validator) external onlyOwner {
        if (isValidator[validator]) {
            isValidator[validator] = false;
            unchecked { --validatorCount; }
            emit ValidatorRemoved(validator);
        }
    }

    /// @notice The swappable membership seam. Defaults to the local owner-managed allowlist.
    function _isAllowlisted(address validator) internal view virtual returns (bool) {
        return isValidator[validator];
    }

    // --- native-token escrow ---

    /// @notice Assert the value sent equals the expected stake. Native escrow needs no pull: the
    /// value already arrived with the call. This validates at the boundary and fails fast.
    function _take(uint256 expected) internal view {
        if (msg.value != expected) revert StakeMismatch();
    }

    /// @notice Pay a winner.
    function _pay(address to, uint256 amount) internal {
        to.safeTransferETH(amount);
    }

    /// @notice Refund an escrowed stake.
    function _refund(address to, uint256 amount) internal {
        to.safeTransferETH(amount);
    }

    /// @notice Validate a declared subset at instance creation: at least MIN_SUBSET members, all
    /// distinct, all allowlisted. Distinctness is enforced here (once, cheaply); _heatBound's
    /// binding then guarantees the heated set equals this validated subset.
    function _validateSubset(address[] calldata subset) internal view {
        uint256 n = subset.length;
        if (n < MIN_SUBSET) revert BadSubset();
        for (uint256 i = 0; i < n; ++i) {
            address v = subset[i];
            if (!_isAllowlisted(v)) revert NotAllowlisted();
            for (uint256 j = i + 1; j < n; ++j) {
                if (subset[j] == v) revert BadSubset();
            }
        }
    }

    /// @notice Heat exactly the declared subset's preimages, with this contract as request owner and
    /// the change callback on (so Random calls onCast at finalization). Enforces:
    ///   binding — locations.length == subset.length (required == count, no slack) and each
    ///     location's provider equals the subset member at the same index (no sybil substitution);
    ///   membership — each subset member is still allowlisted at heat time (protects a raw-contract
    ///     caller who never touched the front end).
    /// Provider-level binding suffices: a subset containing one honest provider defeats grinding
    /// regardless of which of that provider's preimages is chosen, because the attacker never
    /// learns the honest secret.
    function _heatBound(address[] memory subset, PreimageLocation.Info[] calldata locations)
        internal
        returns (bytes32 key)
    {
        uint256 n = subset.length;
        if (locations.length != n) revert SubsetMismatch();
        for (uint256 i = 0; i < n; ++i) {
            if (locations[i].provider != subset[i]) revert SubsetMismatch();
            if (!_isAllowlisted(subset[i])) revert NotAllowlisted();
        }
        PreimageLocation.Info memory settings = PreimageLocation.Info({
            provider: address(this),
            callAtChange: true,
            durationIsTimestamp: DURATION_IS_TIMESTAMP,
            duration: HEAT_DURATION,
            token: HEAT_TOKEN,
            price: 0,
            offset: 0,
            index: 0
        });
        key = IRandom(random).heat(n, settings, locations, false);
    }

    // --- ConsumerReceiver callbacks and dispatch ---

    /// @notice Core Random calls this when a request's seed finalizes (callAtChange was set on
    /// heat). Looks up the instance by key and routes to the game's _settle.
    function onCast(bytes32 key, bytes32 seed) external override {
        if (msg.sender != random) revert OnlyRandom();
        _settle(instanceByKey[key], seed);
    }

    /// @notice Core Random calls this when a request is chopped at expiry (the seed never formed).
    /// Records the instance as a liveness failure so the game's refund path can fire.
    function onChop(bytes32 key) external override {
        if (msg.sender != random) revert OnlyRandom();
        bytes32 instanceId = instanceByKey[key];
        choppedInstance[instanceId] = true;
        _onChop(instanceId);
    }

    function onReverse(bytes32, address, uint256) external override {}

    /// @notice The game-specific settlement, invoked by onCast (push) and the game's pull fallback.
    function _settle(bytes32 instanceId, bytes32 seed) internal virtual;

    /// @notice Optional hook for a game to react to a chop beyond the recorded flag.
    function _onChop(bytes32 instanceId) internal virtual {}

    /// @notice True once `armedAtBlock + STALE_BLOCKS` has passed.
    function _isStale(uint256 armedAtBlock) internal view returns (bool) {
        return block.number >= armedAtBlock + STALE_BLOCKS;
    }
}
