// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// Shared P2P coin-flip scaffolding for FlipBook (variant A: escrowed native-value offers) and
/// FlipBookX (variant B: off-chain EIP-3009 offers over an x402 wrapper token). Extracted
/// byte-for-byte identical pieces only: the reveal-window bounds, the error names both books
/// revert with for identical conditions, and the comparison primitives (window-bounds check,
/// commit-opening check, reveal-window elapsed checks in both directions) that recur across their
/// take/reveal/claim paths.
///
/// Everything that differs between the two escrow models stays in the child: offer/flip storage
/// shape, post/cancel/withdraw (FlipBook only — FlipBookX has no on-chain standing offer or pull
/// fallback), the native-vs-ERC3009 payout paths, FlipBookX's second (taker) reveal phase and its
/// extra errors (UnknownFlip, ChoiceAlreadyRevealed, ChoiceNotRevealed), and FlipBook's own
/// UnknownOffer/NotMaker/NotTaken/WrongValue/NothingOwed. `AlreadyTaken` is reverted by both books
/// but over genuinely different underlying checks (an offer's `taker` field vs a flip mapping's
/// existence), so only the error name is shared here — the comparison stays inline in each child.
///
/// STORAGE NOTE: this base declares NO storage variables, so inheriting it does not shift either
/// child's own storage layout — unlike e.g. HousePoolBase, there is nothing to redeploy-note here.
abstract contract FlipBookBase {
    /// Reveal-window bounds: enough time for an honest reveal to land, short enough that a
    /// counterparty is never parked for long. Identical across both books.
    uint32 public constant MIN_REVEAL_WINDOW = 5 minutes;
    uint32 public constant MAX_REVEAL_WINDOW = 7 days;

    error ZeroStake(); // msg.value/stake must be positive
    error ZeroBond(); // a bond of 0 makes bailing on a loss free (even-money indifference)
    error BadWindow(); // a reveal window outside [MIN_REVEAL_WINDOW, MAX_REVEAL_WINDOW]
    error SelfTake(); // maker taking their own offer (wash flip)
    error OfferExpired(); // take after takeDeadline
    error AlreadyTaken(); // this offer/flip is already locked in
    error BadReveal(); // (value, salt) does not hash to the commit
    error RevealWindowOver(); // reveal after the window — the default/forfeit path owns it now
    error RevealWindowOpen(); // claim before the window has lapsed

    /// Bounds-check a reveal window against [MIN_REVEAL_WINDOW, MAX_REVEAL_WINDOW].
    function _checkWindow(uint32 window) internal pure {
        if (window < MIN_REVEAL_WINDOW || window > MAX_REVEAL_WINDOW) revert BadWindow();
    }

    /// Revert SelfTake() if the taker and maker are the same address.
    function _checkNotSelf(address taker, address maker) internal pure {
        if (taker == maker) revert SelfTake();
    }

    /// Revert OfferExpired() once the take deadline has passed.
    function _checkNotExpired(uint64 takeDeadline) internal view {
        if (block.timestamp > takeDeadline) revert OfferExpired();
    }

    /// Open a commit: keccak256(abi.encode(who, value, salt)) must equal `commit`, else BadReveal().
    function _checkCommit(address who, bool value, bytes32 salt, bytes32 commit) internal pure {
        if (keccak256(abi.encode(who, value, salt)) != commit) revert BadReveal();
    }

    /// Revert RevealWindowOver() once `window` seconds have elapsed since `startedAt`. Gates the
    /// reveal / choice-reveal / guess-reveal paths, which must land inside their window.
    function _checkWithinWindow(uint256 startedAt, uint32 window) internal view {
        if (block.timestamp > startedAt + window) revert RevealWindowOver();
    }

    /// Revert RevealWindowOpen() while fewer than `window` seconds have elapsed since `startedAt`.
    /// Gates the claim / default paths, which are only live once the window has lapsed.
    function _checkWindowElapsed(uint256 startedAt, uint32 window) internal view {
        if (block.timestamp <= startedAt + window) revert RevealWindowOpen();
    }
}
