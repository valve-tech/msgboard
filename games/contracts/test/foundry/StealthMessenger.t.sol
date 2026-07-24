// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {StealthMessenger} from "../../contracts/messaging/StealthMessenger.sol";

contract StealthMessengerTest is Test {
    StealthMessenger internal m;

    uint256 internal pkSender = 0xA11CE;
    uint256 internal pkOther = 0xB0B;
    address internal sender;
    address internal other;

    // A representative announcement. The contract treats these as opaque; the real ERC-5564
    // derivation lives + is round-trip-proven in packages/ui/src/lib/stealth.test.ts.
    uint256 internal constant SCHEME_ID = 1;
    address internal stealthAddr = address(uint160(uint256(keccak256("stealth-address"))));
    // a 33-byte compressed secp256k1 ephemeral pubkey (arbitrary bytes; hashed on-chain)
    bytes internal ephemeralPubKey = hex"0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
    bytes1 internal viewTag = 0x7f;
    bytes internal ciphertext = hex"cafebabefeedface0011223344556677";
    // a 66-byte compressed meta-address (spendingPub 33 ‖ viewingPub 33)
    bytes internal metaAddress =
        hex"0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
        hex"02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";

    event MessageSent(
        uint256 indexed schemeId,
        address indexed stealthAddress,
        address indexed sender,
        bytes ephemeralPubKey,
        bytes1 viewTag,
        bytes ciphertext
    );
    event StealthMetaAddressSet(address indexed registrant, uint256 schemeId, bytes stealthMetaAddress);

    function setUp() public {
        m = new StealthMessenger();
        sender = vm.addr(pkSender);
        other = vm.addr(pkOther);
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    // ── send: sender-sig recovery + event ─────────────────────────────────────────────────────

    /// A valid signature over the exact payload recovers `sender` and emits the announcement with
    /// all fields intact (schemeId/stealthAddress/sender indexed; ephemeralPubKey/viewTag/ct data).
    function test_sendRecoversSenderAndEmits() public {
        bytes memory sig =
            _sign(pkSender, m.messageDigest(SCHEME_ID, sender, stealthAddr, ephemeralPubKey, viewTag, ciphertext));
        vm.expectEmit(true, true, true, true, address(m));
        emit MessageSent(SCHEME_ID, stealthAddr, sender, ephemeralPubKey, viewTag, ciphertext);
        m.sendMessage(SCHEME_ID, sender, stealthAddr, ephemeralPubKey, viewTag, ciphertext, sig);
    }

    /// Anyone may relay (msg.sender ≠ sender); authenticity comes from the signature, not the tx origin.
    function test_sendRelayedByThirdPartyStillAuthenticatesSender() public {
        bytes memory sig =
            _sign(pkSender, m.messageDigest(SCHEME_ID, sender, stealthAddr, ephemeralPubKey, viewTag, ciphertext));
        vm.expectEmit(true, true, true, true, address(m));
        emit MessageSent(SCHEME_ID, stealthAddr, sender, ephemeralPubKey, viewTag, ciphertext);
        vm.prank(other); // a relayer submits it
        m.sendMessage(SCHEME_ID, sender, stealthAddr, ephemeralPubKey, viewTag, ciphertext, sig);
    }

    /// Tampering the ciphertext after signing changes the digest, so recovery no longer yields
    /// `sender` → revert. (Any field tamper behaves identically; ciphertext is representative.)
    function test_sendRejectsTamperedCiphertext() public {
        bytes memory sig =
            _sign(pkSender, m.messageDigest(SCHEME_ID, sender, stealthAddr, ephemeralPubKey, viewTag, ciphertext));
        bytes memory tampered = hex"cafebabefeedface0011223344556678"; // last byte flipped
        vm.expectRevert(StealthMessenger.BadSig.selector);
        m.sendMessage(SCHEME_ID, sender, stealthAddr, ephemeralPubKey, viewTag, tampered, sig);
    }

    /// Tampering the view tag also breaks recovery.
    function test_sendRejectsTamperedViewTag() public {
        bytes memory sig =
            _sign(pkSender, m.messageDigest(SCHEME_ID, sender, stealthAddr, ephemeralPubKey, viewTag, ciphertext));
        vm.expectRevert(StealthMessenger.BadSig.selector);
        m.sendMessage(SCHEME_ID, sender, stealthAddr, ephemeralPubKey, bytes1(0x00), ciphertext, sig);
    }

    /// Claiming a `sender` you don't hold the key for fails: a signature by `other` cannot
    /// authenticate a message that names `sender`.
    function test_sendRejectsClaimedSenderMismatch() public {
        bytes memory sig =
            _sign(pkOther, m.messageDigest(SCHEME_ID, sender, stealthAddr, ephemeralPubKey, viewTag, ciphertext));
        vm.expectRevert(StealthMessenger.BadSig.selector);
        m.sendMessage(SCHEME_ID, sender, stealthAddr, ephemeralPubKey, viewTag, ciphertext, sig);
    }

    // ── registry: set / get ───────────────────────────────────────────────────────────────────

    function test_registerSetsAndGets() public {
        vm.expectEmit(true, false, false, true, address(m));
        emit StealthMetaAddressSet(sender, 1, metaAddress);
        vm.prank(sender);
        m.registerStealthMetaAddress(metaAddress);
        assertEq(m.stealthMetaAddressOf(sender), metaAddress);
    }

    function test_registerRejectsEmpty() public {
        vm.prank(sender);
        vm.expectRevert(StealthMessenger.EmptyMetaAddress.selector);
        m.registerStealthMetaAddress("");
    }

    // ── registry: on-behalf (EIP-712) ─────────────────────────────────────────────────────────

    function test_registerOnBehalf() public {
        bytes memory sig = _sign(pkSender, m.registrationDigest(sender, metaAddress));
        // relayed by this contract (address(this)), authorized by `sender`'s signature
        vm.expectEmit(true, false, false, true, address(m));
        emit StealthMetaAddressSet(sender, 1, metaAddress);
        m.registerStealthMetaAddressOnBehalf(sender, metaAddress, sig);
        assertEq(m.stealthMetaAddressOf(sender), metaAddress);
        assertEq(m.nonces(sender), 1);
    }

    function test_registerOnBehalfRejectsBadSig() public {
        bytes memory sig = _sign(pkOther, m.registrationDigest(sender, metaAddress)); // wrong signer
        vm.expectRevert(StealthMessenger.BadSig.selector);
        m.registerStealthMetaAddressOnBehalf(sender, metaAddress, sig);
    }

    /// The nonce advances, so a captured on-behalf signature cannot be replayed to overwrite a later
    /// meta-address.
    function test_registerOnBehalfReplayRejected() public {
        bytes memory sig = _sign(pkSender, m.registrationDigest(sender, metaAddress));
        m.registerStealthMetaAddressOnBehalf(sender, metaAddress, sig);
        vm.expectRevert(StealthMessenger.BadSig.selector); // nonce is now 1; old digest no longer valid
        m.registerStealthMetaAddressOnBehalf(sender, metaAddress, sig);
    }
}
