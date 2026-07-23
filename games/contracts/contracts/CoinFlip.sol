// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {GameBase} from "./GameBase.sol";
import {IRandom} from "./implementations/IRandom.sol";
import {PreimageLocation} from "./PreimageLocation.sol";

/// @notice Two-person coin flip on validator-only entropy. Players escrow a stake and a side and
/// declare a validator subset; opposite-side equal-stake entrants on the same subset are matched
/// first-in-first-out, the subset's preimages are heated through GameBase's bound heat, and the
/// parity of the validator-produced seed decides the winner. The game inks nothing and contributes
/// nothing to the seed; players hold no entropy.
contract CoinFlip is GameBase {
    error WrongSide();
    error ZeroStake();
    error NotEntrant();
    error AlreadyResolved();
    error TooEarly();

    event Entered(uint256 indexed id, address indexed player, uint8 side, uint256 stake, bytes32 subsetHash);
    event Cancelled(uint256 indexed id);
    event Paired(bytes32 indexed flipId, address heads, address tails, uint256 stake);
    event Heated(bytes32 indexed flipId, bytes32 indexed key);
    event Settled(bytes32 indexed flipId, address indexed winner, uint8 winningSide, uint256 payout, bytes32 seed);

    enum Status { None, Pending, Settled, Refunded }

    struct Entry {
        address player;
        uint8 side;
        uint256 stake;
        bytes32 subsetHash;
        uint256 enteredAtBlock;
        bool active;
    }

    struct Flip {
        address heads;
        address tails;
        uint256 stake;
        bytes32 key;
        uint256 pairedAtBlock;
        Status status;
    }

    uint8 internal constant HEADS = 0;
    uint8 internal constant TAILS = 1;
    uint256 internal constant MAX_QUEUE_SCAN = 32;

    uint256 public nextEntrant;
    mapping(uint256 id => Entry entry) public entries;

    // stake => subsetHash => side => first-in-first-out queue of entry ids, with a moving head.
    mapping(uint256 => mapping(bytes32 => mapping(uint8 => uint256[]))) internal _queue;
    mapping(uint256 => mapping(bytes32 => mapping(uint8 => uint256))) internal _queueHead;

    mapping(bytes32 flipId => Flip flip) public flips;
    uint256 internal _flipNonce;

    constructor(address _random) GameBase(_random) {}

    /// @notice Enter a side at the sent stake on a declared validator subset. If an opposite-side
    /// equal-stake entry waits on the same subset, pair and heat in one transaction (supply the
    /// subset's heat locations); otherwise queue (pass an empty locations array).
    function enterAndMatch(
        uint8 side,
        address[] calldata validatorSubset,
        PreimageLocation.Info[] calldata validatorLocations
    ) external payable returns (uint256 id) {
        if (side > TAILS) revert WrongSide();
        if (msg.value == 0) revert ZeroStake();
        _validateSubset(validatorSubset);
        bytes32 subsetHash = keccak256(abi.encode(validatorSubset));

        id = ++nextEntrant;
        entries[id] = Entry({
            player: msg.sender,
            side: side,
            stake: msg.value,
            subsetHash: subsetHash,
            enteredAtBlock: block.number,
            active: true
        });
        emit Entered(id, msg.sender, side, msg.value, subsetHash);

        uint8 opposite = side == HEADS ? TAILS : HEADS;
        uint256 matchedId = _popQueued(msg.value, subsetHash, opposite);
        if (matchedId == 0) {
            _queue[msg.value][subsetHash][side].push(id);
            return id;
        }
        _pairAndHeat(matchedId, id, msg.value, validatorSubset, validatorLocations);
    }

    function _popQueued(uint256 stake, bytes32 subsetHash, uint8 side) internal returns (uint256 id) {
        uint256[] storage q = _queue[stake][subsetHash][side];
        uint256 head = _queueHead[stake][subsetHash][side];
        uint256 scanned;
        while (head < q.length && scanned < MAX_QUEUE_SCAN) {
            uint256 candidate = q[head];
            unchecked { ++head; ++scanned; }
            if (entries[candidate].active) {
                _queueHead[stake][subsetHash][side] = head;
                return candidate;
            }
        }
        _queueHead[stake][subsetHash][side] = head;
        return 0;
    }

    /// @notice A still-waiting entrant reclaims their stake; the entry stays an inactive tombstone.
    function cancel(uint256 id) external {
        Entry storage e = entries[id];
        if (e.player != msg.sender) revert NotEntrant();
        if (!e.active) revert AlreadyResolved();
        e.active = false;
        emit Cancelled(id);
        _refund(e.player, e.stake);
    }

    /// @notice Refund both players of a paired flip whose seed never finalized in time. The seed
    /// must be genuinely missing: a flip whose seed HAS finalized is value-decided and can only be
    /// settled to the parity winner via claim/onCast, never unwound to a mutual refund (otherwise a
    /// participant could escape a decided outcome by waiting out the timeout). Mirrors
    /// Raffle.refundTicket — refund opens once the seed is missing AND the request was chopped or
    /// the liveness timeout elapsed.
    function refundStale(bytes32 flipId) external {
        Flip storage flip = flips[flipId];
        if (flip.status != Status.Pending) revert AlreadyResolved();
        bool seedMissing = IRandom(random).randomness(flip.key).seed == bytes32(0);
        if (!seedMissing) revert TooEarly();
        if (!choppedInstance[flipId] && !_isStale(flip.pairedAtBlock)) revert TooEarly();
        flip.status = Status.Refunded;
        _refund(flip.heads, flip.stake);
        _refund(flip.tails, flip.stake);
    }

    function _pairAndHeat(
        uint256 aId,
        uint256 bId,
        uint256 stake,
        address[] calldata validatorSubset,
        PreimageLocation.Info[] calldata validatorLocations
    ) internal {
        Entry storage a = entries[aId];
        Entry storage b = entries[bId];
        a.active = false;
        b.active = false;
        (Entry storage heads, Entry storage tails) = a.side == HEADS ? (a, b) : (b, a);

        bytes32 key = _heatBound(validatorSubset, validatorLocations);

        bytes32 flipId = keccak256(abi.encode(address(this), ++_flipNonce, heads.player, tails.player));
        flips[flipId] = Flip({
            heads: heads.player,
            tails: tails.player,
            stake: stake,
            key: key,
            pairedAtBlock: block.number,
            status: Status.Pending
        });
        instanceByKey[key] = flipId;
        emit Paired(flipId, heads.player, tails.player, stake);
        emit Heated(flipId, key);
    }

    /// @notice The single settlement path, shared by onCast (push) and claim (pull). Guards status
    /// before transfer (checks-effects-interactions); this is what makes a double payout impossible.
    /// Do NOT add a reentrancy guard — it would block the claim retry after a swallowed onCast.
    function _settle(bytes32 flipId, bytes32 seed) internal override {
        Flip storage flip = flips[flipId];
        if (flip.status != Status.Pending) revert AlreadyResolved();
        flip.status = Status.Settled;
        uint8 winningSide = uint8(uint256(seed) & 1);
        address winner = winningSide == HEADS ? flip.heads : flip.tails;
        uint256 payout = flip.stake * 2;
        emit Settled(flipId, winner, winningSide, payout, seed);
        _pay(winner, payout);
    }

    /// @notice Pull fallback when the onCast push did not complete though the seed is finalized.
    function claim(bytes32 flipId) external {
        Flip storage flip = flips[flipId];
        if (flip.status != Status.Pending) revert AlreadyResolved();
        bytes32 seed = IRandom(random).randomness(flip.key).seed;
        if (seed == bytes32(0)) revert TooEarly();
        _settle(flipId, seed);
    }
}
