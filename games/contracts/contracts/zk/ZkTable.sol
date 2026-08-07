// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {EIP712} from "solady/src/utils/EIP712.sol";
import {SafeTransferLib} from "solady/src/utils/SafeTransferLib.sol";
import {ChannelState, ChannelStateLib} from "./ChannelState.sol";
import {IGameRules} from "./IGameRules.sol";
import {ChannelTableBase} from "./ChannelTableBase.sol";
import {SignedIntentBase} from "./SignedIntentBase.sol";
import {ShowdownDecodeLib} from "../vendor/uzkge/ShowdownDecodeLib.sol";
import {IX402Token} from "../games/FlipBookX.sol";

/// A wrapper clone's own view of the underlying asset it wraps (ValveWrapperImpl.underlying()).
interface IValveWrapperView {
    function underlying() external view returns (address);
}

/// The CREATE2 factory that deploys x402 wrapper clones (ValveWrapperFactory.wrapperOf), used at
/// `create()` to confirm a supplied token address is a genuine wrapper clone for its underlying —
/// not an arbitrary ERC-20 masquerading as one. `factory_ == address(0)` skips the check entirely
/// (unit-test / pre-factory-deploy escape hatch).
interface IWrapperFactory {
    function wrapperOf(address underlying) external view returns (address);
}

/// @notice Two-party state-channel card table. Stakes escrow at create/join, play is
/// off-chain co-signed states, the chain is touched again only to settle, top up, or
/// dispute. Tables are independent structs keyed by id — nothing reads another table,
/// so sessions pipeline (spec: 2026-06-11-zk-card-games-design.md, msgboard repo).
///
/// Shared errors/Status/dispute-clock constants/co-sign helpers live in ChannelTableBase,
/// alongside its HoldemTableN counterpart (2026-08 DRY pass) — see that file's header for
/// what's shared vs. why the escrow/state shape stays separate.
///
/// ── x402 ASSET PLUMBING (2026-08 conversion) ─────────────────────────────────────────────────
/// Escrow no longer moves as native PLS (`msg.value`). Every table is denominated in ONE x402
/// wrapper token (`tableToken[tableId]`, set once at `create` and immutable thereafter), pulled
/// gaslessly via the wrapper's EIP-3009/7598 `receiveWithAuthorization` (see `_pull`, lifted
/// verbatim from FlipBookX). The signer of each `DepositAuth` — `auth.from` — is the player;
/// `msg.sender` is whoever relays the call (a bot, a paymaster, the player themselves) and is
/// NEVER used as a player identity anywhere funds move. This is the seat-hijack closure: each of
/// `createNonce`/`joinNonce`/`topUpNonce` binds every economically-relevant term (table id where
/// applicable, channelKey, deckKey, rules, amounts, clock) into the wrapper's own EIP-712 nonce,
/// so a relayer that tampers with any term recomputes a different nonce, the wrapper's signature
/// recovery then fails against the player's original signature, and the call reverts — a relayer
/// can relay a call unmodified or not at all, never a mutated one. Payouts move via `token
/// .transfer` (a plain push of the wrapper token — NEVER unwrapped in-contract; the player holds
/// the wrapper and unwraps it themselves if they want native PLS back).
///
/// `settle` and `respondWithState` are now fully permissionless (no `_seatOf(msg.sender)` gate):
/// each is self-authenticating via the two co-signed channel-key signatures, so any relayer/
/// watchtower can submit them on a player's behalf without ever touching that player's escrow
/// identity.
///
/// ── SIGNED-INTENT RELAY (2026-08 pass) ───────────────────────────────────────────────────────
/// Two more mechanisms let a gasless seat's actions be relayed by ANYONE, closing the gap that
/// used to force a player to hold native gas just to defend or manage its own table:
///
/// (1) A permissionless carve-out for the two remaining self-authenticating dispute-response
/// paths, `respondWithShare` and `postShowdownReveals`: both already prove their own legitimacy
/// via a passing Groth16 snark against a SPECIFIC seat's registered `deckKeys` entry, so the
/// `_seatOf(msg.sender)` gate they used to have was redundant with — and strictly weaker than —
/// the proof itself. `respondWithShare` now derives its seat structurally (`3 - t.disputant`,
/// i.e. always the dispute's counterparty) instead of from the caller; `postShowdownReveals`
/// takes an explicit `seat` argument (bounds-checked to 1/2). Either way, a stranger can only
/// ever land a share/reveal under a seat whose registered key it does NOT hold by finding a snark
/// proof for someone else's secret — which is exactly the hardness assumption the whole reveal
/// scheme rests on. See each function's header for the full argument.
///
/// (2) `SignedIntentBase`-backed `*For` variants of every remaining seat-gated, choice-bearing
/// direct-action function (`disputeSetup`/`openDispute`/`respondWithMove`/`reclaimTopUp`/
/// `cancel`): each `*For` entrypoint recovers an EIP-712-signed intent's signer via
/// `_consumeIntent` (nonce + deadline + domain-bound signature — see SignedIntentBase.sol) and
/// resolves the ACTING seat from that RECOVERED signer, through the exact same `_seatOf`
/// identity check (or, for the two wallet-only functions, `cancel`/`cancelFor`, the exact same
/// `== t.playerA` check) a direct call would use — never from a caller-supplied seat/address,
/// and never from `msg.sender`. Every one of these functions is refactored into a thin direct
/// wrapper, a thin `*For` wrapper, and one shared internal `_x` that both call — so the direct
/// path's behavior is provably unchanged (same internal function, same checks, same order) and
/// the ONLY new thing the relayed path adds is "resolve the seat from a verified signature
/// instead of `msg.sender`". Payout destinations (`t.playerA`/`t.playerB`) and dispute-identity
/// fields (`t.disputant`) are therefore always keyed to the signing seat, never the relayer.
contract ZkTable is EIP712, ChannelTableBase, SignedIntentBase {
    using SafeTransferLib for address;
    using ChannelStateLib for ChannelState;

    // ZkTable-only errors: BadSig/BadGameState/etc are inherited from ChannelTableBase.
    error BadProof();
    error NothingToReclaim();
    /// `create()`'s token argument does not round-trip through the wrapper factory
    /// (`factory.wrapperOf(token.underlying()) != token`) — not a genuine x402 wrapper clone.
    error BadToken();
    /// A showdown demand is answered again for a (slot, seat) pair already stored.
    error AlreadyRevealed();
    /// finalizeShowdown called before all 4 showdown reveals (2 slots x 2 seats) are on-chain.
    error RevealsIncomplete();
    /// resolveTimeout called on a DEMAND_SHOWDOWN dispute where both seats already fully
    /// revealed (haveMask == 0x0F) — must settle via the permissionless, deadline-free
    /// finalizeShowdown instead (see resolveTimeout's header for why).
    error MustFinalize();
    // An undecodable card is NOT an error path: CardTable52.decode returns (bool ok, uint8)
    // rather than reverting, so finalizeShowdown routes a bad-decode or duplicate-card deck to the
    // pot-split fallback (see _showdownOutcome) instead of bricking — this is what keeps a
    // fully-revealed showdown always settleable (no freeze) even on a malformed deck.

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
        bool disputeResultDecided;
        uint8 disputeResultWinner;   // 1=A, 2=B; meaningful only when decided
        ChannelState disputeState;
    }

    /// A top-up the counterparty has not yet acknowledged on-chain (see topUp/reclaimTopUp).
    /// Deliberately a separate mapping, NOT new Table fields: the auto-generated `tables`
    /// getter's tuple shape (destructured positionally by tests/off-chain readers) stays put.
    struct PendingTopUp {
        uint256 amount;   // cumulative un-acknowledged top-up for this seat
        uint64 deadline;  // block after which the seat may reclaim (refreshed per top-up)
    }

    /// Accumulates the (up to) 4 snark-verified decryption shares — {A,B} seats x {slotA,slotB}
    /// — for an open DEMAND_SHOWDOWN dispute. Deliberately a SEPARATE mapping, not new Table
    /// fields: same rationale as PendingTopUp — the auto-generated `tables` getter's tuple shape
    /// stays put. reveal[slotIdx][seatIdx] = (x, y) of that seat's decryption share point for
    /// that slot; slotIdx 0/1 <=> slotA/slotB, seatIdx 0/1 <=> seat A/B. haveMask bit
    /// (slotIdx*2 + seatIdx) records which of the 4 cells are filled; finalizeShowdown requires
    /// haveMask == 0x0F (all 4).
    struct ShowdownDispute {
        uint32 slotA;
        uint32 slotB;
        uint256[2][2][2] reveal; // [slotIdx][seatIdx] = (x, y)
        uint8 haveMask;
    }

    /// A signed x402 EIP-3009/7598 pull authorization: `from` is the player identity (NOT
    /// necessarily `msg.sender` — this is the whole point, see the contract header), `sig` is
    /// either a 65-byte (v,r,s) EOA signature or an EIP-7598 `bytes` payload (ERC-1271/Safe),
    /// routed by `_pull` exactly as FlipBookX does. `validBefore` is the wrapper authorization's
    /// own expiry; `salt` lets a signer mint a fresh nonce for actions (create/topUp) that would
    /// otherwise be replay-identical.
    ///
    /// @dev CLIENT OBLIGATION — `validBefore` sizing for `topUp`. A signed topUp auth is
    /// bearer-submittable by ANY relayer at ANY time before it expires or is burned — this
    /// contract has no way to know when the signer actually *wants* it submitted. A hostile
    /// relayer holding a topUp auth with a far-future `validBefore` can withhold it indefinitely
    /// and then submit it at a moment of its choosing — e.g. racing it against a `settle`
    /// (breaking the counterparty's expectation of the pre-top-up total) or simply forcing the
    /// signer into `reclaimTopUp`'s full `clockBlocks` wait to get an unwanted top-up reverted.
    /// Clients MUST sign topUp authorizations with a SHORT `validBefore` (seconds-to-minutes out,
    /// matched to how quickly the top-up is expected to land) — never a far-future one — so an
    /// un-submitted authorization expires on its own instead of sitting as a live landmine.
    struct DepositAuth {
        address from;
        uint64 validBefore;
        bytes32 salt;
        bytes sig;
    }

    uint256 internal _counter;
    mapping(bytes32 => Table) public tables;
    // EdOnBN254 deck pubkeys for snark-reveal disputes: tableId => seat (1/2) => [x, y]
    mapping(bytes32 => mapping(uint8 => uint256[2])) public deckKeys;
    // tableId => seat (1/2) => pending (un-acknowledged) top-up
    mapping(bytes32 => mapping(uint8 => PendingTopUp)) public pendingTopUps;
    // tableId => open DEMAND_SHOWDOWN dispute's accumulated reveals (see ShowdownDispute above).
    mapping(bytes32 => ShowdownDispute) internal showdowns;
    /// The x402 wrapper token a table is denominated + escrowed in, set once at `create` and
    /// immutable thereafter. Separate mapping (not a Table field) for the same reason as
    /// PendingTopUp/ShowdownDispute: keeps the `tables()` getter's tuple shape unchanged.
    mapping(bytes32 => IX402Token) public tableToken;

    /// The CREATE2 wrapper factory used to confirm a `create()`-supplied token is a genuine x402
    /// wrapper clone (see IWrapperFactory). Immutable, set once at deploy; `address(0)` disables
    /// the clone-check entirely (used by the unit-test suite, which funds via a bare MockX402).
    IWrapperFactory public immutable factory;

    /// finalizeShowdown's `winner` value meaning "the pot was split" (a decode failure or a
    /// duplicate-card deck, NOT an on-chain rank tie — that's `winner == 0`). Distinct from 0/1/2
    /// so an off-chain listener can tell the two "nobody clearly won" outcomes apart.
    uint8 internal constant SHOWDOWN_SPLIT = 3;

    // NOTE (x402 conversion): gained the `token` field (inserted before `rules`) — a new position
    // in the event's non-indexed tuple, not just a new trailing field. No ABI artifact is
    // committed for this package (hardhat's artifacts/ + typechain-types/ are both gitignored,
    // regenerated on `hardhat compile`) and no off-chain indexer consumes this event yet
    // (ZkTable is undeployed) — but whichever indexer/ABI IS built against this contract MUST be
    // rebuilt from this source, not from a stale copy, or it will decode `token`'s slot as `rules`.
    event TableCreated(bytes32 indexed tableId, address indexed playerA, address token, address rules, uint256 escrow, uint256 joinStake, uint64 clockBlocks);
    event TableJoined(bytes32 indexed tableId, address indexed playerB);
    event TableCancelled(bytes32 indexed tableId);
    event ToppedUp(bytes32 indexed tableId, uint8 seat, uint256 amount);
    event TopUpReclaimed(bytes32 indexed tableId, uint8 seat, uint256 amount);
    event TableSettled(bytes32 indexed tableId, uint256 payoutA, uint256 payoutB);
    event DisputeOpened(bytes32 indexed tableId, uint8 disputant, uint8 demandKind, uint32 demandSlot, uint64 deadline);
    event SetupDisputeOpened(bytes32 indexed tableId, uint8 disputant, uint64 deadline);
    event DisputeAnsweredWithState(bytes32 indexed tableId, uint64 nonce);
    event DisputeAnsweredWithMove(bytes32 indexed tableId, bytes move, bytes32 newGameStateHash);
    event DisputeAnsweredWithShare(bytes32 indexed tableId, uint32 slot, uint256 revealX, uint256 revealY);
    // `winner` is the seat awarded the pot on timeout. For MOVE/SHARE disputes: the recorded
    // game winner when the contested state was a decided terminal, else the disputant (always a
    // real seat, 1 or 2 — see resolveTimeout's A3 branch). For a DEMAND_SHOWDOWN dispute
    // (resolveTimeout's answer-aware branch): 1/2 = whichever seat actually revealed, or 0 =
    // SPLIT (neither, or both, revealed — see resolveTimeout's header truth table).
    event DisputeForfeited(bytes32 indexed tableId, uint8 winner, uint256 payoutA, uint256 payoutB);
    event SetupDisputeRefunded(bytes32 indexed tableId);
    /// One (slot, seat) cell of a DEMAND_SHOWDOWN dispute's reveal accumulator was filled by a
    /// snark-verified share (postShowdownReveals).
    event ShowdownRevealStored(bytes32 indexed tableId, uint32 slot, uint8 seat, uint256 x, uint256 y);
    /// A DEMAND_SHOWDOWN dispute was finalized: both cards decoded and the pot routed per
    /// `winner` (1=A, 2=B, 0=tie — see finalizeShowdown for the tie/forfeit rule).
    event ShowdownFinalized(bytes32 indexed tableId, uint8 cardA, uint8 cardB, uint8 winner);

    constructor(address factory_) {
        factory = IWrapperFactory(factory_);
    }

    /// Matches makeDomain() in zk-cards-core: { name: 'ZkTable', version: '1' }.
    /// (Solady EIP712 rather than OZ: OZ 5.6's Strings->Bytes dependency uses MCOPY
    /// assembly, which solc rejects outright when targeting shanghai for 943.)
    function _domainNameAndVersion() internal pure override returns (string memory, string memory) {
        return ("ZkTable", "1");
    }

    /// Resolves the `_hashTypedData` diamond: Solady's `EIP712` provides a full implementation
    /// (`internal view virtual`); `SignedIntentBase` re-declares the same signature unimplemented
    /// purely so it can call it without knowing this contract's domain. Solidity requires an
    /// explicit override listing every base that declares the function once more than one base
    /// does — this delegates straight to `EIP712`'s implementation, so the nonce/deadline/recover
    /// logic in `SignedIntentBase._consumeIntent` and the co-signed-state digest in
    /// `_checkCoSigned`/`stateDigest` both hash against the exact same ("ZkTable","1") domain.
    function _hashTypedData(bytes32 structHash) internal view override(EIP712, SignedIntentBase) returns (bytes32) {
        return EIP712._hashTypedData(structHash);
    }

    /// Route to the wrapper's matching authorization overload: exactly-65-byte signatures use the
    /// universal (v,r,s) form (works on every wrapper build, incl. 943's older impl); any other
    /// length is an ERC-1271 payload for the EIP-7598 `bytes` form (Safes / smart accounts).
    /// Lifted verbatim from FlipBookX._pull.
    function _pull(IX402Token token, address from, uint256 value, uint64 validBefore, bytes32 nonce, bytes calldata sig)
        internal
    {
        if (sig.length == 65) {
            bytes32 r = bytes32(sig[0:32]);
            bytes32 s = bytes32(sig[32:64]);
            uint8 v = uint8(sig[64]);
            token.receiveWithAuthorization(from, address(this), value, 0, validBefore, nonce, v, r, s);
        } else {
            token.receiveWithAuthorization(from, address(this), value, 0, validBefore, nonce, sig);
        }
    }

    /// The `create()` authorization's nonce — binds EVERY economically-relevant term (the token,
    /// the rules contract, both stake amounts, the clock, the channel key, and the deck key) so a
    /// relayer altering any one of them recomputes a different nonce and the wrapper's signature
    /// check fails. `salt` lets the same signer mint distinct table-creation authorizations.
    function createNonce(
        address from,
        IX402Token token,
        IGameRules rules,
        uint256 buyIn,
        uint256 joinStake,
        uint64 clockBlocks,
        address channelKey,
        uint256[2] memory deckKey,
        bytes32 salt
    ) public view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("ZkTable.X402.Create"),
                block.chainid,
                address(this),
                from,
                token,
                rules,
                buyIn,
                joinStake,
                clockBlocks,
                channelKey,
                deckKey[0],
                deckKey[1],
                salt
            )
        );
    }

    /// The `join()` authorization's nonce — binds the exact table plus the joiner's channel key
    /// and deck key, so a relayer cannot redirect a join's escrow to a different table or seat it
    /// under a different channel/deck key than the one the player actually signed.
    function joinNonce(bytes32 tableId, address from, address channelKey, uint256[2] memory deckKey)
        public
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(keccak256("ZkTable.X402.Join"), block.chainid, address(this), tableId, from, channelKey, deckKey[0], deckKey[1])
        );
    }

    /// The `topUp()` authorization's nonce — binds the table and amount; `salt` distinguishes
    /// repeated top-ups of the same amount by the same player.
    function topUpNonce(bytes32 tableId, address from, uint256 amount, bytes32 salt) public view returns (bytes32) {
        return keccak256(abi.encode(keccak256("ZkTable.X402.TopUp"), block.chainid, address(this), tableId, from, amount, salt));
    }

    function create(
        IX402Token token,
        uint256 buyIn,
        IGameRules rules,
        uint256 joinStake,
        uint64 clockBlocks,
        address channelKey,
        uint256[2] calldata deckKey,
        DepositAuth calldata auth
    ) external returns (bytes32 tableId) {
        if (buyIn == 0) revert WrongValue();
        _validateClock(clockBlocks);
        _validateRulesCode(address(rules));
        // Clone-check: confirm `token` is a genuine x402 wrapper clone for its own underlying,
        // not an arbitrary ERC-20 impersonating one. Skipped when no factory is configured
        // (address(0) — unit tests funding via a bare mock).
        if (address(factory) != address(0)) {
            address underlying = IValveWrapperView(address(token)).underlying();
            if (factory.wrapperOf(underlying) != address(token)) revert BadToken();
        }
        tableId = keccak256(abi.encode(block.chainid, address(this), ++_counter));
        // Effects BEFORE the pull (CEI): the table fully exists — Created, escrowed, keyed — by
        // the time `_pull` makes its one external call. A revert inside `_pull` still unwinds
        // every write below in the same transaction (so a bad auth persists no table at all —
        // see ZkTableX402.t.sol's badAuth-leaves-no-trace tests), but a reentrant deposit that
        // somehow re-entered `create`/`join`/`topUp` during that external call would see this
        // table already fully formed, not a half-written one.
        Table storage t = tables[tableId];
        tableToken[tableId] = token;
        t.playerA = auth.from;
        t.keyA = channelKey == address(0) ? auth.from : channelKey; // see join()'s channelKey @dev note — same footgun applies here
        t.escrowA = buyIn;
        t.joinStake = joinStake;
        t.rules = rules;
        t.clockBlocks = clockBlocks;
        t.status = Status.Created;
        deckKeys[tableId][1] = deckKey;
        emit TableCreated(tableId, auth.from, address(token), address(rules), buyIn, joinStake, clockBlocks);
        // Interaction LAST: the single external call this function makes.
        bytes32 nonce = createNonce(auth.from, token, rules, buyIn, joinStake, clockBlocks, channelKey, deckKey, auth.salt);
        _pull(token, auth.from, buyIn, auth.validBefore, nonce, auth.sig);
    }

    /// @dev CLIENT OBLIGATION — `channelKey` is a real signing key for your seat, not a label. It
    /// is whichever address co-signs every `ChannelState` on this table's behalf for the rest of
    /// the table's life (see `_checkCoSigned`/`_seatOf`); `create`/`join` bind it to YOUR
    /// signature (it's a term inside `createNonce`/`joinNonce`), which closes the seat-hijack
    /// where a relayer substitutes a different key — but nothing stops a client from
    /// *legitimately signing* a self-defeating one. Nominating the COUNTERPARTY's address (or
    /// any key you do not exclusively control) as your own `channelKey` hands them a valid
    /// signing key for your own seat, letting them co-sign losing states as "you". This is a
    /// pre-existing footgun carried over unchanged from the native-PLS contract, not something
    /// this conversion introduces or closes — pick a channelKey you alone control.
    function join(bytes32 tableId, address channelKey, uint256[2] calldata deckKey, DepositAuth calldata auth) external {
        Table storage t = tables[tableId];
        if (t.status != Status.Created) revert BadStatus();
        if (auth.from == t.playerA) revert NotPlayer();
        address keyB = channelKey == address(0) ? auth.from : channelKey;
        // keyB colliding with A's identities would make _seatOf ambiguous
        if (keyB == t.playerA || keyB == t.keyA) revert NotPlayer();
        uint256 stake = t.joinStake;
        // Effects BEFORE the pull (CEI): status flips to Live and the seat is fully seated here,
        // so a reentrant join attempt during `_pull`'s external call hits BadStatus immediately
        // rather than racing this function's own writes. A revert inside `_pull` still unwinds
        // all of this in the same transaction (bad auth => no persisted seat — see
        // ZkTableX402.t.sol's badAuth-leaves-no-trace tests).
        t.playerB = auth.from;
        t.keyB = keyB;
        t.escrowB = stake;
        t.status = Status.Live;
        deckKeys[tableId][2] = deckKey;
        emit TableJoined(tableId, auth.from);
        // Interaction LAST: the single external call this function makes.
        bytes32 nonce = joinNonce(tableId, auth.from, channelKey, deckKey);
        _pull(tableToken[tableId], auth.from, stake, auth.validBefore, nonce, auth.sig);
    }

    /// Creator backs out before anyone joins.
    function cancel(bytes32 tableId) external {
        Table storage t = tables[tableId];
        if (msg.sender != t.playerA) revert NotPlayer();
        _cancel(t, tableId);
    }

    /// Relayed variant of `cancel`: WALLET-ONLY (see the `CancelIntent` typehash comment) — the
    /// recovered signer must equal `t.playerA` exactly, the same identity check the direct call
    /// makes against `msg.sender`. A channel-signing key alone (the `_seatOf` OR-arm) is NOT
    /// sufficient to cancel a table, by design: cancelling moves the FULL A-side escrow, so it
    /// stays gated to the wallet that actually owns it, exactly like the direct path.
    function cancelFor(bytes32 tableId, uint256 nonce, uint64 deadline, bytes calldata sig) external {
        Table storage t = tables[tableId];
        address signer = _consumeIntent(_hashCancelIntent(tableId, nonce, deadline), nonce, deadline, sig);
        if (signer != t.playerA) revert NotPlayer();
        _cancel(t, tableId);
    }

    function _cancel(Table storage t, bytes32 tableId) internal {
        if (t.status != Status.Created) revert BadStatus();
        t.status = Status.Cancelled;
        uint256 amount = t.escrowA;
        t.escrowA = 0;
        emit TableCancelled(tableId);
        address(tableToken[tableId]).safeTransfer(t.playerA, amount);
    }

    /// Spec: top-up only at a flip boundary, reflected in the next co-signed state
    /// (both clients mirror via Channel.applyTopUp). On-chain it bumps escrow AND
    /// records the amount as a PENDING top-up with a clockBlocks reclaim deadline:
    /// every accepted co-signed state must conserve the CURRENT escrow total, so a
    /// top-up the counterparty never countersigns into a newer state would otherwise
    /// make every existing co-signed state unsubmittable (ConservationViolated) and —
    /// with disputeSetup closed off once a checkpoint exists — permanently freeze both
    /// escrows for 1 wei of griefing. The pending record is erased the moment ANY
    /// co-signed state is accepted on-chain (settle / openDispute / respondWithState):
    /// acceptance requires conservation of the increased total, so the counterparty's
    /// signature on that state IS the acknowledgment. If none arrives before the
    /// deadline, the top-upper can reclaimTopUp() exactly the un-acknowledged amount,
    /// returning escrow to the previously-conserved total so pre-top-up states work again.
    ///
    /// @dev See the `validBefore` sizing warning on `DepositAuth` above: SIGN THIS AUTH WITH A
    /// SHORT `validBefore`. Unlike create/join (which seat a specific table the instant they
    /// land), a signed topUp authorization is a live, bearer-submittable claim against an
    /// ALREADY-Live table for as long as it remains valid and unburned — a far-future
    /// `validBefore` hands a relayer an option to submit it whenever suits them, not the signer.
    function topUp(bytes32 tableId, uint256 amount, DepositAuth calldata auth) external {
        Table storage t = tables[tableId];
        if (t.status != Status.Live) revert BadStatus();
        if (amount == 0) revert WrongValue();
        uint8 seat = _seatOf(t, auth.from);
        // Effects BEFORE the pull (CEI): escrow and the pending-top-up accounting are fully
        // updated here, before `_pull`'s external call. A revert inside `_pull` still unwinds
        // all of this in the same transaction (bad auth => no escrow bump, no pending record —
        // see ZkTableX402.t.sol's badAuth-leaves-no-trace tests).
        if (seat == 1) t.escrowA += amount;
        else t.escrowB += amount;
        PendingTopUp storage p = pendingTopUps[tableId][seat];
        p.amount += amount;
        // refresh: a later top-up extends the whole pending amount's window (top-upper's
        // own choice — it only delays their own reclaim, never the counterparty's rights)
        p.deadline = uint64(block.number) + t.clockBlocks;
        emit ToppedUp(tableId, seat, amount);
        // Interaction LAST: the single external call this function makes.
        bytes32 nonce = topUpNonce(tableId, auth.from, amount, auth.salt);
        _pull(tableToken[tableId], auth.from, amount, auth.validBefore, nonce, auth.sig);
    }

    /// Claw back a top-up the counterparty never acknowledged: if no co-signed state
    /// has been accepted on-chain since the top-up (which would have required — and
    /// proven — both signatures over the increased total) by the time the reclaim
    /// clock expires, the top-upper takes back exactly their own pending amount,
    /// restoring the previously-conserved escrow total. Only while Live: during a
    /// dispute the pending amount is either already zero (openDispute's acceptance
    /// cleared it) or, for a setup dispute, exits via resolveTimeout's full per-seat
    /// refund / respondWithState's acknowledgment. Counterparty defense: anyone
    /// holding a newer post-top-up co-signed state has the full clock window to
    /// checkpoint it (settle/openDispute), which cancels the pending claim first.
    function reclaimTopUp(bytes32 tableId) external {
        Table storage t = tables[tableId];
        uint8 seat = _seatOf(t, msg.sender);
        _reclaimTopUp(t, tableId, seat);
    }

    /// Relayed variant of `reclaimTopUp`: the seat is resolved from `_consumeIntent`'s recovered
    /// signer through the SAME `_seatOf` identity check the direct call makes against
    /// `msg.sender` — a gasless seat's channel key (or wallet) authorizes the reclaim, the
    /// relayer's own address is never consulted, and the refund always lands on `t.playerA`/
    /// `t.playerB` regardless of who submitted the transaction.
    function reclaimTopUpFor(bytes32 tableId, uint256 nonce, uint64 deadline, bytes calldata sig) external {
        Table storage t = tables[tableId];
        address signer = _consumeIntent(_hashReclaimTopUpIntent(tableId, nonce, deadline), nonce, deadline, sig);
        uint8 seat = _seatOf(t, signer);
        _reclaimTopUp(t, tableId, seat);
    }

    function _reclaimTopUp(Table storage t, bytes32 tableId, uint8 seat) internal {
        if (t.status != Status.Live) revert BadStatus();
        PendingTopUp storage p = pendingTopUps[tableId][seat];
        uint256 amount = p.amount;
        if (amount == 0) revert NothingToReclaim();
        _validateClockExpired(p.deadline);
        delete pendingTopUps[tableId][seat];
        // escrow >= pending always: the seat's escrow only ever grows while Live and
        // includes every wei of its own pending (0.8 checked math would revert anyway).
        if (seat == 1) t.escrowA -= amount;
        else t.escrowB -= amount;
        emit TopUpReclaimed(tableId, seat, amount);
        // effects fully settled above
        address to = seat == 1 ? t.playerA : t.playerB;
        address(tableToken[tableId]).safeTransfer(to, amount);
    }

    /// Any accepted co-signed state conserves the CURRENT escrow total and carries both
    /// signatures — the on-chain proof that all outstanding top-ups were acknowledged.
    /// Called by every accepting path (settle / openDispute / respondWithState); once
    /// acknowledged a top-up is part of the conserved total and can never be reclaimed
    /// (no double-spend: reclaim XOR counted-in-settlement).
    function _ackTopUps(bytes32 tableId) internal {
        if (pendingTopUps[tableId][1].amount != 0) delete pendingTopUps[tableId][1];
        if (pendingTopUps[tableId][2].amount != 0) delete pendingTopUps[tableId][2];
    }

    /// Cooperative settle: either party (or ANY relayer/watchtower on their behalf — see the
    /// contract header) submits the final co-signed state. Fully permissionless: the payout is
    /// determined entirely by the two verified channel-key signatures, conservation, isFinal,
    /// pot==0, and nonce monotonicity — msg.sender's identity is never consulted.
    /// (A Disputed table must first return to Live via a dispute response.)
    function settle(bytes32 tableId, ChannelState calldata state, bytes calldata sigA, bytes calldata sigB) external {
        Table storage t = tables[tableId];
        if (t.status != Status.Live) revert BadStatus();
        _checkCoSigned(t, tableId, state, sigA, sigB);
        if (!t.rules.isFinal(state.phase)) revert NotFinal();
        if (state.pot != 0) revert PotNotZero();
        if (t.hasCheckpoint && state.nonce <= t.checkpointNonce) revert StaleNonce();
        _ackTopUps(tableId); // accepted state conserves the current total incl. any top-ups
        _payout(t, tableId, state.balanceA, state.balanceB);
    }

    /// Public so off-chain code can parity-test the EIP-712 digest. Takes `memory` (not
    /// calldata) so Solidity callers holding a memory struct — fuzz/invariant tests, other
    /// contracts — can compute the digest directly; the external ABI signature is unchanged
    /// (memory vs calldata is internal codegen only), so viem/TS callers keep working.
    function stateDigest(ChannelState memory state) public view returns (bytes32) {
        return _hashTypedData(state.structHashMem());
    }

    // ── Signed-intent typehashes ──────────────────────────────────────────────
    // One EIP-712 struct per relayable `*For` entrypoint. Each binds `tableId` (so an intent
    // cannot be replayed against a different table), `nonce`/`deadline` (consumed by
    // `_consumeIntent` — see SignedIntentBase.sol), and whatever else that specific action's
    // choice actually commits to (see each typehash's own comment). Domain is the contract's
    // existing ("ZkTable","1") EIP-712 domain — the SAME one `stateDigest`/`_checkCoSigned` use
    // (see `_hashTypedData`'s override above), so an intent signed for THIS contract on THIS
    // chain can never be replayed against another ZkTable deployment or another chain.
    bytes32 internal constant DISPUTE_SETUP_INTENT_TYPEHASH =
        keccak256("DisputeSetupIntent(bytes32 tableId,uint256 nonce,uint64 deadline)");
    /// `stateHash` pins the EXACT contested `ChannelState` (via its existing
    /// `ChannelStateLib.structHash`) the signer is opening a dispute against — tampering any
    /// field of the relayer-supplied `state` recomputes a different `stateHash`, which recovers a
    /// different (garbage) signer and fails `_seatOf`. `demandKind`/`demandSlot` are bound
    /// directly since they are the signer's own choice, not derived from `state`.
    bytes32 internal constant OPEN_DISPUTE_INTENT_TYPEHASH = keccak256(
        "OpenDisputeIntent(bytes32 tableId,bytes32 stateHash,uint8 demandKind,uint32 demandSlot,uint256 nonce,uint64 deadline)"
    );
    /// `gameStateHash` is `t.rules.hashGameState(gameState)` computed AT EXECUTION TIME from the
    /// submitted `gameState` bytes — the exact same value `_respondWithMove` independently checks
    /// against `t.disputeState.gameStateHash`. Binding it into the intent gives cross-dispute
    /// replay protection for free: if this intent is replayed against a LATER dispute round on
    /// the same table (a different contested game state), `_respondWithMove`'s own
    /// `BadGameState` guard rejects it, because the hash the (unmodified) replayed `gameState`
    /// bytes recompute to no longer matches the table's CURRENT `disputeState.gameStateHash`.
    /// `moveHash = keccak256(move)` pins the exact move bytes.
    bytes32 internal constant RESPOND_MOVE_INTENT_TYPEHASH = keccak256(
        "RespondMoveIntent(bytes32 tableId,bytes32 gameStateHash,bytes32 moveHash,uint256 nonce,uint64 deadline)"
    );
    bytes32 internal constant RECLAIM_TOPUP_INTENT_TYPEHASH =
        keccak256("ReclaimTopUpIntent(bytes32 tableId,uint256 nonce,uint64 deadline)");
    /// Wallet-only (see `cancelFor`): the recovered signer must equal `t.playerA` directly, never
    /// resolved via `_seatOf` (a channel-signing key alone must not be able to cancel a table).
    bytes32 internal constant CANCEL_INTENT_TYPEHASH =
        keccak256("CancelIntent(bytes32 tableId,uint256 nonce,uint64 deadline)");

    function _hashDisputeSetupIntent(bytes32 tableId, uint256 nonce, uint64 deadline) internal pure returns (bytes32) {
        return keccak256(abi.encode(DISPUTE_SETUP_INTENT_TYPEHASH, tableId, nonce, deadline));
    }

    function _hashOpenDisputeIntent(bytes32 tableId, bytes32 stateHash, uint8 demandKind, uint32 demandSlot, uint256 nonce, uint64 deadline)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(OPEN_DISPUTE_INTENT_TYPEHASH, tableId, stateHash, demandKind, demandSlot, nonce, deadline));
    }

    function _hashRespondMoveIntent(bytes32 tableId, bytes32 gameStateHash, bytes32 moveHash, uint256 nonce, uint64 deadline)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(RESPOND_MOVE_INTENT_TYPEHASH, tableId, gameStateHash, moveHash, nonce, deadline));
    }

    function _hashReclaimTopUpIntent(bytes32 tableId, uint256 nonce, uint64 deadline) internal pure returns (bytes32) {
        return keccak256(abi.encode(RECLAIM_TOPUP_INTENT_TYPEHASH, tableId, nonce, deadline));
    }

    function _hashCancelIntent(bytes32 tableId, uint256 nonce, uint64 deadline) internal pure returns (bytes32) {
        return keccak256(abi.encode(CANCEL_INTENT_TYPEHASH, tableId, nonce, deadline));
    }

    // Public digest helpers — same rationale as `stateDigest`: let off-chain code (and the
    // Solidity<->viem parity tests) compute exactly what `_consumeIntent` will recover against,
    // without duplicating the typehash/encoding on the TS side going stale silently.
    function disputeSetupIntentDigest(bytes32 tableId, uint256 nonce, uint64 deadline) public view returns (bytes32) {
        return _hashTypedData(_hashDisputeSetupIntent(tableId, nonce, deadline));
    }

    function openDisputeIntentDigest(bytes32 tableId, bytes32 stateHash, uint8 demandKind, uint32 demandSlot, uint256 nonce, uint64 deadline)
        public
        view
        returns (bytes32)
    {
        return _hashTypedData(_hashOpenDisputeIntent(tableId, stateHash, demandKind, demandSlot, nonce, deadline));
    }

    function respondWithMoveIntentDigest(bytes32 tableId, bytes32 gameStateHash, bytes32 moveHash, uint256 nonce, uint64 deadline)
        public
        view
        returns (bytes32)
    {
        return _hashTypedData(_hashRespondMoveIntent(tableId, gameStateHash, moveHash, nonce, deadline));
    }

    function reclaimTopUpIntentDigest(bytes32 tableId, uint256 nonce, uint64 deadline) public view returns (bytes32) {
        return _hashTypedData(_hashReclaimTopUpIntent(tableId, nonce, deadline));
    }

    function cancelIntentDigest(bytes32 tableId, uint256 nonce, uint64 deadline) public view returns (bytes32) {
        return _hashTypedData(_hashCancelIntent(tableId, nonce, deadline));
    }

    /// Every state the contract accepts must conserve the CURRENT escrow total —
    /// so dispute timeouts (next task) can always pay out exactly escrowA+escrowB,
    /// and a pre-top-up state becomes unsubmittable once the top-up lands (until/
    /// unless the un-acknowledged top-up is reclaimed — see topUp/reclaimTopUp).
    function _checkCoSigned(Table storage t, bytes32 tableId, ChannelState calldata state, bytes calldata sigA, bytes calldata sigB) internal view {
        _validateTableId(state.tableId, tableId);
        _validateConservation(state.balanceA + state.balanceB + state.pot, t.escrowA + t.escrowB);
        // hot path: hash the calldata struct directly (no calldata->memory copy)
        bytes32 digest = _hashTypedData(state.structHash());
        _validateSig(digest, sigA, t.keyA);
        _validateSig(digest, sigB, t.keyB);
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
        uint8 seat = _seatOf(t, msg.sender);
        _disputeSetup(t, tableId, seat);
    }

    /// Relayed variant of `disputeSetup`: seat resolved from the recovered signer via the same
    /// `_seatOf` a direct call uses — see the contract header's signed-intent section.
    function disputeSetupFor(bytes32 tableId, uint256 nonce, uint64 deadline, bytes calldata sig) external {
        Table storage t = tables[tableId];
        address signer = _consumeIntent(_hashDisputeSetupIntent(tableId, nonce, deadline), nonce, deadline, sig);
        uint8 seat = _seatOf(t, signer);
        _disputeSetup(t, tableId, seat);
    }

    function _disputeSetup(Table storage t, bytes32 tableId, uint8 seat) internal {
        if (t.status != Status.Live) revert BadStatus();
        if (t.hasCheckpoint) revert BadDemand(); // a state exists: use openDispute
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
    ///
    /// @dev DEMAND_SHOWDOWN betting-bypass semantic: for HiLoWarRules, `rules.showdownSlots`
    /// is eligible exactly at PHASE_BET_COMMIT — i.e. the instant the two showdown cards are
    /// dealt, before either seat has committed a bet. A DEMAND_SHOWDOWN dispute therefore only
    /// ever resolves the co-signed state's pot AT THAT PHASE (the ante-only 2x-ante pot from
    /// MOVE_DEAL_DONE) — it can never target a later, larger raised pot, because the contested
    /// `gameState` (and therefore its phase) is fixed at the moment this dispute opens, and
    /// showdownSlots re-derives eligibility from that exact frozen state. This is intentional,
    /// not a gap: it is the earliest point both showdown cards are committed on-chain, so it is
    /// also the earliest point a forced-reveal deadlock could otherwise occur.
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
        uint8 seat = _seatOf(t, msg.sender);
        _openDispute(t, tableId, seat, state, sigA, sigB, gameState, demandKind, demandSlot);
    }

    /// Relayed variant of `openDispute`: `stateHash` (the contested state's own
    /// `ChannelStateLib.structHash`, recomputed here from the relayer-supplied `state`) is bound
    /// into the signed intent — see the `OpenDisputeIntent` typehash comment — so a relayer
    /// cannot swap in a different contested state (or a different demand) than what the signer
    /// actually authorized; a mismatch recovers a garbage signer and fails `_seatOf` below. The
    /// counterparty's own `sigA`/`sigB` co-signature over `state` needs no separate binding: it
    /// is verified against the table's own `keyA`/`keyB` inside `_checkCoSigned` exactly as the
    /// direct path does.
    function openDisputeFor(
        bytes32 tableId,
        ChannelState calldata state,
        bytes calldata sigA,
        bytes calldata sigB,
        bytes calldata gameState,
        uint8 demandKind,
        uint32 demandSlot,
        uint256 nonce,
        uint64 deadline,
        bytes calldata intentSig
    ) external {
        Table storage t = tables[tableId];
        bytes32 stateHash = state.structHash();
        address signer = _consumeIntent(
            _hashOpenDisputeIntent(tableId, stateHash, demandKind, demandSlot, nonce, deadline), nonce, deadline, intentSig
        );
        uint8 seat = _seatOf(t, signer);
        _openDispute(t, tableId, seat, state, sigA, sigB, gameState, demandKind, demandSlot);
    }

    function _openDispute(
        Table storage t,
        bytes32 tableId,
        uint8 seat,
        ChannelState calldata state,
        bytes calldata sigA,
        bytes calldata sigB,
        bytes calldata gameState,
        uint8 demandKind,
        uint32 demandSlot
    ) internal {
        if (t.status != Status.Live) revert BadStatus();
        _checkCoSigned(t, tableId, state, sigA, sigB);
        if (t.hasCheckpoint && state.nonce < t.checkpointNonce) revert StaleNonce();
        if (t.rules.hashGameState(gameState) != state.gameStateHash) revert BadGameState();
        // A3: record whether the contested state is a decided terminal, and who won, so
        // resolveTimeout can pay the recorded winner instead of forfeiting to the disputant
        // (see the resolveTimeout comment for why). winner must be a real seat when decided.
        (bool decided, uint8 winner) = t.rules.result(gameState);
        if (decided && winner != 1 && winner != 2) revert BadGameState();
        t.disputeResultDecided = decided;
        t.disputeResultWinner = winner;
        // Inlined rather than the shared ChannelTableBase._validateDemandKind: DEMAND_SHOWDOWN is
        // a ZkTable-only (2-party) demand kind — HoldemTableN has no showdown adjudication yet —
        // so extending the SHARED helper would let HoldemTableN's openDispute silently accept a
        // demand kind it has no respond/finalize path for. Keeping the tri-state check local here
        // scopes the extension to exactly the contract that implements it.
        if (demandKind != DEMAND_MOVE && demandKind != DEMAND_SHARE && demandKind != DEMAND_SHOWDOWN) revert BadDemand();
        // A SHARE demand names a deck slot the counterparty must reveal via respondWithShare, which
        // reads t.demandSlot / disputeState.deckCommitment (NOT caller args). An out-of-range slot,
        // or a state with no committed deck, is unanswerable by construction — left unbounded a
        // single party could open a dispute the counterparty cannot clear and take the pot on
        // timeout. Bound both here at the trust boundary (respondWithShare's slot>51 guard becomes
        // an assert). 52-card deck => valid slots are [0, 51].
        if (demandKind == DEMAND_SHARE) {
            if (demandSlot > 51) revert BadDemand();
            if (state.deckCommitment == bytes32(0)) revert BadDemand();
        } else if (demandKind == DEMAND_SHOWDOWN) {
            // Same unanswerable-by-construction concern as SHARE, plus: the two showdown slots
            // come from the RULES contract (not caller args), so a malformed/ineligible gameState
            // is rejected here rather than silently opening an unfinalizable dispute.
            if (state.deckCommitment == bytes32(0)) revert BadDemand();
            (bool eligible, uint32 sA, uint32 sB) = t.rules.showdownSlots(gameState);
            if (!eligible || sA > 51 || sB > 51 || sA == sB) revert BadDemand();
            delete showdowns[tableId]; // defensive: wipe any stale reveals from a prior cycle
            showdowns[tableId].slotA = sA;
            showdowns[tableId].slotB = sB;
        }
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
        // accepted contested state conserves the current total incl. any top-ups, so the
        // pending claims die here — resolveTimeout can then pay out exactly the escrow.
        _ackTopUps(tableId);
        emit DisputeOpened(tableId, seat, demandKind, demandSlot, t.disputeDeadline);
    }

    /// Universal answer: a co-signed state newer than the contested one. Fully permissionless
    /// (no `_seatOf(msg.sender)` gate — see the contract header) so a watchtower can defend a
    /// gasless player's table without needing that player's own key to submit the tx.
    function respondWithState(bytes32 tableId, ChannelState calldata state, bytes calldata sigA, bytes calldata sigB) external {
        Table storage t = tables[tableId];
        if (t.status != Status.Disputed) revert BadStatus();
        _checkCoSigned(t, tableId, state, sigA, sigB);
        // setup dispute (demandKind 0): any co-signed state proves liveness;
        // move/share disputes need strictly newer than the contested state.
        if (t.demandKind != 0 && state.nonce <= t.disputeState.nonce) revert StaleNonce();
        t.checkpointNonce = state.nonce;
        t.hasCheckpoint = true;
        _ackTopUps(tableId); // accepted state conserves the current total incl. any top-ups
        _clearDispute(tableId, t);
        emit DisputeAnsweredWithState(tableId, state.nonce);
    }

    /// Answer a MOVE demand: the owing seat publishes the demanded move on-chain.
    /// The rules contract is the judge; an illegal move reverts there.
    function respondWithMove(bytes32 tableId, bytes calldata gameState, bytes calldata move) external {
        Table storage t = tables[tableId];
        uint8 seat = _seatOf(t, msg.sender);
        _respondWithMove(t, tableId, seat, gameState, move);
    }

    /// Relayed variant of `respondWithMove`: `gameStateHash` is `t.rules.hashGameState(gameState)`
    /// computed HERE, at execution time, from the submitted `gameState` — see the
    /// `RespondMoveIntent` typehash comment for why this alone gives cross-dispute replay
    /// protection (no separate check needed: `_respondWithMove`'s own `BadGameState` guard below
    /// already requires this hash to match the table's CURRENT contested state).
    function respondWithMoveFor(
        bytes32 tableId,
        bytes calldata gameState,
        bytes calldata move,
        uint256 nonce,
        uint64 deadline,
        bytes calldata sig
    ) external {
        Table storage t = tables[tableId];
        bytes32 gameStateHash = t.rules.hashGameState(gameState);
        bytes32 moveHash = keccak256(move);
        address signer =
            _consumeIntent(_hashRespondMoveIntent(tableId, gameStateHash, moveHash, nonce, deadline), nonce, deadline, sig);
        uint8 seat = _seatOf(t, signer);
        _respondWithMove(t, tableId, seat, gameState, move);
    }

    function _respondWithMove(Table storage t, bytes32 tableId, uint8 seat, bytes calldata gameState, bytes calldata move) internal {
        if (t.status != Status.Disputed) revert BadStatus();
        if (t.demandKind != DEMAND_MOVE) revert NotDemanded();
        if (seat == t.disputant) revert NotYourDispute();
        if (t.rules.hashGameState(gameState) != t.disputeState.gameStateHash) revert BadGameState();
        bytes memory newState = t.rules.applyMove(gameState, move);
        _clearDispute(tableId, t);
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
    ///
    /// @dev CLOSED — forced-reveal-then-refuse-to-cosign deadlock. This function's answer is
    /// still deliberately event-only/non-settling (unforgeable per-slot proof, but no on-chain
    /// game-state advance) — that has NOT changed, and never settles funds by itself. What
    /// changed: a party stuck at SHOWDOWN who cannot get a FLIP_DONE co-sign is no longer stuck
    /// oscillating Live<->Disputed forever. They instead open a DEMAND_SHOWDOWN dispute (see
    /// postShowdownReveals / finalizeShowdown / resolveTimeout below), which accumulates BOTH
    /// seats' snark-verified reveals for the two showdown slots on-chain, decodes the cards via
    /// the vendored CardTable52, asks the rules contract for the winner, and pays out —
    /// converting the exposed truth into a real settlement instead of an inert event. The safety
    /// invariant is unchanged: only snark-verified reveals ever feed a payout; respondWithMove's
    /// (unverified) MOVE_SHOWDOWN cards still settle nothing (see finalizeShowdown / A3).
    /// resolveTimeout is ANSWER-AWARE for a showdown dispute (tracks which seat actually posted
    /// its 2 reveals), so a disputant who posts nothing and lets the honest counterparty reveal
    /// can no longer free-roll the pot by timeout — see resolveTimeout's header for the full
    /// truth table.
    ///
    /// @dev OFF-CHAIN OBLIGATION — deck-key binding. respondWithShare (and postShowdownReveals)
    /// prove a share against the key each seat registered at create/join (deckKeys), but NOTHING
    /// on-chain ties that key to the key actually used to mask the committed deck. A seat that
    /// registers a decoy key can answer with snark-valid but useless shares. For a SHARE dispute
    /// this only defeats reveal-forcing (forfeit-only, per the note above). For a SHOWDOWN
    /// dispute it can make its own slot decrypt to a point outside the fixed 52-card table —
    /// finalizeShowdown detects that (CardTable52.decode reports ok=false) and falls back to
    /// SPLITTING the pot rather than reverting or forfeiting the whole pot to either side, so a
    /// decoy key can at most cost its registrant half the pot, never steal the other half. Full
    /// closure — on-chain enforcement that each registered deckKey actually multiplies into the
    /// state's committed joint masking key — is a follow-up, out of scope here. Clients MUST
    /// verify the deck's aggregate masking key equals the product of the registered deckKeys before
    /// co-signing any DEAL state.
    ///
    /// @dev PERMISSIONLESS (2026-08 signed-intent pass) — no `_seatOf(msg.sender)` gate. The
    /// responder is always the STRUCTURAL counterparty of the dispute (`seat = 3 - t.disputant`
    /// — a SHARE dispute's disputant is always a real seat, 1 or 2, so this is always the other
    /// real seat), never derived from the caller. The function is self-authenticating regardless:
    /// the snark check below verifies the proof against `deckKeys[tableId][seat]`, a specific
    /// registered secret only that seat's holder can produce a passing witness for — a stranger
    /// relaying this call can only ever land the TRUE counterparty's own share (which helps that
    /// seat exactly as if it had submitted directly); it can never fabricate a share, redirect one
    /// to the wrong seat, or move funds (this function only clears the dispute — see the CLOSED
    /// note above; it never pays out). An invalid proof reverts `BadProof` and stores nothing.
    function respondWithShare(
        bytes32 tableId,
        uint256[] calldata deck,
        uint256[2] calldata reveal,
        uint256[8] calldata zkproof
    ) external {
        Table storage t = tables[tableId];
        if (t.status != Status.Disputed) revert BadStatus();
        if (t.demandKind != DEMAND_SHARE) revert NotDemanded();
        // The responder is structurally the dispute's counterparty — SHARE disputes always have
        // a real seat (1 or 2) as disputant (set by openDispute), so 3-disputant is always the
        // other real seat. See the @dev PERMISSIONLESS note above for why this is safe.
        uint8 seat = 3 - t.disputant;
        if (deck.length != 208) revert BadDeck();
        if (keccak256(abi.encodePacked(deck)) != t.disputeState.deckCommitment) revert BadDeck();
        uint32 slot = t.demandSlot;
        if (slot > 51) revert BadDeck();
        uint256[2] memory pk = deckKeys[tableId][seat];
        uint256[6] memory pi = [deck[4 * slot], deck[4 * slot + 1], reveal[0], reveal[1], pk[0], pk[1]];
        (bool callOk, bytes memory ret) = t.rules.revealVerifier()
            .staticcall(abi.encodeWithSignature("verifyRevealWithSnark(uint256[6],uint256[8])", pi, zkproof));
        if (!callOk || ret.length < 32 || !abi.decode(ret, (bool))) revert BadProof();
        _clearDispute(tableId, t);
        emit DisputeAnsweredWithShare(tableId, slot, reveal[0], reveal[1]);
    }

    // ── Showdown dispute (binding on-chain card-reveal settlement) ───────────

    /// Shared verification + accumulation for `postShowdownReveals`: checks the deck matches the
    /// contested state's commitment, verifies the Groth16 snark proof that `reveal = seat's
    /// registered deckKey * e1` for `slot`, and — ONLY if that proof passes — stores the share
    /// in the showdown accumulator. This is the sole write path into `showdowns[tableId]`, so
    /// every stored reveal is behind a passing snark proof by construction; nothing else can
    /// populate the accumulator finalizeShowdown / resolveTimeout read from.
    function _verifyAndStoreReveal(
        bytes32 tableId,
        Table storage t,
        uint8 seat,
        uint256[] calldata deck,
        uint32 slot,
        uint256[2] calldata reveal,
        uint256[8] calldata zkproof
    ) internal {
        ShowdownDispute storage sd = showdowns[tableId];
        uint8 slotIdx;
        if (slot == sd.slotA) slotIdx = 0;
        else if (slot == sd.slotB) slotIdx = 1;
        else revert BadDeck(); // not one of the two slots this showdown dispute demands

        if (deck.length != 208) revert BadDeck();
        if (keccak256(abi.encodePacked(deck)) != t.disputeState.deckCommitment) revert BadDeck();

        uint256[2] memory pk = deckKeys[tableId][seat];
        uint256[6] memory pi = [deck[4 * slot], deck[4 * slot + 1], reveal[0], reveal[1], pk[0], pk[1]];
        (bool callOk, bytes memory ret) = t.rules.revealVerifier()
            .staticcall(abi.encodeWithSignature("verifyRevealWithSnark(uint256[6],uint256[8])", pi, zkproof));
        if (!callOk || ret.length < 32 || !abi.decode(ret, (bool))) revert BadProof();

        uint8 seatIdx = seat - 1; // seat is always 1 or 2 (from _seatOf)
        uint8 bit = uint8(1 << (slotIdx * 2 + seatIdx));
        if (sd.haveMask & bit != 0) revert AlreadyRevealed();
        sd.reveal[slotIdx][seatIdx][0] = reveal[0];
        sd.reveal[slotIdx][seatIdx][1] = reveal[1];
        sd.haveMask |= bit;
        emit ShowdownRevealStored(tableId, slot, seat, reveal[0], reveal[1]);
    }

    /// Either seat posts BOTH of its own showdown reveals (for slotA and slotB, in either order)
    /// in one call. There is no "forced" vs "own" distinction anymore — the demand is implicit:
    /// resolveTimeout is answer-aware and punishes whichever seat did NOT fully reveal (see its
    /// header). `_verifyAndStoreReveal`'s first-write-wins guard means calling this twice for the
    /// same slot reverts AlreadyRevealed rather than overwriting.
    ///
    /// @dev PERMISSIONLESS (2026-08 signed-intent pass) — no `_seatOf(msg.sender)` gate. `seat`
    /// (1 or 2, bounds-checked below) is now an EXPLICIT argument rather than derived from the
    /// caller, so a relayer/watchtower can post a gasless seat's own reveals on its behalf. This
    /// is safe because the function is self-authenticating regardless of who calls it or what
    /// `seat` they claim: `_verifyAndStoreReveal` verifies each proof against
    /// `deckKeys[tableId][seat]` — a specific registered secret only that seat's holder can
    /// produce a passing witness for — so a proof valid under seat 1's key can only ever land in
    /// seat 1's reveal cells; a stranger cannot mis-attribute a share to the wrong seat, and an
    /// invalid/wrong-seat proof reverts `BadProof` before anything is stored.
    ///
    /// Extends the dispute clock by a full `clockBlocks` window after a successful post — a
    /// seat that reveals right before the original deadline must not have its answer race a
    /// clock that was sized for a MOVE/SHARE answer, not two Groth16 verifications plus calldata.
    /// Bounded: at most 4 reveals total ever get stored (first-write-wins), so this cannot be
    /// used to extend the dispute indefinitely.
    function postShowdownReveals(
        bytes32 tableId,
        uint8 seat,
        uint256[] calldata deck,
        uint32[2] calldata slots,
        uint256[2][2] calldata reveals,
        uint256[8][2] calldata proofs
    ) external {
        Table storage t = tables[tableId];
        if (t.status != Status.Disputed) revert BadStatus();
        if (t.demandKind != DEMAND_SHOWDOWN) revert NotDemanded();
        if (seat != 1 && seat != 2) revert NotPlayer();
        _verifyAndStoreReveal(tableId, t, seat, deck, slots[0], reveals[0], proofs[0]);
        _verifyAndStoreReveal(tableId, t, seat, deck, slots[1], reveals[1], proofs[1]);
        t.disputeDeadline = uint64(block.number) + t.clockBlocks;
    }

    /// Finalize a DEMAND_SHOWDOWN dispute once BOTH seats' reveals for BOTH contested slots are
    /// on-chain (haveMask == 0x0F, i.e. all 4 of {A,B} x {slotA,slotB}). This is the ONLY
    /// terminal for a fully-revealed showdown — there is no deadline requirement and no caller
    /// restriction (anyone may call it, since it can only ever pay the two seated players the
    /// deterministic outcome; see resolveTimeout's header for why a fully-revealed showdown must
    /// NOT be timeout-resolvable). ONLY reveals that passed `_verifyAndStoreReveal`'s snark check
    /// ever reach this function; respondWithMove's MOVE_SHOWDOWN cards are never consulted here
    /// (or anywhere else) — see the A3 safety note on respondWithShare above.
    function finalizeShowdown(bytes32 tableId, uint256[] calldata deck, bytes calldata gameState) external {
        Table storage t = tables[tableId];
        if (t.status != Status.Disputed) revert BadStatus();
        if (t.demandKind != DEMAND_SHOWDOWN) revert NotDemanded();
        _finalizeShowdown(tableId, t, deck, gameState);
    }

    /// Split out of `finalizeShowdown` (kept as a thin entrypoint that only checks status/kind)
    /// purely to keep each function's local-variable count small: the combined body hit solc's
    /// Yul stack-too-deep under this profile's viaIR/optimizer-runs:1000 (a whole-contract
    /// budget, not a defect in the logic itself — splitting the same code across two internal
    /// calls resolves it without changing behavior).
    function _finalizeShowdown(bytes32 tableId, Table storage t, uint256[] calldata deck, bytes calldata gameState) internal {
        ShowdownDispute storage sd = showdowns[tableId];
        if (sd.haveMask != 0x0F) revert RevealsIncomplete();
        if (deck.length != 208) revert BadDeck();
        if (keccak256(abi.encodePacked(deck)) != t.disputeState.deckCommitment) revert BadDeck();
        if (t.rules.hashGameState(gameState) != t.disputeState.gameStateHash) revert BadGameState();

        // Decoding lives in ShowdownDecodeLib, an EXTERNAL (separately-deployed) library — see
        // that file's header for why: CardTable52.decode's 52-branch body, inlined internally,
        // tipped ZkTable's viaIR build over solc's Yul stack-too-deep in an unrelated function.
        uint256[8] memory revealsFlat = [
            sd.reveal[0][0][0], sd.reveal[0][0][1], sd.reveal[0][1][0], sd.reveal[0][1][1],
            sd.reveal[1][0][0], sd.reveal[1][0][1], sd.reveal[1][1][0], sd.reveal[1][1][1]
        ];
        (bool okA, uint8 cardA, bool okB, uint8 cardB) = ShowdownDecodeLib.decodeBothCards(deck, sd.slotA, sd.slotB, revealsFlat);

        // Conservation invariant (_checkCoSigned, enforced when this state was co-signed and
        // accepted at openDispute) guarantees balanceA + balanceB + pot == escrowA + escrowB,
        // so routing the pot below consumes the full escrow exactly — same accounting shape as
        // resolveTimeout.
        (uint256 toA, uint256 toB, uint8 winner) = _showdownOutcome(t, okA, cardA, okB, cardB, gameState);

        // Effects before the token transfers (CEI, matching _payout's own discipline): emit, wipe
        // the reveal accumulator + dispute fields, THEN transfer. NB: payout is a wrapper-token
        // safeTransfer (no receiver callback), not a native forced-send — a genuine clone's
        // transfer cannot revert-grief, but the treasury/recipients must be transfer-able addresses.
        emit ShowdownFinalized(tableId, cardA, cardB, winner);
        _clearDispute(tableId, t);
        _payout(t, tableId, toA, toB);
    }

    /// Both cards must have decoded to real, DISTINCT table entries to have a real winner;
    /// otherwise (a decode failure from a decoy/garbage deck key, or a stacked/duplicated deck
    /// producing cardA==cardB) this SPLITS the pot instead of forfeiting it to either side — see
    /// the off-chain-obligation note on respondWithShare for why this is the correct fallback
    /// (a decoy key can cost its registrant at most half the pot, never hand the other seat's
    /// half to it, and never revert the whole settlement). `winner` returned is 1/2 (a real
    /// winner), 0 (an on-chain rank tie — forfeit-to-disputant, matching resolveTimeout's
    /// undecided-terminal policy), or SHOWDOWN_SPLIT (this fallback), purely for the
    /// ShowdownFinalized event; the tie and split cases are accounting-distinct even though
    /// both can withhold the "whole pot to one side" outcome.
    function _showdownOutcome(Table storage t, bool okA, uint8 cardA, bool okB, uint8 cardB, bytes calldata gameState)
        internal
        view
        returns (uint256 toA, uint256 toB, uint8 winner)
    {
        toA = t.disputeState.balanceA;
        toB = t.disputeState.balanceB;
        uint256 pot = t.disputeState.pot;
        if (okA && okB && cardA != cardB) {
            winner = t.rules.showdownResult(gameState, cardA, cardB);
            if (winner > 2) revert BadGameState();
            uint8 potTo = winner == 0 ? t.disputant : winner;
            if (potTo == 1) toA += pot; else toB += pot;
        } else {
            winner = SHOWDOWN_SPLIT;
            uint256 half = pot / 2;
            toA += half + (pot - half * 2); // odd wei stays with A
            toB += half;
        }
    }

    /// Clock expired unanswered. Setup disputes (demandKind 0) refund both escrows in full (no
    /// pot exists yet — spec edge case). MOVE/SHARE disputes keep the original A3 forfeit logic
    /// verbatim (pay the recorded decided-terminal winner, else forfeit-to-disputant).
    ///
    /// DEMAND_SHOWDOWN is ANSWER-AWARE — this is the fix for the disputant free-roll: a
    /// disputant who posts nothing, lets the honest counterparty reveal its 2 shares, and then
    /// simply never calls finalizeShowdown (because it can decrypt off-chain from the exposed
    /// shares and only wants to finalize when IT wins) used to still collect the whole pot via
    /// the old demand-kind-agnostic forfeit-to-disputant timeout. Truth table (dispSeat = the
    /// seat that opened the dispute; cpSeat = the other seat; "answered" = posted BOTH of that
    /// seat's 2 reveals via postShowdownReveals):
    ///   haveMask == 0x0F (both fully answered)      -> revert MustFinalize(); anyone can (and
    ///                                                   must) call the permissionless, deadline-
    ///                                                   free finalizeShowdown instead. This
    ///                                                   closes the free-roll: a decode that
    ///                                                   actually works is never timeout-gameable.
    ///   dispSeat answered, cpSeat did not            -> pot to dispSeat (cp refused to reveal).
    ///   cpSeat answered, dispSeat did not             -> pot to cpSeat (disp refused — the
    ///                                                   free-roll path, now closed).
    ///   neither fully answered                        -> SPLIT the pot (mutual no-show; a
    ///                                                   rational eventual winner would have
    ///                                                   revealed to claim it, so splitting
    ///                                                   denies either side a griefing edge).
    /// Balances are always refunded to their respective seats in every branch; only the pot's
    /// destination differs.
    function resolveTimeout(bytes32 tableId) external {
        Table storage t = tables[tableId];
        if (t.status != Status.Disputed) revert BadStatus();
        _validateClockExpired(t.disputeDeadline);
        if (t.demandKind == 0) {
            emit SetupDisputeRefunded(tableId);
            _payout(t, tableId, t.escrowA, t.escrowB);
            return;
        }
        if (t.demandKind == DEMAND_SHOWDOWN) {
            _resolveShowdownTimeout(tableId, t);
            return;
        }
        // Conservation invariant (_checkCoSigned) guarantees the contested state's
        // balances + pot == escrowA + escrowB, so handing the pot to the recorded
        // party and balances to each seat consumes the full escrow exactly — no excess.
        uint256 toA = t.disputeState.balanceA;
        uint256 toB = t.disputeState.balanceB;
        // A3: at a co-signed *decided* terminal state pay the recorded winner, not the
        // disputant — otherwise the loser could open an unanswerable dispute at FLIP_DONE
        // and steal the pot on timeout. Undecided states keep forfeit-to-disputant (the
        // reveal/move-forcing lever). Keyed on decided-ness, NOT demandKind, so it covers
        // both MOVE and SHARE disputes opened at a decided FLIP_DONE.
        //
        // KNOWN v1 LIMITATION — undecided-terminal (tie/"war") carry-pot race. A rank-tie
        // FLIP_DONE is undecided (resultSet=false, pot carried into warPot), so it takes this
        // forfeit-to-disputant branch: if a player force-terminates an ongoing war by disputing
        // the co-signed tie state, whichever of the TWO seated players reaches chain first takes
        // the carried pot on timeout. Accepted as-is: low-stakes (only a carried pot, at a tie),
        // symmetric (either player can do it), and both contributed equally. Only the two seats
        // can dispute (_seatOf) — no outsider path. A fair 50/50 split would need a tri-state
        // result() hook; deferred.
        uint8 potTo = t.disputeResultDecided ? t.disputeResultWinner : t.disputant;
        if (potTo == 1) toA += t.disputeState.pot; else toB += t.disputeState.pot;
        emit DisputeForfeited(tableId, potTo, toA, toB);
        _payout(t, tableId, toA, toB);
    }

    /// See resolveTimeout's header for the full truth table. `winner` in the emitted
    /// DisputeForfeited event is 1/2 for a real forfeit destination, or 0 to mean SPLIT here
    /// specifically (distinct from the MOVE/SHARE branch above, where potTo is always a real
    /// seat — t.disputant is never 0).
    function _resolveShowdownTimeout(bytes32 tableId, Table storage t) internal {
        ShowdownDispute storage sd = showdowns[tableId];
        uint8 haveMask = sd.haveMask;
        if (haveMask == 0x0F) revert MustFinalize();

        uint8 dispSeat = t.disputant;
        uint8 cpSeat = dispSeat == 1 ? 2 : 1;
        // seat 1's two reveal bits are {bit0, bit2} = 0x05; seat 2's are {bit1, bit3} = 0x0A
        // (bit = 1 << (slotIdx*2 + seatIdx), seatIdx = seat-1 — see ShowdownDispute/haveMask).
        uint8 dispMask = dispSeat == 1 ? 0x05 : 0x0A;
        uint8 cpMask = cpSeat == 1 ? 0x05 : 0x0A;
        bool dispAnswered = (haveMask & dispMask) == dispMask;
        bool cpAnswered = (haveMask & cpMask) == cpMask;

        uint256 toA = t.disputeState.balanceA;
        uint256 toB = t.disputeState.balanceB;
        uint256 pot = t.disputeState.pot;
        uint8 potTo; // 1/2 = real forfeit destination, 0 = split
        if (dispAnswered && !cpAnswered) {
            potTo = dispSeat;
        } else if (cpAnswered && !dispAnswered) {
            potTo = cpSeat;
        } else {
            potTo = 0; // neither fully answered (both-0x0F already handled above)
        }

        if (potTo == 1) {
            toA += pot;
        } else if (potTo == 2) {
            toB += pot;
        } else {
            uint256 half = pot / 2;
            toA += half + (pot - half * 2); // odd wei stays with A
            toB += half;
        }

        delete showdowns[tableId];
        emit DisputeForfeited(tableId, potTo, toA, toB);
        _payout(t, tableId, toA, toB);
    }

    /// Clears a table's dispute fields back to Live AND wipes any showdown reveal accumulator —
    /// so a newer co-signed state (respondWithState) always resets showdown progress rather than
    /// letting stale reveals from an abandoned dispute leak into a later one. Deleting
    /// `showdowns[tableId]` here is a no-op for MOVE/SHARE disputes (the mapping is only ever
    /// written by DEMAND_SHOWDOWN's reveal path) — cheap, and correct regardless of demand kind.
    function _clearDispute(bytes32 tableId, Table storage t) internal {
        t.status = Status.Live;
        t.disputant = 0;
        t.demandKind = 0;
        t.demandSlot = 0;
        t.disputeDeadline = 0;
        t.disputeResultDecided = false;
        t.disputeResultWinner = 0;
        delete t.disputeState;
        delete showdowns[tableId];
    }

    function _payout(Table storage t, bytes32 tableId, uint256 toA, uint256 toB) internal {
        t.status = Status.Settled;
        t.escrowA = 0;
        t.escrowB = 0;
        emit TableSettled(tableId, toA, toB);
        address token = address(tableToken[tableId]);
        if (toA > 0) token.safeTransfer(t.playerA, toA);
        if (toB > 0) token.safeTransfer(t.playerB, toB);
    }
}
