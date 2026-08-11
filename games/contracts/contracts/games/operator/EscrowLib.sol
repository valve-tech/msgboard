// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// @notice Pure per-(operator, token) ledger accounting for GameEscrow. Only the mutations and their
/// bounds-check reverts live here — token transfers, events, and access control stay in GameEscrow,
/// since a library must not move the contract's tokens. Mirrors BankrollLib's split.
///
/// `bankroll` is the operator's armed capital a new bet may lock exposure against. `locked` is the
/// full payout escrowed by live bets (operator exposure + the player's own stake). `rake` is accrued
/// operator rake awaiting withdrawal. Every unit is denominated in one token; the (operator, token)
/// key lives in GameEscrow's mapping, one Ledger per key — buckets never mix.
library EscrowLib {
    error InsufficientBankroll();

    struct Ledger {
        uint256 bankroll;
        uint256 locked;
        uint256 rake;
    }

    function creditBankroll(Ledger storage l, uint256 amount) internal {
        l.bankroll += amount;
    }

    function debitBankroll(Ledger storage l, uint256 amount) internal {
        if (l.bankroll < amount) revert InsufficientBankroll();
        l.bankroll -= amount;
    }

    /// @notice Reserve a bet at lock: only the operator's exposure leaves bankroll; `locked` grows by
    /// the full payout (the player's own stake, pulled by the caller, funds the remainder).
    function lock(Ledger storage l, uint256 exposure, uint256 payout) internal {
        if (l.bankroll < exposure) revert InsufficientBankroll();
        l.bankroll -= exposure;
        l.locked += payout;
    }

    /// @notice Player won: payout leaves `locked` to be paid to the player by the caller. bankroll is
    /// untouched — the exposure already left at lock.
    function settleWin(Ledger storage l, uint256 payout) internal {
        l.locked -= payout;
    }

    /// @notice Player lost: the whole reservation returns to the operator minus rake. bankroll gains
    /// (payout - rakeAmt) = exposure + stake - rake; rake accrues separately.
    function settleLoss(Ledger storage l, uint256 payout, uint256 rakeAmt) internal {
        l.locked -= payout;
        l.rake += rakeAmt;
        l.bankroll += (payout - rakeAmt);
    }

    /// @notice Refund (abort/timeout): only the operator's exposure returns to bankroll — the player
    /// reclaims their own stake directly (a transfer the caller performs).
    function refundExposure(Ledger storage l, uint256 payout, uint256 exposure) internal {
        l.locked -= payout;
        l.bankroll += exposure;
    }

    /// @notice Zero and return the accrued rake for withdrawal.
    function takeRake(Ledger storage l) internal returns (uint256 amt) {
        amt = l.rake;
        l.rake = 0;
    }
}
