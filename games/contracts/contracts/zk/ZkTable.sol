// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {EIP712} from "solady/src/utils/EIP712.sol";
import {ECDSA} from "solady/src/utils/ECDSA.sol";
import {SafeTransferLib} from "solady/src/utils/SafeTransferLib.sol";
import {ChannelState, ChannelStateLib} from "./ChannelState.sol";
import {IGameRules} from "./IGameRules.sol";

/// @notice Two-party state-channel card table. Stakes escrow at create/join, play is
/// off-chain co-signed states, the chain is touched again only to settle, top up, or
/// dispute. Tables are independent structs keyed by id — nothing reads another table,
/// so sessions pipeline (spec: 2026-06-11-zk-card-games-design.md, msgboard repo).
contract ZkTable is EIP712 {
    using SafeTransferLib for address;
    using ChannelStateLib for ChannelState;

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
    error BadDeck();
    error BadProof();
    error BadDemand();

    uint8 internal constant DEMAND_MOVE = 1;
    uint8 internal constant DEMAND_SHARE = 2;

    enum Status { None, Created, Live, Disputed, Settled, Cancelled }

    struct Table {
        address playerA;
        address playerB;
        address keyA;            // channel signing key (may differ from wallet)
        address keyB;
        uint256 escrowA;
        uint256 escrowB;
        uint256 joinStake;       // exact amount B must escrow
        IGameRules rules;
        uint64 clockBlocks;
        Status status;
        uint64 checkpointNonce;  // highest nonce co-signed on-chain; later submissions must not be older
        bool hasCheckpoint;
        // dispute fields (next task)
        uint64 disputeDeadline;
        uint8 disputant;
        uint8 demandKind;
        uint32 demandSlot;
        ChannelState disputeState;
    }

    uint64 public constant MIN_CLOCK_BLOCKS = 30;     // ~5 min at 10s blocks
    uint64 public constant MAX_CLOCK_BLOCKS = 60480;  // ~1 week

    uint256 internal _counter;
    mapping(bytes32 => Table) public tables;
    // EdOnBN254 deck pubkeys for snark-reveal disputes: tableId => seat (1/2) => [x, y]
    mapping(bytes32 => mapping(uint8 => uint256[2])) public deckKeys;

    event TableCreated(bytes32 indexed tableId, address indexed playerA, address rules, uint256 escrow, uint256 joinStake, uint64 clockBlocks);
    event TableJoined(bytes32 indexed tableId, address indexed playerB);
    event TableCancelled(bytes32 indexed tableId);
    event ToppedUp(bytes32 indexed tableId, uint8 seat, uint256 amount);
    event TableSettled(bytes32 indexed tableId, uint256 payoutA, uint256 payoutB);
    event DisputeOpened(bytes32 indexed tableId, uint8 disputant, uint8 demandKind, uint32 demandSlot, uint64 deadline);
    event SetupDisputeOpened(bytes32 indexed tableId, uint8 disputant, uint64 deadline);
    event DisputeAnsweredWithState(bytes32 indexed tableId, uint64 nonce);
    event DisputeAnsweredWithMove(bytes32 indexed tableId, bytes move, bytes32 newGameStateHash);
    event DisputeAnsweredWithShare(bytes32 indexed tableId, uint32 slot, uint256 revealX, uint256 revealY);
    // `winner` carries `t.disputant` (the seat that opened the dispute and is awarded the pot on
    // timeout) — NOT a game winner; indexers must not read it as a game result.
    event DisputeForfeited(bytes32 indexed tableId, uint8 winner, uint256 payoutA, uint256 payoutB);
    event SetupDisputeRefunded(bytes32 indexed tableId);

    /// Matches makeDomain() in zk-cards-core: { name: 'ZkTable', version: '1' }.
    /// (Solady EIP712 rather than OZ: OZ 5.6's Strings->Bytes dependency uses MCOPY
    /// assembly, which solc rejects outright when targeting shanghai for 943.)
    function _domainNameAndVersion() internal pure override returns (string memory, string memory) {
        return ("ZkTable", "1");
    }

    function create(IGameRules rules, uint256 joinStake, uint64 clockBlocks, address channelKey, uint256[2] calldata deckKey)
        external
        payable
        returns (bytes32 tableId)
    {
        if (msg.value == 0) revert WrongValue();
        if (clockBlocks < MIN_CLOCK_BLOCKS || clockBlocks > MAX_CLOCK_BLOCKS) revert BadClock();
        if (address(rules).code.length == 0) revert BadRules(); // a dead rules address would brick settle for both escrows
        tableId = keccak256(abi.encode(block.chainid, address(this), ++_counter));
        Table storage t = tables[tableId];
        t.playerA = msg.sender;
        t.keyA = channelKey == address(0) ? msg.sender : channelKey;
        t.escrowA = msg.value;
        t.joinStake = joinStake;
        t.rules = rules;
        t.clockBlocks = clockBlocks;
        t.status = Status.Created;
        deckKeys[tableId][1] = deckKey;
        emit TableCreated(tableId, msg.sender, address(rules), msg.value, joinStake, clockBlocks);
    }

    function join(bytes32 tableId, address channelKey, uint256[2] calldata deckKey) external payable {
        Table storage t = tables[tableId];
        if (t.status != Status.Created) revert BadStatus();
        if (msg.sender == t.playerA) revert NotPlayer();
        if (msg.value != t.joinStake) revert WrongValue();
        t.playerB = msg.sender;
        address keyB = channelKey == address(0) ? msg.sender : channelKey;
        // keyB colliding with A's identities would make _seatOf ambiguous
        if (keyB == t.playerA || keyB == t.keyA) revert NotPlayer();
        t.keyB = keyB;
        t.escrowB = msg.value;
        t.status = Status.Live;
        deckKeys[tableId][2] = deckKey;
        emit TableJoined(tableId, msg.sender);
    }

    /// Creator backs out before anyone joins.
    function cancel(bytes32 tableId) external {
        Table storage t = tables[tableId];
        if (t.status != Status.Created) revert BadStatus();
        if (msg.sender != t.playerA) revert NotPlayer();
        t.status = Status.Cancelled;
        uint256 amount = t.escrowA;
        t.escrowA = 0;
        emit TableCancelled(tableId);
        // forced send so a reverting receiver cannot hold the counterparty's payout hostage
        t.playerA.forceSafeTransferETH(amount);
    }

    /// Spec: top-up only at a flip boundary, reflected in the next co-signed state.
    /// On-chain it just bumps escrow; both clients mirror via Channel.applyTopUp.
    function topUp(bytes32 tableId) external payable {
        Table storage t = tables[tableId];
        if (t.status != Status.Live) revert BadStatus();
        if (msg.value == 0) revert WrongValue();
        uint8 seat = _seatOf(t, msg.sender);
        if (seat == 1) t.escrowA += msg.value;
        else t.escrowB += msg.value;
        emit ToppedUp(tableId, seat, msg.value);
    }

    /// Cooperative settle: either party submits the final co-signed state.
    /// (A Disputed table must first return to Live via a dispute response.)
    function settle(bytes32 tableId, ChannelState calldata state, bytes calldata sigA, bytes calldata sigB) external {
        Table storage t = tables[tableId];
        if (t.status != Status.Live) revert BadStatus();
        _seatOf(t, msg.sender); // reverts NotPlayer for strangers
        _checkCoSigned(t, tableId, state, sigA, sigB);
        if (!t.rules.isFinal(state.phase)) revert NotFinal();
        if (state.pot != 0) revert PotNotZero();
        if (t.hasCheckpoint && state.nonce <= t.checkpointNonce) revert StaleNonce();
        _payout(t, tableId, state.balanceA, state.balanceB);
    }

    /// Public so off-chain code can parity-test the EIP-712 digest. Takes `memory` (not
    /// calldata) so Solidity callers holding a memory struct — fuzz/invariant tests, other
    /// contracts — can compute the digest directly; the external ABI signature is unchanged
    /// (memory vs calldata is internal codegen only), so viem/TS callers keep working.
    function stateDigest(ChannelState memory state) public view returns (bytes32) {
        return _hashTypedData(state.structHashMem());
    }

    /// Every state the contract accepts must conserve the CURRENT escrow total —
    /// so dispute timeouts (next task) can always pay out exactly escrowA+escrowB,
    /// and a pre-top-up state becomes unsubmittable once the top-up lands.
    function _checkCoSigned(Table storage t, bytes32 tableId, ChannelState calldata state, bytes calldata sigA, bytes calldata sigB) internal view {
        if (state.tableId != tableId) revert WrongTable();
        if (state.balanceA + state.balanceB + state.pot != t.escrowA + t.escrowB) revert ConservationViolated();
        // hot path: hash the calldata struct directly (no calldata->memory copy)
        bytes32 digest = _hashTypedData(state.structHash());
        // Solady ECDSA does not enforce low-s; sigs are never used as identifiers here (replay
        // safety = status + tableId pin + nonce checkpoint), so malleability is benign — do not
        // use sig bytes as dedup keys off-chain.
        if (ECDSA.recoverCalldata(digest, sigA) != t.keyA) revert BadSig();
        if (ECDSA.recoverCalldata(digest, sigB) != t.keyB) revert BadSig();
    }

    function _seatOf(Table storage t, address who) internal view returns (uint8) {
        if (who == t.playerA || who == t.keyA) return 1;
        if (who == t.playerB || who == t.keyB) return 2;
        revert NotPlayer();
    }

    // ── Dispute machine (ForceMove-style adjudication) ───────────────────────

    /// Stall before state 0 (spec edge case): no co-signed state exists yet.
    /// If the counterparty produces ANY valid co-signed state before the clock
    /// expires the table goes back to Live; otherwise both escrows refund in full.
    function disputeSetup(bytes32 tableId) external {
        Table storage t = tables[tableId];
        if (t.status != Status.Live) revert BadStatus();
        if (t.hasCheckpoint) revert BadDemand(); // a state exists: use openDispute
        uint8 seat = _seatOf(t, msg.sender);
        t.status = Status.Disputed;
        t.disputant = seat;
        t.demandKind = 0;
        t.disputeDeadline = uint64(block.number) + t.clockBlocks;
        emit SetupDisputeOpened(tableId, seat, t.disputeDeadline);
    }

    /// Post your latest co-signed state and demand the owed protocol action.
    /// gameState must be the preimage of state.gameStateHash; the demand must
    /// target a seat that actually owes per the rules (ForceMove-style guard:
    /// you cannot demand from someone whose turn it is not).
    function openDispute(
        bytes32 tableId,
        ChannelState calldata state,
        bytes calldata sigA,
        bytes calldata sigB,
        bytes calldata gameState,
        uint8 demandKind,
        uint32 demandSlot
    ) external {
        Table storage t = tables[tableId];
        if (t.status != Status.Live) revert BadStatus();
        uint8 seat = _seatOf(t, msg.sender);
        _checkCoSigned(t, tableId, state, sigA, sigB);
        if (t.hasCheckpoint && state.nonce < t.checkpointNonce) revert StaleNonce();
        if (t.rules.hashGameState(gameState) != state.gameStateHash) revert BadGameState();
        if (demandKind != DEMAND_MOVE && demandKind != DEMAND_SHARE) revert BadDemand();
        uint8 counterparty = seat == 1 ? 2 : 1;
        if (t.rules.whoseTurn(gameState) & counterparty == 0) revert NotYourTurn();
        t.status = Status.Disputed;
        t.disputant = seat;
        t.demandKind = demandKind;
        // demandSlot is trusted as-supplied: legitimacy (is this slot revealable now?) is NOT
        // adjudicated on-chain — see the respondWithShare @dev note.
        t.demandSlot = demandSlot;
        t.disputeState = state;
        t.checkpointNonce = state.nonce;
        t.hasCheckpoint = true;
        t.disputeDeadline = uint64(block.number) + t.clockBlocks;
        emit DisputeOpened(tableId, seat, demandKind, demandSlot, t.disputeDeadline);
    }

    /// Universal answer: a co-signed state newer than the contested one.
    function respondWithState(bytes32 tableId, ChannelState calldata state, bytes calldata sigA, bytes calldata sigB) external {
        Table storage t = tables[tableId];
        if (t.status != Status.Disputed) revert BadStatus();
        _seatOf(t, msg.sender);
        _checkCoSigned(t, tableId, state, sigA, sigB);
        // setup dispute (demandKind 0): any co-signed state proves liveness;
        // move/share disputes need strictly newer than the contested state.
        if (t.demandKind != 0 && state.nonce <= t.disputeState.nonce) revert StaleNonce();
        t.checkpointNonce = state.nonce;
        t.hasCheckpoint = true;
        _clearDispute(t);
        emit DisputeAnsweredWithState(tableId, state.nonce);
    }

    /// Answer a MOVE demand: the owing seat publishes the demanded move on-chain.
    /// The rules contract is the judge; an illegal move reverts there.
    function respondWithMove(bytes32 tableId, bytes calldata gameState, bytes calldata move) external {
        Table storage t = tables[tableId];
        if (t.status != Status.Disputed) revert BadStatus();
        if (t.demandKind != DEMAND_MOVE) revert NotDemanded();
        uint8 seat = _seatOf(t, msg.sender);
        if (seat == t.disputant) revert NotYourDispute();
        if (t.rules.hashGameState(gameState) != t.disputeState.gameStateHash) revert BadGameState();
        bytes memory newState = t.rules.applyMove(gameState, move);
        _clearDispute(t);
        emit DisputeAnsweredWithMove(tableId, move, t.rules.hashGameState(newState));
    }

    /// Answer a SHARE demand: a Groth16 snark-reveal for the demanded deck slot
    /// (the CP-DL form is rejected by design — 15.6M gas; spike addendum risk 5).
    /// deck = 208 words (52 cards x [c1.x, c1.y, c2.x, c2.y]) matching the
    /// contested state's deckCommitment; pi layout per vendored RevealVerifier:
    /// [masked.e1.x, masked.e1.y, reveal.x, reveal.y, pk.x, pk.y].
    /// @dev KNOWN v1 LIMITATION — demandSlot legitimacy is not adjudicated on-chain. openDispute
    /// proves (via whoseTurn & counterparty) that the counterparty owes *some* action, but NOT
    /// that `demandSlot` is a slot they can legitimately reveal at the current phase — the rules
    /// contract cannot cheaply prove a slot is revealable. A counterparty who cannot produce the
    /// demanded share must instead answer via respondWithState with a strictly-newer co-signed
    /// state. This is forfeit-only: an illegitimate demand can at worst force a state response or
    /// run the chess clock, and can never move funds beyond the staked escrow. Revisit with an
    /// IGameRules.owesShare(gameState, slot, seat) hook if SHARE disputes become adversarially
    /// load-bearing (out of scope for v1 — would ripple into IGameRules/HiLoWarRules).
    function respondWithShare(
        bytes32 tableId,
        uint256[] calldata deck,
        uint256[2] calldata reveal,
        uint256[8] calldata zkproof
    ) external {
        Table storage t = tables[tableId];
        if (t.status != Status.Disputed) revert BadStatus();
        if (t.demandKind != DEMAND_SHARE) revert NotDemanded();
        uint8 seat = _seatOf(t, msg.sender);
        if (seat == t.disputant) revert NotYourDispute();
        if (deck.length != 208) revert BadDeck();
        if (keccak256(abi.encodePacked(deck)) != t.disputeState.deckCommitment) revert BadDeck();
        uint32 slot = t.demandSlot;
        if (slot > 51) revert BadDeck();
        uint256[2] memory pk = deckKeys[tableId][seat];
        uint256[6] memory pi = [deck[4 * slot], deck[4 * slot + 1], reveal[0], reveal[1], pk[0], pk[1]];
        (bool callOk, bytes memory ret) = t.rules.revealVerifier()
            .staticcall(abi.encodeWithSignature("verifyRevealWithSnark(uint256[6],uint256[8])", pi, zkproof));
        if (!callOk || ret.length < 32 || !abi.decode(ret, (bool))) revert BadProof();
        _clearDispute(t);
        emit DisputeAnsweredWithShare(tableId, slot, reveal[0], reveal[1]);
    }

    /// Clock expired unanswered: forfeit the disputed pot to the disputant and
    /// settle balances from the contested co-signed state. Setup disputes refund
    /// both escrows in full (no pot exists yet — spec edge case).
    function resolveTimeout(bytes32 tableId) external {
        Table storage t = tables[tableId];
        if (t.status != Status.Disputed) revert BadStatus();
        if (uint64(block.number) <= t.disputeDeadline) revert ClockNotExpired();
        if (t.demandKind == 0) {
            emit SetupDisputeRefunded(tableId);
            _payout(t, tableId, t.escrowA, t.escrowB);
            return;
        }
        // Conservation invariant (_checkCoSigned) guarantees the contested state's
        // balances + pot == escrowA + escrowB, so handing the pot to the disputant
        // and balances to each seat consumes the full escrow exactly — no excess.
        uint256 toA = t.disputeState.balanceA;
        uint256 toB = t.disputeState.balanceB;
        if (t.disputant == 1) toA += t.disputeState.pot;
        else toB += t.disputeState.pot;
        // `winner` here is t.disputant (the seat awarded the pot on timeout), not a game winner.
        emit DisputeForfeited(tableId, t.disputant, toA, toB);
        _payout(t, tableId, toA, toB);
    }

    function _clearDispute(Table storage t) internal {
        t.status = Status.Live;
        t.disputant = 0;
        t.demandKind = 0;
        t.demandSlot = 0;
        t.disputeDeadline = 0;
        delete t.disputeState;
    }

    function _payout(Table storage t, bytes32 tableId, uint256 toA, uint256 toB) internal {
        t.status = Status.Settled;
        t.escrowA = 0;
        t.escrowB = 0;
        emit TableSettled(tableId, toA, toB);
        // forced send so a reverting receiver cannot hold the counterparty's payout hostage
        if (toA > 0) t.playerA.forceSafeTransferETH(toA);
        if (toB > 0) t.playerB.forceSafeTransferETH(toB);
    }
}
