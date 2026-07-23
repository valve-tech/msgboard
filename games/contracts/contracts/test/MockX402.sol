// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// Test double for the valve x402 wrapper (ValveWrapperImpl): a minimal ERC20 carrying the exact
/// EIP-3009 + EIP-7598 authorization surface FlipBookX depends on, with the SAME EIP-712 shape
/// (domain name "x402 PLS", version "1", the canonical 3009 typehashes) — so signatures built for
/// this mock are built identically to ones the real deployed wrapper accepts, and the unit suite
/// exercises the true signing path, not a simplified stand-in.
contract MockX402 {
    string public constant name = "x402 PLS";
    string public constant symbol = "x402PLS";
    uint8 public constant decimals = 18;

    bytes32 private constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 private constant CANCEL_AUTHORIZATION_TYPEHASH =
        keccak256("CancelAuthorization(address authorizer,bytes32 nonce)");

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(bytes32 => bool)) public authorizationState;

    error AuthorizationNotYetValid(uint256 validAfter, uint256 nowTs);
    error AuthorizationExpired(uint256 validBefore, uint256 nowTs);
    error AuthorizationAlreadyUsed(address authorizer, bytes32 nonce);
    error CallerMustBePayee(address caller, address payee);
    error InvalidSignature();
    error InsufficientBalance();

    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);
    event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce);
    event Transfer(address indexed from, address indexed to, uint256 value);

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(name)),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    function _digest(bytes32 structHash) private view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));
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
        if (msg.sender != to) revert CallerMustBePayee(msg.sender, to);
        _requireValid(from, validAfter, validBefore, nonce);
        bytes32 digest = _digest(
            keccak256(abi.encode(RECEIVE_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce))
        );
        if (ecrecover(digest, v, r, s) != from) revert InvalidSignature();
        authorizationState[from][nonce] = true;
        emit AuthorizationUsed(from, nonce);
        _transfer(from, to, value);
    }

    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) external {
        if (msg.sender != to) revert CallerMustBePayee(msg.sender, to);
        _requireValid(from, validAfter, validBefore, nonce);
        bytes32 digest = _digest(
            keccak256(abi.encode(RECEIVE_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce))
        );
        if (!_isValidSignatureNow(from, digest, signature)) revert InvalidSignature();
        authorizationState[from][nonce] = true;
        emit AuthorizationUsed(from, nonce);
        _transfer(from, to, value);
    }

    function cancelAuthorization(address authorizer, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external {
        if (authorizationState[authorizer][nonce]) revert AuthorizationAlreadyUsed(authorizer, nonce);
        bytes32 digest = _digest(keccak256(abi.encode(CANCEL_AUTHORIZATION_TYPEHASH, authorizer, nonce)));
        if (ecrecover(digest, v, r, s) != authorizer) revert InvalidSignature();
        authorizationState[authorizer][nonce] = true;
        emit AuthorizationCanceled(authorizer, nonce);
    }

    /// SignatureChecker semantics: contracts verify via ERC-1271, EOAs via ecrecover.
    function _isValidSignatureNow(address signer, bytes32 digest, bytes memory signature) private view returns (bool) {
        if (signer.code.length > 0) {
            (bool ok, bytes memory ret) =
                signer.staticcall(abi.encodeWithSignature("isValidSignature(bytes32,bytes)", digest, signature));
            return ok && ret.length == 32 && abi.decode(ret, (bytes4)) == bytes4(0x1626ba7e);
        }
        if (signature.length != 65) return false;
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(signature, 0x20))
            s := mload(add(signature, 0x40))
            v := byte(0, mload(add(signature, 0x60)))
        }
        return ecrecover(digest, v, r, s) == signer;
    }

    function _requireValid(address from, uint256 validAfter, uint256 validBefore, bytes32 nonce) private view {
        if (block.timestamp <= validAfter) revert AuthorizationNotYetValid(validAfter, block.timestamp);
        if (block.timestamp >= validBefore) revert AuthorizationExpired(validBefore, block.timestamp);
        if (authorizationState[from][nonce]) revert AuthorizationAlreadyUsed(from, nonce);
    }

    function _transfer(address from, address to, uint256 value) private {
        if (balanceOf[from] < value) revert InsufficientBalance();
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }
}

/// A minimal ERC-1271 wallet for the 7598/Safe path: approves exactly one digest at a time.
contract Mock1271Wallet {
    bytes32 public approvedDigest;

    function approveDigest(bytes32 digest) external {
        approvedDigest = digest;
    }

    function isValidSignature(bytes32 digest, bytes memory) external view returns (bytes4) {
        return digest == approvedDigest ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}
