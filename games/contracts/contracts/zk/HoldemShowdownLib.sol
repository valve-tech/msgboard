// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {EllipticCurve} from "./lib/EllipticCurve.sol";
import {CardTableSecp} from "./CardTableSecp.sol";
import {RevealShareDLEQ} from "./lib/RevealShareDLEQ.sol";
import {SidePot} from "./ChannelStateN.sol";
import {IGameRulesN} from "./IGameRulesN.sol";
import {LibString} from "solady/src/utils/LibString.sol";

/// @notice EXTERNAL (separately-deployed) library housing HoldemTableN's C2 (DEMAND_SHOWDOWN)
/// showdown-share decode + reveal-verification + reveal-completeness logic — extracted out of
/// HoldemTableN.sol for the SAME EIP-170 reason DeckChallengeLib/ShowdownDecodeLib are external
/// (see their headers): the secp256k1 point arithmetic (EllipticCurve.ecAdd/ecMul, pulled in
/// transitively by RevealShareDLEQ.verify) and CardTableSecp's 52-branch decode table are large,
/// cold-path, dispute-only code that does not need to live in HoldemTableN's own deployed
/// bytecode. Beyond the raw crypto, this library ALSO hosts the per-share bookkeeping
/// (required-slot gate, first-write-wins duplicate check, and the storage write itself) and the
/// whole-showdown decode loop, so HoldemTableN's own bytecode only ever contains thin
/// orchestration calling into here — see `verifyAndStoreShare`/`decodeShowdown` below.
///
/// Holds NO storage of its own; every mapping it touches is the CALLING contract's own storage,
/// passed by reference (see the storage-key scheme note below) — this only works because a
/// library function that is `external` (not `internal`) and takes a storage-reference parameter
/// is invoked via DELEGATECALL, which shares the caller's storage context, so the base storage
/// slot alone (ABI-encoded as a single word) is enough for this library to read AND write the
/// caller's mapping correctly.
///
/// Several errors below deliberately mirror an identically-named, identically-shaped error
/// already declared on HoldemTableN/ChannelTableBase (`BadDemand`, `BadShareProof`,
/// `NotRequiredSlot`, `AlreadyRevealed`) — a Solidity custom error's 4-byte selector is purely a
/// function of its signature text, not which contract/library declares it, so a revert
/// originating HERE (inside a delegatecall) still matches e.g.
/// `vm.expectRevert(HoldemTableN.BadShareProof.selector)` on the caller side exactly as if
/// HoldemTableN had reverted it directly (mirrors DeckChallengeLib's identical technique — see
/// that file's header for the same rationale).
///
/// STORAGE-KEY SCHEME (HoldemTableN's epoch-keyed reveal accumulator — see that file's header):
///   share key  = (epoch << 24) | (slot << 8) | seat   -> mapping(uint256 => uint256[2]) (x, y)
///   posted key = (epoch << 8)  | seat                 -> mapping(uint256 => uint32) count
/// `epoch` bumps forward-only on every `openShowdownDispute`, so a stale cycle's cells become
/// permanently unreachable without ever needing an O(N*slots) delete — this library only ever
/// reads/writes cells addressed by the CURRENT epoch its caller passes in.
///
/// Slot layout (derived from `n` seats, mirrors games/holdem's `dealSeq.ts` dealPlan): seat `s`'s
/// two hole cards are slots `[s, n+s]`; the 5 board cards are slots `[2n, 2n+1, 2n+2, 2n+3, 2n+4]`.
/// `(0, 0)` in a share cell means "not yet posted" (secp256k1 has no valid point at the origin —
/// see EllipticCurve's own infinity-sentinel convention), which every read path here treats as
/// "cannot decode this slot" rather than a valid point.
library HoldemShowdownLib {
    using RevealShareDLEQ for RevealShareDLEQ.Statement;

    /// Mirrors ChannelTableBase.BadDemand (same selector) — a malformed slot/deck pairing.
    error BadDemand();
    /// Mirrors HoldemTableN.BadShareProof (same selector) — a failed DLEQ check.
    error BadShareProof();
    /// Mirrors HoldemTableN.NotRequiredSlot (same selector) — `slot` is not one this dispute
    /// cycle needs decoded (see `_isRequiredSlot`'s header).
    error NotRequiredSlot();
    /// Mirrors HoldemTableN.AlreadyRevealed (same selector) — first-write-wins on a duplicate post.
    error AlreadyRevealed();
    /// Mirrors ChannelTableBase.BadDeck (same selector) — malformed deck length in `deckHash`.
    error BadDeck();
    /// Mirrors ChannelTableBase.BadGameState (same selector) — a mismatched game-state hash.
    error BadGameState();

    /// keccak over the 33-byte COMPRESSED SEC1 encoding of every card's (c1, c2) in slot order —
    /// the on-chain mirror of zk-core `deckCommitment(deck)` (which hashes the same compressed
    /// wire points). Binds a passed affine deck to a co-signed bytes32 commitment. Moved here
    /// (EIP-170) from HoldemTableN._deckHash verbatim — same loop, same encoding, same revert.
    function deckHash(uint256[] calldata deck) external pure returns (bytes32) {
        return _deckHash(deck);
    }

    function _deckHash(uint256[] calldata deck) private pure returns (bytes32) {
        if (deck.length % 4 != 0) revert BadDeck();
        bytes memory acc;
        for (uint256 i = 0; i < deck.length; i += 4) {
            acc = abi.encodePacked(
                acc,
                bytes1(uint8(2 + (deck[i + 1] & 1))), bytes32(deck[i]),     // compress c1
                bytes1(uint8(2 + (deck[i + 3] & 1))), bytes32(deck[i + 2])  // compress c2
            );
        }
        return keccak256(acc);
    }

    /// Shared hash-pin guard for HoldemTableN's `finalizeShowdownN`/`resolveShowdownTimeout`
    /// (EIP-170 — moved here verbatim from `HoldemTableN._pinShowdown`): `deck` must hash (via
    /// `_deckHash` above) to `deckCommitment`, and `gameState` must hash (via the game's own
    /// `rules.hashGameState`) to `gameStateHash` — both pinned at `openShowdownDispute` time.
    function pinShowdown(
        IGameRulesN rules,
        uint256[] calldata deck,
        bytes calldata gameState,
        bytes32 deckCommitment,
        bytes32 gameStateHash
    ) external view {
        if (_deckHash(deck) != deckCommitment) revert BadDeck();
        if (rules.hashGameState(gameState) != gameStateHash) revert BadGameState();
    }

    /// The per-cycle showdown-dispute parameters `openShowdownDispute` snapshots (EIP-170 — moved
    /// here verbatim from HoldemTableN, including the `_popcount` it needed only for this):
    /// `requiredCount` = 0 for a STUB (single live seat, nothing to decode) else `2*popcount(liveMask)+5`
    /// (both hole slots of every live seat, plus the 5 board slots); `answeredMask` starts fully
    /// set for a STUB (nothing to wait for) else empty; `deadlineCeil` bounds how far
    /// `postShowdownReveals` can ever push the dispute clock out — `(nSeats+3)` chess-clock
    /// windows from THIS block, regardless of how many reveal batches get posted.
    function computeCycle(uint8 nSeats, uint256 liveMask, bool stub, uint64 clockBlocks)
        external
        view
        returns (uint32 requiredCount, uint16 answeredMask, uint64 deadlineCeil)
    {
        if (stub) {
            answeredMask = uint16((uint256(1) << nSeats) - 1);
        } else {
            uint256 c;
            uint256 m = liveMask;
            while (m != 0) {
                c += m & 1;
                m >>= 1;
            }
            requiredCount = uint32(2 * c + 5);
        }
        deadlineCeil = uint64(block.number) + (uint64(nSeats) + 3) * clockBlocks;
    }

    /// True iff `slot` is one this showdown dispute cycle actually needs decoded: any of the 5
    /// board slots `[2n, 2n+5)`, or either hole slot `[s, n+s]` of a seat `s` that was LIVE
    /// (non-folded) in the contested state. A folded seat's hole cards are never required — their
    /// privacy is preserved (nobody needs to decode a card that plays no role in ranking). In the
    /// STUB case (`requiredCount == 0`, exactly one live seat already swept the pot(s) off-chain)
    /// NOTHING is required.
    function _isRequiredSlot(uint256 liveMask, uint256 n, uint256 requiredCount, uint256 slot) private pure returns (bool) {
        if (requiredCount == 0) return false;
        if (slot >= 2 * n && slot < 2 * n + 5) return true;
        if (slot < n) return (liveMask >> slot) & 1 == 1;
        if (slot < 2 * n) return (liveMask >> (slot - n)) & 1 == 1;
        return false;
    }

    /// Mirrors HoldemTableN.ShowdownRevealStored exactly (same topic hash — see this file's
    /// header on selector/topic mirroring): emitted from WITHIN this delegatecalled library, a
    /// LOG still records under HoldemTableN's own address (delegatecall preserves the logical
    /// contract identity for both storage AND logs), so off-chain indexers watching HoldemTableN
    /// see it exactly as if HoldemTableN had emitted it directly.
    event ShowdownRevealStored(bytes32 indexed tableId, uint32 slot, uint8 seat, uint256 x, uint256 y);

    /// Reconstruct the replay-binding ctx string exactly as zk-core `ctxFor(tableId, slot)` (and
    /// HoldemTableN's own `_ctxFor`, kept there too for `respondWithShare`'s single-slot path):
    ///   "holdem/" ‖ 0x-prefixed 32-byte lowercase hex tableId ‖ "/slot/" ‖ decimal slot.
    function _ctxFor(bytes32 tableId, uint32 slot) private pure returns (string memory) {
        return string.concat("holdem/", LibString.toHexString(uint256(tableId), 32), "/slot/", LibString.toString(uint256(slot)));
    }

    /// Verify + store a WHOLE BATCH of one seat's DLEQ-proven decryption shares in a single
    /// external call (EIP-170 — see this file's header): required-slot gating, first-write-wins
    /// duplicate rejection, the DLEQ check, the storage write, AND the `ShowdownRevealStored`
    /// event for every (slot, share, proof) triple all happen HERE, so `deck` (up to 208 words)
    /// is ABI-encoded into calldata for this call exactly ONCE regardless of batch size — the
    /// per-slot version this replaced re-encoded the full `deck` array once PER SLOT. Reverts
    /// `NotRequiredSlot` / `AlreadyRevealed` / `BadDemand` / `BadShareProof` exactly as
    /// HoldemTableN's own inline checks would (selector mirroring — see this file's header), so
    /// `postShowdownReveals`' caller-visible behavior is unchanged by hosting this here. Returns
    /// `complete = true` once this seat's TOTAL posted-share count (prior + this batch) reaches
    /// `requiredCount`, telling the caller whether to flip its `answeredMask` bit.
    function postReveals(
        mapping(uint256 => uint256[2]) storage share,
        mapping(uint256 => uint32) storage posted,
        uint256 liveMask,
        uint256 n,
        uint256 requiredCount,
        uint64 epoch,
        uint8 seat,
        uint256 pkX,
        uint256 pkY,
        uint256[] calldata deck,
        uint32[] calldata slots,
        uint256[2][] calldata shares,
        uint256[5][] calldata proofs,
        bytes32 tableId
    ) external returns (bool complete) {
        if (slots.length != shares.length || slots.length != proofs.length) revert BadDemand();

        uint256 postedKey = (uint256(epoch) << 8) | seat;
        uint32 total = posted[postedKey];

        for (uint256 i = 0; i < slots.length; i++) {
            uint32 slot = slots[i];
            if (!_isRequiredSlot(liveMask, n, requiredCount, slot)) revert NotRequiredSlot();
            uint256 base = uint256(slot) * 4;
            if (base + 4 > deck.length) revert BadDemand();

            uint256[2] storage cell = share[(uint256(epoch) << 24) | (uint256(slot) << 8) | seat];
            if (cell[0] != 0 || cell[1] != 0) revert AlreadyRevealed();

            RevealShareDLEQ.Statement memory st = RevealShareDLEQ.Statement({
                pkX: pkX, pkY: pkY,
                c1X: deck[base],     c1Y: deck[base + 1],
                c2X: deck[base + 2], c2Y: deck[base + 3],
                dX: shares[i][0], dY: shares[i][1],
                t1X: proofs[i][0], t1Y: proofs[i][1],
                t2X: proofs[i][2], t2Y: proofs[i][3],
                z: proofs[i][4]
            });
            if (!st.verify(_ctxFor(tableId, slot))) revert BadShareProof();

            cell[0] = shares[i][0];
            cell[1] = shares[i][1];
            emit ShowdownRevealStored(tableId, slot, seat, shares[i][0], shares[i][1]);
            total++;
        }
        posted[postedKey] = total;
        complete = total >= requiredCount;
    }

    /// Decode showdown slot `slot`'s plaintext card from the ACCUMULATED per-seat decryption
    /// shares (Σ over all `n` seats — the joint-key ElGamal scheme needs every seat's
    /// contribution to peel one layer of masking off ANY slot, live or folded, ranked or not).
    /// `ok = false` (never reverts) when: any of the `n` seats has not yet posted a share for
    /// this slot (a `(0, 0)` cell), OR the fully-unmasked point does not land on one of the 52
    /// canonical card points (a decoy/garbage masking key, or a duplicate-card deck) — the
    /// caller treats either as "this decode is unattributably bad" and falls back to a split,
    /// never a steal (mirrors ZkTable's `ShowdownDecodeLib` garbage-branch reasoning, generalized
    /// from 2 seats to N).
    function decodeSlot(
        mapping(uint256 => uint256[2]) storage share,
        uint256[] calldata deck,
        uint32 slot,
        uint256 n,
        uint64 epoch
    ) external view returns (bool ok, uint8 card) {
        return _decodeOne(share, deck, slot, n, epoch);
    }

    function _decodeOne(
        mapping(uint256 => uint256[2]) storage share,
        uint256[] calldata deck,
        uint32 slot,
        uint256 n,
        uint64 epoch
    ) private view returns (bool ok, uint8 card) {
        uint256 sumX;
        uint256 sumY;
        bool haveSum;
        uint256 base = (uint256(epoch) << 24) | (uint256(slot) << 8);
        for (uint256 seat = 0; seat < n; seat++) {
            uint256[2] storage cell = share[base | seat];
            uint256 x = cell[0];
            uint256 y = cell[1];
            if (x == 0 && y == 0) return (false, 0); // this seat hasn't posted its share yet
            if (!haveSum) {
                sumX = x;
                sumY = y;
                haveSum = true;
            } else {
                (sumX, sumY) = EllipticCurve.ecAdd(sumX, sumY, x, y);
            }
        }
        // card = c2 - Σshares = c2 + (-Σshares); negate by flipping y (mod field prime PP).
        uint256 deckBase = uint256(slot) * 4;
        uint256 c2x = deck[deckBase + 2];
        uint256 c2y = deck[deckBase + 3];
        uint256 negY = sumY == 0 ? 0 : (EllipticCurve.PP - sumY);
        (uint256 rx, uint256 ry) = EllipticCurve.ecAdd(c2x, c2y, sumX, negY);
        return CardTableSecp.matchCard(rx, ry);
    }

    /// Whole-showdown decode: the 5 board slots plus both hole slots of every seat in `rankMask`,
    /// tracking a 52-bit used-card bitmap so a duplicate decode (only possible via a
    /// masking-side deviation) is caught exactly like an off-table decode. `clean=false` the
    /// moment either happens; `holes`/`board` past that point are partial and MUST NOT be
    /// trusted by the caller (which only ever reads them when `clean==true`). `requiredCount==0`
    /// (the STUB case) returns `clean=true` with empty holes/board immediately — nothing to
    /// decode, the game's own uncontested-hand path already swept the pot(s).
    function decodeShowdown(
        mapping(uint256 => uint256[2]) storage share,
        uint256[] calldata deck,
        uint256 n,
        uint64 epoch,
        uint32 requiredCount,
        uint256 rankMask
    ) external view returns (bool clean, uint8[2][] memory holes, uint8[5] memory board) {
        return _decodeShowdown(share, deck, n, epoch, requiredCount, rankMask);
    }

    function _decodeShowdown(
        mapping(uint256 => uint256[2]) storage share,
        uint256[] calldata deck,
        uint256 n,
        uint64 epoch,
        uint32 requiredCount,
        uint256 rankMask
    ) private view returns (bool clean, uint8[2][] memory holes, uint8[5] memory board) {
        holes = new uint8[2][](n);
        clean = true;
        if (requiredCount == 0) return (clean, holes, board);

        uint256 usedMask;
        for (uint256 i = 0; i < 5; i++) {
            (bool ok, uint8 card) = _decodeOne(share, deck, uint32(2 * n + i), n, epoch);
            if (!ok || (usedMask >> card) & 1 == 1) return (false, holes, board);
            usedMask |= (uint256(1) << card);
            board[i] = card;
        }
        for (uint256 s = 0; s < n; s++) {
            if ((rankMask >> s) & 1 == 0) continue; // not ranked -> holes stay zero, never read
            for (uint256 h = 0; h < 2; h++) {
                (bool ok, uint8 card) = _decodeOne(share, deck, uint32(s + h * n), n, epoch);
                if (!ok || (usedMask >> card) & 1 == 1) return (false, holes, board);
                usedMask |= (uint256(1) << card);
                holes[s][h] = card;
            }
        }
    }

    /// Cheap PRESENCE-only completeness check (no point arithmetic, no card matching): true iff
    /// every one of the 5 board slots AND both hole slots of every seat named in `mask` have all
    /// `n` seats' shares posted for the CURRENT `epoch`. Used by HoldemTableN's answer-aware
    /// `resolveShowdownTimeout` to decide whether a ranked settle is even attemptable before
    /// paying the gas to try (a garbage/duplicate decode is still caught downstream by
    /// `decodeShowdown`, which falls back to a split exactly as it would on a `finalizeShowdownN`
    /// path — `rankable` only screens out the case a required slot has NO chance of decoding at
    /// all because some seat withheld its column entirely).
    function rankable(mapping(uint256 => uint256[2]) storage share, uint64 epoch, uint256 n, uint256 mask)
        external
        view
        returns (bool)
    {
        for (uint256 i = 0; i < 5; i++) {
            if (!_allPosted(share, epoch, 2 * n + i, n)) return false;
        }
        for (uint256 s = 0; s < n; s++) {
            if ((mask >> s) & 1 == 0) continue;
            if (!_allPosted(share, epoch, s, n)) return false;
            if (!_allPosted(share, epoch, s + n, n)) return false;
        }
        return true;
    }

    function _allPosted(mapping(uint256 => uint256[2]) storage share, uint64 epoch, uint256 slot, uint256 n)
        private
        view
        returns (bool)
    {
        uint256 base = (uint256(epoch) << 24) | (slot << 8);
        for (uint256 seat = 0; seat < n; seat++) {
            uint256[2] storage cell = share[base | seat];
            if (cell[0] == 0 && cell[1] == 0) return false;
        }
        return true;
    }

    /// The Chaum–Pedersen DLEQ host for `respondWithShare` (the pre-existing SHARE-dispute
    /// answer): relocates `RevealShareDLEQ.verify` (and, transitively, EllipticCurve's
    /// `ecMul`/`ecAdd`/`invMod` bodies it calls) OUT of HoldemTableN's own deployed bytecode.
    /// Takes the DLEQ statement's 13 scalar fields directly (rather than a pre-built
    /// `RevealShareDLEQ.Statement` — see `verifyAndStoreShare`'s identical convention) so the
    /// caller never has to assemble a local memory struct just to hand it straight to this one
    /// external call.
    function verifyShare(
        uint256 pkX, uint256 pkY,
        uint256 c1X, uint256 c1Y, uint256 c2X, uint256 c2Y,
        uint256 dX, uint256 dY,
        uint256 t1X, uint256 t1Y, uint256 t2X, uint256 t2Y,
        uint256 z,
        string memory ctx
    ) external pure returns (bool) {
        RevealShareDLEQ.Statement memory s = RevealShareDLEQ.Statement({
            pkX: pkX, pkY: pkY,
            c1X: c1X, c1Y: c1Y,
            c2X: c2X, c2Y: c2Y,
            dX: dX, dY: dY,
            t1X: t1X, t1Y: t1Y,
            t2X: t2X, t2Y: t2Y,
            z: z
        });
        return s.verify(ctx);
    }

    /// Combines `decodeShowdown` + a `settleShowdown` try/catch + the belt-and-braces
    /// conservation re-check into ONE external call — `HoldemTableN._settleShowdown` calls this
    /// exactly once instead of chaining `decodeShowdown` then a separate settle call, so the
    /// decoded `holes`/`board` never have to round-trip back out through HoldemTableN's own
    /// bytecode just to be handed straight to the rules contract (EIP-170 — every byte of ABI
    /// marshalling for that nested array at the HoldemTableN boundary is bytecode HoldemTableN
    /// would otherwise carry). `ok=false` on ANY failure — an unclean decode (bad/duplicate
    /// card), a reverting rules contract, a wrong-length vector, an over-`rakeCap` rake, or a
    /// non-conserving total (never trust the rules contract's own arithmetic; re-derive Σ escrow
    /// fresh) — `HoldemTableN._settleShowdown` treats that uniformly as "fall back to
    /// `_splitShowdownPots`", exactly as it did before this EIP-170 extraction.
    function settleOrFail(
        mapping(uint256 => uint256[2]) storage share,
        uint256[] calldata deck,
        uint256 n,
        uint64 epoch,
        uint32 requiredCount,
        uint256 rankMask,
        IGameRulesN rules,
        bytes calldata gameState,
        uint256 extraFoldMask,
        uint256[] calldata escrow,
        uint256 rakeCap
    ) external view returns (bool ok, uint256[] memory payouts, uint256 rake) {
        (bool clean, uint8[2][] memory holes, uint8[5] memory board) =
            _decodeShowdown(share, deck, n, epoch, requiredCount, rankMask);
        if (!clean) return (false, payouts, rake);

        try rules.settleShowdown(gameState, holes, board, extraFoldMask) returns (uint256[] memory p, uint256 r) {
            if (p.length != n || r > rakeCap) return (false, payouts, rake);
            uint256 sumEscrow;
            uint256 sumOut = r;
            for (uint256 i = 0; i < n; i++) {
                sumEscrow += escrow[i];
                sumOut += p[i];
            }
            if (sumOut != sumEscrow) return (false, payouts, rake);
            return (true, p, r);
        } catch {
            return (false, payouts, rake);
        }
    }

    /// The guaranteed-terminal split fallback for `HoldemTableN._splitShowdownPots` (EIP-170 —
    /// see that function's header for the full tiering rationale): refund `balances` as the
    /// payout base, then split `pot` and every `sidePots[k].amount` among the best-available
    /// tier of `(eligible, live, prefer)` — see `_tieredMask`. `full` (every real seat) is
    /// ALWAYS the last-resort tier, so no `_distributeTier` call here can ever see an empty mask.
    function splitPots(
        uint256[] calldata balances,
        uint256 pot,
        SidePot[] calldata sidePots,
        uint256 liveMask,
        uint256 prefer
    ) external pure returns (uint256[] memory payouts) {
        uint256 n = balances.length;
        payouts = new uint256[](n);
        for (uint256 i = 0; i < n; i++) payouts[i] = balances[i];

        uint256 full = (uint256(1) << n) - 1;
        _distributeTier(payouts, pot, _tieredMask(full, liveMask, prefer, full));
        for (uint256 k = 0; k < sidePots.length; k++) {
            _distributeTier(payouts, sidePots[k].amount, _tieredMask(sidePots[k].eligibleMask, liveMask, prefer, full));
        }
    }

    /// First non-empty of: `eligible & live & prefer`, `eligible & live`, `eligible`, `full`.
    /// `full` (every real seat) is always non-empty for a >=2-seat table, so this NEVER returns
    /// an empty mask.
    function _tieredMask(uint256 eligible, uint256 live, uint256 prefer, uint256 full) private pure returns (uint256) {
        uint256 m = eligible & live & prefer;
        if (m != 0) return m;
        m = eligible & live;
        if (m != 0) return m;
        if (eligible != 0) return eligible;
        return full;
    }

    /// Mirrors HoldemTableN._distribute exactly (duplicated, not shared — an internal function on
    /// one side of an external-library boundary cannot be called from the other): split `amount`
    /// equally among the seats set in `mask`, remainder to the lowest-index eligible seat. `mask`
    /// is guaranteed non-empty by `_tieredMask`'s `full` fallback, so — unlike `_distribute` —
    /// this never needs an empty-mask revert guard.
    function _distributeTier(uint256[] memory payouts, uint256 amount, uint256 mask) private pure {
        if (amount == 0) return;
        uint256 n = payouts.length;
        uint256 count;
        for (uint256 i = 0; i < n; i++) if (mask & (uint256(1) << i) != 0) count++;
        uint256 share = amount / count;
        uint256 rem = amount - share * count;
        bool remGiven = false;
        for (uint256 i = 0; i < n; i++) {
            if (mask & (uint256(1) << i) == 0) continue;
            payouts[i] += share;
            if (!remGiven) {
                payouts[i] += rem;
                remGiven = true;
            }
        }
    }
}
