// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {FlipBookX} from "../../contracts/games/FlipBookX.sol";
import {MockX402, Mock1271Wallet} from "../../contracts/test/MockX402.sol";

/// Coverage-gap closer for FlipBookX._pull's `sig.length == 65` else arm (the EIP-7598 `bytes`
/// overload for ERC-1271 / smart-account signers). FlipBookX.t.sol already has ONE passing case
/// through this arm (test_erc1271Maker_bytesSignaturePath, a 64-byte payload for the MAKER side),
/// but forge's `--ir-minimum` branch accounting never registers a hit for the else arm's OWN
/// branch node even though the underlying line/statement DOES show a real hit from that existing
/// test (confirmed by `forge coverage --report debug`) — the same class of instrumentation
/// artifact seen on the other four targets in this pass (a real bytecode path whose specific
/// counter node the tool doesn't wire up, not a genuine test gap). This file still adds real
/// value: it exercises the ERC-1271 `bytes` path from the angles the existing suite doesn't
/// reach — the TAKER side (existing suite only tries it for the maker), and the FAILURE case
/// (existing suite only has the success case) — pinning exact revert behavior, not just "it works
/// once."
contract FlipBookXCovTest is Test {
    MockX402 internal token;
    FlipBookX internal book;

    uint256 internal makerKey = 0xA11CE;
    address internal maker;
    address internal crank;

    uint256 internal constant STAKE = 10e18;
    uint256 internal constant MAKER_BOND = 2e18;
    uint256 internal constant TAKER_BOND = 1e18;
    uint32 internal constant W1 = 3600;
    uint32 internal constant W2 = 1800;
    bytes32 internal constant SALT = keccak256("cov-maker-salt");
    bytes32 internal constant SALT2 = keccak256("cov-taker-salt");

    bytes32 internal constant RECEIVE_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    function setUp() public {
        token = new MockX402();
        book = new FlipBookX(address(token));
        maker = vm.addr(makerKey);
        crank = vm.addr(0xC4A2);
        vm.warp(1_000_000);
    }

    function _offer(bool choice, address makerAddr) internal view returns (FlipBookX.Offer memory o) {
        o = FlipBookX.Offer({
            maker: makerAddr,
            commit: keccak256(abi.encode(makerAddr, choice, SALT)),
            stake: STAKE,
            makerBond: MAKER_BOND,
            takerBond: TAKER_BOND,
            takeDeadline: uint64(block.timestamp + 1 days),
            makerRevealWindow: W1,
            takerRevealWindow: W2
        });
    }

    function _receiveDigest(address from, uint256 value, uint64 validBefore, bytes32 nonce)
        internal
        view
        returns (bytes32)
    {
        bytes32 structHash =
            keccak256(abi.encode(RECEIVE_TYPEHASH, from, address(book), value, uint256(0), validBefore, nonce));
        return keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash));
    }

    function _sign(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    /// The TAKER is the ERC-1271 wallet here (the existing suite's test_erc1271Maker_... only
    /// ever puts the smart-account on the MAKER side) — a distinct call site into `_pull`'s bytes
    /// overload, over the taker's authorization nonce rather than the maker's offer id.
    function test_erc1271Taker_bytesSignaturePath_succeeds() public {
        Mock1271Wallet wallet = new Mock1271Wallet();
        token.mint(maker, 100e18);
        token.mint(address(wallet), 50e18);

        FlipBookX.Offer memory o = _offer(true, maker);
        bytes32 id = book.offerId(o);
        bytes memory makerSig = _sign(makerKey, _receiveDigest(maker, STAKE + MAKER_BOND, o.takeDeadline, id));

        bytes32 gc = keccak256(abi.encode(address(wallet), true, SALT2));
        bytes32 takerNonce = book.takerNonce(id, address(wallet), gc);
        bytes32 takerDigest = _receiveDigest(address(wallet), STAKE + TAKER_BOND, o.takeDeadline, takerNonce);
        wallet.approveDigest(takerDigest);

        bytes memory contractTakerSig = new bytes(64); // any non-65-length payload routes here
        vm.prank(crank);
        book.take(o, makerSig, address(wallet), gc, contractTakerSig);

        assertEq(token.balanceOf(address(book)), 2 * STAKE + MAKER_BOND + TAKER_BOND, "1271 taker escrowed");
    }

    /// The failure case through the SAME bytes overload: a smart-account maker whose wallet
    /// rejects the digest (wrong approval) must revert with the wrapper's own InvalidSignature —
    /// the existing suite only ever exercises the success path through this arm.
    function test_erc1271Maker_bytesSignaturePath_wrongApproval_reverts() public {
        Mock1271Wallet wallet = new Mock1271Wallet();
        token.mint(address(wallet), 50e18);
        token.mint(maker, 50e18); // taker in this test — irrelevant that it's the same address var

        FlipBookX.Offer memory o = _offer(true, address(wallet));
        bytes32 id = book.offerId(o);
        // Approve a DIFFERENT digest than the one `take` will actually present.
        wallet.approveDigest(keccak256("some-other-digest"));

        bytes32 gc = keccak256(abi.encode(maker, true, SALT2));
        bytes memory takerSig = _sign(makerKey, _receiveDigest(maker, STAKE + TAKER_BOND, o.takeDeadline, book.takerNonce(id, maker, gc)));
        bytes memory contractMakerSig = new bytes(64);

        vm.expectRevert(MockX402.InvalidSignature.selector);
        vm.prank(crank);
        book.take(o, contractMakerSig, maker, gc, takerSig);
    }

    /// A garbage-length signature (neither 65 bytes nor a meaningful ERC-1271 payload) still
    /// routes through the bytes overload (any length != 65 does) and must fail closed via the
    /// wrapper's own InvalidSignature — not revert for some unrelated ABI-decoding reason.
    function test_pull_nonEoaLengthSignature_routesToBytesOverload_andFailsClosed() public {
        uint256 takerKey = 0xD00D;
        address takerAddr = vm.addr(takerKey);
        token.mint(maker, 100e18);
        token.mint(takerAddr, 100e18);
        FlipBookX.Offer memory o = _offer(true, maker);
        bytes32 id = book.offerId(o);
        bytes memory garbageSig = new bytes(3); // definitely not 65, not a valid 1271 payload either
        bytes32 gc = keccak256(abi.encode(takerAddr, true, SALT2));
        bytes memory takerSig =
            _sign(takerKey, _receiveDigest(takerAddr, STAKE + TAKER_BOND, o.takeDeadline, book.takerNonce(id, takerAddr, gc)));

        vm.expectRevert(MockX402.InvalidSignature.selector);
        vm.prank(crank);
        book.take(o, garbageSig, takerAddr, gc, takerSig);
    }
}
