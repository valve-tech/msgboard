// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {GameEscrow} from "../games/operator/GameEscrow.sol";
import {OperatorRegistry} from "../games/operator/OperatorRegistry.sol";
import {ERC20} from "./ERC20.sol";

/// @notice Bounded, stateful driver for the GameEscrow invariant suite. This one contract plays all
/// three external roles at once — the permissionless bankroll funder, the sole "game" that calls
/// lockExposure/settleWin/settleLoss/refund, and the player whose stake gets pulled/repaid — which
/// keeps the corpus simple (one mint, one approval) while still exercising every money-moving path
/// across two operators (opX/opY) and two independent tokens (tokA/tokB). Every action is
/// bound()-clamped and try/catch-wrapped so a legitimate revert (e.g. InsufficientBankroll) is
/// absorbed rather than failing the run — `fail_on_revert = false` in the [invariant] profile.
/// Open bets are tracked in `openBetIds` so settle/refund only ever target live, un-settled bets.
contract EscrowHandler is Test {
    GameEscrow public esc;
    OperatorRegistry public reg;
    ERC20 public tokA;
    ERC20 public tokB;
    address public opX;
    address public opY;

    bytes32[] public openBetIds;
    uint256 internal nextSalt;

    constructor(GameEscrow _esc, OperatorRegistry _reg, ERC20 _tokA, ERC20 _tokB, address _opX, address _opY) {
        esc = _esc;
        reg = _reg;
        tokA = _tokA;
        tokB = _tokB;
        opX = _opX;
        opY = _opY;

        // Funder + game + player are all this contract, so one generous mint + max approval per
        // token covers every pull path (depositBankroll and lockExposure both pull from msg.sender
        // / the named player, both of which are `address(this)` here).
        tokA.mint(address(this), 1_000_000_000 ether);
        tokB.mint(address(this), 1_000_000_000 ether);
        tokA.approve(address(esc), type(uint256).max);
        tokB.approve(address(esc), type(uint256).max);
    }

    function openBetIdsLength() external view returns (uint256) {
        return openBetIds.length;
    }

    function _op(uint256 seed) internal view returns (address) {
        return seed % 2 == 0 ? opX : opY;
    }

    function _tok(uint256 seed) internal view returns (ERC20) {
        return seed % 2 == 0 ? tokA : tokB;
    }

    function _removeOpen(uint256 i) internal {
        uint256 last = openBetIds.length - 1;
        openBetIds[i] = openBetIds[last];
        openBetIds.pop();
    }

    // ── actions ─────────────────────────────────────────────────────────────

    function depositBankroll(uint256 opSel, uint256 tokSel, uint256 amountSeed) public {
        address op = _op(opSel);
        ERC20 tok = _tok(tokSel);
        uint256 amount = bound(amountSeed, 0, 1_000_000 ether);
        try esc.depositBankroll(op, address(tok), amount) {} catch {}
    }

    /// @dev withdrawBankroll debits `msg.sender`'s own ledger, so the operator itself must call it.
    function withdrawBankroll(uint256 opSel, uint256 tokSel, uint256 amountSeed) public {
        address op = _op(opSel);
        ERC20 tok = _tok(tokSel);
        uint256 amount = bound(amountSeed, 0, 1_000_000 ether);
        vm.prank(op);
        try esc.withdrawBankroll(address(tok), amount) {} catch {}
    }

    /// @dev Varies the rake taken on settleLoss; `address(this)` is the "game" of record for every
    /// bet this handler locks, matching what GameEscrow queries at settleLoss time.
    function setRakeBps(uint256 opSel, uint256 bpsSeed) public {
        address op = _op(opSel);
        uint16 bps = uint16(bound(bpsSeed, 0, 500));
        vm.prank(op);
        try reg.setRakeBps(address(this), bps) {} catch {}
    }

    function lock(uint256 opSel, uint256 tokSel, uint256 stakeSeed, uint256 multSeed) public {
        address op = _op(opSel);
        ERC20 tok = _tok(tokSel);
        uint256 stake = bound(stakeSeed, 1, 1_000 ether);
        uint256 mult = bound(multSeed, 100, 300); // payout is 1.00x-3.00x stake, always >= stake
        uint256 payout = (stake * mult) / 100;
        bytes32 betId = keccak256(abi.encode(address(this), nextSalt++));
        try esc.lockExposure(betId, op, address(tok), address(this), stake, payout) {
            openBetIds.push(betId);
        } catch {}
    }

    function settleWin(uint256 idxSeed) public {
        if (openBetIds.length == 0) return;
        uint256 i = bound(idxSeed, 0, openBetIds.length - 1);
        bytes32 betId = openBetIds[i];
        try esc.settleWin(betId) {
            _removeOpen(i);
        } catch {}
    }

    function settleLoss(uint256 idxSeed) public {
        if (openBetIds.length == 0) return;
        uint256 i = bound(idxSeed, 0, openBetIds.length - 1);
        bytes32 betId = openBetIds[i];
        try esc.settleLoss(betId) {
            _removeOpen(i);
        } catch {}
    }

    function refund(uint256 idxSeed) public {
        if (openBetIds.length == 0) return;
        uint256 i = bound(idxSeed, 0, openBetIds.length - 1);
        bytes32 betId = openBetIds[i];
        try esc.refund(betId) {
            _removeOpen(i);
        } catch {}
    }
}
