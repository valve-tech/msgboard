// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ZkTable} from "../../contracts/zk/ZkTable.sol";
import {ChannelState} from "../../contracts/zk/ChannelState.sol";
import {IGameRules} from "../../contracts/zk/IGameRules.sol";
import {MockGameRules} from "../../contracts/test/MockGameRules.sol";
import {IX402Token} from "../../contracts/games/FlipBookX.sol";
import {X402AuthLib} from "./X402AuthLib.sol";

interface IX402Full {
    function wrap() external payable;
    function balanceOf(address) external view returns (uint256);
    function decimals() external view returns (uint8);
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

/// Integration against the REAL deployed x402 wrappers + the real ValveWrapperFactory on 369
/// mainnet, mirroring FlipBookXFork.t.sol's self-skip / sign-vs-real-domain pattern (see that
/// file's header). Proves the full create -> join -> topUp -> settle cycle end to end on BOTH an
/// 18-decimal wrapper (x402PLS) and a 6-decimal wrapper (x402USDC) with ZERO dust left in the
/// escrow, decimals-agnostic; that replay dies at the REAL wrapper's burned nonce; that a
/// tampered term dies at the REAL wrapper's InvalidSignature; and that every call is submitted by
/// a THIRD, separate relayer key — neither the maker nor the taker ever sends a transaction.
///
/// Skips cleanly when FORK_RPC is unset, so the default suite is unaffected. Run:
///   FORK_RPC=https://games.msgboard.xyz/rpc/evm/369 forge test --match-path 'test/foundry/ZkTableX402Fork.t.sol' -vv
///
/// Deploy note: ZkTable link-references the external ShowdownDecodeLib library. `new ZkTable(...)`
/// from Solidity source auto-links it exactly as the non-fork ZkTable*.t.sol suites already do
/// (forge resolves + deploys external library references at contract-creation time regardless of
/// whether the surrounding state is forked) — no extra linking step needed here.
contract ZkTableX402ForkTest is Test {
    address internal constant X402PLS = 0xeb274050cb029288B8A4F232Da8d23F393d54A1E;
    address internal constant X402USDC = 0x33D3BBF903D3E85973aF93d55CDeA7C1523e607B;
    /// The real ValveWrapperFactory on 369 mainnet.
    address internal constant FACTORY = 0xB10A088ea04B261371Edc9Fe9e6121B8355aDe70;

    ZkTable internal zk;
    MockGameRules internal rules;
    bool internal forked;

    uint256 internal makerKey = 0xA11CE;
    uint256 internal takerKey = 0xB0B;
    uint256 internal relayerKey = 0xC0FFEE; // a THIRD key — never a table seat
    address internal maker;
    address internal taker;
    address internal relayer;

    uint64 internal constant CLOCK = 30;
    uint256[2] internal ZERO_DECK = [uint256(0), uint256(0)];

    function setUp() public {
        string memory rpc = vm.envOr("FORK_RPC", string(""));
        if (bytes(rpc).length == 0) return; // not a fork run — every test self-skips
        vm.createSelectFork(rpc);
        forked = true;

        zk = new ZkTable(FACTORY);
        rules = new MockGameRules();
        maker = vm.addr(makerKey);
        taker = vm.addr(takerKey);
        relayer = vm.addr(relayerKey);
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    function _authFor(IX402Full token, uint256 pk, address from, uint256 value, uint64 validBefore, bytes32 nonce)
        internal
        returns (ZkTable.DepositAuth memory)
    {
        bytes32 digest = X402AuthLib.receiveDigest(token.DOMAIN_SEPARATOR(), from, address(zk), value, validBefore, nonce);
        return ZkTable.DepositAuth({from: from, validBefore: validBefore, salt: bytes32(0), sig: X402AuthLib.sign65(pk, digest)});
    }

    /// Full cycle against a given REAL wrapper: create -> join -> topUp -> settle, submitted
    /// entirely by `relayer` (neither maker nor taker ever sends a transaction). Asserts ZERO
    /// dust left on the real wrapper's escrow balance for this contract at the end — decimals
    /// never enter the assertion (it's exact-unit conservation, proving decimals-agnosticism).
    function _fullCycle(IX402Full token, uint256 buyIn, uint256 stake, uint256 topUpAmt) internal {
        IGameRules r = IGameRules(address(rules));
        uint64 validBefore = uint64(block.timestamp + 1 days);

        bytes32 cNonce = zk.createNonce(maker, IX402Token(address(token)), r, buyIn, stake, CLOCK, address(0), ZERO_DECK, bytes32(0));
        ZkTable.DepositAuth memory cAuth = _authFor(token, makerKey, maker, buyIn, validBefore, cNonce);
        vm.prank(relayer);
        bytes32 tableId = zk.create(IX402Token(address(token)), buyIn, r, stake, CLOCK, address(0), ZERO_DECK, cAuth);

        bytes32 jNonce = zk.joinNonce(tableId, taker, address(0), ZERO_DECK);
        ZkTable.DepositAuth memory jAuth = _authFor(token, takerKey, taker, stake, validBefore, jNonce);
        vm.prank(relayer);
        zk.join(tableId, address(0), ZERO_DECK, jAuth);

        if (topUpAmt > 0) {
            bytes32 tNonce = zk.topUpNonce(tableId, maker, topUpAmt, bytes32(0));
            ZkTable.DepositAuth memory tAuth = _authFor(token, makerKey, maker, topUpAmt, validBefore, tNonce);
            vm.prank(relayer);
            zk.topUp(tableId, topUpAmt, tAuth);
        }

        uint256 total = buyIn + stake + topUpAmt;
        ChannelState memory s;
        s.tableId = tableId;
        s.nonce = 1;
        s.balanceA = total / 3; // an uneven split so a rounding/decimals bug can't hide
        s.balanceB = total - s.balanceA;
        s.pot = 0;
        s.phase = 1;
        bytes32 digest = zk.stateDigest(s);
        (uint8 v1, bytes32 r1, bytes32 sg1) = vm.sign(makerKey, digest);
        (uint8 v2, bytes32 r2, bytes32 sg2) = vm.sign(takerKey, digest);
        bytes memory sigA = abi.encodePacked(r1, sg1, v1);
        bytes memory sigB = abi.encodePacked(r2, sg2, v2);

        uint256 makerBefore = token.balanceOf(maker);
        uint256 takerBefore = token.balanceOf(taker);
        vm.prank(relayer);
        zk.settle(tableId, s, sigA, sigB);

        assertEq(token.balanceOf(maker) - makerBefore, s.balanceA, "maker paid exactly its co-signed balance");
        assertEq(token.balanceOf(taker) - takerBefore, s.balanceB, "taker paid exactly its co-signed balance");
        assertEq(token.balanceOf(address(zk)), 0, "ZERO dust left on the real wrapper");
    }

    /// x402PLS (18 decimals): real `wrap{value}()`, sign against the real DOMAIN_SEPARATOR, full
    /// cycle through the real ValveWrapperFactory clone-check.
    function test_fork_fullCycle_x402PLS_zeroDust() public {
        if (!forked) return;
        IX402Full token = IX402Full(X402PLS);
        assertEq(token.decimals(), 18, "sanity: x402PLS is 18-decimal");
        vm.deal(maker, 100e18);
        vm.deal(taker, 100e18);
        vm.prank(maker);
        token.wrap{value: 10e18}();
        vm.prank(taker);
        token.wrap{value: 10e18}();

        _fullCycle(token, 1e18, 1e18, 0.5e18);
    }

    /// x402USDC (6 decimals): players funded via forge-std's `deal` (stdstore — this wrapper has
    /// no ETH-backed `wrap()`, so minting directly into its balance mapping is the only way to
    /// get test funds). Identical full cycle to the PLS case, exact-unit amounts, proving the
    /// escrow/nonce/payout machinery is decimals-agnostic.
    function test_fork_fullCycle_x402USDC_6decimals_zeroDust() public {
        if (!forked) return;
        IX402Full token = IX402Full(X402USDC);
        assertEq(token.decimals(), 6, "sanity: x402USDC is 6-decimal");
        uint256 amt = 25_000000; // 25.000000 (6dp)
        deal(X402USDC, maker, amt * 3);
        deal(X402USDC, taker, amt * 3);

        _fullCycle(token, amt, amt, amt / 2);
    }

    /// Replay of an executed create authorization dies at the REAL wrapper's burned nonce.
    function test_fork_replay_diesAtRealWrapperBurnedNonce() public {
        if (!forked) return;
        IX402Full token = IX402Full(X402PLS);
        vm.deal(maker, 10e18);
        vm.prank(maker);
        token.wrap{value: 5e18}();

        IGameRules r = IGameRules(address(rules));
        uint64 validBefore = uint64(block.timestamp + 1 days);
        bytes32 nonce = zk.createNonce(maker, IX402Token(address(token)), r, 1e18, 1e18, CLOCK, address(0), ZERO_DECK, bytes32(0));
        ZkTable.DepositAuth memory auth = _authFor(token, makerKey, maker, 1e18, validBefore, nonce);

        vm.prank(relayer);
        zk.create(IX402Token(address(token)), 1e18, r, 1e18, CLOCK, address(0), ZERO_DECK, auth);

        vm.prank(relayer);
        vm.expectRevert(); // the real wrapper's AuthorizationAlreadyUsed
        zk.create(IX402Token(address(token)), 1e18, r, 1e18, CLOCK, address(0), ZERO_DECK, auth);
    }

    /// A relayer that flips `channelKey` between signing and submission dies at the REAL
    /// wrapper's InvalidSignature (the seat-hijack closure, proven against production code).
    function test_fork_tamper_channelKey_diesAtRealWrapperInvalidSignature() public {
        if (!forked) return;
        IX402Full token = IX402Full(X402PLS);
        vm.deal(maker, 10e18);
        vm.prank(maker);
        token.wrap{value: 5e18}();

        IGameRules r = IGameRules(address(rules));
        uint64 validBefore = uint64(block.timestamp + 1 days);
        // Signed for channelKey == address(0)...
        bytes32 nonce = zk.createNonce(maker, IX402Token(address(token)), r, 1e18, 1e18, CLOCK, address(0), ZERO_DECK, bytes32(0));
        ZkTable.DepositAuth memory auth = _authFor(token, makerKey, maker, 1e18, validBefore, nonce);

        vm.prank(relayer);
        vm.expectRevert(); // ...but submitted with a DIFFERENT channelKey => different nonce => InvalidSignature
        zk.create(IX402Token(address(token)), 1e18, r, 1e18, CLOCK, /* tampered */ taker, ZERO_DECK, auth);
    }
}
