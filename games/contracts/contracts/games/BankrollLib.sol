// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// @notice Reusable hot/cold bankroll accounting for an operator-run table-vault game
/// (CoinFlipTables today; any future permissionless-table game tomorrow). `hot` is the armed
/// balance a new round may escrow against; `cold` is the reserve, never at risk until promoted;
/// `escrowed` is the full payout locked by live rounds; `stake` is a ranking signal never touched
/// by settlement. Only the PURE accounting mutations and their bounds-check reverts live here —
/// token transfers, events, and access control (onlyOperator) stay in the calling contract, since a
/// library should not move the contract's tokens or emit the contract's events on its own.
///
/// Each error below mirrors an identically-named, identically-signatured error the calling
/// contract also declares for its own ABI (so `Contract.ErrorName.selector` keeps resolving for
/// callers/tests) — the two declarations share a selector because they share a signature; only one
/// of them actually fires, from inside these internal (inlined) functions.
library BankrollLib {
    error NoTable();
    error InsufficientHot();
    error InsufficientCold();
    error InsufficientStake();
    error NothingToRefill();

    struct Table {
        address operator;
        uint256 hot;              // armed — the only balance a new round can escrow against
        uint256 cold;             // reserve — never at risk until promoted
        uint256 escrowed;         // full payout locked by live rounds
        uint256 stake;            // ranking signal, never touched by settlement
        uint16  maxMultiplierX100;
        uint256 maxStake;
        uint256 hotTarget;
        bool    open;
    }

    function fundHot(Table storage t, uint256 amount) internal {
        if (t.operator == address(0)) revert NoTable();
        t.hot += amount;
    }

    function fundCold(Table storage t, uint256 amount) internal {
        if (t.operator == address(0)) revert NoTable();
        t.cold += amount;
    }

    function withdrawHot(Table storage t, uint256 amount) internal {
        if (t.hot < amount) revert InsufficientHot();
        t.hot -= amount;
    }

    function withdrawCold(Table storage t, uint256 amount) internal {
        if (t.cold < amount) revert InsufficientCold();
        t.cold -= amount;
    }

    function promote(Table storage t, uint256 amount) internal {
        if (t.cold < amount) revert InsufficientCold();
        t.cold -= amount;
        t.hot += amount;
    }

    function demote(Table storage t, uint256 amount) internal {
        if (t.hot < amount) revert InsufficientHot();
        t.hot -= amount;
        t.cold += amount;
    }

    /// @notice Move up to `hotTarget - hot` from cold to hot, capped at cold's balance. Reverts if
    /// there is nothing to move (hot already at/above target, or cold is empty).
    function refillHot(Table storage t) internal returns (uint256 moved) {
        if (t.operator == address(0)) revert NoTable();
        if (t.hot >= t.hotTarget) revert NothingToRefill();
        uint256 need = t.hotTarget - t.hot;
        moved = need < t.cold ? need : t.cold;
        if (moved == 0) revert NothingToRefill();
        t.cold -= moved;
        t.hot += moved;
    }

    function stakeForRank(Table storage t, uint256 amount) internal {
        t.stake += amount;
    }

    function unstake(Table storage t, uint256 amount) internal {
        if (t.stake < amount) revert InsufficientStake();
        t.stake -= amount;
    }

    /// @notice Reserve a round's escrow at open time. Only the operator's exposure (payout - stake)
    /// leaves hot; escrowed grows by the full payout (the player's own stake, pulled into the
    /// contract by the caller separately, funds the remainder). Callers must check
    /// `t.hot >= exposure` themselves first (the feasibility revert is game-specific, e.g.
    /// InsufficientBankroll) — this just performs the mutation.
    function reserve(Table storage t, uint256 exposure, uint256 payout) internal {
        t.hot -= exposure;
        t.escrowed += payout;
    }

    /// @notice Release a round's escrow on a win: the payout leaves escrow to be paid to the
    /// player by the caller. hot is untouched — the exposure already left at open time.
    function releaseWin(Table storage t, uint256 payout) internal {
        t.escrowed -= payout;
    }

    /// @notice Release a round's escrow on a loss: the whole reservation (operator exposure plus
    /// the player's forfeited stake) returns to hot.
    function releaseLoss(Table storage t, uint256 payout) internal {
        t.escrowed -= payout;
        t.hot += payout;
    }

    /// @notice Release a round's escrow on a refund: only the operator's exposure returns to hot —
    /// the player reclaims their own stake directly (a token transfer the caller performs).
    function releaseRefund(Table storage t, uint256 payout, uint256 exposure) internal {
        t.escrowed -= payout;
        t.hot += exposure;
    }
}
