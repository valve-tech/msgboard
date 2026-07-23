// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {FlipBookX} from "../../contracts/games/FlipBookX.sol";

interface IX402Full {
    function wrap() external payable;
    function balanceOf(address) external view returns (uint256);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) external;
}

/// Integration against the REAL deployed x402PLS wrapper (same address on 943 and 369, but
/// DIFFERENT impl builds — 943 predates `version()`), on a fork. Proves the actual EIP-712
/// domain, the payee-only receive, nonce burning, and — the open question — which authorization
/// overloads each chain's build supports. Skips cleanly when FORK_RPC is unset, so the default
/// suite is unaffected. Run:
///   FORK_RPC=https://games.msgboard.xyz/rpc/evm/943 forge test --match-path 'test/foundry/FlipBookXFork.t.sol' -vv
contract FlipBookXForkTest is Test {
    address internal constant X402PLS = 0xeb274050cb029288B8A4F232Da8d23F393d54A1E;

    IX402Full internal token;
    FlipBookX internal book;
    bool internal forked;

    uint256 internal makerKey = 0xA11CE;
    uint256 internal takerKey = 0xB0B;
    address internal maker;
    address internal taker;

    uint256 internal constant STAKE = 1e18;
    uint256 internal constant BOND = 2e17;
    bytes32 internal constant SALT = keccak256("fork-maker-salt");
    bytes32 internal constant SALT2 = keccak256("fork-taker-salt");
    bytes32 internal constant RECEIVE_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    function setUp() public {
        string memory rpc = vm.envOr("FORK_RPC", string(""));
        if (bytes(rpc).length == 0) return; // not a fork run — every test self-skips
        vm.createSelectFork(rpc);
        forked = true;

        token = IX402Full(X402PLS);
        book = new FlipBookX(X402PLS);
        maker = vm.addr(makerKey);
        taker = vm.addr(takerKey);
        // Real wrap path: native PLS in, wrapper tokens out — exactly what players will do.
        vm.deal(maker, 100e18);
        vm.deal(taker, 100e18);
        vm.prank(maker);
        token.wrap{value: 10e18}();
        vm.prank(taker);
        token.wrap{value: 10e18}();
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

    /// The full variant-B cycle against the real wrapper: signed offer → take pulls both escrows →
    /// two-phase reveal → winner paid, zero dust. This is the production path end to end.
    function test_fork_fullFlip_realWrapper() public {
        if (!forked) return;
        FlipBookX.Offer memory o = FlipBookX.Offer({
            maker: maker,
            commit: keccak256(abi.encode(maker, true, SALT)),
            stake: STAKE,
            makerBond: BOND,
            takerBond: BOND,
            takeDeadline: uint64(block.timestamp + 1 days),
            makerRevealWindow: 3600,
            takerRevealWindow: 3600
        });
        bytes32 id = book.offerId(o);
        bytes memory makerSig = _sign(makerKey, _receiveDigest(maker, STAKE + BOND, o.takeDeadline, id));
        bytes memory takerSig =
            _sign(takerKey, _receiveDigest(taker, STAKE + BOND, o.takeDeadline, book.takerNonce(id, taker)));
        bytes32 guessCommit = keccak256(abi.encode(taker, true, SALT2));

        uint256 m0 = token.balanceOf(maker);
        uint256 t0 = token.balanceOf(taker);
        book.take(o, makerSig, taker, guessCommit, takerSig);
        assertEq(token.balanceOf(address(book)), 2 * STAKE + 2 * BOND, "escrows locked on the REAL wrapper");

        book.revealChoice(id, true, SALT);
        book.revealGuess(id, true, SALT2); // guess == choice → taker wins
        assertEq(token.balanceOf(taker), t0 + STAKE, "taker nets +stake");
        assertEq(token.balanceOf(maker), m0 - STAKE, "maker nets -stake");
        assertEq(token.balanceOf(address(book)), 0, "no dust on the real wrapper");
    }

    /// Replay of a settled offer must die at the wrapper's burned nonce.
    function test_fork_replayBurnedByWrapper() public {
        if (!forked) return;
        FlipBookX.Offer memory o = FlipBookX.Offer({
            maker: maker,
            commit: keccak256(abi.encode(maker, false, SALT)),
            stake: STAKE,
            makerBond: BOND,
            takerBond: BOND,
            takeDeadline: uint64(block.timestamp + 1 days),
            makerRevealWindow: 3600,
            takerRevealWindow: 3600
        });
        bytes32 id = book.offerId(o);
        bytes memory makerSig = _sign(makerKey, _receiveDigest(maker, STAKE + BOND, o.takeDeadline, id));
        bytes memory takerSig =
            _sign(takerKey, _receiveDigest(taker, STAKE + BOND, o.takeDeadline, book.takerNonce(id, taker)));
        bytes32 gc = keccak256(abi.encode(taker, false, SALT2));

        book.take(o, makerSig, taker, gc, takerSig);
        book.revealChoice(id, false, SALT);
        book.revealGuess(id, false, SALT2);

        vm.expectRevert(); // AuthorizationAlreadyUsed on the real wrapper
        book.take(o, makerSig, taker, gc, takerSig);
    }

    /// THE probe: does this chain's wrapper build carry the EIP-7598 `bytes` overload? (943 runs
    /// an older impl than 369's v1.) Informational on 943, asserted on 369.
    function test_fork_probe7598BytesOverload() public {
        if (!forked) return;
        bytes32 nonce = keccak256("probe-7598");
        uint64 validBefore = uint64(block.timestamp + 1 hours);
        bytes32 structHash =
            keccak256(abi.encode(RECEIVE_TYPEHASH, maker, address(this), STAKE, uint256(0), validBefore, nonce));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash));
        bytes memory sig = _sign(makerKey, digest);

        // payee-only: this test contract is `to`, so it must be the caller.
        try token.receiveWithAuthorization(maker, address(this), STAKE, 0, validBefore, nonce, sig) {
            emit log_named_uint("7598 bytes overload SUPPORTED on chain", block.chainid);
        } catch {
            emit log_named_uint("7598 bytes overload MISSING on chain", block.chainid);
            // v1 (369) must have it; the older 943 build is allowed to lack it (FlipBookX routes
            // 65-byte EOA signatures through the (v,r,s) overload there).
            assertTrue(block.chainid != 369, "v1 wrapper must support the 7598 bytes overload");
        }
    }
}
