// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// @notice A minimal x402-shaped ERC-20 mock (same EIP-3009 `ReceiveWithAuthorization` surface as
/// MockX402) whose `transfer` can be armed to re-enter an arbitrary target+calldata mid-transfer.
///
/// This replaces the OLD native-PLS reentrancy vector the pre-x402 ZkTable exercised via
/// `ReenteringReceiver.receive()`: a native `forceSafeTransferETH` payout invoked the recipient's
/// `receive()` hook, so a malicious PLAYER contract could re-enter on its own payout. Payouts now
/// move via `SafeTransferLib.safeTransfer` — a plain ERC-20 `transfer` call — which NEVER invokes
/// the recipient's code at all (no hook, no callback), so that exact vector is closed by
/// construction, not by a guard. The genuinely analogous threat under the x402 model is a
/// MALICIOUS ESCROW TOKEN whose own `transfer` implementation re-enters ZkTable — this contract
/// models that instead, proving the SAME CEI property (status flips to Settled and escrow zeroes
/// out BEFORE any transfer — see ZkTable.sol's `_payout`) still holds against a hostile token, not
/// just a hostile receiver.
contract ReenteringToken {
    string public constant name = 'ReenteringToken';
    string public constant symbol = 'RTK';
    uint8 public constant decimals = 18;

    bytes32 private constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        'ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)'
    );

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => mapping(bytes32 => bool)) public authorizationState;

    address public reenterTarget;
    bytes public reenterData;
    bool public armed;
    uint256 public reentryCalls;
    bool public lastReentryReverted;
    /// @notice Raw returndata (or revert reason) from the last armed re-entry call, so callers can
    /// assert on the SPECIFIC revert selector (e.g. GameEscrow.UnknownBet) rather than just the
    /// success/failure boolean — a boolean alone can't distinguish "blocked for the right reason"
    /// from "blocked for an unrelated, confounding reason".
    bytes public lastReentryReturnData;

    error InvalidSignature();
    error AuthorizationAlreadyUsed();
    error InsufficientBalance();

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'),
                keccak256(bytes(name)),
                keccak256(bytes('1')),
                block.chainid,
                address(this)
            )
        );
    }

    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        validAfter; validBefore; // unused (this mock never expires — kept for signature parity)
        if (authorizationState[from][nonce]) revert AuthorizationAlreadyUsed();
        bytes32 digest = keccak256(
            abi.encodePacked(
                '\x19\x01',
                DOMAIN_SEPARATOR(),
                keccak256(abi.encode(RECEIVE_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce))
            )
        );
        if (ecrecover(digest, v, r, s) != from) revert InvalidSignature();
        authorizationState[from][nonce] = true;
        _transfer(from, to, value);
    }

    /// Arms a ONE-SHOT re-entry: the next `transfer` call will attempt `target.call(data)` before
    /// completing the transfer's own accounting, then disarm regardless of outcome.
    function arm(address target, bytes calldata data) external {
        reenterTarget = target;
        reenterData = data;
        armed = true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        if (armed) {
            armed = false; // single-shot: never recurse indefinitely
            reentryCalls += 1;
            (bool ok, bytes memory ret) = reenterTarget.call(reenterData);
            lastReentryReverted = !ok;
            lastReentryReturnData = ret;
        }
        _transfer(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        return true;
    }

    /// Same one-shot armed-reentry behavior as `transfer`, but on the PULL leg (`transferFrom`) —
    /// the vector a caller like GameEscrow's `_pullVerified` (which pulls via `safeTransferFrom`)
    /// actually exercises.
    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        if (armed) {
            armed = false; // single-shot: never recurse indefinitely
            reentryCalls += 1;
            (bool ok, bytes memory ret) = reenterTarget.call(reenterData);
            lastReentryReverted = !ok;
            lastReentryReturnData = ret;
        }
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            allowance[from][msg.sender] = allowed - value;
        }
        _transfer(from, to, value);
        return true;
    }

    function _transfer(address from, address to, uint256 value) internal {
        if (balanceOf[from] < value) revert InsufficientBalance();
        balanceOf[from] -= value;
        balanceOf[to] += value;
    }
}
