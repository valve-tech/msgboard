// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {EIP712} from "solady/src/utils/EIP712.sol";
import {SafeTransferLib} from "solady/src/utils/SafeTransferLib.sol";
import {LibString} from "solady/src/utils/LibString.sol";
import {ChannelStateN, ChannelStateNLib, SidePot} from "./ChannelStateN.sol";
import {IGameRulesN} from "./IGameRulesN.sol";
import {RevealShareDLEQ} from "./lib/RevealShareDLEQ.sol";
import {EllipticCurve} from "./lib/EllipticCurve.sol";
import {ChannelTableBase} from "./ChannelTableBase.sol";
import {IX402Token} from "../games/FlipBookX.sol";

/// A wrapper clone's own view of the underlying asset it wraps (ValveWrapperImpl.underlying()).
/// Duplicated verbatim from ZkTable.sol (its sibling x402 conversion) rather than imported from
/// it, so this file's compilation graph does not pick up ZkTable's own dependencies (incl. the
/// external ShowdownDecodeLib library) merely to reach two tiny interfaces.
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
/// Every seat registers its deck pubkey (the same pubkeys that form the off-chain joint
/// encryption key) as a parameter of create()/join() — a seat cannot exist without one —
/// and may rotate it via registerDeckKey() while still Forming.
///
/// Shared errors/Status/dispute-clock constants/co-sign helpers live in ChannelTableBase,
/// alongside its ZkTable counterpart (2026-08 DRY pass) — see that file's header for what's
/// shared vs. why the escrow/state shape stays separate. (Status.Created is this contract's
/// "Forming" — the enum keeps ZkTable's original member name; see ChannelTableBase.)
///
/// ── x402 ASSET PLUMBING (2026-08 conversion) ─────────────────────────────────────────────────
/// Escrow no longer moves as native PLS (`msg.value`). Every table is denominated in ONE x402
/// wrapper token (`tableToken[tableId]`, set once at `create` and immutable thereafter), pulled
/// gaslessly via the wrapper's EIP-3009/7598 `receiveWithAuthorization` (see `_pull`, lifted
/// verbatim from FlipBookX/ZkTable). The signer of each `DepositAuth` — `auth.from` — is the
/// player; `msg.sender` is whoever relays the call (a bot, a paymaster, the player themselves)
/// and is NEVER used as a player identity anywhere funds move. This is the seat-hijack closure:
/// `createNonce`/`joinNonce` bind every economically-relevant term (the token, the rules
/// contract, the buy-in, the seat cap, BOTH rake parameters, the clock, the channel key, the
/// deck key, and a `salt`) into the wrapper's own EIP-712 nonce, so a relayer that tampers with
/// any term recomputes a different nonce, the wrapper's signature recovery then fails against
/// the player's original signature, and the call reverts. `join`'s `salt` exists purely for
/// REJOIN liveness, not anti-double-join: the seat/key collision loop is what actually enforces
/// one seat per (tableId, from) while a player is seated, so a bare `joinNonce` (no salt) would
/// otherwise be a one-shot authorization a player who `leaveBeforeStart`s can never reuse to
/// rejoin the SAME table with the SAME channelKey/deckKey (the wrapper's nonce is burned
/// forever) — a genuine liveness bug, not a fund-safety one, since a stale burned auth cannot be
/// replayed while the original seat still exists. Seat INDEX is deliberately NOT bound into
/// either nonce — it is assigned by execution order and is mutable via `leaveBeforeStart`'s
/// swap-and-pop, so binding it would make a perfectly valid join replay-fail merely because
/// another seat joined or left first; identity + channel key + deck key + table is what a
/// signer actually commits to. Payouts move via `token.safeTransfer` (a plain push of the
/// wrapper token — NEVER unwrapped in-contract; a player holds the wrapper and unwraps it
/// themselves if they want native PLS back). The accrued rake is paid to `treasury` in the SAME
/// wrapper token as the table — see `_payoutVector`'s note on multi-token treasury inflow AND
/// on why `treasury` must be a non-reverting receiver.
///
/// `settle` and `respondWithState` are now fully permissionless (no `_seatOf(msg.sender)` gate):
/// each is self-authenticating via the N co-signed channel-key signatures, so any relayer/
/// watchtower can submit them on a player's behalf without ever touching that player's escrow
/// identity. `openDispute`/`respondWithMove`/`respondWithShare`/`registerDeckKey`/`start` stay
/// seat-gated on `msg.sender` exactly as before — those are direct-action paths (identity
/// load-bearing, or only meaningful while Forming), not relayable deposits. `leaveBeforeStart`/
/// `cancel` likewise stay `msg.sender`-gated: they are withdrawal requests by an already-seated
/// wallet, not something a relayer needs to submit on a signer's behalf.
///
/// ── GAS PRECONDITION for gasless seating (2026-08, F3) ───────────────────────────────────────
/// Deposits (`create`/`join`) are gasless/relayable, but EVERY defensive path is NOT: `start`,
/// `leaveBeforeStart`, `cancel`, `openDispute`, `respondWithMove`, and `respondWithShare` are all
/// gas-gated on the seat/channelKey actually submitting the transaction as `msg.sender` (see
/// `_seatOf`). A seat whose escrow was funded entirely by a relayer, but which holds zero native
/// PLS of its own, cannot defend itself: it cannot `leaveBeforeStart` to exit a Forming table it
/// no longer wants to be at, and once Live it cannot answer a MOVE or SHARE demand naming it —
/// `resolveTimeout` then force-folds its stake to the other seats. For an N-seat table this means
/// N−1 of the N players each need their OWN gas-funded wallet, not just a signed deposit
/// authorization. This is a HARD client/product precondition for gasless seating as shipped here;
/// removing it needs a follow-up dispute-relay path (signed-intent MOVE/SHARE/leave responses a
/// relayer can submit on a gas-less seat's behalf), which is out of scope for this conversion.
contract HoldemTableN is EIP712, ChannelTableBase {
    using SafeTransferLib for address;
    using ChannelStateNLib for ChannelStateN;
    using RevealShareDLEQ for RevealShareDLEQ.Statement;

    // HoldemTableN-only errors: the shared 18 (WrongValue..BadDeck) are inherited from
    // ChannelTableBase.
    error BadSeatCount();
    error DuplicateKey();
    error TooManySeats();
    error NotEnoughSeats();
    error RakeTooHigh();
    error WrongSigCount();
    error SeatRange();
    error BadDeckKey();
    error DeckKeyNotSet();
    error BadShareProof();
    /// `create()`'s token argument does not round-trip through the wrapper factory
    /// (`factory.wrapperOf(token.underlying()) != token`) — not a genuine x402 wrapper clone.
    error BadToken();

    uint256 public constant MAX_SEATS = 9;
    uint256 public constant MAX_RAKE_BPS = 250; // 2.5%

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

    /// A signed x402 EIP-3009/7598 pull authorization: `from` is the player identity (NOT
    /// necessarily `msg.sender` — this is the whole point, see the contract header), `sig` is
    /// either a 65-byte (v,r,s) EOA signature or an EIP-7598 `bytes` payload (ERC-1271/Safe),
    /// routed by `_pull` exactly as FlipBookX/ZkTable do. `validBefore` is the wrapper
    /// authorization's own expiry; `salt` lets a signer mint a fresh nonce for `create` (join
    /// needs none — see the contract header).
    struct DepositAuth {
        address from;
        uint64 validBefore;
        bytes32 salt;
        bytes sig;
    }

    address public immutable treasury;
    uint256 internal _counter;
    mapping(bytes32 => Table) internal _tables;
    /// tableId => seat index => secp256k1 deck pubkey (x,y). (0,0) == unset (not on-curve).
    /// These are the SAME per-seat keys that aggregate into the off-chain joint deck key;
    /// registered while Forming and read by respondWithShare to check a contested share.
    mapping(bytes32 => mapping(uint256 => uint256[2])) internal _deckKey;
    /// The x402 wrapper token a table is denominated + escrowed in, set once at `create` and
    /// immutable thereafter. Separate mapping (not a Table field), mirroring ZkTable's
    /// `tableToken` — keeps the Table struct's shape (and every existing view getter) unchanged.
    mapping(bytes32 => IX402Token) public tableToken;

    /// The CREATE2 wrapper factory used to confirm a `create()`-supplied token is a genuine x402
    /// wrapper clone (see IWrapperFactory). Immutable, set once at deploy; `address(0)` disables
    /// the clone-check entirely (used by the unit-test suite, which funds via a bare MockX402).
    IWrapperFactory public immutable factory;

    // NOTE (x402 conversion): TableCreated gained the `token` field (inserted right after
    // `creator`) — a new position in the event's tuple, not just a new trailing field. No ABI
    // artifact is committed for this package (hardhat's artifacts/ + typechain-types/ are both
    // gitignored, regenerated on `hardhat compile`) and no off-chain indexer consumes this event
    // yet (HoldemTableN is undeployed) — but whichever indexer/ABI IS built against this contract
    // MUST be rebuilt from this source, not from a stale copy.
    event TableCreated(bytes32 indexed tableId, address indexed creator, address token, address rules, uint256 buyIn, uint256 maxSeats, uint16 rakeBps, uint256 rakeCap, uint64 clockBlocks);
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

    constructor(address treasury_, address factory_) {
        treasury = treasury_ == address(0) ? msg.sender : treasury_;
        factory = IWrapperFactory(factory_);
    }

    /// Matches makeDomainN() in the holdem stateSigN.ts: name 'HoldemTableN', version '1'.
    function _domainNameAndVersion() internal pure override returns (string memory, string memory) {
        return ("HoldemTableN", "1");
    }

    /// Route to the wrapper's matching authorization overload: exactly-65-byte signatures use the
    /// universal (v,r,s) form (works on every wrapper build, incl. 943's older impl); any other
    /// length is an ERC-1271 payload for the EIP-7598 `bytes` form (Safes / smart accounts).
    /// Lifted verbatim from FlipBookX._pull / ZkTable._pull.
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

    /// The `create()` authorization's nonce — binds EVERY economically-relevant term: the token,
    /// the rules contract, the buy-in, the seat cap, BOTH rake parameters (the creator signs off
    /// on exactly the rake it exposes every future joiner to), the clock, the channel key, and
    /// the deck key. `salt` lets the same signer mint distinct table-creation authorizations.
    function createNonce(
        address from,
        IX402Token token,
        IGameRulesN rules,
        uint256 buyIn,
        uint256 maxSeats,
        uint16 rakeBps,
        uint256 rakeCap,
        uint64 clockBlocks,
        address channelKey,
        uint256[2] memory deckKey,
        bytes32 salt
    ) public view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("HoldemTableN.X402.Create"),
                block.chainid,
                address(this),
                from,
                token,
                rules,
                buyIn,
                maxSeats,
                rakeBps,
                rakeCap,
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
    /// under a different channel/deck key than the one the player actually signed. `salt` here
    /// exists purely for REJOIN LIVENESS, not anti-double-join: `join()`'s own seat/key collision
    /// loop is what actually prevents a second, concurrent seat for the same (tableId, from) —
    /// the nonce's job is only to make each signed join authorization distinguishable. Without a
    /// salt, a player who signs a join, gets seated, then calls `leaveBeforeStart` (freeing that
    /// (tableId, from) slot) could NEVER rejoin the same table with the identical channelKey/
    /// deckKey: the wrapper's nonce for that exact tuple is already burned forever. A fresh salt
    /// lets the same signer mint a new, distinguishable authorization to rejoin; an identical
    /// salt on a rejoin attempt still correctly dies at the wrapper's burned-nonce check (bearer
    /// replay of the exact same authorization is still rejected). Seat INDEX is deliberately NOT
    /// bound — see the contract header.
    function joinNonce(bytes32 tableId, address from, address channelKey, uint256[2] memory deckKey, bytes32 salt)
        public
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                keccak256("HoldemTableN.X402.Join"), block.chainid, address(this), tableId, from, channelKey, deckKey[0], deckKey[1], salt
            )
        );
    }

    // ── lifecycle ──────────────────────────────────────────────────────────────

    function create(
        IX402Token token,
        IGameRulesN rules,
        uint256 buyIn,
        uint256 maxSeats,
        uint16 rakeBps,
        uint256 rakeCap,
        uint64 clockBlocks,
        address channelKey,
        uint256[2] calldata deckKey,
        DepositAuth calldata auth
    ) external returns (bytes32 tableId) {
        if (buyIn == 0) revert WrongValue();
        _validateClock(clockBlocks);
        _validateRulesCode(address(rules));
        if (maxSeats < 2 || maxSeats > MAX_SEATS) revert BadSeatCount();
        if (rakeBps > MAX_RAKE_BPS) revert RakeTooHigh();
        if (!EllipticCurve.isOnCurve(deckKey[0], deckKey[1])) revert BadDeckKey();
        // Clone-check: confirm `token` is a genuine x402 wrapper clone for its own underlying,
        // not an arbitrary ERC-20 impersonating one. Skipped when no factory is configured
        // (address(0) — unit tests funding via a bare mock).
        if (address(factory) != address(0)) {
            address underlying = IValveWrapperView(address(token)).underlying();
            if (factory.wrapperOf(underlying) != address(token)) revert BadToken();
        }
        tableId = keccak256(abi.encode(block.chainid, address(this), ++_counter));
        // Effects BEFORE the pull (CEI): the table (seat 0, keys, escrow, deck key) fully exists
        // by the time `_pull` makes its one external call. A revert inside `_pull` still unwinds
        // every write below in the same transaction (bad auth => no persisted table at all).
        Table storage t = _tables[tableId];
        tableToken[tableId] = token;
        t.rules = rules;
        t.buyIn = buyIn;
        t.maxSeats = maxSeats;
        t.rakeBps = rakeBps;
        t.rakeCap = rakeCap;
        t.clockBlocks = clockBlocks;
        t.status = Status.Created;
        address key = channelKey == address(0) ? auth.from : channelKey;
        t.seats.push(auth.from);
        t.channelKeys.push(key);
        t.escrow.push(buyIn);
        _deckKey[tableId][0] = deckKey;
        emit TableCreated(tableId, auth.from, address(token), address(rules), buyIn, maxSeats, rakeBps, rakeCap, clockBlocks);
        emit TableJoined(tableId, auth.from, 0);
        // Interaction LAST: the single external call this function makes.
        bytes32 nonce = createNonce(auth.from, token, rules, buyIn, maxSeats, rakeBps, rakeCap, clockBlocks, channelKey, deckKey, auth.salt);
        _pull(token, auth.from, buyIn, auth.validBefore, nonce, auth.sig);
    }

    /// @dev CLIENT OBLIGATION — `validBefore` sizing on a join `DepositAuth`. Exactly like
    /// ZkTable's topUp warning: a signed join authorization is bearer-submittable by ANY relayer
    /// at ANY time before it expires or is burned. A hostile/lazy relayer holding a join auth
    /// with a far-future `validBefore` can withhold it and then submit it at a moment of its
    /// choosing — e.g. right before another seat calls `start()`, locking the signer's buy-in
    /// into a table that immediately goes Live around them while they aren't watching. Recovery
    /// via `leaveBeforeStart` only works Forming-side AND still costs the signer their own gas to
    /// call it — no help if the relayer times the join to land the instant before `start()`.
    /// Clients MUST sign join authorizations with a SHORT `validBefore` (seconds-to-minutes out),
    /// and can proactively burn a stale/un-submitted one via the wrapper's own
    /// `cancelAuthorization` if they change their mind before it would otherwise land.
    ///
    /// @dev CLIENT OBLIGATION — `channelKey` is a real signing key for your seat, not a label
    /// (mirrors ZkTable's identical footgun note). `_seatOf` matches EITHER the wallet (`auth
    /// .from`) OR the channel key, and `leaveBeforeStart` refunds to `msg.sender` — so nominating
    /// a channelKey you do not exclusively control (e.g. the table creator's address, or any key
    /// shared with another seat) hands that party co-signing power over your seat's channel
    /// states AND the ability to call `leaveBeforeStart`/`registerDeckKey`/`start` AS you while
    /// Forming. This is carried over unchanged from the native-PLS contract, not something the
    /// x402 conversion introduces or closes — nominate only a channelKey you alone control (or
    /// pass `address(0)` to default it to your own wallet).
    function join(bytes32 tableId, address channelKey, uint256[2] calldata deckKey, DepositAuth calldata auth) external {
        Table storage t = _tables[tableId];
        if (t.status != Status.Created) revert BadStatus();
        if (t.seats.length >= t.maxSeats) revert TooManySeats();
        address key = channelKey == address(0) ? auth.from : channelKey;
        // reject any wallet/key collision with an existing seat (keeps _seatOf unambiguous)
        for (uint256 i = 0; i < t.seats.length; i++) {
            if (t.seats[i] == auth.from || t.channelKeys[i] == auth.from) revert NotPlayer();
            if (t.seats[i] == key || t.channelKeys[i] == key) revert DuplicateKey();
        }
        if (!EllipticCurve.isOnCurve(deckKey[0], deckKey[1])) revert BadDeckKey();
        uint256 stake = t.buyIn;
        // Effects BEFORE the pull (CEI): the new seat is fully seated here, before `_pull`'s
        // external call. A revert inside `_pull` still unwinds all of this in the same
        // transaction (bad auth => no persisted seat).
        t.seats.push(auth.from);
        t.channelKeys.push(key);
        t.escrow.push(stake);
        uint256 seat = t.seats.length - 1;
        _deckKey[tableId][seat] = deckKey;
        emit TableJoined(tableId, auth.from, seat);
        // Interaction LAST: the single external call this function makes.
        bytes32 nonce = joinNonce(tableId, auth.from, channelKey, deckKey, auth.salt);
        _pull(tableToken[tableId], auth.from, stake, auth.validBefore, nonce, auth.sig);
    }

    /// Forming → Live once at least 2 seats have joined. Every seat already has a registered
    /// deck key by construction (create()/join() require one), so there is no key-completeness
    /// gate here anymore.
    function start(bytes32 tableId) external {
        Table storage t = _tables[tableId];
        if (t.status != Status.Created) revert BadStatus();
        _seatOf(t, msg.sender);
        if (t.seats.length < 2) revert NotEnoughSeats();
        t.status = Status.Live;
        emit TableStarted(tableId, t.seats.length);
    }

    /// Rotate the caller's secp256k1 deck pubkey (the key it contributes to the off-chain
    /// joint deck key). create()/join() already set an initial on-curve key for every seat;
    /// this only overwrites it, and only while Forming (so it is immutable across live play)
    /// and only by a seat, for its OWN seat. NOTE: leaveBeforeStart re-indexes seats, so a
    /// rotation must target the caller's CURRENT seat index, which _seatOf always resolves.
    function registerDeckKey(bytes32 tableId, uint256[2] calldata pk) external {
        Table storage t = _tables[tableId];
        if (t.status != Status.Created) revert BadStatus();
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
        if (t.status != Status.Created) revert BadStatus();
        uint8 seat = _seatOf(t, msg.sender);
        uint256 refund = t.escrow[seat];
        // compact arrays (swap-and-pop)
        uint256 last = t.seats.length - 1;
        t.seats[seat] = t.seats[last];
        t.channelKeys[seat] = t.channelKeys[last];
        t.escrow[seat] = t.escrow[last];
        // _deckKey is indexed by seat, so it must move with the swapped-down seat too — otherwise
        // the seat now at `seat` reads the departed seat's pubkey and can never answer a SHARE
        // dispute (its honest proof fails verify -> force-folded on timeout). Move it, clear the tail.
        _deckKey[tableId][seat] = _deckKey[tableId][last];
        delete _deckKey[tableId][last];
        t.seats.pop();
        t.channelKeys.pop();
        t.escrow.pop();
        emit SeatLeft(tableId, seat);
        if (t.seats.length == 0) {
            t.status = Status.Cancelled;
            emit TableCancelled(tableId);
        }
        if (refund > 0) address(tableToken[tableId]).safeTransfer(msg.sender, refund);
    }

    /// Creator cancels a Forming table that only they occupy; refunds all current escrow.
    function cancel(bytes32 tableId) external {
        Table storage t = _tables[tableId];
        if (t.status != Status.Created) revert BadStatus();
        if (t.seats.length != 1 || t.seats[0] != msg.sender) revert NotPlayer();
        t.status = Status.Cancelled;
        uint256 refund = t.escrow[0];
        t.escrow[0] = 0;
        emit TableCancelled(tableId);
        if (refund > 0) address(tableToken[tableId]).safeTransfer(msg.sender, refund);
    }

    // ── settle ───────────────────────────────────────────────────────────────

    /// Cooperative settle: fully permissionless (no `_seatOf(msg.sender)` gate — see the
    /// contract header) — any relayer/watchtower may submit the final N-of-N co-signed state on
    /// a seat's behalf. The payout is determined entirely by the N verified channel-key
    /// signatures, conservation, isFinal, pot==0, and nonce monotonicity — msg.sender's identity
    /// is never consulted.
    function settle(bytes32 tableId, ChannelStateN calldata state, bytes[] calldata sigs) external {
        Table storage t = _tables[tableId];
        if (t.status != Status.Live) revert BadStatus();
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
        _validateDemandKind(demandKind);
        // A SHARE demand names a deck slot the target must reveal via respondWithShare, which
        // reads t.demandSlot / disputeState.deckCommitment (NOT caller args) — so an out-of-range
        // slot, or a state with no committed deck, is unanswerable by construction. Left unbounded,
        // a single seat could open a dispute no honest counterparty can clear and take the pot on
        // timeout. Bound both at the trust boundary (the deep guards in respondWithShare then become
        // asserts). 52-card deck => valid slots are [0, 51].
        if (demandKind == DEMAND_SHARE) {
            if (demandSlot > 51) revert BadDemand();
            if (state.deckCommitment == bytes32(0)) revert BadDemand();
        }
        if (demandSeat >= t.seats.length) revert SeatRange();
        if (t.rules.whoseTurn(gameState) & (uint256(1) << demandSeat) == 0) revert NotYourTurn();
        // resolveTimeout can only ever force-fold `demandSeat` (never any other seat), so a
        // non-empty side-pot whose eligibleMask names ONLY demandSeat would be left with zero
        // eligible claimants the instant that seat forfeits. A real side-pot always has >=2
        // contestants when it is created (one player short-all-in, at least one caller covering
        // more) — if only demandSeat remains eligible, that pot should already have been awarded
        // off-chain before reaching a dispute. Nothing but the Σ-conservation check constrains
        // eligibleMask, so reject the malformed state here — before it becomes disputeState —
        // rather than let resolveTimeout's _distribute discover an orphaned pot with nowhere
        // correct to go.
        uint256 demandBit = uint256(1) << demandSeat;
        for (uint256 i = 0; i < state.sidePots.length; i++) {
            if (state.sidePots[i].amount != 0 && state.sidePots[i].eligibleMask & ~demandBit == 0) {
                revert BadDemand();
            }
        }
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

    /// Universal answer: fully permissionless (no `_seatOf(msg.sender)` gate — see the contract
    /// header) — any relayer/watchtower may post a strictly-newer N-of-N co-signed state on a
    /// seat's behalf.
    function respondWithState(bytes32 tableId, ChannelStateN calldata state, bytes[] calldata sigs) external {
        Table storage t = _tables[tableId];
        if (t.status != Status.Disputed) revert BadStatus();
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
        if (pk[0] == 0 && pk[1] == 0) revert DeckKeyNotSet(); // assert: create()/join() guarantee every seat has a registered key

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
        _validateClockExpired(t.disputeDeadline);
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
    /// `mask` is genuinely never empty here: the main pot's mask excludes only `forfeit` out of
    /// >=2 seats (a table cannot go Live with fewer), and openDispute already rejects any
    /// side-pot whose eligibleMask would go empty once `demandSeat` (== `forfeit`, the only seat
    /// resolveTimeout ever forfeits) is removed. Revert instead of silently sinking to an
    /// arbitrary seat if that invariant is ever violated — a wrong-but-quiet payout is worse
    /// than a stuck call here, since misdirected funds cannot be recovered after the fact.
    function _distribute(uint256[] memory payouts, uint256 amount, uint256 mask) internal pure {
        if (amount == 0) return;
        uint256 n = payouts.length;
        uint256 count;
        for (uint256 i = 0; i < n; i++) if (mask & (uint256(1) << i) != 0) count++;
        if (count == 0) revert BadDemand(); // assert: eligibleMask is seat-range-checked in _checkCoSigned
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
        _validateTableId(state.tableId, tableId);
        uint256 n = t.seats.length;
        if (state.balances.length != n) revert BadSeatCount();
        if (sigs.length != n) revert WrongSigCount();
        // Every side pot's eligibleMask must name only real seats [0, n). Nothing else enforces
        // this: an out-of-range bit survives openDispute's orphan check yet popcounts to 0 in
        // _distribute (permanent fund-lock), and a PARTIALLY out-of-range mask (e.g. off-by-one
        // 1-indexed bits from a buggy shared signer) would silently pay the wrong seats. Reject at
        // the boundary — this runs for openDispute AND respondWithState, so disputeState is clean.
        {
            uint256 seatMask = (uint256(1) << n) - 1;
            for (uint256 i = 0; i < state.sidePots.length; i++) {
                if (state.sidePots[i].eligibleMask & ~seatMask != 0) revert BadDemand();
            }
        }
        // conservation: Σ balances + pot + Σ sidePots + rake == Σ escrow
        uint256 locked = state.totalLockedCalldata();
        uint256 escrowSum;
        for (uint256 i = 0; i < n; i++) escrowSum += t.escrow[i];
        _validateConservation(locked, escrowSum);
        bytes32 digest = _hashTypedData(state.structHash());
        for (uint256 i = 0; i < n; i++) {
            _validateSig(digest, sigs[i], t.channelKeys[i]);
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
    ///
    /// NOTE — this is NOT griefing-proof the way the old ETH path's `forceSafeTransferETH` was.
    /// Solady's `SafeTransferLib.safeTransfer` for ERC-20s REVERTS THE WHOLE CALL if the
    /// underlying `transfer` fails or returns `false` — unlike `forceSafeTransferETH`, it does
    /// NOT swallow a failing send and move on. A single reverting recipient here — any seat, or
    /// `treasury` — would therefore brick `settle`/`resolveTimeout` for EVERY seat at this table,
    /// not just itself. This is safe ONLY because `create()`'s factory clone-check pins `token`
    /// to a genuine ValveWrapperImpl clone: a plain, hook-free ERC-20 with no blacklist, no
    /// transfer-tax, and no recipient callback — so `transfer` to an arbitrary address cannot be
    /// made to revert by that address. It is NOT safe in general (a factory-less deployment with
    /// `factory == address(0)`, or a future wrapper implementation gaining hooks/blacklisting,
    /// would reopen exactly this griefing vector). @dev DEPLOY OBLIGATION: `treasury` must be an
    /// address the wrapper can ALWAYS successfully `transfer` to — a plain EOA, or a contract
    /// that is guaranteed never to revert on receiving an ERC-20 transfer — never a contract that
    /// could plausibly reject the transfer (e.g. a paused multisig-like receiver).
    ///
    /// NOTE (multi-token treasury inflow): `treasury` receives rake in WHATEVER wrapper token
    /// this table is denominated in — a HoldemTableN deployment serving several distinct wrapper
    /// tokens accrues rake in each of them separately, not into one common asset. Ops sweeping
    /// the treasury must account for this.
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
        address token = address(tableToken[tableId]);
        for (uint256 i = 0; i < n; i++) {
            if (payouts[i] > 0) token.safeTransfer(recipients[i], payouts[i]);
        }
        if (rake > 0) token.safeTransfer(treasury, rake);
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
