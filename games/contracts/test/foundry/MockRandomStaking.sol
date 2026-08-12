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
        _revealed[key] = (1 << _n[key]) - 1;
        _seed[key] = seed;

        address token = _cohortToken[key];
        custodied[_bonusTo][token] += _cohortFee[key];

        _notifyCast(_owner[key], key, seed);
    }

    /// @notice Chop an unfinalized cohort: validators who did not reveal forfeit their stake to
    /// the request owner, on top of the owner's fee refund, then deliver `onChop`.
    function chop(bytes32 key, PreimageLocation.Info[] calldata info) external {
        require(_seed[key] == bytes32(0), "MockRandomStaking: already finalized");
        require(keccak256(abi.encode(info)) == key, "MockRandomStaking: info mismatch");

        uint256 withheld = _n[key] - _popcount(_revealed[key]);
        uint256 forfeit = withheld * _price[key];
        address token = _cohortToken[key];
        address owner = _owner[key];

        custodied[owner][token] += _cohortFee[key] + forfeit;

        _notifyChop(owner, key);
    }

    /// @notice Test knob: set which validators (by bit index) revealed for `key`.
    function setRevealed(bytes32 key, uint256 mask) external {
        _revealed[key] = mask;
    }

    function handoff(address recipient, address token, int256 amount) external {
        if (amount > 0) {
            uint256 want = uint256(amount);
            uint256 bal = custodied[msg.sender][token];
            uint256 send = want < bal ? want : bal;
            custodied[msg.sender][token] -= send;
            token.safeTransfer(recipient, send);
        } else if (amount < 0) {
            uint256 pull = uint256(-amount);
            token.safeTransferFrom(msg.sender, address(this), pull);
            custodied[recipient][token] += pull;
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

    /// @dev Deliver `onCast` through the real interface when `owner` has code (so a genuine
    /// ConsumerReceiver reverts propagate), and skip the call for a plain test address with no
    /// code (a Solidity interface call always reverts against an address with no code, even
    /// though a raw EVM call to an EOA succeeds trivially).
    function _notifyCast(address owner, bytes32 key, bytes32 seed) internal {
        if (owner.code.length > 0) ConsumerReceiver(owner).onCast(key, seed);
    }

    /// @dev See `_notifyCast`; same leniency for `onChop`.
    function _notifyChop(address owner, bytes32 key) internal {
        if (owner.code.length > 0) ConsumerReceiver(owner).onChop(key);
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
