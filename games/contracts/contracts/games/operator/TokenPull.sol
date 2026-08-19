// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {SafeTransferLib} from "solady/src/utils/SafeTransferLib.sol";

/// @notice One audited copy of the "pull a token and measure the real delta" primitive. GameEscrow and
/// OperatorCoinFlip each held a byte-identical `_pullVerified`; both now call this instead, so the
/// fee-on-transfer reasoning lives in one place (code-review §1).
///
/// The functions are `internal`, so the compiler inlines them into the caller. `address(this)` therefore
/// resolves to the CALLING contract, and the pulled tokens land in that contract's own balance — the same
/// behaviour the two inline copies had.
library TokenPull {
    using SafeTransferLib for address;

    /// @notice Pull `amount` of `token` from `from` into the caller and return the MEASURED delta actually
    /// received. Crediting the delta (not the requested amount) keeps the books exact for fee-on-transfer
    /// tokens and contains any such token to its own bucket. NOTE: this measures only the DEPOSIT-time
    /// delta — a token that rebases (balance drifts) BETWEEN two measurements is not re-measured, so a
    /// genuinely rebasing token can desync a bucket. Such tokens are out of the supported set; the caller's
    /// per-bucket isolation still confines any damage to that token's own bucket.
    function measured(address token, address from, uint256 amount) internal returns (uint256 received) {
        uint256 balBefore = token.balanceOf(address(this));
        token.safeTransferFrom(from, address(this), amount);
        received = token.balanceOf(address(this)) - balBefore;
    }
}
