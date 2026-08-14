// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {SafeTransferLib} from "solady/src/utils/SafeTransferLib.sol";
import {ReentrancyGuard} from "./ReentrancyGuard.sol";
import {GameEscrow} from "./GameEscrow.sol";
import {BonusChips1155} from "./BonusChips1155.sol";
import {IBackingPool} from "./IBackingPool.sol";

/// @notice The collateral co-operator of the operator bonus economy — the MOST fund-safety-critical
/// contract in System 2. It owns one `(pool, token)` escrow bucket inside `GameEscrow` and holds ALL
/// bonus backing there. It is a co-operator by the paired-bet model (accounting doc F-A): a boosted
/// round opens a SECOND escrow bet (bet B, stake 0, payout `d`) OWNED BY THE POOL, so escrow itself
/// structurally returns the boost to the pool's own bucket on every non-win terminal — no code path
/// can strand the boost in an operator-withdrawable bucket. `GameEscrow` is byte-identical (I1).
///
/// The pool keeps a per-token internal ledger that partitions its escrow balance:
/// - `earmark[series]` — backs the currently circulating charges of a series (P2: earmark == circ*w).
/// - `hold[roundId]`   — the residual `r = w - d` of one open boosted round (P4: created/destroyed once).
/// - `credit[op][token]` — released capital the operator may withdraw; the ONLY door out of the pool.
///
/// INVARIANT (per token τ):
///   P1  bankrollOf(pool, τ) == Σ earmark[s] + Σ hold[r] + Σ credit[op][τ]
///   P2  earmark[s] == circ(s) * w(s)          (circ = minted - burned - game-held)
///   P4  hold[r] == w - d >= 0, created at consume, destroyed at exactly one terminal.
///
/// The pool NEVER reads a 1155 balance for accounting — it trusts the game's exact-pull custody
/// conveyed through the hooks, and its own earmark bookkeeping. State hooks are `msg.sender == game`
/// only (the game holds its mutex across the round). The public token-movers (`fundEarmark`,
/// `expireCharges`, `withdrawCredit`) carry the pool mutex + CEI. No transient storage / MCOPY (I7).
contract BackingPool is IBackingPool, ReentrancyGuard {
    using SafeTransferLib for address;

    GameEscrow public immutable escrow;
    BonusChips1155 public immutable chips;
    address public immutable game;

    address public owner;
    address public minter; // the mint-sale (S2c); the only caller that may fund earmarks

    /// @notice Per open boosted round: the split needed to route the terminal correctly. `open` mirrors
    /// the escrow bet's lifecycle so a round's residual is destroyed at EXACTLY one terminal (P4).
    struct Round {
        uint256 seriesId;
        address operator; // credit key
        address token;    // credit key + the series' settlement token
        uint256 w;        // per-charge backing at consume time
        uint256 d;        // boost delta escrowed as bet B
        bool open;
    }

    mapping(uint256 seriesId => uint256) public earmark;
    /// @notice Circulating charge count per series (`circ = minted - burned - game-held`). The pool
    /// maintains this explicitly so P2 (`earmark == circ * w`) is a POOL-ENFORCED invariant, not just a
    /// test assumption. The pool never reads a 1155 balance; it moves this counter in lockstep with the
    /// earmark on every hook (mint +n, consume -1, plain-refund +1, win/loss/chop net 0 — the charge
    /// only moves game-held -> burned, expire -n).
    mapping(uint256 seriesId => uint256) public circ;
    mapping(bytes32 roundId => uint256) public hold; // residual r = w - d
    mapping(address operator => mapping(address token => uint256)) public credit;
    mapping(uint256 seriesId => address) public seriesOperator;
    mapping(bytes32 roundId => Round) internal _rounds;

    error NotOwner();
    error NotGame();
    error NotMinter();
    error NotOperator();
    error RoundExists();
    error UnknownRound();
    error BackingShort();
    error BoostTooLarge();
    error OperatorMismatch();
    error DepositMismatch();
    error BeforeExpiry();
    error InsufficientCredit();
    error HolderIsGame();
    error CircShort();
    error InvariantBroken();

    event OwnerSet(address indexed owner);
    event MinterSet(address indexed minter);
    event GameAuthorizationSet(bool allowed);
    event EarmarkFunded(uint256 indexed seriesId, address indexed operator, uint256 units, uint256 amount);
    event Consumed(bytes32 indexed roundId, uint256 indexed seriesId, uint256 d, uint256 residual);
    event WinReleased(bytes32 indexed roundId, address indexed operator, address token, uint256 residual);
    event LossReleased(bytes32 indexed roundId, address indexed operator, address token, uint256 amount);
    event PlainRefunded(bytes32 indexed roundId, uint256 indexed seriesId, uint256 amount);
    event ChopRefunded(bytes32 indexed roundId, address indexed operator, address token, uint256 amount);
    event ChargesExpired(uint256 indexed seriesId, address indexed operator, uint256 units, uint256 amount);
    event CreditWithdrawn(address indexed operator, address indexed token, uint256 amount);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyGame() {
        if (msg.sender != game) revert NotGame();
        _;
    }

    /// @param escrow_ the shared GameEscrow.
    /// @param chips_  the BonusChips1155 registry.
    /// @param game_   the boosted game that will drive the paired bets and call the hooks.
    /// @dev Self-authorizes `game_` as a bucket owner for operator = pool (permissionless and
    /// self-sovereign, GameEscrow.sol:135-138), so the game may lock/settle/refund the pool-owned
    /// bet B against the (pool, token) bucket. This authorizes ONLY the pool's own bucket.
    constructor(address escrow_, address chips_, address game_) {
        escrow = GameEscrow(escrow_);
        chips = BonusChips1155(chips_);
        game = game_;
        owner = msg.sender;
        GameEscrow(escrow_).authorizeGame(game_, true);
        emit OwnerSet(msg.sender);
    }

    function setOwner(address o) external onlyOwner {
        owner = o;
        emit OwnerSet(o);
    }

    function setMinter(address m) external onlyOwner {
        minter = m;
        emit MinterSet(m);
    }

    /// @notice Emergency kill-switch on the boosted game. The pool authorizes `game` against its own
    /// escrow bucket in the constructor; this lets the owner REVOKE (or restore) that authorization if
    /// S2b is ever found exploitable. Deauthorizing blocks any new `lockExposure(pool, ...)` — so no new
    /// boosted round can open — without touching earmark/hold/credit, so existing rounds still settle
    /// and operators still withdraw released credit. This gates ONLY the pool's own bucket
    /// (`authorizedGame[pool][game]`); it cannot affect any other operator's authorization.
    function setGameAuthorized(bool allowed) external onlyOwner {
        escrow.authorizeGame(game, allowed);
        emit GameAuthorizationSet(allowed);
    }

    function roundOf(bytes32 roundId) external view returns (Round memory) {
        return _rounds[roundId];
    }

    /// @dev Pool-enforced P2: after every mutating hook, the series earmark must exactly back its
    /// circulating charges. Reverts the whole tx if the two ledgers ever disagree — a corrupt state can
    /// never be committed.
    function _assertBacked(uint256 seriesId) internal view {
        if (earmark[seriesId] != circ[seriesId] * chips.w(seriesId)) revert InvariantBroken();
    }

    // ── T1 MINT — fund the earmark ───────────────────────────────────────────────────────────────

    /// @notice Fund AND mint `n` charges for `seriesId` in one atomic step: deposit exactly `n * w`
    /// backing into the pool's escrow bucket, earmark it, raise `circ`, and mint the `n` charges to
    /// `recipient`. Minter-gated (the mint-sale). Because the pool is the sole 1155 minter, minted
    /// charges can NEVER exceed funded backing — the two move together, so P2 (`earmark == circ * w`)
    /// holds at genesis and a buggy/hostile minter cannot mint under-backed supply. The backing is
    /// pulled from `fundingSource` (recorded as the series operator, where released credit later
    /// accrues). The pull is MEASURED and must be exact: FOT/rebasing/zero-revert tokens are rejected
    /// here (O6). The chips mint happens LAST (CEI; the 1155 mint may call back into a contract
    /// recipient, and by then every ledger for this series is already terminal and re-checked).
    ///
    /// S2c note: the mint-sale collects the buyer's PURCHASE PRICE separately (the vesting escrow, O4).
    /// That price flow is out of scope here — this call only funds backing and mints charges.
    function fundEarmark(uint256 seriesId, uint256 n, address fundingSource, address recipient)
        external
        nonReentrant
    {
        if (msg.sender != minter) revert NotMinter();

        address recorded = seriesOperator[seriesId];
        if (recorded == address(0)) {
            seriesOperator[seriesId] = fundingSource;
        } else if (recorded != fundingSource) {
            revert OperatorMismatch();
        }

        (,,, address token) = chips.seriesOf(seriesId);
        uint256 amount = n * chips.w(seriesId);

        // Measured, exact pull into the pool: reject any token that does not deliver the full amount.
        uint256 balBefore = token.balanceOf(address(this));
        token.safeTransferFrom(fundingSource, address(this), amount);
        if (token.balanceOf(address(this)) - balBefore != amount) revert DepositMismatch();

        // Deposit into the pool's own (pool, token) escrow bucket; earmark the ESCROW-credited delta so
        // the ledger can never drift from bankrollOf(pool).
        token.safeApproveWithRetry(address(escrow), amount);
        uint256 b0 = escrow.bankrollOf(address(this), token);
        escrow.depositBankroll(address(this), token, amount);
        uint256 credited = escrow.bankrollOf(address(this), token) - b0;
        if (credited != amount) revert DepositMismatch();

        earmark[seriesId] += credited;
        circ[seriesId] += n;
        _assertBacked(seriesId);

        // Mint LAST: minted supply now equals funded backing, always.
        chips.mint(recipient, seriesId, n);
        emit EarmarkFunded(seriesId, fundingSource, n, credited);
    }

    // ── T2 OPEN — consume backing for one round ──────────────────────────────────────────────────

    /// @notice Reserve one charge's backing for a boosted round: move `w` out of the series earmark,
    /// route `d` into the pool-owned bet B (the game locks it right after), and hold the residual
    /// `r = w - d`. Game-only. This is pure ledger — no token movement here; the game's bet-B
    /// `lockExposure(pool, ...)` debits the escrow bucket by `d` in the same tx.
    function consume(bytes32 roundId, uint256 seriesId, uint256 d) external onlyGame {
        if (_rounds[roundId].open) revert RoundExists();
        uint256 w = chips.w(seriesId);
        if (d > w) revert BoostTooLarge();          // P4: r = w - d >= 0
        if (earmark[seriesId] < w) revert BackingShort(); // L2: earmark >= w must hold

        earmark[seriesId] -= w;
        circ[seriesId] -= 1; // the game now holds this charge; it leaves circulation
        uint256 r;
        unchecked { r = w - d; }
        hold[roundId] = r;

        (,,, address token) = chips.seriesOf(seriesId);
        _rounds[roundId] = Round({
            seriesId: seriesId,
            operator: seriesOperator[seriesId],
            token: token,
            w: w,
            d: d,
            open: true
        });
        _assertBacked(seriesId);
        emit Consumed(roundId, seriesId, d, r);
    }

    // ── T3–T6 terminals (game-only; escrow accounting done by the game's bet-B settle/refund) ──────

    /// @notice T3 WIN: the player was paid `d` from bet B (escrow). Release only the residual `r` to
    /// the operator's credit.
    /// @dev circ is UNCHANGED: the charge only moves game-held -> burned (burned +1, game-held -1),
    /// which nets to zero in `circ = minted - burned - game-held`. earmark is untouched, so P2 holds.
    function onSettleWin(bytes32 roundId) external onlyGame {
        Round storage rd = _closeRound(roundId);
        uint256 r = hold[roundId];
        hold[roundId] = 0;
        credit[rd.operator][rd.token] += r;
        _assertBacked(rd.seriesId);
        emit WinReleased(roundId, rd.operator, rd.token, r);
    }

    /// @notice T4 LOSS: bet B returned `d` to the pool bucket. The operator OWNS `d` after a settled
    /// loss, so release the full `w` (= d + r) to credit.
    /// @dev circ UNCHANGED (game-held -> burned nets zero); earmark untouched. P2 holds.
    function onSettleLoss(bytes32 roundId) external onlyGame {
        Round storage rd = _closeRound(roundId);
        hold[roundId] = 0;
        credit[rd.operator][rd.token] += rd.w;
        _assertBacked(rd.seriesId);
        emit LossReleased(roundId, rd.operator, rd.token, rd.w);
    }

    /// @notice T5 PLAIN-REFUND (timeout): bet B returned `d` to the pool bucket and the charge is
    /// returned to the player, so re-earmark the full `w` (funded exactly by the returned d + r — no
    /// external liquidity, ever). circ rises by one; P2 holds.
    function onPlainRefund(bytes32 roundId) external onlyGame {
        Round storage rd = _closeRound(roundId);
        hold[roundId] = 0;
        earmark[rd.seriesId] += rd.w;
        circ[rd.seriesId] += 1; // the charge returns to the player -> back into circulation
        _assertBacked(rd.seriesId);
        emit PlainRefunded(roundId, rd.seriesId, rd.w);
    }

    /// @notice T6 CHOP-REFUND: bet B returned `d` to the pool bucket and the charge is BURNED (never
    /// returned — removes the tier-boundary selective-abort profit, F4). Release `w` to the operator.
    /// @dev circ UNCHANGED (game-held -> burned nets zero); earmark untouched. P2 holds.
    function onChopRefund(bytes32 roundId) external onlyGame {
        Round storage rd = _closeRound(roundId);
        hold[roundId] = 0;
        credit[rd.operator][rd.token] += rd.w;
        _assertBacked(rd.seriesId);
        emit ChopRefunded(roundId, rd.operator, rd.token, rd.w);
    }

    /// @dev Close a round exactly once (P4). Reverts if the round is not open, so a residual can never
    /// be destroyed twice.
    function _closeRound(bytes32 roundId) internal returns (Round storage rd) {
        rd = _rounds[roundId];
        if (!rd.open) revert UnknownRound();
        rd.open = false;
    }

    // ── T7 EXPIRY — immediate settlement, permissionless ─────────────────────────────────────────

    /// @notice Burn `n` expired charges held by `holder` and move `n * w` from the series earmark to
    /// the operator's credit — immediate settlement (O3), no window, no holderPot. The backing is the
    /// OPERATOR's capital (deposited at mint, never used on an unopened round), so it returns to the
    /// operator the moment an expired charge is burned. Permissionless: any keeper may call. Burning
    /// first validates that the holder truly had `n` units before the ledger moves (CEI; the 1155 burn
    /// has no receiver callback).
    ///
    /// CRITICAL-1 — `holder` MUST NOT be the game. A consumed charge lives ONLY in the game's balance
    /// while its round is live, and its `w` has already moved from `earmark` into `hold` at `consume`.
    /// Expiring the game's charge would burn that in-flight charge (stranding the open round, whose
    /// terminal then reverts because the game no longer holds it) AND de-earmark another `n * w` that
    /// the earmark no longer backs — a permissionless double-release that breaks P2 and under-backs
    /// every other holder. Two independent guards stop it: (1) `holder != game` directly, and (2)
    /// `n <= circ[seriesId]` — the game's in-flight charges are excluded from `circ`, so even a future
    /// refactor cannot de-earmark more than the circulating supply. Both are belt-and-suspenders.
    ///
    /// MEDIUM-3 (S2c constraint, NOT solved here): this call BURNS the expired charge, which is the
    /// same charge O4's purchase-price refund needs. The S2c mint-sale must sequence its price refund
    /// so a racing `expireCharges` cannot strand it — burn the charge in exactly one place, or have the
    /// price refund read a pre-burn snapshot. Do not rely on the charge still existing after expiry.
    function expireCharges(uint256 seriesId, address holder, uint256 n) external nonReentrant {
        if (holder == game) revert HolderIsGame(); // never burn an in-flight (consumed) charge
        (,, uint64 expiry,) = chips.seriesOf(seriesId);
        if (block.timestamp < expiry) revert BeforeExpiry();
        if (n > circ[seriesId]) revert CircShort(); // cannot de-earmark more than the circulating supply

        uint256 amount = n * chips.w(seriesId);
        chips.burn(holder, seriesId, n); // reverts if holder lacks n units

        // De-earmark strictly against circ. `earmark == circ * w` and `n <= circ` together guarantee
        // `amount <= earmark`, so this subtraction can never underflow when the books agree.
        earmark[seriesId] -= amount;
        circ[seriesId] -= n;
        address op = seriesOperator[seriesId];
        (,,, address token) = chips.seriesOf(seriesId);
        credit[op][token] += amount;
        _assertBacked(seriesId);
        emit ChargesExpired(seriesId, op, n, amount);
    }

    // ── T8 WITHDRAW-CREDIT — the only door out ───────────────────────────────────────────────────

    /// @notice The operator withdraws its released credit for one token. CEI: debit the credit ledger
    /// BEFORE pulling from escrow, then forward. `withdrawBankroll` pays the pool (the bucket owner);
    /// the pool forwards to the operator. Opens only for released credit — never for earmark or hold.
    function withdrawCredit(address token, uint256 amount) external nonReentrant {
        uint256 c = credit[msg.sender][token];
        if (amount > c) revert InsufficientCredit();
        unchecked { credit[msg.sender][token] = c - amount; }

        escrow.withdrawBankroll(token, amount); // pool receives the tokens
        token.safeTransfer(msg.sender, amount); // forward to the operator
        emit CreditWithdrawn(msg.sender, token, amount);
    }
}
