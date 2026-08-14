// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {OperatorRegistry} from "../../contracts/games/operator/OperatorRegistry.sol";
import {GameEscrow} from "../../contracts/games/operator/GameEscrow.sol";
import {BonusChips1155} from "../../contracts/games/operator/BonusChips1155.sol";
import {BackingPool} from "../../contracts/games/operator/BackingPool.sol";
import {ERC20} from "../../contracts/test/ERC20.sol";

/// @notice The mock boosted game — a faithful stand-in for S2b's real game. Per boosted round it
/// performs EXACTLY the paired bet-B escrow operations against the pool's bucket (operator = pool)
/// AND calls the matching pool hook, in the order the accounting doc pins. Bet A (the operator's own
/// bet) is out of scope here: S2a proves the POOL's ledger, so we exercise only the pool-owned bet B.
///
/// The game holds each in-flight charge (exact-pull counter `gameHeld`), mirroring the real game's
/// custody. It is a `burner` on the chips so it can destroy a used charge; on a plain refund it
/// returns the charge to the player instead.
contract MockBoostGame {
    GameEscrow public immutable escrow;
    BonusChips1155 public immutable chips;
    BackingPool public pool;

    mapping(uint256 seriesId => uint256) public gameHeld; // exact-pull counter, never a balance read

    struct R {
        uint256 seriesId;
        uint256 d;
        address player;
        address token;
        bool open;
    }

    mapping(bytes32 roundId => R) public rounds;

    constructor(GameEscrow e, BonusChips1155 c) {
        escrow = e;
        chips = c;
    }

    function setPool(BackingPool p) external {
        pool = p;
    }

    function _boostId(bytes32 roundId) internal pure returns (bytes32) {
        return keccak256(abi.encode(roundId, "boost"));
    }

    /// T2 OPEN: pull one charge, consume (ledger), then lock the pool-owned bet B (stake 0, payout d).
    function open(bytes32 roundId, uint256 seriesId, uint256 d, address player) external {
        (,,, address token) = chips.seriesOf(seriesId);
        chips.safeTransferFrom(player, address(this), seriesId, 1, ""); // exact-pull custody
        gameHeld[seriesId] += 1;
        pool.consume(roundId, seriesId, d);
        escrow.lockExposure(_boostId(roundId), address(pool), token, player, 0, d);
        rounds[roundId] = R(seriesId, d, player, token, true);
    }

    /// T3 WIN: settle bet B (pays d to the player), release the residual, burn the charge.
    function win(bytes32 roundId) external {
        R storage r = rounds[roundId];
        r.open = false;
        escrow.settleWin(_boostId(roundId));
        pool.onSettleWin(roundId);
        chips.burn(address(this), r.seriesId, 1);
        gameHeld[r.seriesId] -= 1;
    }

    /// T4 LOSS: settle bet B (returns d to the pool bucket), release w to the operator, burn the charge.
    function loss(bytes32 roundId) external {
        R storage r = rounds[roundId];
        r.open = false;
        escrow.settleLoss(_boostId(roundId));
        pool.onSettleLoss(roundId);
        chips.burn(address(this), r.seriesId, 1);
        gameHeld[r.seriesId] -= 1;
    }

    /// T5 PLAIN-REFUND: refund bet B (returns d to the pool bucket), re-earmark w, RETURN the charge.
    function plainRefund(bytes32 roundId) external {
        R storage r = rounds[roundId];
        r.open = false;
        escrow.refund(_boostId(roundId));
        pool.onPlainRefund(roundId);
        chips.safeTransferFrom(address(this), r.player, r.seriesId, 1, ""); // charge back to player
        gameHeld[r.seriesId] -= 1;
    }

    /// T6 CHOP-REFUND: refund bet B (returns d to the pool bucket), credit w to the operator, BURN it.
    function chopRefund(bytes32 roundId) external {
        R storage r = rounds[roundId];
        r.open = false;
        escrow.refund(_boostId(roundId));
        pool.onChopRefund(roundId);
        chips.burn(address(this), r.seriesId, 1); // never returned (removes the tier-boundary abort profit)
        gameHeld[r.seriesId] -= 1;
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC1155Received.selector;
    }
}

contract BackingPoolTest is Test {
    OperatorRegistry internal reg;
    GameEscrow internal esc;
    BonusChips1155 internal chips;
    BackingPool internal pool;
    MockBoostGame internal game;
    ERC20 internal tok;

    address internal operator = address(0x0B);
    address internal minter = address(0x111); // the mint-sale stand-in
    address internal player = address(0x9E7);

    // Test-side bookkeeping for circ(s) = minted - burned - gameHeld (the pool never reads balances).
    uint256[] internal seriesIds;
    mapping(uint256 => uint256) internal mintedOf;
    mapping(uint256 => uint256) internal burnedOf;
    bytes32[] internal roundIds;
    mapping(bytes32 => bool) internal roundSeen;

    function setUp() public {
        reg = new OperatorRegistry();
        esc = new GameEscrow(address(reg));
        chips = new BonusChips1155();
        tok = new ERC20(false); // plain token (boosted tables reject FOT/rebase; O6)

        game = new MockBoostGame(esc, chips);
        // Pool self-authorizes `game` as an escrow bucket owner for operator = pool (constructor).
        pool = new BackingPool(address(esc), address(chips), address(game));
        game.setPool(pool);

        // Chips roles: minter mints, game + pool may burn.
        chips.setCreator(address(this));
        chips.setMinter(minter);
        chips.setBurner(address(game), true);
        chips.setBurner(address(pool), true);

        // Pool minter (the mint-sale) may fund earmarks.
        pool.setMinter(minter);

        vm.prank(operator);
        reg.register();

        // Player consents to the game (bet B pulls a 0-stake but still checks consent), and approves
        // the game to move its charges.
        vm.prank(player);
        esc.setPlayerGame(address(game), true);
        vm.prank(player);
        chips.setApprovalForAll(address(game), true);

        // Operator funds through the pool: approve the pool to pull backing.
        tok.mint(operator, 1_000_000 ether);
        vm.prank(operator);
        tok.approve(address(pool), type(uint256).max);
    }

    // ── helpers ──────────────────────────────────────────────────────────────────────────────────

    function _createSeries(uint16 bp, uint256 maxStake) internal returns (uint256 id) {
        id = chips.createSeries(bp, maxStake, uint64(block.timestamp + 7 days), address(tok));
        seriesIds.push(id);
    }

    /// T1 MINT: fund the earmark AND mint the charges together (one economic transition).
    function _mint(uint256 seriesId, uint256 n) internal {
        vm.prank(minter);
        pool.fundEarmark(seriesId, n, operator);
        vm.prank(minter);
        chips.mint(player, seriesId, n);
        mintedOf[seriesId] += n;
    }

    function _open(bytes32 roundId, uint256 seriesId, uint256 d) internal {
        if (!roundSeen[roundId]) {
            roundIds.push(roundId);
            roundSeen[roundId] = true;
        }
        game.open(roundId, seriesId, d, player);
    }

    function _circ(uint256 seriesId) internal view returns (uint256) {
        return mintedOf[seriesId] - burnedOf[seriesId] - game.gameHeld(seriesId);
    }

    /// P1: bankrollOf(pool, token) == Σ earmark[s] + Σ hold[r] + Σ credit[op][token].
    /// P2: for every series, earmark[s] == circ(s) * w(s).
    function _assertInvariants() internal view {
        uint256 sumEarmark;
        for (uint256 i = 0; i < seriesIds.length; i++) {
            uint256 s = seriesIds[i];
            sumEarmark += pool.earmark(s);
            // The pool-maintained circ counter must match the test's independent circ = minted - burned
            // - gameHeld, and the earmark must exactly back it (P2 as a pool-enforced invariant).
            assertEq(pool.circ(s), _circ(s), "pool.circ != minted - burned - gameHeld");
            assertEq(pool.earmark(s), pool.circ(s) * chips.w(s), "P2: earmark != circ * w");
        }
        uint256 sumHold;
        for (uint256 i = 0; i < roundIds.length; i++) {
            sumHold += pool.hold(roundIds[i]);
        }
        uint256 sumCredit = pool.credit(operator, address(tok));
        assertEq(
            esc.bankrollOf(address(pool), address(tok)),
            sumEarmark + sumHold + sumCredit,
            "P1: pool bankroll != earmark + hold + credit"
        );
    }

    // ── per-transition tests ─────────────────────────────────────────────────────────────────────

    function test_mint_earmarks() public {
        uint256 id = _createSeries(25, 999); // w = 250
        _mint(id, 4);
        assertEq(pool.earmark(id), 4 * 250);
        assertEq(esc.bankrollOf(address(pool), address(tok)), 4 * 250);
        _assertInvariants();
    }

    function test_consume_then_win_releases_residual() public {
        uint256 id = _createSeries(25, 999); // w = 250
        _mint(id, 1);
        // d chosen inside [1, w]. Say d = 90, r = 160.
        uint256 d = 90;
        uint256 w = chips.w(id);
        uint256 r = w - d;
        bytes32 rid = keccak256("win-round");

        _open(rid, id, d);
        // After open: earmark 0, hold = r, bankroll dropped by d.
        assertEq(pool.earmark(id), 0);
        assertEq(pool.hold(rid), r);
        assertEq(esc.bankrollOf(address(pool), address(tok)), w - d); // = r
        _assertInvariants();

        game.win(rid);
        burnedOf[id] += 1;
        // Win: residual r released to credit[op]; d was paid to the player (left escrow).
        assertEq(pool.hold(rid), 0);
        assertEq(pool.credit(operator, address(tok)), r);
        assertEq(esc.bankrollOf(address(pool), address(tok)), r); // bankroll holds the released residual
        _assertInvariants();
    }

    function test_consume_then_loss_returns_d_to_pool() public {
        uint256 id = _createSeries(30, 500); // w = 150
        _mint(id, 1);
        uint256 w = chips.w(id);
        uint256 d = 120;
        bytes32 rid = keccak256("loss-round");

        _open(rid, id, d);
        _assertInvariants();

        game.loss(rid);
        burnedOf[id] += 1;
        // Loss: d returned to the pool bucket; operator owns w (= d + r) as credit.
        assertEq(pool.hold(rid), 0);
        assertEq(pool.credit(operator, address(tok)), w);
        assertEq(esc.bankrollOf(address(pool), address(tok)), w);
        _assertInvariants();
    }

    function test_plain_refund_reearmarks() public {
        uint256 id = _createSeries(25, 999); // w = 250
        _mint(id, 1);
        uint256 w = chips.w(id);
        uint256 d = 200;
        bytes32 rid = keccak256("plain-refund-round");

        _open(rid, id, d);
        _assertInvariants();

        game.plainRefund(rid);
        // No burn — charge returned to the player. earmark re-funded by the returned d+r.
        assertEq(pool.hold(rid), 0);
        assertEq(pool.earmark(id), w);
        assertEq(pool.credit(operator, address(tok)), 0);
        assertEq(_circ(id), 1); // charge is circulating again
        _assertInvariants();
    }

    function test_chop_refund_burns_and_credits() public {
        uint256 id = _createSeries(25, 999); // w = 250
        _mint(id, 1);
        uint256 w = chips.w(id);
        uint256 d = 200;
        bytes32 rid = keccak256("chop-refund-round");

        _open(rid, id, d);
        _assertInvariants();

        game.chopRefund(rid);
        burnedOf[id] += 1;
        // Charge burned; operator credited w.
        assertEq(pool.hold(rid), 0);
        assertEq(pool.credit(operator, address(tok)), w);
        assertEq(chips.balanceOf(address(game), id), 0); // charge destroyed, not returned
        assertEq(_circ(id), 0);
        _assertInvariants();
    }

    function test_expire_returns_backing_to_operator() public {
        uint256 id = _createSeries(25, 999); // w = 250
        _mint(id, 3);
        uint256 w = chips.w(id);
        _assertInvariants();

        // Before expiry: reverts.
        vm.expectRevert(BackingPool.BeforeExpiry.selector);
        pool.expireCharges(id, player, 2);

        vm.warp(block.timestamp + 8 days); // past the 7-day expiry
        pool.expireCharges(id, player, 2);
        burnedOf[id] += 2;

        assertEq(pool.earmark(id), 1 * w); // 3 - 2 remaining
        assertEq(pool.credit(operator, address(tok)), 2 * w);
        assertEq(_circ(id), 1);
        _assertInvariants();
    }

    function test_withdrawCredit_only_released() public {
        uint256 id = _createSeries(30, 500); // w = 150
        _mint(id, 1);
        uint256 w = chips.w(id);
        uint256 d = 120;
        bytes32 rid = keccak256("wc-round");
        _open(rid, id, d);
        game.loss(rid);
        burnedOf[id] += 1;
        assertEq(pool.credit(operator, address(tok)), w);

        // A non-operator cannot withdraw.
        vm.prank(address(0xBAD));
        vm.expectRevert(); // credit[bad] is 0 -> InsufficientCredit
        pool.withdrawCredit(address(tok), 1);

        // Operator cannot overdraw.
        vm.prank(operator);
        vm.expectRevert(BackingPool.InsufficientCredit.selector);
        pool.withdrawCredit(address(tok), w + 1);

        // Operator withdraws exactly the released credit.
        uint256 balBefore = tok.balanceOf(operator);
        vm.prank(operator);
        pool.withdrawCredit(address(tok), w);
        assertEq(tok.balanceOf(operator) - balBefore, w);
        assertEq(pool.credit(operator, address(tok)), 0);
        assertEq(esc.bankrollOf(address(pool), address(tok)), 0);
        _assertInvariants();
    }

    function test_consume_revertsForNonGame() public {
        uint256 id = _createSeries(25, 999);
        _mint(id, 1);
        vm.expectRevert(BackingPool.NotGame.selector);
        pool.consume(keccak256("x"), id, 100);
    }

    function test_fundEarmark_revertsForNonMinter() public {
        uint256 id = _createSeries(25, 999);
        vm.prank(address(0xBAD));
        vm.expectRevert(BackingPool.NotMinter.selector);
        pool.fundEarmark(id, 1, operator);
    }

    // ── CRITICAL-1: expireCharges must never burn the game's in-flight (consumed) charge ────────────

    /// The reviewer's attack: with a round open, the game holds one consumed charge whose `w` already
    /// moved earmark -> hold. A keeper calls `expireCharges(s, game, 1)` after expiry, trying to burn
    /// that in-flight charge and de-earmark a SECOND `w` — a permissionless double-release that would
    /// break P2 and strand the open round. Both guards must stop it, and the round must still settle.
    function test_expireCharges_cannotBurnGameHeldCharge() public {
        uint256 id = _createSeries(25, 999); // w = 250
        _mint(id, 2);

        uint256 d = 100;
        bytes32 rid = keccak256("attack-round");
        _open(rid, id, d); // game now holds one consumed charge
        _assertInvariants();

        uint256 earmarkBefore = pool.earmark(id); // 1 * w (one charge still circulating with player)
        uint256 circBefore = pool.circ(id);       // 1
        uint256 holdBefore = pool.hold(rid);      // w - d

        vm.warp(block.timestamp + 8 days); // past expiry

        // Guard 1 — direct `holder == game` rejection.
        vm.expectRevert(BackingPool.HolderIsGame.selector);
        pool.expireCharges(id, address(game), 1);

        // Guard 2 — cannot de-earmark more than the circulating supply (the game-held charge is
        // excluded from circ), so even from a legit holder, n > circ reverts before any state moves.
        vm.expectRevert(BackingPool.CircShort.selector);
        pool.expireCharges(id, player, circBefore + 1);

        // The failed attack left every ledger untouched; P2 still holds.
        assertEq(pool.earmark(id), earmarkBefore, "earmark moved");
        assertEq(pool.circ(id), circBefore, "circ moved");
        assertEq(pool.hold(rid), holdBefore, "hold moved");
        _assertInvariants();

        // And the open round still terminates normally afterward.
        game.win(rid);
        burnedOf[id] += 1;
        assertEq(pool.hold(rid), 0);
        assertEq(pool.credit(operator, address(tok)), holdBefore); // residual released on the win
        _assertInvariants();
    }

    // ── randomized invariant sequence ────────────────────────────────────────────────────────────

    /// The core deliverable: a bounded random legal sequence of every transition, asserting P1 + P2
    /// after EACH step. One series, variable stake per round, immediate expiry.
    function test_invariant_random_sequence(uint256 seed) public {
        uint256 id = _createSeries(25, 999); // w = 250
        uint256 w = chips.w(id);

        // Seed the pool with a batch of charges so opens have something to consume.
        _mint(id, 20);
        _assertInvariants();

        uint256 openCount; // charges currently held by the game (open rounds)
        bytes32[] memory live = new bytes32[](64);
        uint256 nonce;

        for (uint256 step = 0; step < 48; step++) {
            seed = uint256(keccak256(abi.encode(seed, step)));
            uint256 action = seed % 7;

            // CRITICAL-1 probe: expiring the game's in-flight charges must ALWAYS revert — never
            // corrupt state — whoever the holder and whatever the round/expiry state. The direct
            // `holder == game` guard fires before the expiry check, so this reverts mid-loop too.
            if (seed % 5 == 0) {
                vm.expectRevert(BackingPool.HolderIsGame.selector);
                pool.expireCharges(id, address(game), 1);
                _assertInvariants(); // the failed attack left every ledger untouched
            }

            if (action == 0) {
                // MINT a random small batch.
                uint256 n = (seed >> 8) % 5 + 1;
                _mint(id, n);
            } else if (action == 1) {
                // OPEN a round if a charge is available to the player.
                if (chips.balanceOf(player, id) == 0 || pool.earmark(id) < w) continue;
                uint256 d = (seed >> 8) % w + 1; // d in [1, w]
                bytes32 rid = keccak256(abi.encode("r", nonce++));
                _open(rid, id, d);
                live[openCount++] = rid;
            } else if (action >= 2 && action <= 5) {
                // Terminate a random open round via one of the four terminals.
                if (openCount == 0) continue;
                uint256 pick = (seed >> 8) % openCount;
                bytes32 rid = live[pick];
                if (action == 2) {
                    game.win(rid);
                    burnedOf[id] += 1;
                } else if (action == 3) {
                    game.loss(rid);
                    burnedOf[id] += 1;
                } else if (action == 4) {
                    game.plainRefund(rid); // returns the charge (no burn)
                } else {
                    game.chopRefund(rid);
                    burnedOf[id] += 1;
                }
                live[pick] = live[--openCount]; // swap-remove
            } else {
                // WITHDRAW a slice of released credit.
                uint256 c = pool.credit(operator, address(tok));
                if (c == 0) continue;
                uint256 a = (seed >> 8) % c + 1;
                vm.prank(operator);
                pool.withdrawCredit(address(tok), a);
            }

            _assertInvariants();
        }

        // Finally, expire everything left circulating with the player (if any), after expiry.
        vm.warp(block.timestamp + 8 days);
        uint256 held = chips.balanceOf(player, id);
        if (held > 0) {
            pool.expireCharges(id, player, held);
            burnedOf[id] += held;
        }
        _assertInvariants();
    }
}
