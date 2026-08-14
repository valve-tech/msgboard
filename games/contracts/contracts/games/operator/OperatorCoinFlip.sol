// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {SafeTransferLib} from "solady/src/utils/SafeTransferLib.sol";
import {GameBase} from "../../GameBase.sol";
import {PreimageLocation} from "../../PreimageLocation.sol";
import {GameEscrow} from "./GameEscrow.sol";
import {OperatorRegistry} from "./OperatorRegistry.sol";
import {IRandomStaking} from "./IRandomStaking.sol";
import {ReentrancyGuard} from "./ReentrancyGuard.sol";
import {IValidatorPolicy} from "./IValidatorPolicy.sol";
import {IFeePolicy} from "./IFeePolicy.sol";
import {BonusChips1155} from "./BonusChips1155.sol";
import {IBackingPool} from "./IBackingPool.sol";

/// @notice Escrow-backed coin flip — the slice-A reference game. Identical parity mechanics to
/// CoinFlipTables, but every chip lives in GameEscrow (token-agnostic, pre-collateralized) and every
/// table belongs to a registered operator. The operator supplies bankroll and cannot touch the coin;
/// the substrate guarantees the player is paid on a win and refunded on a validator abort, from
/// pre-locked capital.
///
/// This build activates VALIDATOR FORFEIT. A table is a ladder of power-of-two stake tiers between
/// minStake and maxStake. Each round heats the table token at its stake tier price (via
/// _heatBoundStaked), so every validator STAKES that price in the bet's own token. The operator
/// pre-funds a fee pool (depositFees) that feeds the round's heat fee, metered per operator. When a
/// validator withholds its reveal, chopAndRoute chops the cohort, restores the operator's fee, refunds
/// the player, and routes the withheld stake (the forfeit) to a NEUTRAL SINK through an owner-set
/// IFeePolicy — never to the operator's own bankroll. This closes the operator-run-validator win-denial
/// hole: the operator gains nothing from a selective abort. The forfeit is measured as a custody delta,
/// so it needs no oracle; it is denominated in the bet token and always at least the stake
/// (tierPrice >= stake by construction), making a selective abort negative-EV for the validator. The
/// refund runs BEFORE the route, and the route is try/catch-parked, so a bad policy can never freeze a
/// chopped round's refund.
contract OperatorCoinFlip is GameBase, ReentrancyGuard {
    using SafeTransferLib for address;

    error NotRegisteredOperator();
    error NotOperator();
    error BadMultiplier();
    error TableClosed();
    error WrongSide();
    error DustStake();
    error BadTier();
    error StakeOutOfRange();
    error InsufficientFees();
    error AlreadyResolved();
    error TooEarly();
    error PolicyRejected();
    error TableCapExceeded();
    // --- S2b (boosted rounds) ---
    error BonusInfraUnset();
    error BonusInfraAlreadySet();
    error NoBonusSeries();
    error SeriesTokenMismatch();
    error MultiplierClampExceeded();
    error SeriesExpired();
    error MinEffMultNotMet();

    uint16 internal constant MULT_MIN = 150;
    uint16 internal constant MULT_MAX = 200;
    uint8 internal constant TAILS = 1;
    bytes32 internal constant FORFEIT_KIND = keccak256("forfeit");

    enum Status { None, Pending, Settled, Refunded }

    struct Table {
        address operator;
        address token;
        uint16  maxMultiplierX100;
        uint256 minStake;
        uint256 maxStake;
        bool    open;
        address validatorPolicy; // 0 = floor only; else a stricter-only IValidatorPolicy hook
    }

    struct Round {
        bytes32 tableId;
        address player;
        uint8   side;
        uint256 stake;
        uint256 payout;
        uint256 tierPrice;
        bytes32 key;
        uint256 openedAtBlock;
        Status  status;
        // appended (indices 9,10) so the earlier tuple layout the caster/QA read stays stable:
        uint256 feeCharged; // n*tierPrice metered out of the operator's fee pool at open
        uint256 chopCredit; // fee refund + withheld stakes, recorded by onReverse on chop (any caller)
        // S2b boost fields, appended (indices 11,12,13) — the same appended-index rule. A plain round
        // leaves all three at zero; `seriesId != 0` is the sole boosted/plain branch across every path.
        uint256 seriesId; // 0 = plain round; != 0 = the attached bonus series consumed at open
        uint256 boostD;   // the boost delta d = P_t - P_b, escrowed as bet B against the pool bucket
        uint16  effMult;  // the effective multiplier applied (base + bonusPoints, capped at MULT_MAX)
    }

    address public immutable escrow;
    address public immutable registry;

    mapping(bytes32 tableId => Table) public tables;
    mapping(bytes32 roundId => Round) public rounds;
    /// @notice Per-operator, per-token fee pool. Funded by depositFees (which also parks the tokens in
    /// this game's Random custody), drawn down by _chargeFee at open, restored by chopAndRoute, and
    /// reclaimable via withdrawFees.
    /// Invariant at rest: Random.balanceOf(this, token) == Σ_operator feeBalance[operator][token],
    /// ABSENT real Random's late-cast half-refund. When a seed forms AFTER the HEAT_DURATION window,
    /// real Random returns half the round fee to this game's custody while the round still settles
    /// normally; feeBalance stays fully debited, so custody exceeds Σ feeBalance by that half. This is
    /// harmless — it strands the operator's OWN already-spent fee (no theft, and no effect on any chop
    /// forfeit, which is measured locally as a custody delta). The mock has no late-cast path.
    mapping(address operator => mapping(address token => uint256)) public feeBalance;
    /// @notice Per-table risk policy. `tableCap` is the operator-set maximum concurrent locked exposure
    /// on a table (0 = unlimited, backward compatible); `tableLocked` is the running sum of open-round
    /// exposure (payout - stake) on that table. The cap only gates `open()`; it never touches
    /// settle/forfeit/custody or another table. `tableLocked` is incremented by exactly `exposure` once
    /// per successful open and decremented by exactly that once per terminal transition, so it can never
    /// drift from the true sum of open-round exposure.
    mapping(bytes32 tableId => uint256) public tableCap;
    mapping(bytes32 tableId => uint256) public tableLocked;
    uint256 internal _tableNonce;
    uint256 internal _roundNonce;

    /// @notice The active neutral sink for the validator forfeit. Owner-set, only to a menu member;
    /// defaults to a menu BurnFeePolicy so it is never unset. An operator can never set it (I5).
    address public forfeitPolicy;
    /// @notice The constructor-fixed fee-policy menu. Populated once at construction; there is NO adder,
    /// so `setForfeitPolicy` can only ever point at an address the deployer sealed in here (I5).
    mapping(address policy => bool) public allowedFeePolicy;
    /// @notice Forfeit parked per token when the policy route failed — retried by `sweepForfeit`.
    mapping(address token => uint256) public unrouted;

    // --- S2b bonus economy (boosted rounds) ---
    /// @notice The collateral co-operator (BackingPool) and the charge registry (BonusChips1155). Set
    /// once by the owner via `setBonusInfra` AFTER the pool is deployed (the pool references this game in
    /// its own constructor, so deploy order is game -> pool -> setBonusInfra). Until set, `openBoosted`
    /// and any series attach revert; plain `open()` is unaffected.
    address public backingPool;
    BonusChips1155 public bonusChips;
    bool internal _bonusInfraSet;
    /// @notice The bonus series attached to a table (0 = none/disabled). An operator attaches a series
    /// with `setBonusSeries`; `openBoosted` consumes one charge of it per round. A round records the id
    /// it consumed in `Round.seriesId`, so every terminal branches boosted/plain on `seriesId != 0`.
    mapping(bytes32 tableId => uint256 seriesId) public bonusSeries;
    /// @notice A plain-timeout charge return that the player's 1155 receiver rejected — parked here so a
    /// contract-player receiver failure can never freeze the round's fund refund. Retried permissionlessly
    /// by `claimParkedCharge`, mirroring the `unrouted`/`sweepForfeit` park pattern.
    mapping(bytes32 roundId => bool) public parkedCharge;

    event TableCreated(bytes32 indexed tableId, address indexed operator, address indexed token, uint16 maxMultiplierX100, uint256 minStake, uint256 maxStake);
    event OpenSet(bytes32 indexed tableId, bool open);
    event ValidatorPolicySet(bytes32 indexed tableId, address indexed policy);
    event TableCapSet(bytes32 indexed tableId, uint256 cap);
    event FeesDeposited(address indexed operator, address indexed token, uint256 credited);
    event FeesWithdrawn(address indexed operator, address indexed token, uint256 amount);
    event RoundOpened(bytes32 indexed roundId, bytes32 indexed tableId, address indexed player, uint8 side, uint256 stake, uint256 payout, uint256 tierPrice, bytes32 key, uint256 openedAtBlock);
    event RoundSettled(bytes32 indexed roundId, bytes32 indexed tableId, address indexed player, bool won, uint256 payout, bytes32 seed);
    event RoundRefunded(bytes32 indexed roundId, bytes32 indexed tableId, address indexed player, uint256 stake);
    /// @notice 4th arg is the amount routed to the neutral sink (0 if the route failed and it parked).
    event ForfeitRouted(bytes32 indexed roundId, address indexed operator, address indexed token, uint256 forfeit);
    /// @notice The route to the sink failed; the amount is parked in `unrouted` for a later `sweepForfeit`.
    event ForfeitParked(bytes32 indexed roundId, address indexed token, uint256 amount);
    event ForfeitPolicySet(address indexed policy);
    // --- S2b events ---
    event BonusInfraSet(address indexed pool, address indexed chips);
    event BonusSeriesSet(bytes32 indexed tableId, uint256 indexed seriesId);
    /// @notice A boosted round opened: `effMult` is the applied multiplier and `d` the boost delta (bet B).
    event BoostApplied(bytes32 indexed roundId, uint256 indexed seriesId, uint16 effMult, uint256 d);
    /// @notice A plain-timeout charge was returned to the player (T5).
    event ChargeReturned(bytes32 indexed roundId, address indexed player, uint256 seriesId);
    /// @notice The player's 1155 receiver rejected the returned charge; it is parked for a later claim.
    event ChargeParked(bytes32 indexed roundId, address indexed player, uint256 seriesId);

    constructor(address random_, address escrow_, address registry_, address[] memory feePolicyMenu_, address forfeitPolicy_)
        GameBase(random_)
    {
        escrow = escrow_;
        registry = registry_;
        for (uint256 i = 0; i < feePolicyMenu_.length; ++i) allowedFeePolicy[feePolicyMenu_[i]] = true;
        if (!allowedFeePolicy[forfeitPolicy_]) revert PolicyRejected(); // the default must be on the menu
        forfeitPolicy = forfeitPolicy_;
    }

    /// @notice Switch the active forfeit sink. Immediate (a recovery lever if a policy goes bad), but only
    /// to a menu member — an operator can never set this, and it can never point off the fixed menu.
    function setForfeitPolicy(address policy) external onlyOwner {
        if (!allowedFeePolicy[policy]) revert PolicyRejected();
        forfeitPolicy = policy;
        emit ForfeitPolicySet(policy);
    }

    /// @notice Wire the bonus economy: the BackingPool (collateral co-operator) and the BonusChips1155
    /// charge registry. Owner-only and ONE-TIME (the pool references this game in its constructor, so the
    /// deploy order is game -> pool -> setBonusInfra). Setting it does not touch any plain-round path.
    function setBonusInfra(address pool, address chips) external onlyOwner {
        if (_bonusInfraSet) revert BonusInfraAlreadySet();
        _bonusInfraSet = true;
        backingPool = pool;
        bonusChips = BonusChips1155(chips);
        emit BonusInfraSet(pool, chips);
    }

    /// @notice Attach (or, with `seriesId == 0`, disable) a bonus series on a table. Operator-only. F-C:
    /// the series' settlement token MUST equal the table token (otherwise backing sits in the wrong
    /// token), and `base + bonusPoints <= MULT_MAX` must hold with NO clamp reliance (a clamp at attach
    /// would silently under-deliver the advertised boost). Enable requires the infra to be set.
    function setBonusSeries(bytes32 tableId, uint256 seriesId) external onlyOperator(tableId) {
        if (seriesId != 0) {
            if (!_bonusInfraSet) revert BonusInfraUnset();
            (uint16 bonusPoints,,, address seriesToken) = bonusChips.seriesOf(seriesId);
            if (tables[tableId].token != seriesToken) revert SeriesTokenMismatch();
            if (uint256(tables[tableId].maxMultiplierX100) + bonusPoints > MULT_MAX) revert MultiplierClampExceeded();
        }
        bonusSeries[tableId] = seriesId;
        emit BonusSeriesSet(tableId, seriesId);
    }

    modifier onlyOperator(bytes32 tableId) {
        if (tables[tableId].operator != msg.sender) revert NotOperator();
        _;
    }

    /// @notice Create a stake-tier table. `minStake`..`maxStake` is a power-of-two ladder: minStake > 0,
    /// maxStake >= minStake, maxStake a whole multiple of minStake, and that multiple a power of two.
    /// Every accepted stake rounds UP to the smallest tier >= stake (see _tierPrice); that tier price is
    /// what each validator stakes, so the forfeit on a withheld reveal is always >= the player's stake.
    function createTable(address token, uint16 maxMultiplierX100, uint256 minStake, uint256 maxStake) external returns (bytes32 tableId) {
        if (!OperatorRegistry(registry).registered(msg.sender)) revert NotRegisteredOperator();
        if (maxMultiplierX100 < MULT_MIN || maxMultiplierX100 > MULT_MAX) revert BadMultiplier();
        if (minStake == 0 || maxStake < minStake || maxStake % minStake != 0) revert BadTier();
        uint256 r = maxStake / minStake;
        if ((r & (r - 1)) != 0) revert BadTier(); // r is a power of two (r != 0 guaranteed above)
        tableId = keccak256(abi.encode(address(this), msg.sender, ++_tableNonce));
        tables[tableId] = Table({operator: msg.sender, token: token, maxMultiplierX100: maxMultiplierX100, minStake: minStake, maxStake: maxStake, open: true, validatorPolicy: address(0)});
        emit TableCreated(tableId, msg.sender, token, maxMultiplierX100, minStake, maxStake);
    }

    function setOpen(bytes32 tableId, bool isOpen) external onlyOperator(tableId) {
        tables[tableId].open = isOpen;
        emit OpenSet(tableId, isOpen);
    }

    function operatorOf(bytes32 tableId) external view returns (address) {
        return tables[tableId].operator;
    }

    function setValidatorPolicy(bytes32 tableId, address policy) external onlyOperator(tableId) {
        tables[tableId].validatorPolicy = policy;
        emit ValidatorPolicySet(tableId, policy);
    }

    /// @notice Set the per-table exposure cap (0 = unlimited). Lowering it below the current
    /// `tableLocked` is allowed — it only blocks NEW opens; it never claws back in-flight rounds.
    function setTableCap(bytes32 tableId, uint256 cap) external onlyOperator(tableId) {
        tableCap[tableId] = cap;
        emit TableCapSet(tableId, cap);
    }

    /// @notice The smallest ladder tier >= `stake`, in [minStake, maxStake]. Reverts if out of range.
    function _tierPrice(uint256 minStake, uint256 maxStake, uint256 stake) internal pure returns (uint256 price) {
        if (stake < minStake || stake > maxStake) revert StakeOutOfRange();
        price = minStake;
        while (price < stake) price <<= 1;
    }

    /// @notice The tier price a `stake` would map to on `tableId` — for the caster and off-chain quoting.
    function tierPriceOf(bytes32 tableId, uint256 stake) external view returns (uint256) {
        Table storage t = tables[tableId];
        return _tierPrice(t.minStake, t.maxStake, stake);
    }

    // --- fee pool ---

    /// @notice Pull `amount` of `token` from `from`, crediting the MEASURED delta (fee-on-transfer safe).
    function _pullVerified(address token, address from, uint256 amount) internal returns (uint256 received) {
        uint256 balBefore = token.balanceOf(address(this));
        token.safeTransferFrom(from, address(this), amount);
        received = token.balanceOf(address(this)) - balBefore;
    }

    /// @notice Fund `operator`'s fee pool for `token`. Pulls the tokens from msg.sender, parks them in
    /// this game's Random custody (so `heat` can charge them), and meters them to the operator's pool.
    /// Anyone may fund any operator. The pool is credited by the MEASURED Random-custody delta of the
    /// handoff, NOT the face amount: a fee-on-transfer token loses a cut on the game→Random leg too, so
    /// crediting `credited` (the funder→game delta) would over-count custody and let one operator charge
    /// more than it funded — draining co-operators' shared custody. Crediting the custody delta keeps
    /// Random.balanceOf(this, token) == Σ feeBalance exact.
    function depositFees(address operator, address token, uint256 amount) external nonReentrant {
        uint256 credited = _pullVerified(token, msg.sender, amount);
        uint256 balBefore = IRandomStaking(random).balanceOf(address(this), token);
        token.safeApproveWithRetry(random, credited);
        IRandomStaking(random).handoff(address(this), token, -int256(credited));
        uint256 delta = IRandomStaking(random).balanceOf(address(this), token) - balBefore;
        feeBalance[operator][token] += delta;
        emit FeesDeposited(operator, token, delta);
    }

    /// @notice Operator reclaims its own idle fee pool for `token`, pulling it back out of this game's
    /// Random custody. Both sides drop by `amount`, so the custody invariant holds.
    function withdrawFees(address token, uint256 amount) external nonReentrant {
        uint256 bal = feeBalance[msg.sender][token];
        if (bal < amount) revert InsufficientFees();
        unchecked { feeBalance[msg.sender][token] = bal - amount; }
        IRandomStaking(random).handoff(msg.sender, token, int256(amount));
        emit FeesWithdrawn(msg.sender, token, amount);
    }

    /// @notice Meter `n * tierPrice` out of the operator's fee pool. The matching Random custody debit
    /// happens inside `heat`; this only tracks the operator's share so chopAndRoute can restore it.
    function _chargeFee(address operator, address token, uint256 n, uint256 tierPrice) internal {
        uint256 fee = n * tierPrice;
        uint256 bal = feeBalance[operator][token];
        if (bal < fee) revert InsufficientFees();
        unchecked { feeBalance[operator][token] = bal - fee; }
    }

    function open(
        bytes32 tableId,
        uint8 side,
        uint256 stake,
        address[] calldata validatorSubset,
        PreimageLocation.Info[] calldata validatorLocations
    ) external returns (bytes32 roundId) {
        Table storage t = tables[tableId];
        if (t.operator == address(0)) revert TableClosed();
        if (!t.open) revert TableClosed();
        if (side > TAILS) revert WrongSide();
        _validateSubset(validatorSubset); // hard floor first — a hook can only tighten it
        address policy = t.validatorPolicy;
        if (policy != address(0)) {
            if (!IValidatorPolicy(policy).validate(t.operator, tableId, msg.sender, validatorSubset)) revert PolicyRejected();
        }

        // Round the stake up to its ladder tier — the price each validator stakes on this round.
        uint256 tierPrice = _tierPrice(t.minStake, t.maxStake, stake);

        uint256 payout = stake * t.maxMultiplierX100 / 100;
        // Guard the dust case: at tiny stakes the multiplier truncates to break-even (payout == stake,
        // zero operator exposure), a degenerate round where a "win" pays nothing. Reject it so the
        // advertised 1.5x-2x odds always hold.
        if (payout == stake) revert DustStake();

        // Per-table exposure cap: gate this open against the table's running locked exposure. A revert
        // in the subsequent lockExposure unwinds the increment below atomically. `tableCap` is a
        // standalone mapping (not a Table field), so it is read as tableCap[tableId].
        uint256 exposure = payout - stake;
        uint256 cap = tableCap[tableId];
        if (cap != 0 && tableLocked[tableId] + exposure > cap) revert TableCapExceeded();
        tableLocked[tableId] += exposure;

        // Meter the operator's fee BEFORE heat charges its Random custody the same amount.
        uint256 feeCharged = validatorSubset.length * tierPrice;
        _chargeFee(t.operator, t.token, validatorSubset.length, tierPrice);
        // Heat the table token at the tier price: each provider's preimage is STAKED with (token, price),
        // so a withheld reveal forfeits that stake on chop. Binding both token and price closes the
        // native/price-0 free-roll.
        bytes32 key = _heatBoundStaked(validatorSubset, validatorLocations, t.token, tierPrice);
        roundId = keccak256(abi.encode(address(this), ++_roundNonce, tableId, msg.sender));

        // Effects before interaction: record the round + reverse index BEFORE the escrow call. A revert
        // in lockExposure (insufficient bankroll, player not consented, …) unwinds these writes
        // atomically, so nothing dangles; and no external call sits between the id derivation and its
        // local record.
        rounds[roundId] = Round({
            tableId: tableId, player: msg.sender, side: side, stake: stake, payout: payout,
            tierPrice: tierPrice, key: key, openedAtBlock: block.number, status: Status.Pending,
            feeCharged: feeCharged, chopCredit: 0,
            seriesId: 0, boostD: 0, effMult: 0 // plain round — no boost
        });
        instanceByKey[key] = roundId;

        // custody lives in the escrow: it pulls the player's stake (player approves the escrow) and
        // debits the operator's exposure from its bankroll — reverting if the operator is short.
        GameEscrow(escrow).lockExposure(roundId, t.operator, t.token, msg.sender, stake, payout);
        emit RoundOpened(roundId, tableId, msg.sender, side, stake, payout, tierPrice, key, block.number);
    }

    /// @notice The bet-B (boost) escrow id for a boosted round — the pool-owned second bet under the
    /// same roundId. Kept in one place so open/settle/refund derive it identically.
    function _boostId(bytes32 roundId) internal pure returns (bytes32) {
        return keccak256(abi.encode(roundId, "boost"));
    }

    /// @notice Open a BOOSTED round: identical to `open()` for the operator's own bet A (stake, payout
    /// P_b), PLUS a second escrow bet B owned by the BackingPool (stake 0, payout d) that funds the boost
    /// from pre-collateralized bonus backing. Consumes exactly one of the table's attached bonus charges.
    ///
    /// `base` = table multiplier; `eff = min(base + bonusPoints, MULT_MAX)`; `P_b = stake*base/100`;
    /// `P_t = stake*eff/100`; `d = P_t - P_b` (the boost, escrowed as bet B); `x = P_b - stake` (the
    /// operator's marginal risk, the ONLY thing the table cap counts, O2). `minEffMult` is the player's
    /// slippage floor on the applied multiplier.
    ///
    /// CEI (accounting §6, T2), EXACTLY: checks -> effects (Round incl. boost fields, `tableLocked += x`,
    /// `feeBalance -= F`, instanceByKey) -> heat -> pull 1 charge (player->game) -> `pool.consume` ->
    /// `lockExposure(B: pool, 0, d)` -> `lockExposure(A: operator, stake, P_b)` LAST. `nonReentrant`.
    function openBoosted(
        bytes32 tableId,
        uint8 side,
        uint256 stake,
        uint16 minEffMult,
        address[] calldata validatorSubset,
        PreimageLocation.Info[] calldata validatorLocations
    ) external nonReentrant returns (bytes32 roundId) {
        Table storage t = tables[tableId];
        if (t.operator == address(0)) revert TableClosed();
        if (!t.open) revert TableClosed();
        if (side > TAILS) revert WrongSide();

        uint256 sid = bonusSeries[tableId];
        if (sid == 0) revert NoBonusSeries();

        _validateSubset(validatorSubset); // hard floor first — a hook can only tighten it
        address policy = t.validatorPolicy;
        if (policy != address(0)) {
            if (!IValidatorPolicy(policy).validate(t.operator, tableId, msg.sender, validatorSubset)) revert PolicyRejected();
        }

        // Series parameters. Token match + no-clamp were enforced at `setBonusSeries` (F-C); here we
        // enforce the round-time guards: not expired, and the stake within the series' backed range.
        (uint16 bonusPoints, uint256 maxStake, uint64 expiry,) = bonusChips.seriesOf(sid);
        if (block.timestamp >= expiry) revert SeriesExpired();
        if (stake > maxStake) revert StakeOutOfRange();

        uint256 tierPrice = _tierPrice(t.minStake, t.maxStake, stake);

        uint16 base = t.maxMultiplierX100;
        uint16 eff = base + bonusPoints > MULT_MAX ? MULT_MAX : base + bonusPoints;
        if (eff <= base) revert BadMultiplier();          // the boost must add value
        if (eff < minEffMult) revert MinEffMultNotMet();  // player slippage floor

        uint256 pB = stake * base / 100;
        uint256 pT = stake * eff / 100;
        uint256 d = pT - pB;
        if (d == 0) revert DustStake();      // boost truncated to nothing at this stake
        uint256 x = pB - stake;
        if (x == 0) revert DustStake();      // base payout truncated to break-even (matches plain open)

        // Per-table exposure cap gates BASE exposure `x` only (O2) — the boost is pre-funded and cannot
        // bankrupt the operator.
        uint256 cap = tableCap[tableId];
        if (cap != 0 && tableLocked[tableId] + x > cap) revert TableCapExceeded();

        // --- effects (all local state written before any external interaction) ---
        tableLocked[tableId] += x;
        uint256 feeCharged = validatorSubset.length * tierPrice;
        _chargeFee(t.operator, t.token, validatorSubset.length, tierPrice); // feeBalance -= F
        bytes32 key = _heatBoundStaked(validatorSubset, validatorLocations, t.token, tierPrice);
        roundId = keccak256(abi.encode(address(this), ++_roundNonce, tableId, msg.sender));
        rounds[roundId] = Round({
            tableId: tableId, player: msg.sender, side: side, stake: stake, payout: pB,
            tierPrice: tierPrice, key: key, openedAtBlock: block.number, status: Status.Pending,
            feeCharged: feeCharged, chopCredit: 0,
            seriesId: sid, boostD: d, effMult: eff
        });
        instanceByKey[key] = roundId;

        // --- interactions, in the pinned order; bet A LAST so an operator-short revert unwinds all ---
        bonusChips.safeTransferFrom(msg.sender, address(this), sid, 1, ""); // pull 1 charge (exact-pull)
        IBackingPool(backingPool).consume(roundId, sid, d);                 // earmark -= w; hold = w - d
        GameEscrow(escrow).lockExposure(_boostId(roundId), backingPool, t.token, msg.sender, 0, d); // bet B
        GameEscrow(escrow).lockExposure(roundId, t.operator, t.token, msg.sender, stake, pB);       // bet A

        emit BoostApplied(roundId, sid, eff, d);
        emit RoundOpened(roundId, tableId, msg.sender, side, stake, pB, tierPrice, key, block.number);
    }

    /// @notice Release a round's exposure from its table's running total on a terminal transition.
    /// Reads the round's stored payout/stake, so the amount released always equals the amount locked at
    /// open. Called exactly once per round, on each of the three terminal paths (_settle, _routeForfeit,
    /// refundStale's plain-timeout branch), so tableLocked can never drift or double-decrement.
    function _releaseTableExposure(bytes32 tableId, uint256 payout, uint256 stake) internal {
        tableLocked[tableId] -= (payout - stake);
    }

    function _settle(bytes32 roundId, bytes32 seed) internal override {
        Round storage r = rounds[roundId];
        if (r.status != Status.Pending) revert AlreadyResolved();
        r.status = Status.Settled;
        _releaseTableExposure(r.tableId, r.payout, r.stake);
        bool won = uint8(uint256(seed) & 1) == r.side;
        uint256 sid = r.seriesId; // 0 = plain round; branch boosted on != 0
        if (won) {
            // T3: bet A pays P_b; boosted also settles bet B (pays d, so the player receives P_t), the
            // pool releases the residual r to the operator's credit, then the charge burns LAST.
            GameEscrow(escrow).settleWin(roundId);
            if (sid != 0) {
                GameEscrow(escrow).settleWin(_boostId(roundId));
                IBackingPool(backingPool).onSettleWin(roundId);
                bonusChips.burn(address(this), sid, 1);
            }
        } else {
            // T4: bet A returns to the operator minus rake; boosted also settles bet B (d returns to the
            // pool bucket), the pool credits the operator the full w, then the charge burns LAST.
            GameEscrow(escrow).settleLoss(roundId);
            if (sid != 0) {
                GameEscrow(escrow).settleLoss(_boostId(roundId));
                IBackingPool(backingPool).onSettleLoss(roundId);
                bonusChips.burn(address(this), sid, 1);
            }
        }
        emit RoundSettled(roundId, r.tableId, r.player, won, r.payout, seed);
    }

    /// @dev `nonReentrant` (accounting §6): a boosted `_settle` pays the player out of escrow and then
    /// moves a 1155 charge; guarding the pull-fallback entry keeps that terminal single-shot even though
    /// the status-first CEI already makes re-entry hit `AlreadyResolved`.
    function claim(bytes32 roundId) external nonReentrant {
        Round storage r = rounds[roundId];
        if (r.status != Status.Pending) revert AlreadyResolved();
        bytes32 seed = _seed(r.key);
        if (seed == bytes32(0)) revert TooEarly();
        _settle(roundId, seed);
    }

    /// @notice Record the credit Random reverses into this game's custody on a chop — the withheld
    /// validators' staked price PLUS the fee refund, delivered EXACTLY by Random. `chop` is PUBLIC on
    /// Random, so a third party can front-run this game's chopAndRoute; capturing the credit here (rather
    /// than by a custody snapshot around our own chop call) makes the forfeit routing work no matter who
    /// called chop. Guarded by onlyRandom in GameBase, so the amount can't be forged. Recorded only while
    /// the round is still Pending; a resolved round ignores it. DEPENDS on the request carrying
    /// callAtChange = true (GameBase._heatBoundStaked sets it) so Random fires onReverse on every chop —
    /// without it a front-run chop would strand the forfeit.
    function _onReverse(bytes32 roundId, address, uint256 amount) internal override {
        Round storage r = rounds[roundId];
        if (r.status == Status.Pending) r.chopCredit = amount;
    }

    /// @notice Abort a stalled round and route the validator forfeit. Permissionless. If no one has chopped
    /// yet, chop now (`info` must hash to the round key inside Random.chop, so it can't be forged); if a
    /// third party already chopped, the credit is already recorded via onReverse and we route it directly.
    function chopAndRoute(bytes32 roundId, PreimageLocation.Info[] calldata info) external nonReentrant {
        Round storage r = rounds[roundId];
        if (r.status != Status.Pending) revert AlreadyResolved();
        if (_seed(r.key) != bytes32(0)) revert TooEarly(); // a finalized round settles via claim, never chops
        if (r.chopCredit == 0) IRandomStaking(random).chop(r.key, info); // onReverse records r.chopCredit
        _routeForfeit(roundId);
    }

    /// @notice Restore the operator's fee, refund the player, then route the withheld stakes (the
    /// forfeit) to the neutral sink. Drives from r.chopCredit (fee refund + withheld stakes) recorded by
    /// onReverse — so it is identical whether this game chopped or a third party did. The refund happens
    /// BEFORE the sink route, and the route is wrapped in a try/catch that parks on failure, so a bad or
    /// griefing policy can never freeze a chopped round's refund (M1/M2).
    function _routeForfeit(bytes32 roundId) internal {
        Round storage r = rounds[roundId];
        Table storage t = tables[r.tableId];
        address token = t.token;
        address operator = t.operator;

        uint256 fee = r.feeCharged; // Random refunds exactly this into custody on chop
        // chopCredit == fee + Σ withheld stakes; the excess over the fee is the punitive forfeit.
        uint256 forfeit = r.chopCredit - fee;

        // Effects before interactions: resolve the round and restore the fee BEFORE the external
        // refund/handoff/route. nonReentrant already guards the entrypoints; this is the second line.
        r.status = Status.Refunded;
        _releaseTableExposure(r.tableId, r.payout, r.stake);
        feeBalance[operator][token] += fee; // the operator's fee is restored exactly as before

        // Interactions — refund the player FIRST; the sink route must never gate the refund (M1).
        GameEscrow(escrow).refund(roundId);
        emit RoundRefunded(roundId, r.tableId, r.player, r.stake);

        // T6 boosted: refund bet B (d returns to the pool bucket) and credit the operator the full w.
        // The charge burn (never a return — removes the tier-boundary selective-abort profit, F4) is the
        // 1155 move, done LAST below after the forfeit route.
        uint256 sid = r.seriesId;
        if (sid != 0) {
            GameEscrow(escrow).refund(_boostId(roundId));
            IBackingPool(backingPool).onChopRefund(roundId);
        }

        uint256 routed;
        if (forfeit > 0) {
            uint256 pre = token.balanceOf(address(this));
            IRandomStaking(random).handoff(address(this), token, int256(forfeit));
            uint256 measured = token.balanceOf(address(this)) - pre; // fee-on-transfer safe (M3)
            routed = _routeForfeitToSink(roundId, operator, r.player, token, measured);
        }
        emit ForfeitRouted(roundId, operator, token, routed); // 4th arg = amount to the sink (0 if parked)

        if (sid != 0) bonusChips.burn(address(this), sid, 1); // 1155 move LAST
    }

    /// @notice Deliver the full forfeit to the neutral sink; park it on any failure so a bad policy cannot
    /// freeze the abort. Returns the amount routed (0 if parked). The transfer + route are wrapped in one
    /// external self-call so a route() revert rolls the transfer back and we park cleanly.
    function _routeForfeitToSink(bytes32 roundId, address operator, address player, address token, uint256 amount)
        internal
        returns (uint256 routed)
    {
        if (amount == 0) return 0;
        bytes memory ctx = abi.encode(roundId, operator, player); // I5: policy can self-check non-participant
        try this._deliverAndRoute(forfeitPolicy, token, amount, ctx) {
            return amount;
        } catch {
            unrouted[token] += amount;
            emit ForfeitParked(roundId, token, amount);
            return 0;
        }
    }

    /// @notice External-self-only: transfer `amount` to the policy then call route(), atomically, so the
    /// caller's try/catch can roll both back together. Full amount — never a bps cut (H2). NOT
    /// nonReentrant: it is a self-call from within an already-nonReentrant path (chopAndRoute / refundStale
    /// / sweepForfeit), so guarding it would deadlock; the self-only check plus the outer mutex protect it.
    function _deliverAndRoute(address policy, address token, uint256 amount, bytes calldata ctx) external {
        if (msg.sender != address(this)) revert NotOperator(); // self-only
        token.safeTransfer(policy, amount);
        IFeePolicy(policy).route(FORFEIT_KIND, token, amount, ctx);
    }

    /// @notice Permissionless retry of parked forfeits (after the owner swapped a bad policy). Exactly-once:
    /// zero the ledger before the external route, park it back on failure.
    function sweepForfeit(address token) external nonReentrant {
        uint256 amount = unrouted[token];
        if (amount == 0) return;
        unrouted[token] = 0;
        try this._deliverAndRoute(forfeitPolicy, token, amount, abi.encode(bytes32(0), address(0), address(0))) {
            // routed
        } catch {
            unrouted[token] = amount; // restore; still parked
        }
    }

    /// @notice Liveness fallback. If a chop already happened (credit recorded), route the forfeit exactly
    /// as chopAndRoute would — so a stray refundStale can never strand the operator's fee or the forfeit.
    /// Otherwise (a pure timeout with no chop) refund the player; the validators' stakes are untouched.
    function refundStale(bytes32 roundId) external nonReentrant {
        Round storage r = rounds[roundId];
        if (r.status != Status.Pending) revert AlreadyResolved();
        if (_seed(r.key) != bytes32(0)) revert TooEarly();
        if (!_refundableNow(roundId, r.openedAtBlock)) revert TooEarly();
        if (r.chopCredit != 0) { _routeForfeit(roundId); return; } // _routeForfeit already releases exposure
        r.status = Status.Refunded;
        _releaseTableExposure(r.tableId, r.payout, r.stake);
        GameEscrow(escrow).refund(roundId);
        emit RoundRefunded(roundId, r.tableId, r.player, r.stake);

        // T5 boosted plain-timeout: refund bet B (d returns to the pool bucket), the pool re-earmarks the
        // full w (funded exactly by the returned d + r — no external liquidity), then RETURN the charge to
        // the player LAST. A contract-player receiver failure parks the charge so the fund refund above
        // can never freeze; `claimParkedCharge` retries it permissionlessly. Fee is NOT restored (matches
        // the plain-timeout behavior today).
        uint256 sid = r.seriesId;
        if (sid != 0) {
            GameEscrow(escrow).refund(_boostId(roundId));
            IBackingPool(backingPool).onPlainRefund(roundId);
            _returnOrParkCharge(roundId, r.player, sid);
        }
    }

    /// @notice Return one charge to the player as the LAST interaction of a boosted plain-timeout. Wrapped
    /// so a hostile/broken 1155 receiver on a contract-player can never revert the already-completed fund
    /// refund — on failure the charge parks and `claimParkedCharge` retries it.
    function _returnOrParkCharge(bytes32 roundId, address to, uint256 sid) internal {
        try bonusChips.safeTransferFrom(address(this), to, sid, 1, "") {
            emit ChargeReturned(roundId, to, sid);
        } catch {
            parkedCharge[roundId] = true;
            emit ChargeParked(roundId, to, sid);
        }
    }

    /// @notice Permissionless retry of a parked charge return (after the player's receiver is fixed).
    /// Exactly-once: clears the flag before the external move, restores it on failure — mirroring the
    /// `unrouted`/`sweepForfeit` pattern.
    function claimParkedCharge(bytes32 roundId) external nonReentrant {
        if (!parkedCharge[roundId]) return;
        Round storage r = rounds[roundId];
        parkedCharge[roundId] = false;
        try bonusChips.safeTransferFrom(address(this), r.player, r.seriesId, 1, "") {
            emit ChargeReturned(roundId, r.player, r.seriesId);
        } catch {
            parkedCharge[roundId] = true; // restore; still parked
        }
    }

    /// @notice Accept the exact-pull of one bonus charge at `openBoosted`. Accounts NOTHING (the pool's
    /// earmark bookkeeping and the game's own round record are the source of truth); an unsolicited push
    /// is simply held and is harmless over-backing.
    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC1155Received.selector;
    }
}
