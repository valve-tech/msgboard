// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {OperatorCoinFlip} from "../../contracts/games/operator/OperatorCoinFlip.sol";
import {GameEscrow} from "../../contracts/games/operator/GameEscrow.sol";
import {OperatorRegistry} from "../../contracts/games/operator/OperatorRegistry.sol";
import {PreimageLocation} from "../../contracts/PreimageLocation.sol";
import {ERC20} from "../../contracts/test/ERC20.sol";
import {MockRandom} from "./MockRandom.sol";

contract OperatorCoinFlipTest is Test {
    OperatorCoinFlip internal game;
    GameEscrow internal esc;
    OperatorRegistry internal reg;
    MockRandom internal rnd;
    ERC20 internal tok;
    address[] internal subset;
    PreimageLocation.Info[] internal locs;

    address internal op = address(0x0B);
    address internal player = address(0x9E7);
    uint16 internal constant MULT = 196; // 1.96x
    uint256 internal constant MAX_STAKE = 100 ether;

    function setUp() public {
        rnd = new MockRandom();
        reg = new OperatorRegistry();
        esc = new GameEscrow(address(reg));
        tok = new ERC20(false);
        game = new OperatorCoinFlip(address(rnd), address(esc), address(reg));
        for (uint256 i = 0; i < 3; i++) {
            address v = address(uint160(0x3000 + i));
            game.addValidator(v);
            subset.push(v);
            locs.push(PreimageLocation.Info({
                provider: v, callAtChange: true, durationIsTimestamp: false,
                duration: 12, token: address(0), price: 0, offset: 0, index: 0
            }));
        }
        vm.prank(op); reg.register();
        // operator funds bankroll into the escrow
        tok.mint(op, 1000 ether);
        vm.prank(op); tok.approve(address(esc), type(uint256).max);
        vm.prank(op); esc.depositBankroll(op, address(tok), 1000 ether);
        // player approves the ESCROW (custodian) for the token, then consents to THIS game pulling
        // that allowance — the player-side gate that closes the shared-escrow approval drain.
        tok.mint(player, 100 ether);
        vm.prank(player); tok.approve(address(esc), type(uint256).max);
        vm.prank(player); esc.setPlayerGame(address(game), true);
        vm.prank(op); esc.authorizeGame(address(game), true);
    }

    function _open(uint8 side) internal returns (bytes32 roundId, bytes32 key) {
        bytes32 tableId = _table();
        vm.prank(player);
        roundId = game.open(tableId, side, 10 ether, subset, locs);
        (,,,,, key,,) = game.rounds(roundId);
    }

    function _table() internal returns (bytes32 tableId) {
        vm.prank(op);
        tableId = game.createTable(address(tok), MULT, MAX_STAKE);
    }

    function test_open_locksExposure_pullsStakeToEscrow() public {
        (bytes32 roundId,) = _open(0);
        assertEq(esc.lockedOf(op, address(tok)), 19.6 ether); // payout of 10 @ 1.96
        assertEq(tok.balanceOf(player), 90 ether);
        assertGt(uint256(roundId), 0);
    }

    function test_settle_win_paysPlayerFromEscrow() public {
        (bytes32 roundId, bytes32 key) = _open(0); // player picks HEADS (0)
        rnd.pushCast(address(game), key, bytes32(uint256(0))); // even → HEADS → player wins
        assertEq(tok.balanceOf(player), 90 ether + 19.6 ether);
        assertEq(esc.lockedOf(op, address(tok)), 0);
    }

    function test_settle_loss_returnsToBankroll() public {
        (bytes32 roundId, bytes32 key) = _open(0);
        rnd.pushCast(address(game), key, bytes32(uint256(1))); // odd → TAILS → player loses
        assertEq(tok.balanceOf(player), 90 ether); // stake stays lost
        assertEq(esc.lockedOf(op, address(tok)), 0);
        assertGt(esc.bankrollOf(op, address(tok)), 1000 ether); // operator gained
    }

    function test_refundStale_returnsStake_afterTimeout_validatorAbort() public {
        (bytes32 roundId,) = _open(0);
        vm.roll(block.number + 201); // past STALE_BLOCKS (200), no seed finalized
        game.refundStale(roundId);
        assertEq(tok.balanceOf(player), 100 ether);       // player made whole — no free-roll
        assertEq(esc.bankrollOf(op, address(tok)), 1000 ether); // operator exposure restored
    }

    function test_createTable_requiresRegisteredOperator() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(OperatorCoinFlip.NotRegisteredOperator.selector);
        game.createTable(address(tok), MULT, MAX_STAKE);
    }

    /// A stake so small that payout truncates to break-even (payout == stake, zero exposure) is a
    /// degenerate no-win round — rejected before any validator heat is consumed.
    function test_open_revertsOnDustStake() public {
        bytes32 tableId = _table();
        vm.prank(player);
        vm.expectRevert(OperatorCoinFlip.DustStake.selector);
        game.open(tableId, 0, 1, subset, locs); // 1 wei * 196 / 100 == 1 == stake
    }
}
