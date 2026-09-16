// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {IRandom} from "../../contracts/implementations/IRandom.sol";
import {ConsumerReceiver} from "../../contracts/implementations/ConsumerReceiver.sol";
import {PreimageLocation} from "../../contracts/PreimageLocation.sol";
import {SafeTransferLib} from "solady/src/utils/SafeTransferLib.sol";

/// @notice Faithful IRandom test double for validator-stake / per-round-fee / chop-forfeit rules.
/// Unlike MockRandom (which mints a free key with no accounting), this mock reproduces the real
/// Random's custody bookkeeping: `heat` charges the caller's custodied token balance a per-round
/// fee (sum of `info[i].price`); `pushCast` finalizes the cohort and pays the fee to a bonus
/// recipient before delivering `onCast`; `chop` (only reachable before finalization) refunds the
/// fee to the request owner PLUS the stake forfeited by validators who did not reveal, then
/// delivers `onChop`. This lets later tasks exercise validator-forfeit logic without deploying
/// the real (tstore-using) Random contract.
contract MockRandomStaking is IRandom {
    using SafeTransferLib for address;

    /// @dev custodied[account][token] mirrors Random's per-account, per-token custody ledger.
    mapping(address account => mapping(address token => uint256 balance)) public custodied;

    mapping(bytes32 key => address token) internal _cohortToken;
    mapping(bytes32 key => uint256 fee) internal _cohortFee;
    mapping(bytes32 key => address owner) internal _owner;
    mapping(bytes32 key => uint256 mask) internal _revealed;
    mapping(bytes32 key => uint256 required) internal _n;
    mapping(bytes32 key => uint256 price) internal _price;
    /// @dev One-shot settlement guard: real Random can't settle a cohort twice — `chop` marks
    /// the key chopped and a later `cast` reverts, and a second `cast` on an already-seeded key
    /// is a no-op. This flag reproduces that for both `pushCast` and `chop` so neither can credit
    /// (or pay the fee) more than once for the same key.
    mapping(bytes32 key => bool done) internal _finalized;

    /// @notice Emitted when a settlement callback to the request owner reverts. Mirrors real
    /// Random's behavior of swallowing a broken consumer's revert instead of unwinding the
    /// custody credit that was already booked.
    event FailedToCall(bytes32 indexed key, address indexed owner, bytes4 selector);

    /// @dev recipient of the per-round fee on successful finalization; settable for tests.
    address internal _bonusTo = address(0xB0117);

    function setBonusTo(address bonusTo) external {
        _bonusTo = bonusTo;
    }

    function balanceOf(address account, address token) external view returns (uint256) {
        return custodied[account][token];
    }

    /// @notice Test convenience: pull `amount` of `token` from the caller into the caller's
    /// custody, mirroring a deposit into Random.
    function deposit(address token, uint256 amount) external {
        token.safeTransferFrom(msg.sender, address(this), amount);
        custodied[msg.sender][token] += amount;
    }

    /// @dev The mock only supports this codebase's fixed calling convention: `settings.provider
    /// == msg.sender`, `callAtChange == true`, and a uniform per-validator price within a
    /// cohort — `chop` relies on that uniformity via `_price[key] = info[0].price`, which
    /// GameBase itself enforces (see PriceMismatch) before ever calling `heat`.
    function heat(
        uint256 required,
        PreimageLocation.Info calldata,
        PreimageLocation.Info[] calldata info,
        bool
    ) external payable override returns (bytes32 key) {
        require(info.length == required, "MockRandomStaking: length");
        address token = info[0].token;
        uint256 fee;
        unchecked {
            for (uint256 i; i < info.length; ++i) fee += info[i].price;
        }
        require(custodied[msg.sender][token] >= fee, "MockRandomStaking: insufficient custody");
        custodied[msg.sender][token] -= fee;

        key = keccak256(abi.encode(info));
        _cohortToken[key] = token;
        _cohortFee[key] = fee;
        _owner[key] = msg.sender;
        _revealed[key] = 0;
        _n[key] = required;
        _price[key] = info[0].price;
    }

    /// @notice Drive a finalized seed: mark every validator revealed, pay the fee to the bonus
    /// recipient, then deliver the push callback (what Random does in `cast`).
    function pushCast(bytes32 key, bytes32 seed) external {
        require(!_finalized[key], "MockRandomStaking: already finalized");
        _finalized[key] = true;

        _revealed[key] = (1 << _n[key]) - 1;
        _seed[key] = seed;

        address token = _cohortToken[key];
        custodied[_bonusTo][token] += _cohortFee[key];

        _notifyCast(_owner[key], key, seed);
    }

    /// @notice Chop an unfinalized cohort: validators who did not reveal forfeit their stake to
    /// the request owner, on top of the owner's fee refund, then deliver `onChop`.
    function chop(bytes32 key, PreimageLocation.Info[] calldata info) external {
        require(!_finalized[key], "MockRandomStaking: already finalized");
        require(_seed[key] == bytes32(0), "MockRandomStaking: already finalized");
        require(keccak256(abi.encode(info)) == key, "MockRandomStaking: info mismatch");

        uint256 withheld = _n[key] - _popcount(_revealed[key]);
        uint256 forfeit = withheld * _price[key];
        address token = _cohortToken[key];
        address owner = _owner[key];

        uint256 payout = _cohortFee[key] + forfeit;
        custodied[owner][token] += payout;

        _finalized[key] = true;

        // Mirror real Random: _reverseCharges credits the owner then delivers onReverse with the EXACT
        // payout (fee refund + withheld stakes), and chop then delivers onChop. Both are swallow-on-revert.
        _notifyReverse(owner, key, token, payout);
        _notifyChop(owner, key);
    }

    /// @notice Test knob: set which validators (by bit index) revealed for `key`.
    function setRevealed(bytes32 key, uint256 mask) external {
        _revealed[key] = mask;
    }

    function handoff(address recipient, address token, int256 amount) external {
        if (recipient == address(0)) recipient = msg.sender;
        if (amount > 0) {
            uint256 want = uint256(amount);
            uint256 bal = custodied[msg.sender][token];
            uint256 send = want < bal ? want : bal;
            custodied[msg.sender][token] -= send;
            token.safeTransfer(recipient, send);
        } else if (amount < 0) {
            // Pull -amount from msg.sender into recipient's custody, crediting the MEASURED receipt
            // (mirrors real Random's _receiveTokens). Measuring the delta — not the requested face
            // amount — is what makes a fee-on-transfer token's second-leg tax observable, so a game
            // that credits the face amount over-counts custody and breaks the custody invariant.
            uint256 before = token.balanceOf(address(this));
            token.safeTransferFrom(msg.sender, address(this), uint256(-amount));
            uint256 received = token.balanceOf(address(this)) - before;
            custodied[recipient][token] += received;
        }
    }

    function pointer(PreimageLocation.Info calldata) external pure override returns (address) {
        return address(0);
    }

    function consumed(PreimageLocation.Info calldata) external pure override returns (bool) {
        return false;
    }

    function latest(address, bool, bool) external pure override returns (bytes32) {
        return bytes32(0);
    }

    function randomness(bytes32 key) external view override returns (Randomness memory r) {
        r.owner = _owner[key];
        r.seed = _seed[key];
    }

    /// @dev Deliver `onCast` via a raw low-level call, matching real Random: a broken consumer's
    /// revert is swallowed, not bubbled, so it can never claw back the custody credit Random
    /// already booked. A raw call to an address with no code (e.g. a bare test address) trivially
    /// succeeds, so this needs no code-length branch.
    function _notifyCast(address owner, bytes32 key, bytes32 seed) internal {
        (bool ok, ) = owner.call(abi.encodeWithSelector(ConsumerReceiver.onCast.selector, key, seed));
        if (!ok) emit FailedToCall(key, owner, ConsumerReceiver.onCast.selector);
    }

    /// @dev See `_notifyCast`; same swallow-on-revert semantics for `onChop`.
    function _notifyChop(address owner, bytes32 key) internal {
        (bool ok, ) = owner.call(abi.encodeWithSelector(ConsumerReceiver.onChop.selector, key));
        if (!ok) emit FailedToCall(key, owner, ConsumerReceiver.onChop.selector);
    }

    /// @dev See `_notifyCast`; delivers `onReverse(key, token, amount)` with the exact reversed credit,
    /// swallow-on-revert like real Random's _reverseCharges callback.
    function _notifyReverse(address owner, bytes32 key, address token, uint256 amount) internal {
        (bool ok, ) = owner.call(abi.encodeWithSelector(ConsumerReceiver.onReverse.selector, key, token, amount));
        if (!ok) emit FailedToCall(key, owner, ConsumerReceiver.onReverse.selector);
    }

    function _popcount(uint256 mask) internal pure returns (uint256 count) {
        unchecked {
            while (mask != 0) {
                count += mask & 1;
                mask >>= 1;
            }
        }
    }
}
