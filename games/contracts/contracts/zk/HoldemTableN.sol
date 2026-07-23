// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {EIP712} from "solady/src/utils/EIP712.sol";
import {ECDSA} from "solady/src/utils/ECDSA.sol";
import {SafeTransferLib} from "solady/src/utils/SafeTransferLib.sol";
import {LibString} from "solady/src/utils/LibString.sol";
import {ChannelStateN, ChannelStateNLib, SidePot} from "./ChannelStateN.sol";
import {IGameRulesN} from "./IGameRulesN.sol";
import {RevealShareDLEQ} from "./lib/RevealShareDLEQ.sol";
import {EllipticCurve} from "./lib/EllipticCurve.sol";

/// @notice N-party state-channel card table (3–9 seats; supports N=2). Generalizes ZkTable:
/// seats escrow buy-ins, play is off-chain N-of-N co-signed ChannelStateN, and the chain is
/// touched only to settle, dispute, or enforce a per-seat forced-fold-on-timeout so one
/// disconnect cannot freeze the N−1 honest seats. THIN CHAIN: no poker rules here — phases,
/// turns and moves are delegated to an IGameRulesN. The conservation invariant
///   Σ balances + pot + Σ sidePots + rakeAccrued == Σ escrow
/// is enforced on every accepted state, so every settle / forced-fold / dispute-resolve pays
/// out exactly Σ escrow.
///
/// SHARE-DISPUTE (real-money Gate 1, CLOSED): a contested decryption-SHARE demand is now
/// answerable on-chain. A share's correctness is exactly a Chaum–Pedersen DLEQ statement
/// (share d = c1·sk, deck pubkey pk = G·sk, SAME sk), verified by RevealShareDLEQ over
/// secp256k1 — the SAME curve as the off-chain `zk-cards-core` deck (the vendored uzkge
/// ChaumPedersenDL verifier is EdOnBN254, the wrong curve, so it cannot check our live
/// shares). An honest seat can therefore ALWAYS satisfy a SHARE demand with its correct
/// share + proof and can never be force-folded on the clock; a forged share reverts.
/// Seats register their deck pubkey via registerDeckKey() while Forming (the same pubkeys
/// that form the off-chain joint encryption key).
contract HoldemTableN is EIP712 {
    using SafeTransferLib for address;
    using ChannelStateNLib for ChannelStateN;
    using RevealShareDLEQ for RevealShareDLEQ.Statement;

    error WrongValue();
    error BadClock();
    error BadStatus();
    error NotPlayer();
    error WrongTable();
    error BadSig();
    error NotFinal();
    error PotNotZero();
    error ConservationViolated();
    error StaleNonce();
    error BadRules();
    error ClockNotExpired();
    error NotYourDispute();
    error NotDemanded();
    error NotYourTurn();
    error BadGameState();
    error BadDemand();
    error BadSeatCount();
    error DuplicateKey();
    error TooManySeats();
    error NotEnoughSeats();
    error RakeTooHigh();
    error WrongSigCount();
    error SeatRange();
    error BadDeckKey();
    error DeckKeyNotSet();
    error BadDeck();
    error BadShareProof();

    uint8 internal constant DEMAND_MOVE = 1;
    uint8 internal constant DEMAND_SHARE = 2;

    uint256 public constant MAX_SEATS = 9;
    uint256 public constant MAX_RAKE_BPS = 250; // 2.5%
    uint64 public constant MIN_CLOCK_BLOCKS = 30;     // ~5 min at 10s blocks
    uint64 public constant MAX_CLOCK_BLOCKS = 60480;  // ~1 week

    enum Status { None, Forming, Live, Disputed, Settled, Cancelled }

    struct Table {
        IGameRulesN rules;
        uint256 buyIn;          // exact amount each joiner escrows
        uint256 maxSeats;
        uint16 rakeBps;
        uint256 rakeCap;
        uint64 clockBlocks;
        Status status;
        uint64 checkpointNonce; // highest nonce co-signed on-chain
        bool hasCheckpoint;
        address[] seats;        // wallet per seat
        address[] channelKeys;  // channel signing key per seat (may differ from wallet)
        uint256[] escrow;       // per-seat escrow
        // dispute fields
        uint64 disputeDeadline;
        uint8 demandSeat;       // the seat that owes the demanded action
        uint8 demandKind;
        uint32 demandSlot;
        ChannelStateN disputeState;
    }

    address public immutable treasury;
    uint256 internal _counter;
    mapping(bytes32 => Table) internal _tables;
    /// tableId => seat index => secp256k1 deck pubkey (x,y). (0,0) == unset (not on-curve).
    /// These are the SAME per-seat keys that aggregate into the off-chain joint deck key;
    /// registered while Forming and read by respondWithShare to check a contested share.
    mapping(bytes32 => mapping(uint256 => uint256[2])) internal _deckKey;

    event TableCreated(bytes32 indexed tableId, address indexed creator, address rules, uint256 buyIn, uint256 maxSeats, uint16 rakeBps, uint256 rakeCap, uint64 clockBlocks);
    event TableJoined(bytes32 indexed tableId, address indexed player, uint256 seat);
    event TableStarted(bytes32 indexed tableId, uint256 seatCount);
    event TableCancelled(bytes32 indexed tableId);
    event SeatLeft(bytes32 indexed tableId, uint256 seat);
    event TableSettled(bytes32 indexed tableId, uint256[] payouts, uint256 rake);
    event DisputeOpened(bytes32 indexed tableId, uint8 demandSeat, uint8 demandKind, uint32 demandSlot, uint64 deadline);
    event DisputeAnsweredWithState(bytes32 indexed tableId, uint64 nonce);
    event DisputeAnsweredWithMove(bytes32 indexed tableId, bytes move, bytes32 newGameStateHash);
    /// A contested decryption share was delivered + DLEQ-verified on-chain; dispute resolved.
    event DisputeAnsweredWithShare(bytes32 indexed tableId, uint8 seat, uint32 slot);
    event DeckKeyRegistered(bytes32 indexed tableId, uint8 seat);
    /// `forfeitedSeat` is the demandSeat that was force-folded on the chess clock — NOT a game winner.
    event ForcedFold(bytes32 indexed tableId, uint8 forfeitedSeat, uint256[] payouts, uint256 rake);

    constructor(address treasury_) {
        treasury = treasury_ == address(0) ? msg.sender : treasury_;
    }

    /// Matches makeDomainN() in the holdem stateSigN.ts: name 'HoldemTableN', version '1'.
    function _domainNameAndVersion() internal pure override returns (string memory, string memory) {
        return ("HoldemTableN", "1");
    }

    // ── lifecycle ──────────────────────────────────────────────────────────────

    function create(
        IGameRulesN rules,
        uint256 buyIn,
        uint256 maxSeats,
        uint16 rakeBps,
        uint256 rakeCap,
        uint64 clockBlocks,
        address channelKey
    ) external payable returns (bytes32 tableId) {
        if (buyIn == 0 || msg.value != buyIn) revert WrongValue();
        if (clockBlocks < MIN_CLOCK_BLOCKS || clockBlocks > MAX_CLOCK_BLOCKS) revert BadClock();
        if (address(rules).code.length == 0) revert BadRules();
        if (maxSeats < 2 || maxSeats > MAX_SEATS) revert BadSeatCount();
        if (rakeBps > MAX_RAKE_BPS) revert RakeTooHigh();
        tableId = keccak256(abi.encode(block.chainid, address(this), ++_counter));
        Table storage t = _tables[tableId];
        t.rules = rules;
        t.buyIn = buyIn;
        t.maxSeats = maxSeats;
        t.rakeBps = rakeBps;
        t.rakeCap = rakeCap;
        t.clockBlocks = clockBlocks;
        t.status = Status.Forming;
        address key = channelKey == address(0) ? msg.sender : channelKey;
        t.seats.push(msg.sender);
        t.channelKeys.push(key);
        t.escrow.push(msg.value);
        emit TableCreated(tableId, msg.sender, address(rules), buyIn, maxSeats, rakeBps, rakeCap, clockBlocks);
        emit TableJoined(tableId, msg.sender, 0);
    }

    function join(bytes32 tableId, address channelKey) external payable {
        Table storage t = _tables[tableId];
        if (t.status != Status.Forming) revert BadStatus();
        if (msg.value != t.buyIn) revert WrongValue();
        if (t.seats.length >= t.maxSeats) revert TooManySeats();
        address key = channelKey == address(0) ? msg.sender : channelKey;
        // reject any wallet/key collision with an existing seat (keeps _seatOf unambiguous)
        for (uint256 i = 0; i < t.seats.length; i++) {
            if (t.seats[i] == msg.sender || t.channelKeys[i] == msg.sender) revert NotPlayer();
            if (t.seats[i] == key || t.channelKeys[i] == key) revert DuplicateKey();
        }
        t.seats.push(msg.sender);
        t.channelKeys.push(key);
        t.escrow.push(msg.value);
        emit TableJoined(tableId, msg.sender, t.seats.length - 1);
    }

    /// Forming → Live once at least 2 seats have joined.
    function start(bytes32 tableId) external {
        Table storage t = _tables[tableId];
        if (t.status != Status.Forming) revert BadStatus();
        _seatOf(t, msg.sender);
        if (t.seats.length < 2) revert NotEnoughSeats();
        t.status = Status.Live;
        emit TableStarted(tableId, t.seats.length);
    }

    /// Register the caller's secp256k1 deck pubkey (the key it contributes to the off-chain
    /// joint deck key). Only while Forming — so it is immutable across live play — and only
    /// by a seat, for its OWN seat. Required to answer a SHARE dispute (respondWithShare).
    /// NOTE: register after the roster is final; leaveBeforeStart re-indexes seats.
    function registerDeckKey(bytes32 tableId, uint256[2] calldata pk) external {
        Table storage t = _tables[tableId];
        if (t.status != Status.Forming) revert BadStatus();
        uint8 seat = _seatOf(t, msg.sender);
        if (!EllipticCurve.isOnCurve(pk[0], pk[1])) revert BadDeckKey();
        _deckKey[tableId][seat] = pk;
        emit DeckKeyRegistered(tableId, seat);
    }

    /// A seat leaves before the table starts; refunds its escrow. If it was the last seat
    /// the table is cancelled. (Seats are compacted, so seat indices shift — only valid
    /// while Forming, before any co-signed state pins seat order.)
    function leaveBeforeStart(bytes32 tableId) external {
        Table storage t = _tables[tableId];
        if (t.status != Status.Forming) revert BadStatus();
        uint8 seat = _seatOf(t, msg.sender);
        uint256 refund = t.escrow[seat];
        // compact arrays (swap-and-pop)
        uint256 last = t.seats.length - 1;
        t.seats[seat] = t.seats[last];
        t.channelKeys[seat] = t.channelKeys[last];
        t.escrow[seat] = t.escrow[last];
        t.seats.pop();
        t.channelKeys.pop();
        t.escrow.pop();
        emit SeatLeft(tableId, seat);
        if (t.seats.length == 0) {
            t.status = Status.Cancelled;
            emit TableCancelled(tableId);
        }
        if (refund > 0) msg.sender.forceSafeTransferETH(refund);
    }

    /// Creator cancels a Forming table that only they occupy; refunds all current escrow.
    function cancel(bytes32 tableId) external {
        Table storage t = _tables[tableId];
        if (t.status != Status.Forming) revert BadStatus();
        if (t.seats.length != 1 || t.seats[0] != msg.sender) revert NotPlayer();
        t.status = Status.Cancelled;
        uint256 refund = t.escrow[0];
        t.escrow[0] = 0;
        emit TableCancelled(tableId);
        if (refund > 0) msg.sender.forceSafeTransferETH(refund);
    }

    // ── settle ───────────────────────────────────────────────────────────────

    /// Cooperative settle: any seat submits the final N-of-N co-signed state.
    function settle(bytes32 tableId, ChannelStateN calldata state, bytes[] calldata sigs) external {
        Table storage t = _tables[tableId];
        if (t.status != Status.Live) revert BadStatus();
        _seatOf(t, msg.sender);
        _checkCoSigned(t, tableId, state, sigs);
        if (!t.rules.isFinal(state.phase)) revert NotFinal();
        if (state.pot != 0 || state.sidePots.length != 0) revert PotNotZero();
        if (t.hasCheckpoint && state.nonce <= t.checkpointNonce) revert StaleNonce();
        _checkRake(t, state.rakeAccrued, state);
        _payoutVector(t, tableId, state.balances, state.rakeAccrued, false, 0);
    }

    /// Public so off-chain code can parity-test the EIP-712 digest (memory variant, so
    /// fuzz/invariant tests holding a memory struct can hash directly).
    function stateDigest(ChannelStateN memory state) public view returns (bytes32) {
        return _hashTypedData(state.structHashMem());
    }

    // ── dispute machine ───────────────────────────────────────────────────────

    /// Post your latest N-of-N co-signed state and demand the owed protocol action from
    /// exactly one seat. gameState must be the preimage of state.gameStateHash; the demand
    /// must target a seat that actually owes per the rules (ForceMove-style guard) — this is
    /// the seat-level-attribution hook: a seat named by the deal layer's ShareAttributionFault
    /// can be demanded-of here and force-folded if it does not respond.
    function openDispute(
        bytes32 tableId,
        ChannelStateN calldata state,
        bytes[] calldata sigs,
        bytes calldata gameState,
        uint8 demandSeat,
        uint8 demandKind,
        uint32 demandSlot
    ) external {
        Table storage t = _tables[tableId];
        if (t.status != Status.Live) revert BadStatus();
        _seatOf(t, msg.sender);
        _checkCoSigned(t, tableId, state, sigs);
        if (t.hasCheckpoint && state.nonce < t.checkpointNonce) revert StaleNonce();
        // Uniform rake ceiling across settle/timeout: the disputeState carried here is what
        // resolveTimeout pays rake from, so bound it by rakeCap exactly as settle does (the
        // full bps reconstruction is settle-only because a mid-hand disputeState may carry a
        // non-zero pot). Without this an over-cap rakeAccrued could be paid out via timeout.
        if (state.rakeAccrued > t.rakeCap) revert RakeTooHigh();
        if (t.rules.hashGameState(gameState) != state.gameStateHash) revert BadGameState();
        if (demandKind != DEMAND_MOVE && demandKind != DEMAND_SHARE) revert BadDemand();
        if (demandSeat >= t.seats.length) revert SeatRange();
        if (t.rules.whoseTurn(gameState) & (uint256(1) << demandSeat) == 0) revert NotYourTurn();
        t.status = Status.Disputed;
        t.demandSeat = demandSeat;
        t.demandKind = demandKind;
        t.demandSlot = demandSlot;
        t.disputeState = state;
        t.checkpointNonce = state.nonce;
        t.hasCheckpoint = true;
        t.disputeDeadline = uint64(block.number) + t.clockBlocks;
        emit DisputeOpened(tableId, demandSeat, demandKind, demandSlot, t.disputeDeadline);
    }

    /// Universal answer: any seat posts a strictly-newer N-of-N co-signed state.
    function respondWithState(bytes32 tableId, ChannelStateN calldata state, bytes[] calldata sigs) external {
        Table storage t = _tables[tableId];
        if (t.status != Status.Disputed) revert BadStatus();
        _seatOf(t, msg.sender);
        _checkCoSigned(t, tableId, state, sigs);
        if (state.nonce <= t.disputeState.nonce) revert StaleNonce();
        t.checkpointNonce = state.nonce;
        t.hasCheckpoint = true;
        _clearDispute(t);
        emit DisputeAnsweredWithState(tableId, state.nonce);
    }

    /// Answer a MOVE demand: the demanded seat publishes the owed move on-chain; the rules
    /// contract is the judge and reverts on an illegal move.
    function respondWithMove(bytes32 tableId, bytes calldata gameState, bytes calldata move) external {
        Table storage t = _tables[tableId];
        if (t.status != Status.Disputed) revert BadStatus();
        if (t.demandKind != DEMAND_MOVE) revert NotDemanded();
        uint8 seat = _seatOf(t, msg.sender);
        if (seat != t.demandSeat) revert NotYourDispute();
        if (t.rules.hashGameState(gameState) != t.disputeState.gameStateHash) revert BadGameState();
        bytes memory newState = t.rules.applyMove(gameState, move);
        _clearDispute(t);
        emit DisputeAnsweredWithMove(tableId, move, t.rules.hashGameState(newState));
    }

    /// Answer a SHARE demand: the demanded seat delivers its decryption share for the
    /// contested slot on-chain together with a Chaum–Pedersen DLEQ proof of correctness,
    /// verified over secp256k1 (the deck's curve). This CLOSES real-money Gate 1: an honest
    /// seat can always satisfy the demand and clear the dispute before the clock, so it can
    /// never be force-folded for an action it actually performed; a forged/incorrect share
    /// reverts (BadShareProof) and the clock keeps running toward forced-fold.
    ///
    /// `deck` is the full contested masked deck as affine secp256k1 coords, 4 words/card
    ///   [c1.x, c1.y, c2.x, c2.y], in slot order — bound to disputeState.deckCommitment.
    /// `share` is the claimed decryption share d = c1·sk (affine).
    /// `proof` is [t1.x, t1.y, t2.x, t2.y, z] from the off-chain proveShare.
    function respondWithShare(
        bytes32 tableId,
        uint256[] calldata deck,
        uint256[2] calldata share,
        uint256[5] calldata proof
    ) external {
        Table storage t = _tables[tableId];
        if (t.status != Status.Disputed) revert BadStatus();
        if (t.demandKind != DEMAND_SHARE) revert NotDemanded();
        uint8 seat = _seatOf(t, msg.sender);
        if (seat != t.demandSeat) revert NotYourDispute();
        // The passed deck must be exactly the one committed in the contested state.
        if (_deckHash(deck) != t.disputeState.deckCommitment) revert BadDeck();
        uint32 slot = t.demandSlot;
        uint256 base = uint256(slot) * 4;
        if (base + 4 > deck.length) revert BadDemand();

        uint256[2] storage pk = _deckKey[tableId][seat];
        if (pk[0] == 0 && pk[1] == 0) revert DeckKeyNotSet();

        RevealShareDLEQ.Statement memory s = RevealShareDLEQ.Statement({
            pkX: pk[0], pkY: pk[1],
            c1X: deck[base],     c1Y: deck[base + 1],
            c2X: deck[base + 2], c2Y: deck[base + 3],
            dX: share[0], dY: share[1],
            t1X: proof[0], t1Y: proof[1],
            t2X: proof[2], t2Y: proof[3],
            z: proof[4]
        });
        if (!s.verify(_ctxFor(tableId, slot))) revert BadShareProof();

        _clearDispute(t);
        emit DisputeAnsweredWithShare(tableId, seat, slot);
    }

    /// keccak over the 33-byte COMPRESSED SEC1 encoding of every card's (c1, c2) in slot
    /// order — the on-chain mirror of zk-core `deckCommitment(deck)` (which hashes the same
    /// compressed wire points). Binds a passed affine deck to a co-signed bytes32 commitment.
    function _deckHash(uint256[] calldata deck) internal pure returns (bytes32) {
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

    /// Reconstruct the replay-binding ctx string exactly as zk-core `ctxFor(tableId, slot)`:
    ///   "holdem/" ‖ 0x-prefixed 32-byte lowercase hex tableId ‖ "/slot/" ‖ decimal slot.
    /// (Off-chain callers MUST use the on-chain bytes32 tableId as the ctx tableId.)
    function _ctxFor(bytes32 tableId, uint32 slot) internal pure returns (string memory) {
        return string.concat(
            "holdem/",
            LibString.toHexString(uint256(tableId), 32),
            "/slot/",
            LibString.toString(uint256(slot))
        );
    }

    /// Clock expired unanswered: FORCE-FOLD the demandSeat. It keeps its co-signed
    /// `balances[demandSeat]` but forfeits its in-pot stake; the pot and every side-pot it was
    /// eligible for are redistributed to the still-eligible non-forfeiting seats (equal split,
    /// odd-chip to the lowest-index eligible seat), so the table settles among the honest seats
    /// while the staller can never gain by stalling. Conservation (_checkCoSigned) guarantees
    /// exactly Σ escrow is paid out.
    function resolveTimeout(bytes32 tableId) external {
        Table storage t = _tables[tableId];
        if (t.status != Status.Disputed) revert BadStatus();
        if (uint64(block.number) <= t.disputeDeadline) revert ClockNotExpired();
        uint256 n = t.seats.length;
        uint8 forfeit = t.demandSeat;

        uint256[] memory payouts = new uint256[](n);
        for (uint256 i = 0; i < n; i++) payouts[i] = t.disputeState.balances[i];

        // main pot: eligible = everyone except the forfeiting seat
        uint256 mainMask = ((uint256(1) << n) - 1) & ~(uint256(1) << forfeit);
        _distribute(payouts, t.disputeState.pot, mainMask);
        // side-pots: eligible = (sidePot.eligibleMask) minus the forfeiting seat
        SidePot[] storage sps = t.disputeState.sidePots;
        for (uint256 k = 0; k < sps.length; k++) {
            uint256 mask = sps[k].eligibleMask & ~(uint256(1) << forfeit);
            _distribute(payouts, sps[k].amount, mask);
        }

        _payoutVector(t, tableId, payouts, t.disputeState.rakeAccrued, true, forfeit);
    }

    // ── internals ──────────────────────────────────────────────────────────────

    /// Split `amount` equally among the seats whose bit is set in `mask`, adding to `payouts`.
    /// The remainder (amount % count) goes to the lowest-index eligible seat — deterministic.
    /// If no seat is eligible (mask empty), the amount is added to the lowest-index seat overall
    /// as a last-resort sink so conservation never leaks (cannot happen with ≥2 honest seats).
    function _distribute(uint256[] memory payouts, uint256 amount, uint256 mask) internal pure {
        if (amount == 0) return;
        uint256 n = payouts.length;
        uint256 count;
        for (uint256 i = 0; i < n; i++) if (mask & (uint256(1) << i) != 0) count++;
        if (count == 0) {
            payouts[0] += amount; // unreachable with an honest majority; conservation sink
            return;
        }
        uint256 share = amount / count;
        uint256 rem = amount - share * count;
        bool remGiven = false;
        for (uint256 i = 0; i < n; i++) {
            if (mask & (uint256(1) << i) == 0) continue;
            payouts[i] += share;
            if (!remGiven) { payouts[i] += rem; remGiven = true; }
        }
    }

    function _checkRake(Table storage t, uint256 rakeAccrued, ChannelStateN calldata state) internal view {
        if (rakeAccrued > t.rakeCap) revert RakeTooHigh();
        // rake may not exceed rakeBps of the gross pot it was taken from. On a settled state
        // pot==0, so reconstruct the gross as Σ balances + rake (the chips that passed through
        // the pot end up in balances + rake). Bound: rake <= rakeBps/10000 * (balances+rake).
        uint256 gross = rakeAccrued;
        for (uint256 i = 0; i < state.balances.length; i++) gross += state.balances[i];
        if (rakeAccrued * 10000 > uint256(t.rakeBps) * gross) revert RakeTooHigh();
    }

    /// Every accepted state must conserve the CURRENT escrow total and carry N valid sigs
    /// (one per seat, recovering each seat's channel key).
    function _checkCoSigned(Table storage t, bytes32 tableId, ChannelStateN calldata state, bytes[] calldata sigs) internal view {
        if (state.tableId != tableId) revert WrongTable();
        uint256 n = t.seats.length;
        if (state.balances.length != n) revert BadSeatCount();
        if (sigs.length != n) revert WrongSigCount();
        // conservation: Σ balances + pot + Σ sidePots + rake == Σ escrow
        uint256 locked = state.totalLockedCalldata();
        uint256 escrowSum;
        for (uint256 i = 0; i < n; i++) escrowSum += t.escrow[i];
        if (locked != escrowSum) revert ConservationViolated();
        bytes32 digest = _hashTypedData(state.structHash());
        for (uint256 i = 0; i < n; i++) {
            if (ECDSA.recoverCalldata(digest, sigs[i]) != t.channelKeys[i]) revert BadSig();
        }
    }

    function _seatOf(Table storage t, address who) internal view returns (uint8) {
        for (uint256 i = 0; i < t.seats.length; i++) {
            if (t.seats[i] == who || t.channelKeys[i] == who) return uint8(i);
        }
        revert NotPlayer();
    }

    function _clearDispute(Table storage t) internal {
        t.status = Status.Live;
        t.demandSeat = 0;
        t.demandKind = 0;
        t.demandSlot = 0;
        t.disputeDeadline = 0;
        delete t.disputeState;
    }

    /// Pay each seat its `payouts[i]` and the accrued rake to the treasury, then mark settled.
    /// One griefing receiver cannot block the others (forceSafeTransferETH).
    function _payoutVector(
        Table storage t,
        bytes32 tableId,
        uint256[] memory payouts,
        uint256 rake,
        bool forcedFold,
        uint8 forfeitedSeat
    ) internal {
        t.status = Status.Settled;
        uint256 n = t.seats.length;
        address[] memory recipients = new address[](n);
        for (uint256 i = 0; i < n; i++) {
            recipients[i] = t.seats[i];
            t.escrow[i] = 0;
        }
        if (forcedFold) emit ForcedFold(tableId, forfeitedSeat, payouts, rake);
        else emit TableSettled(tableId, payouts, rake);
        for (uint256 i = 0; i < n; i++) {
            if (payouts[i] > 0) recipients[i].forceSafeTransferETH(payouts[i]);
        }
        if (rake > 0) treasury.forceSafeTransferETH(rake);
    }

    // ── views ────────────────────────────────────────────────────────────────

    function status(bytes32 tableId) external view returns (Status) { return _tables[tableId].status; }
    function seatCount(bytes32 tableId) external view returns (uint256) { return _tables[tableId].seats.length; }
    function escrowOf(bytes32 tableId, uint256 seat) external view returns (uint256) { return _tables[tableId].escrow[seat]; }
    function seatAt(bytes32 tableId, uint256 seat) external view returns (address) { return _tables[tableId].seats[seat]; }
    function deckKeyOf(bytes32 tableId, uint256 seat) external view returns (uint256[2] memory) { return _deckKey[tableId][seat]; }
    function totalEscrow(bytes32 tableId) external view returns (uint256 sum) {
        Table storage t = _tables[tableId];
        for (uint256 i = 0; i < t.escrow.length; i++) sum += t.escrow[i];
    }
}
