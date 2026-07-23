// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// Pure on-chain dispute-replay mirror of the LADDER family of STATEFUL games. The ladder engine is the
/// mines pattern, generalized: a hidden layout is committed up front (here DERIVED from the sealed round
/// seed — commit = keccak256(abi.encode(uint256 seed)) — never house-placed), the player takes co-signed
/// steps, a running multiplier grows on each success, and the player either cashes out or busts. The
/// engine is game-agnostic; each game supplies a `resolveStep` that reads its OWN seed-derived layout.
///
/// Mirrored here (bit-for-bit port of examples/games/msgboard-games/src/ladder.ts + the per-game
/// resolvers): TOWERS (14), CHICKEN (15), GREED DICE (19). All three share the same replay
/// (`_settle`) and differ only in `_resolveStep`:
///   - towers:    partial Fisher–Yates over `tilesPerFloor` picks `safePerFloor` safe tiles per floor;
///                a step is safe iff the chosen tile is in that set. Factor = tiles/safe (constant).
///   - chicken:   single forced path (choice always 0); the lane crashes iff subRandom(seed,lane)%25 is
///                in the first `crashCount` outcomes. Factor = 25/(25-crashCount) (constant).
///   - greed dice: a 6-face die; the roll busts iff subRandom(seed,roll)%6 is in the first `bustFaces`
///                faces. Factor = 6/(6-bustFaces) (constant).
/// The remaining ladder games (firewalk, heist, hilo) use the SAME two resolver shapes (escalating
/// mod-probability / escalating Fisher–Yates / deck-rank pricing) and are a mechanical follow-on.
///
/// `settle` returns the conserved (balancePlayer, balanceHouse) split, same shape as GamePayouts; any
/// forged/inconsistent claim reverts. Parity is pinned by foundry vectors generated from the canonical
/// TS (test/foundry/LadderRules.t.sol).
library LadderRules {
    uint8 internal constant TOWERS_GAME_ID = 14;
    uint8 internal constant CHICKEN_GAME_ID = 15;
    uint8 internal constant GREED_DICE_GAME_ID = 19;

    uint256 internal constant HUNDREDTHS = 100;
    uint256 internal constant ONE_MINUS_EDGE_X100 = 99; // (10000 - 100)/100

    uint256 internal constant CHICKEN_OUTCOMES = 25;
    uint256 internal constant GREED_FACES = 6;

    error UnknownGame();
    error BadConfig();
    error CommitMismatch();
    error IllegalMove();
    error MultiplierMismatch();
    error PayoutExceedsPot();

    /// The co-signed ladder claim. `config` is the abi-encoded per-game config (see each resolver);
    /// `choices` is the ordered per-step choice sequence (towers: tile index; chicken/greed: 0);
    /// `cashedOut` distinguishes a claimed cash-out from a claimed bust; `claimedMultiplierX100` is the
    /// edged running multiplier claimed at settlement. `maxSteps` is the ladder height (forced win at top).
    struct LadderClaim {
        uint8 gameId;
        bytes config;
        bytes32 commit;
        uint256 seed;
        uint32 maxSteps;
        uint16[] choices;
        bool cashedOut;
        uint256 claimedMultiplierX100;
    }

    // ---------------------------------------------------------------------------
    // seed sub-stream + edge helpers — mirror rng.ts subRandom + ladder.ts edge
    // ---------------------------------------------------------------------------

    /// subRandom(raw, index) = uint256(keccak256(abi.encode(uint256 raw, uint64 index))) — mirror rng.ts.
    function _subRandom(uint256 raw, uint64 index) private pure returns (uint256) {
        return uint256(keccak256(abi.encode(raw, index)));
    }

    /// commitLayout(seed) = keccak256(abi.encode(uint256 seed)) — mirror ladder.ts.
    function commitLayout(uint256 seed) internal pure returns (bytes32) {
        return keccak256(abi.encode(seed));
    }

    /// edged((num/den)^steps) in hundredths — mirror compoundFairEdgedX100. One rational division.
    function _compoundFairEdgedX100(uint256 num, uint256 den, uint256 steps) private pure returns (uint256) {
        uint256 n = 1;
        uint256 d = 1;
        for (uint256 i = 0; i < steps; i++) {
            n *= num;
            d *= den;
        }
        return ((n * HUNDREDTHS) / d) * ONE_MINUS_EDGE_X100 / HUNDREDTHS;
    }

    // ---------------------------------------------------------------------------
    // per-game resolvers — each reads the seed-derived layout, returns (safe, running multiplier)
    // ---------------------------------------------------------------------------

    /// TOWERS config: abi.encode(uint256 floors, uint256 tilesPerFloor, uint256 safePerFloor).
    /// The safe set on a floor = a partial Fisher–Yates over [0,tilesPerFloor) picking `safePerFloor`
    /// tiles, driven by subRandom(seed, floor) — IDENTICAL uint256 division order to safeTilesOnFloor.
    function _towersSafe(uint256 seed, uint256 T, uint256 S, uint256 floor, uint256 tile)
        private
        pure
        returns (bool)
    {
        uint256[] memory pool = new uint256[](T);
        for (uint256 i = 0; i < T; i++) pool[i] = i;
        uint256 r = _subRandom(seed, uint64(floor));
        for (uint256 i = T - 1; i + 1 > T - S; i--) {
            uint256 window = i + 1;
            uint256 j = r % window;
            r = r / window;
            (pool[i], pool[j]) = (pool[j], pool[i]);
            if (pool[i] == tile) return true; // `tile` is in the safe set
            if (i == 0) break; // guard (unreachable while S < T): keep the loop underflow-safe
        }
        return false;
    }

    // ---------------------------------------------------------------------------
    // generic replay + settle
    // ---------------------------------------------------------------------------

    /// Resolve one step: is `choice` safe at `step`, and the running edged multiplier AFTER a safe step.
    function _resolveStep(LadderClaim memory claim, uint256 step, uint256 choice)
        private
        pure
        returns (bool safe, uint256 multX100)
    {
        if (claim.gameId == TOWERS_GAME_ID) {
            (uint256 floors, uint256 T, uint256 S) = abi.decode(claim.config, (uint256, uint256, uint256));
            if (floors != claim.maxSteps || S < 1 || S > T - 1 || T < 2) revert BadConfig();
            safe = _towersSafe(claim.seed, T, S, step, choice);
            multX100 = _compoundFairEdgedX100(T, S, step + 1);
        } else if (claim.gameId == CHICKEN_GAME_ID) {
            (uint256 lanes, uint256 crashCount) = abi.decode(claim.config, (uint256, uint256));
            if (lanes != claim.maxSteps || crashCount < 1 || crashCount >= CHICKEN_OUTCOMES) revert BadConfig();
            safe = (_subRandom(claim.seed, uint64(step)) % CHICKEN_OUTCOMES) >= crashCount;
            multX100 = _compoundFairEdgedX100(CHICKEN_OUTCOMES, CHICKEN_OUTCOMES - crashCount, step + 1);
        } else if (claim.gameId == GREED_DICE_GAME_ID) {
            (uint256 rolls, uint256 bustFaces) = abi.decode(claim.config, (uint256, uint256));
            if (rolls != claim.maxSteps || bustFaces < 1 || bustFaces >= GREED_FACES) revert BadConfig();
            safe = (_subRandom(claim.seed, uint64(step)) % GREED_FACES) >= bustFaces;
            multX100 = _compoundFairEdgedX100(GREED_FACES, GREED_FACES - bustFaces, step + 1);
        } else {
            revert UnknownGame();
        }
    }

    /// Adjudicate a disputed ladder session and return the conserved payout split. Reverts on any forged
    /// or inconsistent claim (wrong seed, illegal move sequence, inflated multiplier, cash-out/bust
    /// contradiction). `escrowPlayer` is the stake; the house escrow must cover the top-of-ladder
    /// multiplier (the escrow ceiling) for conservation to hold.
    function settle(
        LadderClaim memory claim,
        uint256 escrowPlayer,
        uint256 escrowHouse
    ) internal pure returns (uint256 balancePlayer, uint256 balanceHouse) {
        if (claim.maxSteps < 1) revert BadConfig();
        // 1) the revealed seed must match the layout commitment.
        if (commitLayout(claim.seed) != claim.commit) revert CommitMismatch();

        // 2) replay the choices through the engine (mirror ladderAdvance/verifyLadder).
        uint256 step = 0;
        bool busted = false;
        bool atTop = false;
        uint256 multX100 = HUNDREDTHS; // 1.00x at step 0
        uint16[] memory choices = claim.choices;
        for (uint256 i = 0; i < choices.length; i++) {
            if (step >= claim.maxSteps) revert IllegalMove(); // ladder already at the top
            (bool safe, uint256 stepMult) = _resolveStep(claim, step, choices[i]);
            if (!safe) {
                busted = true;
                multX100 = 0;
                break;
            }
            step++;
            multX100 = stepMult;
            if (step >= claim.maxSteps) { atTop = true; break; } // reaching the top forces a cash-out (win)
        }

        // 3) reconcile the claimed terminal phase with the replay.
        if (claim.cashedOut) {
            if (busted) revert IllegalMove();          // claimed cash-out but a step busted
            if (step == 0) revert IllegalMove();       // cannot cash out before any step
            // atTop ⇒ forced cash-out; otherwise a voluntary cash-out while PLAYING — both legal here.
        } else {
            if (!busted) revert IllegalMove();         // claimed bust but no step busted
        }

        // 4) the claimed multiplier must equal the honest replay (rejects inflation).
        if (multX100 != claim.claimedMultiplierX100) revert MultiplierMismatch();

        // 5) conserved payout split, same shape as GamePayouts.
        uint256 pot = escrowPlayer + escrowHouse;
        uint256 payout = (claim.cashedOut && !busted) ? (escrowPlayer * multX100) / HUNDREDTHS : 0;
        if (payout > pot) revert PayoutExceedsPot();
        balancePlayer = payout;
        balanceHouse = pot - payout;
    }
}
