// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {HoldemTableN} from "../../contracts/zk/HoldemTableN.sol";
import {ChannelTableBase} from "../../contracts/zk/ChannelTableBase.sol";
import {ChannelStateN, SidePot} from "../../contracts/zk/ChannelStateN.sol";
import {IGameRulesN} from "../../contracts/zk/IGameRulesN.sol";
import {MockGameRulesN} from "../../contracts/test/MockGameRulesN.sol";
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
/// mainnet, mirroring ZkTableX402Fork.t.sol's self-skip / sign-vs-real-domain pattern (see that
/// file's header) — the N-party sibling. Proves the full create -> join -> join -> start ->
/// settle cycle end to end for a 3-seat table with rake, on BOTH an 18-decimal wrapper (x402PLS)
/// and a 6-decimal wrapper (x402USDC) with ZERO dust left in the escrow, decimals-agnostic; that
/// replay dies at the REAL wrapper's burned nonce; that a tampered term dies at the REAL
/// wrapper's InvalidSignature; and that every DEPOSIT (create/join) and the final settle are
/// submitted by a FOURTH, separate relayer key — none of the three seated players ever sends a
/// deposit or settlement transaction. `start()` stays seat-gated by design (identity
/// load-bearing, not a deposit path — see HoldemTableN.sol's header), so it alone is submitted
/// by seat A.
///
/// Skips cleanly when FORK_RPC is unset, so the default suite is unaffected. Run:
///   FORK_RPC=https://games.msgboard.xyz/rpc/evm/369 forge test --match-path 'test/foundry/HoldemTableNX402Fork.t.sol' -vv
///
/// Deploy note: HoldemTableN does NOT link any external library (unlike ZkTable's
/// ShowdownDecodeLib) — `new HoldemTableN(...)` needs no linking step at all, fork or otherwise.
contract HoldemTableNX402ForkTest is Test {
    address internal constant X402PLS = 0xeb274050cb029288B8A4F232Da8d23F393d54A1E;
    address internal constant X402USDC = 0x33D3BBF903D3E85973aF93d55CDeA7C1523e607B;
    /// The real ValveWrapperFactory on 369 mainnet.
    address internal constant FACTORY = 0xB10A088ea04B261371Edc9Fe9e6121B8355aDe70;

    HoldemTableN internal zk;
    MockGameRulesN internal rules;
    bool internal forked;

    uint256 internal seatAKey = 0xA11CE;
    uint256 internal seatBKey = 0xB0B;
    uint256 internal seatCKey = 0xC0FFEE;
    uint256 internal relayerKey = 0xD00DFEED; // a FOURTH key — never a table seat
    address internal seatA;
    address internal seatB;
    address internal seatC;
    address internal relayer;
    address internal treasury = address(0xFACE);

    uint64 internal constant CLOCK = 30;
    // HoldemTableN validates every deck key is on-curve (Option B hardening) — unlike ZkTable,
    // (0,0) is rejected with BadDeckKey, so this suite needs a real on-curve point. Reusing the
    // same generator point for every seat is fine: HoldemTableN has no deck-key collision check
    // (only wallet/channelKey identity collisions are rejected).
    uint256 internal constant GX = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798;
    uint256 internal constant GY = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8;
    uint256[2] internal DECK_KEY = [GX, GY];

    function setUp() public {
        string memory rpc = vm.envOr("FORK_RPC", string(""));
        if (bytes(rpc).length == 0) return; // not a fork run — every test self-skips
        vm.createSelectFork(rpc);
        forked = true;

        zk = new HoldemTableN(treasury, FACTORY);
        rules = new MockGameRulesN();
        seatA = vm.addr(seatAKey);
        seatB = vm.addr(seatBKey);
        seatC = vm.addr(seatCKey);
        relayer = vm.addr(relayerKey);
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    function _authFor(IX402Full token, uint256 pk, address from, uint256 value, uint64 validBefore, bytes32 nonce)
        internal
        returns (HoldemTableN.DepositAuth memory)
    {
        bytes32 digest = X402AuthLib.receiveDigest(token.DOMAIN_SEPARATOR(), from, address(zk), value, validBefore, nonce);
        return HoldemTableN.DepositAuth({from: from, validBefore: validBefore, salt: bytes32(0), sig: X402AuthLib.sign65(pk, digest)});
    }

    function _coSign(uint256 n, ChannelStateN memory s, uint256[] memory pks) internal view returns (bytes[] memory sigs) {
        bytes32 digest = zk.stateDigest(s);
        sigs = new bytes[](n);
        for (uint256 i = 0; i < n; i++) {
            (uint8 v, bytes32 r, bytes32 ss) = vm.sign(pks[i], digest);
            sigs[i] = abi.encodePacked(r, ss, v);
        }
    }

    /// Full cycle against a given REAL wrapper: create -> join -> join -> start -> settle (with
    /// rake), submitted entirely by `relayer` (none of the 3 seats ever sends a transaction).
    /// Asserts ZERO dust left on the real wrapper's escrow balance for this contract at the end,
    /// and that the treasury received exactly the rake IN THE WRAPPER TOKEN.
    function _fullCycle(IX402Full token, uint256 buyIn, uint16 rakeBps, uint256 rakeCap) internal {
        IGameRulesN r = IGameRulesN(address(rules));
        uint64 validBefore = uint64(block.timestamp + 1 days);

        bytes32 cNonce = zk.createNonce(seatA, IX402Token(address(token)), r, buyIn, 3, rakeBps, rakeCap, CLOCK, address(0), DECK_KEY, bytes32(0));
        HoldemTableN.DepositAuth memory cAuth = _authFor(token, seatAKey, seatA, buyIn, validBefore, cNonce);
        vm.prank(relayer);
        bytes32 tableId = zk.create(IX402Token(address(token)), r, buyIn, 3, rakeBps, rakeCap, CLOCK, address(0), DECK_KEY, cAuth);

        bytes32 bNonce = zk.joinNonce(tableId, seatB, address(0), DECK_KEY, bytes32(0));
        HoldemTableN.DepositAuth memory bAuth = _authFor(token, seatBKey, seatB, buyIn, validBefore, bNonce);
        vm.prank(relayer);
        zk.join(tableId, address(0), DECK_KEY, bAuth);

        bytes32 cNonce2 = zk.joinNonce(tableId, seatC, address(0), DECK_KEY, bytes32(0));
        HoldemTableN.DepositAuth memory cAuth2 = _authFor(token, seatCKey, seatC, buyIn, validBefore, cNonce2);
        vm.prank(relayer);
        zk.join(tableId, address(0), DECK_KEY, cAuth2);

        // start() stays seat-gated (identity load-bearing — see HoldemTableN.sol's header), so
        // unlike create/join/settle it must be submitted by an actual seat, not the relayer.
        vm.prank(seatA);
        zk.start(tableId);

        uint256 total = buyIn * 3;
        // rake is exactly rakeBps of the gross (which equals `total`, since the final state's
        // pot is zero — gross = Sigma balances + rake); pick something within rakeCap so the
        // ratio (not the cap) determines the exact rake this call must supply.
        uint256 rake = rakeBps == 0 ? 0 : (total * rakeBps) / 10000;
        if (rake > rakeCap) rake = rakeCap;
        uint256 remaining = total - rake;
        ChannelStateN memory s;
        s.tableId = tableId;
        s.nonce = 1;
        s.balances = new uint256[](3);
        s.balances[0] = remaining / 3;
        s.balances[1] = remaining / 3;
        // NOTE: with this file's two parameterizations, `remaining` happens to divide evenly by
        // 3 (both give a whole-number third), so this split is NOT exercising an odd-remainder
        // case — it's still an exact-conservation check (Sigma balances + rake == total), just
        // not the rounding-remainder path. The genuine uneven-remainder / odd-wei case is covered
        // in HoldemTableNX402.t.sol's multi-seat rake test.
        s.balances[2] = remaining - s.balances[0] - s.balances[1];
        s.sidePots = new SidePot[](0);
        s.rakeAccrued = rake;
        s.pot = 0;
        s.phase = 1;
        uint256[] memory pks = new uint256[](3);
        pks[0] = seatAKey; pks[1] = seatBKey; pks[2] = seatCKey;
        bytes[] memory sigs = _coSign(3, s, pks);

        uint256 aBefore = token.balanceOf(seatA);
        uint256 bBefore = token.balanceOf(seatB);
        uint256 cBefore = token.balanceOf(seatC);
        uint256 treasuryBefore = token.balanceOf(treasury);
        vm.prank(relayer);
        zk.settle(tableId, s, sigs);

        assertEq(token.balanceOf(seatA) - aBefore, s.balances[0], "seat A paid exactly its co-signed balance");
        assertEq(token.balanceOf(seatB) - bBefore, s.balances[1], "seat B paid exactly its co-signed balance");
        assertEq(token.balanceOf(seatC) - cBefore, s.balances[2], "seat C paid exactly its co-signed balance");
        assertEq(token.balanceOf(treasury) - treasuryBefore, rake, "treasury paid exactly the rake, in the wrapper token");
        assertEq(token.balanceOf(address(zk)), 0, "ZERO dust left on the real wrapper");
    }

    /// x402PLS (18 decimals): real `wrap{value}()`, sign against the real DOMAIN_SEPARATOR, full
    /// N-seat cycle with rake through the real ValveWrapperFactory clone-check.
    function test_fork_fullCycle_x402PLS_rake_zeroDust() public {
        if (!forked) return;
        IX402Full token = IX402Full(X402PLS);
        assertEq(token.decimals(), 18, "sanity: x402PLS is 18-decimal");
        vm.deal(seatA, 100e18);
        vm.deal(seatB, 100e18);
        vm.deal(seatC, 100e18);
        vm.prank(seatA);
        token.wrap{value: 10e18}();
        vm.prank(seatB);
        token.wrap{value: 10e18}();
        vm.prank(seatC);
        token.wrap{value: 10e18}();

        _fullCycle(token, 1e18, 250, 1e18); // 2.5% rake, loose cap
    }

    /// x402USDC (6 decimals): players funded via forge-std's `deal` (this wrapper has no
    /// ETH-backed `wrap()`). Identical full cycle to the PLS case, proving the escrow/nonce/
    /// payout/rake machinery is decimals-agnostic.
    function test_fork_fullCycle_x402USDC_6decimals_rake_zeroDust() public {
        if (!forked) return;
        IX402Full token = IX402Full(X402USDC);
        assertEq(token.decimals(), 6, "sanity: x402USDC is 6-decimal");
        uint256 amt = 30_000000; // 30.000000 (6dp)
        deal(X402USDC, seatA, amt);
        deal(X402USDC, seatB, amt);
        deal(X402USDC, seatC, amt);

        _fullCycle(token, 10_000000, 250, 1_000000); // 2.5% rake, loose cap
    }

    /// Replay of an executed create authorization dies at the REAL wrapper's burned nonce.
    function test_fork_replay_diesAtRealWrapperBurnedNonce() public {
        if (!forked) return;
        IX402Full token = IX402Full(X402PLS);
        vm.deal(seatA, 10e18);
        vm.prank(seatA);
        token.wrap{value: 5e18}();

        IGameRulesN r = IGameRulesN(address(rules));
        uint64 validBefore = uint64(block.timestamp + 1 days);
        bytes32 nonce = zk.createNonce(seatA, IX402Token(address(token)), r, 1e18, 3, 0, 0, CLOCK, address(0), DECK_KEY, bytes32(0));
        HoldemTableN.DepositAuth memory auth = _authFor(token, seatAKey, seatA, 1e18, validBefore, nonce);

        vm.prank(relayer);
        zk.create(IX402Token(address(token)), r, 1e18, 3, 0, 0, CLOCK, address(0), DECK_KEY, auth);

        vm.prank(relayer);
        vm.expectRevert(); // the real wrapper's AuthorizationAlreadyUsed
        zk.create(IX402Token(address(token)), r, 1e18, 3, 0, 0, CLOCK, address(0), DECK_KEY, auth);
    }

    /// A relayer that flips `channelKey` between signing and submission dies at the REAL
    /// wrapper's InvalidSignature (the seat-hijack closure, proven against production code).
    function test_fork_tamper_channelKey_diesAtRealWrapperInvalidSignature() public {
        if (!forked) return;
        IX402Full token = IX402Full(X402PLS);
        vm.deal(seatA, 10e18);
        vm.prank(seatA);
        token.wrap{value: 5e18}();

        IGameRulesN r = IGameRulesN(address(rules));
        uint64 validBefore = uint64(block.timestamp + 1 days);
        // Signed for channelKey == address(0)...
        bytes32 nonce = zk.createNonce(seatA, IX402Token(address(token)), r, 1e18, 3, 0, 0, CLOCK, address(0), DECK_KEY, bytes32(0));
        HoldemTableN.DepositAuth memory auth = _authFor(token, seatAKey, seatA, 1e18, validBefore, nonce);

        vm.prank(relayer);
        vm.expectRevert(); // ...but submitted with a DIFFERENT channelKey => different nonce => InvalidSignature
        zk.create(IX402Token(address(token)), r, 1e18, 3, 0, 0, CLOCK, /* tampered */ seatB, DECK_KEY, auth);
    }
}
