// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {ECDSA} from "solady/src/utils/ECDSA.sol";
import {SafeTransferLib} from "solady/src/utils/SafeTransferLib.sol";
import {Ownable} from "solady/src/auth/Ownable.sol";
import {SessionState, SessionStateLib, SessionStateEIP712} from "./SessionState.sol";
import {GamePayouts} from "./GamePayouts.sol";

/// On-chain UltraHonk verifier interface (mode-2 ZK settle). The generated
/// `HonkVerifier` (contracts/zk/generated/DiceSettleHonkVerifier.sol) implements
/// this. Kept as a minimal interface so HouseChannel does not pull the ~99 KiB
/// verifier into its own compilation unit — the deployer wires a verifier address
/// at construction. `verify` reverts on a malformed/invalid proof and otherwise
/// returns true.
interface IHonkVerifier {
    function verify(bytes calldata proof, bytes32[] calldata publicInputs) external view returns (bool);
}

/// House-signed authorization for a single escrowed table open (spec 4.3 / 6.2). The player
/// presents this with the house's signature; the contract reserves escrowHouse from the pool.
struct OpenTerms {
    bytes32 tableId;
    address player;
    address playerKey;
    uint256 escrowPlayer;
    uint256 escrowHouse;
    uint8 gameId;
    bytes32 rngCommit;
    uint64 clockBlocks;
    uint64 expiry;
    bytes32 clientSeedCommit;
    bytes32 paramsHash;
}

library OpenTermsLib {
    bytes32 internal constant TYPEHASH = keccak256(
        "OpenTerms(bytes32 tableId,address player,address playerKey,uint256 escrowPlayer,uint256 escrowHouse,uint8 gameId,bytes32 rngCommit,uint64 clockBlocks,uint64 expiry,bytes32 clientSeedCommit,bytes32 paramsHash)"
    );

    function structHash(OpenTerms calldata t) internal pure returns (bytes32) {
        return keccak256(abi.encode(
            TYPEHASH, t.tableId, t.player, t.playerKey, t.escrowPlayer, t.escrowHouse,
            t.gameId, t.rngCommit, t.clockBlocks, t.expiry, t.clientSeedCommit, t.paramsHash
        ));
    }

    function structHashMem(OpenTerms memory t) internal pure returns (bytes32) {
        return keccak256(abi.encode(
            TYPEHASH, t.tableId, t.player, t.playerKey, t.escrowPlayer, t.escrowHouse,
            t.gameId, t.rngCommit, t.clockBlocks, t.expiry, t.clientSeedCommit, t.paramsHash
        ));
    }
}

/// Escrowed settlement backend (spec 6.2): per-table escrow, cooperative settle, chess-clock
/// dispute/forfeit. The ZkTable channel pattern minus deck/pot/rules. Chips (ERC20) escrow.
contract HouseChannel is SessionStateEIP712, Ownable {
    using SafeTransferLib for address;
    using SessionStateLib for SessionState;
    using OpenTermsLib for OpenTerms;

    error BadStatus();
    error BadClock();
    error Expired();
    error WrongTable();
    error WrongGame();
    error BadMode();
    error BadSig();
    error NotPlayer();
    error ConservationViolated();
    error StaleNonce();
    error InsufficientPool();
    error ClockNotExpired();
    error BadReveal();
    error BadParams();
    error NoVerifier();
    error BadProof();
    error PayoutExceedsPot();

    enum Status { None, Live, Disputed, Settled }

    struct Table {
        address player;       // wallet that opened + receives payout
        address playerKey;    // session signing key
        uint256 escrowPlayer;
        uint256 escrowHouse;  // reserved from housePool at open
        uint8 gameId;
        Status status;
        uint64 clockBlocks;
        uint64 checkpointNonce;
        bool hasCheckpoint;
        uint64 disputeDeadline;
        uint8 disputant;      // 1 player, 2 house
        SessionState disputeState;
        bytes32 rngCommit;        // house-signed server-seed commit (for permissionless settleWithSeeds)
        bytes32 clientSeedCommit; // house-signed player-seed commit
        bytes32 paramsHash;       // house-signed round params hash
    }

    uint64 public constant MIN_CLOCK_BLOCKS = 30;     // ~5 min at 10s blocks
    uint64 public constant MAX_CLOCK_BLOCKS = 60480;  // ~1 week

    address public immutable chips;
    address public houseKey;
    uint256 public housePool;
    mapping(bytes32 tableId => Table) public tables;

    /// ZK mode-2 verifier per gameId (1 dice, 2 limbo). Set by the owner after the
    /// generated UltraHonk verifier is deployed. settleWithProof(gameId) reverts
    /// with NoVerifier if none is wired, so mode-2 is opt-in per game and never
    /// blocks the co-sign (mode 0) / recompute (mode 1) paths.
    mapping(uint8 gameId => address) public proofVerifier;

    event HouseFunded(uint256 amount);
    event HouseWithdrawn(uint256 amount);
    event HouseKeySet(address indexed key);
    event Opened(bytes32 indexed tableId, address indexed player, address playerKey, uint8 gameId, uint256 escrowPlayer, uint256 escrowHouse);
    event Settled(bytes32 indexed tableId, uint256 payoutPlayer, uint256 payoutHouse);
    event ProofVerifierSet(uint8 indexed gameId, address verifier);
    event SettledWithProof(bytes32 indexed tableId, uint256 payoutPlayer, uint256 payoutHouse);
    event DisputeOpened(bytes32 indexed tableId, uint8 disputant, uint64 nonce, uint64 deadline);
    event DisputeAnsweredWithState(bytes32 indexed tableId, uint64 nonce);
    event DisputeForfeited(bytes32 indexed tableId, uint256 payoutPlayer, uint256 payoutHouse);

    constructor(address chips_) {
        chips = chips_;
        _initializeOwner(msg.sender);
    }

    function setHouseKey(address key) external onlyOwner {
        houseKey = key;
        emit HouseKeySet(key);
    }

    /// Wire the generated UltraHonk verifier for a game's mode-2 ZK settle.
    function setProofVerifier(uint8 gameId, address verifier) external onlyOwner {
        proofVerifier[gameId] = verifier;
        emit ProofVerifierSet(gameId, verifier);
    }

    function fundHouse(uint256 amount) external onlyOwner {
        housePool += amount;
        chips.safeTransferFrom(msg.sender, address(this), amount);
        emit HouseFunded(amount);
    }

    function withdrawHouse(uint256 amount) external onlyOwner {
        if (housePool < amount) revert InsufficientPool();
        housePool -= amount;
        chips.safeTransfer(msg.sender, amount);
        emit HouseWithdrawn(amount);
    }

    /// Public for off-chain parity + house signing.
    function openTermsDigest(OpenTerms memory terms) public view returns (bytes32) {
        return _hashTypedData(terms.structHashMem());
    }

    /// Read the three open-time commits a permissionless settle authorizes against.
    /// (The auto-getter can't return the nested `disputeState`, so this explicit reader is needed.)
    function tableCommits(bytes32 tableId)
        external view returns (bytes32 rngCommit, bytes32 clientSeedCommit, bytes32 paramsHash)
    {
        Table storage t = tables[tableId];
        return (t.rngCommit, t.clientSeedCommit, t.paramsHash);
    }

    /// Player opens an escrowed table: escrows their own chips, reserves the house's escrow from
    /// the pool, authorized by the house's signature over `terms`. One player tx, no house tx.
    function open(OpenTerms calldata terms, bytes calldata houseSig) external {
        if (terms.player != msg.sender) revert NotPlayer();
        if (block.timestamp > terms.expiry) revert Expired();
        if (terms.clockBlocks < MIN_CLOCK_BLOCKS || terms.clockBlocks > MAX_CLOCK_BLOCKS) revert BadClock();
        if (terms.playerKey == address(0) || terms.playerKey == houseKey) revert NotPlayer();
        Table storage t = tables[terms.tableId];
        if (t.status != Status.None) revert BadStatus();
        if (ECDSA.recoverCalldata(_hashTypedData(terms.structHash()), houseSig) != houseKey) revert BadSig();
        if (housePool < terms.escrowHouse) revert InsufficientPool();
        housePool -= terms.escrowHouse;

        t.player = msg.sender;
        t.playerKey = terms.playerKey;
        t.escrowPlayer = terms.escrowPlayer;
        t.escrowHouse = terms.escrowHouse;
        t.gameId = terms.gameId;
        t.clockBlocks = terms.clockBlocks;
        t.rngCommit = terms.rngCommit;
        t.clientSeedCommit = terms.clientSeedCommit;
        t.paramsHash = terms.paramsHash;
        t.status = Status.Live;

        chips.safeTransferFrom(msg.sender, address(this), terms.escrowPlayer);
        emit Opened(terms.tableId, msg.sender, terms.playerKey, terms.gameId, terms.escrowPlayer, terms.escrowHouse);
    }

    /// Cooperative settle: anyone submits the final both-signed state. Pays from locked escrow.
    function settle(SessionState calldata s, bytes calldata sigPlayer, bytes calldata sigHouse) external {
        Table storage t = tables[s.tableId];
        if (t.status != Status.Live) revert BadStatus();
        _checkCoSigned(t, s, sigPlayer, sigHouse);
        if (t.hasCheckpoint && s.nonce <= t.checkpointNonce) revert StaleNonce();
        _payout(t, s.tableId, s.balancePlayer, s.balanceHouse);
    }

    /// Permissionless trustless settle: anyone submits the two revealed seeds + the round params. The
    /// seeds must match the commits the house signed at open (rngCommit, clientSeedCommit) and the
    /// params must match paramsHash. The contract recomputes the round randomness and the payout itself
    /// via GamePayouts — NO signature from either party is consulted. The winner (the party motivated to
    /// settle) calls it; the house cannot withhold a payout.
    ///
    /// SECURITY: the round nonce is HARDCODED to 1 (the single-draw round) and is NOT a caller input. If
    /// it were, a settler could grind the nonce to choose the outcome — the commit-bound seeds do not
    /// constrain the nonce, so `r` would be attacker-selectable. A future multi-round design must bind a
    /// per-round nonce/roundId in the house-signed OpenTerms at open, never accept it loose here.
    function settleWithSeeds(
        bytes32 tableId,
        bytes32 serverSeed,
        bytes32 clientSeed,
        bytes calldata params
    ) external {
        Table storage t = tables[tableId];
        if (t.status != Status.Live) revert BadStatus();
        if (keccak256(abi.encodePacked(serverSeed)) != t.rngCommit) revert BadReveal();
        if (keccak256(abi.encodePacked(clientSeed)) != t.clientSeedCommit) revert BadReveal();
        if (keccak256(params) != t.paramsHash) revert BadParams();

        uint256 r = uint256(keccak256(abi.encode(serverSeed, clientSeed, uint64(1))));
        (uint256 balancePlayer, uint256 balanceHouse) =
            GamePayouts.settle(t.gameId, r, params, t.escrowPlayer, t.escrowHouse);

        _payout(t, tableId, balancePlayer, balanceHouse);
    }

    /// Permissionless ZK (mode-2) settle: anyone submits an UltraHonk proof that the round was honest,
    /// WITHOUT revealing the seeds on-chain. Unlike settleWithSeeds (mode 1) — which publishes both
    /// serverSeed and clientSeed in calldata — the seeds stay PRIVATE witnesses inside the proof; only
    /// their house-signed commits (rngCommit, clientSeedCommit, fixed at open) are public. The proof
    /// attests, in zero knowledge, that:
    ///   keccak256(serverSeed) == rngCommit, keccak256(clientSeed) == clientSeedCommit (nonce 1),
    ///   r = uint256(keccak256(abi.encode(serverSeed, clientSeed, 1))), and
    ///   payoutPlayer == the EXACT GamePayouts dice math for (r, targetX100, escrowPlayer).
    /// The contract recomputes the conserved house share (pot - payoutPlayer) and settles.
    ///
    /// BINDING (how a proof is tied to THIS table so it cannot be replayed across channels/rounds):
    ///   The 68 public inputs the contract feeds the verifier are reconstructed from the TABLE's own
    ///   stored state — t.rngCommit, t.clientSeedCommit (the house-signed commits bound at open),
    ///   t.escrowPlayer, t.escrowHouse — NOT from caller input. A proof generated against a different
    ///   table has different commit bytes, so the verifier's Fiat-Shamir transcript differs and verify
    ///   fails. `params` is bound to t.paramsHash (the house-signed bet), and targetX100 is decoded from
    ///   it into the public inputs, so the bet cannot be swapped post-hoc. The nonce is hardcoded 1 in
    ///   the circuit (single-draw), same soundness rule as settleWithSeeds: a grindable nonce is unsound.
    ///   Only `payoutPlayer` comes from the caller, and it is itself a bound public input — a wrong value
    ///   makes the proof fail to verify. Result: the proof authorizes settling exactly this table's
    ///   escrow to exactly the proven split.
    ///
    /// Public-input order MUST match the circuit's `pub` parameter order
    /// (examples/games/zk-settle/test-circuits/diceSettleOnchain): rngCommit[32 bytes as 32 fields] ‖
    /// clientSeedCommit[32 fields] ‖ targetX100 ‖ escrowPlayer ‖ escrowHouse ‖ payoutPlayer = 68 fields.
    function settleWithProof(
        bytes32 tableId,
        bytes calldata params,
        uint256 payoutPlayer,
        bytes calldata proof
    ) external {
        Table storage t = tables[tableId];
        if (t.status != Status.Live) revert BadStatus();
        if (keccak256(params) != t.paramsHash) revert BadParams();

        address verifier = proofVerifier[t.gameId];
        if (verifier == address(0)) revert NoVerifier();

        uint256 pot = t.escrowPlayer + t.escrowHouse;
        if (payoutPlayer > pot) revert PayoutExceedsPot();

        uint256 targetX100 = abi.decode(params, (uint256));
        bytes32[] memory publicInputs =
            _buildPublicInputs(t.rngCommit, t.clientSeedCommit, targetX100, t.escrowPlayer, t.escrowHouse, payoutPlayer);

        // verify() reverts on a malformed/invalid proof (bb behaviour); also reject a clean `false`.
        if (!IHonkVerifier(verifier).verify(proof, publicInputs)) revert BadProof();

        emit SettledWithProof(tableId, payoutPlayer, pot - payoutPlayer);
        _payout(t, tableId, payoutPlayer, pot - payoutPlayer);
    }

    /// Reconstruct the 68-element UltraHonk public-input vector for the dice on-chain settle circuit.
    /// Each byte of the two 32-byte commits becomes one zero-padded bytes32 field (the `[u8; 32]` Noir
    /// shape); the four scalars follow as plain big-endian fields. Order is consensus with the circuit.
    function _buildPublicInputs(
        bytes32 rngCommit,
        bytes32 clientSeedCommit,
        uint256 targetX100,
        uint256 escrowPlayer,
        uint256 escrowHouse,
        uint256 payoutPlayer
    ) internal pure returns (bytes32[] memory pi) {
        pi = new bytes32[](68);
        for (uint256 i = 0; i < 32; i++) {
            pi[i] = bytes32(uint256(uint8(rngCommit[i])));
            pi[32 + i] = bytes32(uint256(uint8(clientSeedCommit[i])));
        }
        pi[64] = bytes32(targetX100);
        pi[65] = bytes32(escrowPlayer);
        pi[66] = bytes32(escrowHouse);
        pi[67] = bytes32(payoutPlayer);
    }

    /// Post your latest both-signed state and start the chess clock. Because Plan-1 open()
    /// co-signs state 0, a party always holds at least one both-signed state (nonce 0 refunds
    /// the opening escrows), so no separate pre-state disputeSetup is needed.
    function dispute(SessionState calldata s, bytes calldata sigPlayer, bytes calldata sigHouse) external {
        Table storage t = tables[s.tableId];
        if (t.status != Status.Live) revert BadStatus();
        uint8 seat = _seatOf(t, msg.sender);
        _checkCoSigned(t, s, sigPlayer, sigHouse);
        if (t.hasCheckpoint && s.nonce < t.checkpointNonce) revert StaleNonce();
        t.status = Status.Disputed;
        t.disputant = seat;
        t.disputeState = s;
        t.checkpointNonce = s.nonce;
        t.hasCheckpoint = true;
        t.disputeDeadline = uint64(block.number) + t.clockBlocks;
        emit DisputeOpened(s.tableId, seat, s.nonce, t.disputeDeadline);
    }

    /// Refund floor (no signature needed). If a table is opened but NO state was ever co-signed
    /// off-chain — e.g. the house took the player's open() escrow then refused to co-sign nonce 0 —
    /// the cooperative paths are unreachable and the funds would otherwise lock forever. Either party
    /// may post the CANONICAL opening split (escrowPlayer→player, escrowHouse→pool) as a synthetic
    /// nonce-0 dispute and start the clock. The counterparty overrides it with ANY real co-signed
    /// state (nonce ≥ 1 > 0) via respondWithState; if none exists, resolveTimeout returns each side
    /// exactly what it escrowed. No theft is possible: the synthetic state conserves the pot and pays
    /// back the deposits, and a real round always out-ranks nonce 0.
    function disputeFromOpen(bytes32 tableId) external {
        Table storage t = tables[tableId];
        if (t.status != Status.Live) revert BadStatus();
        uint8 seat = _seatOf(t, msg.sender);
        SessionState memory s;
        s.tableId = tableId;
        s.nonce = 0;
        s.balancePlayer = t.escrowPlayer;
        s.balanceHouse = t.escrowHouse;
        s.settlementMode = 1;
        s.gameId = t.gameId;
        // gameStateHash + rngCommit stay zero: a synthetic state carries no signatures and is never
        // re-verified — only its conserved balances are paid out.
        t.status = Status.Disputed;
        t.disputant = seat;
        t.disputeState = s;
        t.checkpointNonce = 0;
        t.hasCheckpoint = true;
        t.disputeDeadline = uint64(block.number) + t.clockBlocks;
        emit DisputeOpened(tableId, seat, 0, t.disputeDeadline);
    }

    /// Override a dispute with a strictly-newer both-signed state — which IS the true latest, so
    /// it settles immediately (single-draw games have no further play to resume).
    function respondWithState(SessionState calldata s, bytes calldata sigPlayer, bytes calldata sigHouse) external {
        Table storage t = tables[s.tableId];
        if (t.status != Status.Disputed) revert BadStatus();
        _checkCoSigned(t, s, sigPlayer, sigHouse);
        if (s.nonce <= t.disputeState.nonce) revert StaleNonce();
        emit DisputeAnsweredWithState(s.tableId, s.nonce);
        _payout(t, s.tableId, s.balancePlayer, s.balanceHouse);
    }

    /// Clock expired unanswered: the disputer's posted state stands; pay its balances.
    function resolveTimeout(bytes32 tableId) external {
        Table storage t = tables[tableId];
        if (t.status != Status.Disputed) revert BadStatus();
        if (uint64(block.number) <= t.disputeDeadline) revert ClockNotExpired();
        emit DisputeForfeited(tableId, t.disputeState.balancePlayer, t.disputeState.balanceHouse);
        _payout(t, tableId, t.disputeState.balancePlayer, t.disputeState.balanceHouse);
    }

    function _checkCoSigned(Table storage t, SessionState calldata s, bytes calldata sigPlayer, bytes calldata sigHouse) internal view {
        if (s.tableId == bytes32(0) || t.status == Status.None) revert WrongTable();
        if (s.gameId != t.gameId) revert WrongGame();
        if (s.settlementMode != 1) revert BadMode();
        if (s.balancePlayer + s.balanceHouse != t.escrowPlayer + t.escrowHouse) revert ConservationViolated();
        bytes32 digest = _hashTypedData(s.structHash());
        if (ECDSA.recoverCalldata(digest, sigPlayer) != t.playerKey) revert BadSig();
        if (ECDSA.recoverCalldata(digest, sigHouse) != houseKey) revert BadSig();
    }

    function _seatOf(Table storage t, address who) internal view returns (uint8) {
        if (who == t.player || who == t.playerKey) return 1;
        if (who == houseKey || who == owner()) return 2;
        revert NotPlayer();
    }

    function _payout(Table storage t, bytes32 tableId, uint256 toPlayer, uint256 toHouse) internal {
        t.status = Status.Settled;
        t.escrowPlayer = 0;
        t.escrowHouse = 0;
        emit Settled(tableId, toPlayer, toHouse);
        if (toPlayer > 0) chips.safeTransfer(t.player, toPlayer);
        housePool += toHouse; // house's share returns to the pool
    }
}
