// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// Pure on-chain dispute-replay mirror of the STATEFUL game MINES (gameId 5).
///
/// Unlike the single-draw games in GamePayouts — whose outcome is a pure function of the round random
/// `r` — Mines is a multi-step, co-signed session game: the house commits a HIDDEN board up front
/// (commit = hashBoard(tiles,mines,mineTiles[],salt)), the player reveals tiles one at a time (each a
/// co-signed step), and either cashes out the running multiplier or busts on a mine. Nothing but the
/// commitment is carried in the co-signed SessionState (the layout stays secret), so a permissionless
/// settle/dispute cannot be a function of `r` alone — it must REPLAY the revealed board against the
/// claimed move sequence.
///
/// `settle` is that replay. Given the revealed board (mineTiles + salt), the co-signed claim (config +
/// commit + ordered reveals + cashedOut + claimed multiplier) and the two escrows, it:
///   1. rechecks the board is well-formed and hashes to the committed `commit` (rejects a swapped board),
///   2. replays the reveals through the exact TS transition (safe → advance multiplier, mine → bust),
///   3. reconciles the claimed terminal phase (cash-out vs bust) with the replay,
///   4. requires the claimed multiplier to equal the honestly recomputed one (rejects inflation), and
///   5. returns the conserved (balancePlayer, balanceHouse) split, same shape as GamePayouts.
/// ANY inconsistency reverts — a forged settle tx simply fails, so the honest party settles and the
/// house cannot withhold a payout.
///
/// This is the bit-for-bit port of examples/games/msgboard-games/src/games/mines.ts (hashBoard,
/// validateConfig/validateBoard, fairMultiplierX100, applyMinesEdgeX100, multiplierX100At, reveal/
/// cashOut, verify). Parity with the TS reference is pinned by foundry vectors generated from the
/// canonical game code (test/foundry/MinesRules.t.sol).
library MinesRules {
    uint8 internal constant GAME_ID = 5;

    // shared constants — mirror examples/games/msgboard-games/src/game.ts + mines.ts
    uint256 internal constant EDGE_BPS = 100;               // 1% house edge (bps)
    uint256 internal constant HUNDREDTHS = 100;             // 1.00x == 100
    uint256 internal constant ONE_MINUS_EDGE_X100 = 99;     // (10000 - 100)/100
    uint256 internal constant MIN_TILES = 2;
    uint256 internal constant MAX_TILES = 256;              // keeps tile index in uint8 range off-chain

    error BadConfig();
    error BadBoard();
    error CommitMismatch();
    error BadReveal();
    error IllegalMove();
    error MultiplierMismatch();
    error PayoutExceedsPot();

    /// The co-signed claim being adjudicated. `tiles`/`mines` are the board config (part of the commit
    /// preimage); `reveals` is the ordered reveal sequence the player claims; `cashedOut` distinguishes
    /// a claimed cash-out (true) from a claimed bust (false); `claimedMultiplierX100` is the edged
    /// running multiplier (hundredths) the player claims at settlement.
    struct MinesClaim {
        uint16 tiles;
        uint16 mines;
        bytes32 commit;
        uint16[] reveals;
        bool cashedOut;
        uint256 claimedMultiplierX100;
    }

    // ---------------------------------------------------------------------------
    // commitment — mirror hashBoard in mines.ts
    // ---------------------------------------------------------------------------

    /// Canonical board commitment: keccak256(utf8("mines/board/v1/") ‖ uint16 tiles ‖ uint16 mines ‖
    /// uint16 mineTiles[] ‖ bytes32 salt). abi.encodePacked emits uint16 as 2 big-endian bytes, matching
    /// viem numberToHex(size: 2); the utf8 prefix matches stringToHex('mines/board/v1/').
    function hashBoard(uint16 tiles, uint16 mines, uint16[] memory mineTiles, bytes32 salt)
        internal
        pure
        returns (bytes32)
    {
        bytes memory pre = abi.encodePacked(bytes("mines/board/v1/"), tiles, mines);
        for (uint256 i = 0; i < mineTiles.length; i++) {
            pre = abi.encodePacked(pre, mineTiles[i]);
        }
        pre = abi.encodePacked(pre, salt);
        return keccak256(pre);
    }

    // ---------------------------------------------------------------------------
    // fixed-point multiplier — mirror fairMultiplierX100 / applyMinesEdgeX100 / multiplierX100At
    // ---------------------------------------------------------------------------

    /// Fair multiplier (hundredths, BEFORE edge) after revealing `safeRevealed` safe tiles of an
    /// (N tiles, M mines) board: fair = Π (N-i)/(S-i), S = N-M, as one rational bigint division to avoid
    /// compounding rounding. IDENTICAL operation order to fairMultiplierX100 in mines.ts.
    function fairMultiplierX100(uint256 tiles, uint256 mines, uint256 safeRevealed)
        internal
        pure
        returns (uint256)
    {
        uint256 safe = tiles - mines;
        require(safeRevealed <= safe, "mines: safeRevealed out of range");
        uint256 num = 1;
        uint256 den = 1;
        for (uint256 i = 0; i < safeRevealed; i++) {
            num *= (tiles - i);
            den *= (safe - i);
        }
        return (num * HUNDREDTHS) / den;
    }

    /// Running edged multiplier (hundredths) after `safeRevealed` safe reveals. 100 (1.00x) at k=0.
    function multiplierX100At(uint256 tiles, uint256 mines, uint256 safeRevealed)
        internal
        pure
        returns (uint256)
    {
        return (fairMultiplierX100(tiles, mines, safeRevealed) * ONE_MINUS_EDGE_X100) / HUNDREDTHS;
    }

    // ---------------------------------------------------------------------------
    // validation — mirror validateConfig / validateBoard
    // ---------------------------------------------------------------------------

    /// Mirror validateConfig: tiles in [MIN_TILES,MAX_TILES], mines in [1, tiles-1].
    function _validateConfig(uint256 tiles, uint256 mines) private pure {
        if (tiles < MIN_TILES || tiles > MAX_TILES) revert BadConfig();
        if (mines < 1 || mines > tiles - 1) revert BadConfig();
    }

    /// Mirror validateBoard: length == mines, each in range, strictly sorted ascending & distinct.
    function _validateBoard(uint256 tiles, uint256 mines, uint16[] memory mineTiles) private pure {
        if (mineTiles.length != mines) revert BadBoard();
        int256 prev = -1;
        for (uint256 i = 0; i < mineTiles.length; i++) {
            uint256 t = mineTiles[i];
            if (t >= tiles) revert BadBoard();
            if (int256(t) <= prev) revert BadBoard(); // strictly ascending ⇒ also distinct
            prev = int256(t);
        }
    }

    function _isMine(uint16[] memory mineTiles, uint256 tile) private pure returns (bool) {
        for (uint256 i = 0; i < mineTiles.length; i++) if (mineTiles[i] == tile) return true;
        return false;
    }

    // ---------------------------------------------------------------------------
    // dispute-replay settle — mirror verify() + playerDelta, in the GamePayouts conservation shape
    // ---------------------------------------------------------------------------

    /// Adjudicate a disputed Mines session and return the conserved payout split. Reverts on any forged
    /// or inconsistent claim (swapped board, out-of-range/duplicate reveal, mine-claimed-as-safe,
    /// inflated multiplier, cash-out/bust contradiction). `escrowPlayer` is the stake; the house escrow
    /// must cover the top-of-board multiplier (the escrow ceiling) for conservation to hold.
    function settle(
        MinesClaim memory claim,
        uint16[] memory mineTiles,
        bytes32 salt,
        uint256 escrowPlayer,
        uint256 escrowHouse
    ) internal pure returns (uint256 balancePlayer, uint256 balanceHouse) {
        // 1) board well-formed and matches the committed config + commitment.
        _validateConfig(claim.tiles, claim.mines);
        _validateBoard(claim.tiles, claim.mines, mineTiles);
        if (hashBoard(claim.tiles, claim.mines, mineTiles, salt) != claim.commit) revert CommitMismatch();

        // 2) replay the reveal sequence through the pure transition.
        uint256 safe = uint256(claim.tiles) - claim.mines;
        uint256 revealedCount = 0;
        bool busted = false;
        uint256 multX100 = HUNDREDTHS; // 1.00x at k=0
        uint16[] memory reveals = claim.reveals;
        for (uint256 i = 0; i < reveals.length; i++) {
            uint256 tile = reveals[i];
            if (tile >= claim.tiles) revert BadReveal();
            // duplicate check against earlier reveals (small boards; O(n^2) is fine)
            for (uint256 j = 0; j < i; j++) if (reveals[j] == tile) revert IllegalMove();
            if (_isMine(mineTiles, tile)) {
                busted = true;
                multX100 = 0;
                break; // reveals after a bust are ignored, exactly like the TS replay
            }
            revealedCount++;
            if (revealedCount > safe) revert IllegalMove(); // more safe reveals than safe tiles
            multX100 = multiplierX100At(claim.tiles, claim.mines, revealedCount);
        }

        // 3) reconcile the claimed terminal phase with the replay.
        if (claim.cashedOut) {
            if (busted) revert IllegalMove();        // claimed cash-out but a revealed tile was a mine
            if (revealedCount == 0) revert IllegalMove(); // cannot cash out before any reveal
        } else {
            if (!busted) revert IllegalMove();       // claimed bust but no revealed tile was a mine
        }

        // 4) the claimed multiplier must equal the honest replay (rejects inflation).
        if (multX100 != claim.claimedMultiplierX100) revert MultiplierMismatch();

        // 5) conserved payout split. CASHED_OUT pays stake*mult/100 (profit funded by escrowHouse);
        //    BUSTED pays 0. Same funds-conservation shape as GamePayouts.
        uint256 pot = escrowPlayer + escrowHouse;
        uint256 payout = (claim.cashedOut && !busted) ? (escrowPlayer * multX100) / HUNDREDTHS : 0;
        if (payout > pot) revert PayoutExceedsPot();
        balancePlayer = payout;
        balanceHouse = pot - payout;
    }
}
