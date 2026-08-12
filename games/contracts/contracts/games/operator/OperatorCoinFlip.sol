// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {SafeTransferLib} from "solady/src/utils/SafeTransferLib.sol";
import {GameBase} from "../../GameBase.sol";
import {PreimageLocation} from "../../PreimageLocation.sol";
import {GameEscrow} from "./GameEscrow.sol";
import {OperatorRegistry} from "./OperatorRegistry.sol";
import {IRandomStaking} from "./IRandomStaking.sol";

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
/// validator withholds its reveal, chopAndRoute chops the cohort, restores the operator's fee, and
/// routes the withheld stake (the forfeit) into the operator's bankroll — then refunds the player.
/// The forfeit is measured as a custody delta, so it needs no oracle: it is denominated in the bet
/// token and always at least the stake (tierPrice >= stake by construction), making a selective abort
/// negative-EV for the validator instead of a free-roll against the player.
contract OperatorCoinFlip is GameBase {
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

    uint16 internal constant MULT_MIN = 150;
    uint16 internal constant MULT_MAX = 200;
    uint8 internal constant TAILS = 1;

    enum Status { None, Pending, Settled, Refunded }

    struct Table {
        address operator;
        address token;
        uint16  maxMultiplierX100;
        uint256 minStake;
        uint256 maxStake;
        bool    open;
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
    }

    address public immutable escrow;
    address public immutable registry;

    mapping(bytes32 tableId => Table) public tables;
    mapping(bytes32 roundId => Round) public rounds;
    /// @notice Per-operator, per-token fee pool. Funded by depositFees (which also parks the tokens in
    /// this game's Random custody), drawn down by _chargeFee at open, and restored by chopAndRoute.
    /// Invariant at rest: Random.balanceOf(this, token) == Σ_operator feeBalance[operator][token].
    mapping(address operator => mapping(address token => uint256)) public feeBalance;
    uint256 internal _tableNonce;
    uint256 internal _roundNonce;

    event TableCreated(bytes32 indexed tableId, address indexed operator, address indexed token, uint16 maxMultiplierX100, uint256 minStake, uint256 maxStake);
    event OpenSet(bytes32 indexed tableId, bool open);
    event FeesDeposited(address indexed operator, address indexed token, uint256 credited);
    event RoundOpened(bytes32 indexed roundId, bytes32 indexed tableId, address indexed player, uint8 side, uint256 stake, uint256 payout, uint256 tierPrice, bytes32 key, uint256 openedAtBlock);
    event RoundSettled(bytes32 indexed roundId, bytes32 indexed tableId, address indexed player, bool won, uint256 payout, bytes32 seed);
    event RoundRefunded(bytes32 indexed roundId, bytes32 indexed tableId, address indexed player, uint256 stake);
    event ForfeitRouted(bytes32 indexed roundId, address indexed operator, address indexed token, uint256 forfeit);

    constructor(address random_, address escrow_, address registry_) GameBase(random_) {
        escrow = escrow_;
        registry = registry_;
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
        tables[tableId] = Table({operator: msg.sender, token: token, maxMultiplierX100: maxMultiplierX100, minStake: minStake, maxStake: maxStake, open: true});
        emit TableCreated(tableId, msg.sender, token, maxMultiplierX100, minStake, maxStake);
    }

    function setOpen(bytes32 tableId, bool isOpen) external onlyOperator(tableId) {
        tables[tableId].open = isOpen;
        emit OpenSet(tableId, isOpen);
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
    /// Anyone may fund any operator; only the measured delta is credited.
    function depositFees(address operator, address token, uint256 amount) external {
        uint256 credited = _pullVerified(token, msg.sender, amount);
        token.safeApproveWithRetry(random, credited);
        IRandomStaking(random).handoff(address(this), token, -int256(credited));
        feeBalance[operator][token] += credited;
        emit FeesDeposited(operator, token, credited);
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
        _validateSubset(validatorSubset);

        // Round the stake up to its ladder tier — the price each validator stakes on this round.
        uint256 tierPrice = _tierPrice(t.minStake, t.maxStake, stake);

        uint256 payout = stake * t.maxMultiplierX100 / 100;
        // Guard the dust case: at tiny stakes the multiplier truncates to break-even (payout == stake,
        // zero operator exposure), a degenerate round where a "win" pays nothing. Reject it so the
        // advertised 1.5x-2x odds always hold.
        if (payout == stake) revert DustStake();

        // Meter the operator's fee BEFORE heat charges its Random custody the same amount.
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
            tierPrice: tierPrice, key: key, openedAtBlock: block.number, status: Status.Pending
        });
        instanceByKey[key] = roundId;

        // custody lives in the escrow: it pulls the player's stake (player approves the escrow) and
        // debits the operator's exposure from its bankroll — reverting if the operator is short.
        GameEscrow(escrow).lockExposure(roundId, t.operator, t.token, msg.sender, stake, payout);
        emit RoundOpened(roundId, tableId, msg.sender, side, stake, payout, tierPrice, key, block.number);
    }

    function _settle(bytes32 roundId, bytes32 seed) internal override {
        Round storage r = rounds[roundId];
        if (r.status != Status.Pending) revert AlreadyResolved();
        r.status = Status.Settled;
        bool won = uint8(uint256(seed) & 1) == r.side;
        if (won) {
            GameEscrow(escrow).settleWin(roundId);
        } else {
            GameEscrow(escrow).settleLoss(roundId);
        }
        emit RoundSettled(roundId, r.tableId, r.player, won, r.payout, seed);
    }

    function claim(bytes32 roundId) external {
        Round storage r = rounds[roundId];
        if (r.status != Status.Pending) revert AlreadyResolved();
        bytes32 seed = _seed(r.key);
        if (seed == bytes32(0)) revert TooEarly();
        _settle(roundId, seed);
    }

    /// @notice Abort a stalled round and route the validator forfeit. Permissionless — `info` must hash
    /// to the round key inside `chop`, so it can't be forged. Chops the cohort (Random refunds this
    /// game's fee and credits the withheld validators' staked price to this game's custody), restores
    /// the operator's fee pool, deposits the punitive forfeit into the operator's bankroll, and refunds
    /// the player their stake plus the operator its exposure.
    function chopAndRoute(bytes32 roundId, PreimageLocation.Info[] calldata info) external {
        Round storage r = rounds[roundId];
        if (r.status != Status.Pending) revert AlreadyResolved();
        if (_seed(r.key) != bytes32(0)) revert TooEarly(); // a finalized round settles via claim, never chops
        Table storage t = tables[r.tableId];
        address token = t.token;
        address operator = t.operator;

        // Measure the forfeit as a custody DELTA — no recount, no oracle. chop credits (fee refund +
        // withheld stake) to this game's custody; the delta is exactly that sum.
        uint256 balBefore = IRandomStaking(random).balanceOf(address(this), token);
        IRandomStaking(random).chop(r.key, info);
        uint256 credited = IRandomStaking(random).balanceOf(address(this), token) - balBefore;

        // Restore the operator's fee — chop refunded it into custody.
        uint256 fee = info.length * r.tierPrice;
        feeBalance[operator][token] += fee;

        // The rest is the punitive forfeit: pull it out of Random and bank it for the operator.
        uint256 forfeit = credited - fee;
        if (forfeit > 0) {
            IRandomStaking(random).handoff(address(this), token, int256(forfeit));
            token.safeApproveWithRetry(escrow, forfeit);
            GameEscrow(escrow).depositBankroll(operator, token, forfeit);
        }

        r.status = Status.Refunded;
        GameEscrow(escrow).refund(roundId);
        emit RoundRefunded(roundId, r.tableId, r.player, r.stake);
        emit ForfeitRouted(roundId, operator, token, forfeit);
    }

    function refundStale(bytes32 roundId) external {
        Round storage r = rounds[roundId];
        if (r.status != Status.Pending) revert AlreadyResolved();
        if (_seed(r.key) != bytes32(0)) revert TooEarly();
        if (!_refundableNow(roundId, r.openedAtBlock)) revert TooEarly();
        r.status = Status.Refunded;
        GameEscrow(escrow).refund(roundId);
        emit RoundRefunded(roundId, r.tableId, r.player, r.stake);
    }
}
