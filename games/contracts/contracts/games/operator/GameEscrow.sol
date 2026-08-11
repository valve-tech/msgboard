// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {SafeTransferLib} from "solady/src/utils/SafeTransferLib.sol";
import {EscrowLib} from "./EscrowLib.sol";
import {OperatorRegistry} from "./OperatorRegistry.sol";
import {ReentrancyGuard} from "./ReentrancyGuard.sol";

/// @notice The standardized settlement seam — the safety-critical core of the table-maintainer
/// substrate. Holds ALL player and operator funds in per-(operator, token) isolated ledgers, pulls
/// every deposit with balance-delta verification (credits the amount actually received — safe for
/// fee-on-transfer, and for the deposit itself under a rebasing token), and pays out
/// deterministically. It is token-agnostic (any ERC-20, no whitelist, no oracle).
///
/// Every token-moving entrypoint is `nonReentrant`. The balance-delta credit is only sound if no
/// nested transfer runs inside the measured window: a hooked/ERC-777 token that re-entered
/// `depositBankroll` (or `lockExposure`'s stake pull) mid-`transferFrom` would otherwise make the
/// outer delta span the inner transfer and over-credit the ledger, breaking per-bucket solvency. The
/// shared mutex (see ReentrancyGuard) also blocks cross-function re-entry — a payout transfer cannot
/// re-enter deposit/withdraw. The CEI ordering on settle/refund is kept as a second line of defence.
contract GameEscrow is ReentrancyGuard {
    using SafeTransferLib for address;
    using EscrowLib for EscrowLib.Ledger;

    address public immutable registry;

    mapping(bytes32 key => EscrowLib.Ledger) internal ledgers;

    error BetExists();
    error BadPayout();
    error StakeUnderDelivered();
    error UnknownBet();
    error UnauthorizedGame();
    error PlayerNotConsented();

    struct Bet {
        address game;
        address operator;
        address token;
        address player;
        uint256 payout;
        uint256 stake;
        bool    open;
    }

    /// @notice Bets are keyed by (game, betId), NOT the raw caller-chosen betId — otherwise an
    /// attacker's game could pre-occupy a victim game's predicted betId (a public, sequential roundId)
    /// with a gas-only zero-value bet and make the victim's `open` revert BetExists (a targeted griefing
    /// DoS). Namespacing gives every game its own betId space, so no game can collide another's.
    mapping(bytes32 betKey => Bet) internal _bets;

    function _betKey(address game, bytes32 betId) internal pure returns (bytes32) {
        return keccak256(abi.encode(game, betId));
    }

    /// @notice Read a bet by the game that locked it and its betId.
    function betOf(address game, bytes32 betId) external view returns (Bet memory) {
        return _bets[_betKey(game, betId)];
    }

    /// @notice Operator-scoped game authorization. Permissionless and self-sovereign, mirroring
    /// OperatorBond.authorizedGame: only the operator (msg.sender) may opt a game in/out of locking
    /// exposure against its own (operator, token) buckets. There is no admin override.
    mapping(address operator => mapping(address game => bool)) public authorizedGame;

    /// @notice Player-scoped game consent. A player approves the SHARED escrow for a token once, so a
    /// standing allowance is otherwise spendable by ANY authorized game of ANY operator — a malicious
    /// operator could authorize its own game and pull a victim's allowance into a zero-exposure bet it
    /// then banks. This mapping closes that: `lockExposure` only pulls a player's stake for a game the
    /// PLAYER has opted into. Symmetric with the operator side — the player, like the operator, chooses
    /// which games may draw on its funds. The canonical game calls this in onboarding, once per player.
    mapping(address player => mapping(address game => bool)) public playerAllowsGame;

    event BankrollDeposited(address indexed operator, address indexed token, address indexed from, uint256 credited);
    event BankrollWithdrawn(address indexed operator, address indexed token, uint256 amount);
    event ExposureLocked(bytes32 indexed betId, address indexed operator, address token, address player, uint256 stake, uint256 payout);
    event Settled(bytes32 indexed betId, address indexed operator, address token, bool playerWon, uint256 paidToPlayer, uint256 rake);
    event Refunded(bytes32 indexed betId, address indexed operator, address token, address player, uint256 stake);
    event RakeWithdrawn(address indexed operator, address indexed token, address recipient, uint256 amount);
    event GameAuthorized(address indexed operator, address indexed game, bool allowed);
    event PlayerGameSet(address indexed player, address indexed game, bool allowed);

    constructor(address registry_) {
        registry = registry_;
    }

    function _ledgerKey(address operator, address token) internal pure returns (bytes32) {
        return keccak256(abi.encode(operator, token));
    }

    function bankrollOf(address operator, address token) external view returns (uint256) {
        return ledgers[_ledgerKey(operator, token)].bankroll;
    }

    function lockedOf(address operator, address token) external view returns (uint256) {
        return ledgers[_ledgerKey(operator, token)].locked;
    }

    function rakeOf(address operator, address token) external view returns (uint256) {
        return ledgers[_ledgerKey(operator, token)].rake;
    }

    /// @notice Pull `amount` of `token` from `from` and return the MEASURED delta actually received.
    /// Crediting the delta (not the requested amount) keeps the books exact for fee-on-transfer tokens
    /// and contains any such token to its own bucket. NOTE: this measures only the DEPOSIT-time delta —
    /// a token that rebases (balance drifts) BETWEEN lock and settle is not re-measured, so a genuinely
    /// rebasing token can desync a bucket. Such tokens are out of the supported set; the isolation
    /// guarantee still confines any damage to that token's own bucket.
    function _pullVerified(address token, address from, uint256 amount) internal returns (uint256 received) {
        uint256 balBefore = token.balanceOf(address(this));
        token.safeTransferFrom(from, address(this), amount);
        received = token.balanceOf(address(this)) - balBefore;
    }

    /// @notice Fund an operator's (operator, token) bankroll from msg.sender — the BYO funding source
    /// (EOA, Safe, OperatorVault clone). Anyone may fund any operator; only the measured delta is
    /// credited.
    function depositBankroll(address operator, address token, uint256 amount) external nonReentrant {
        uint256 credited = _pullVerified(token, msg.sender, amount);
        ledgers[_ledgerKey(operator, token)].creditBankroll(credited);
        emit BankrollDeposited(operator, token, msg.sender, credited);
    }

    /// @notice Operator withdraws its own idle bankroll. Debits its (operator, token) ledger only —
    /// locked and rake are untouchable here.
    function withdrawBankroll(address token, uint256 amount) external nonReentrant {
        ledgers[_ledgerKey(msg.sender, token)].debitBankroll(amount);
        token.safeTransfer(msg.sender, amount);
        emit BankrollWithdrawn(msg.sender, token, amount);
    }

    /// @notice Operator authorizes (or revokes) a game contract to lock exposure against its own
    /// (operator, *) buckets. Permissionless and self-sovereign: only the operator can authorize games
    /// to draw on its bankroll. Mirrors OperatorBond.authorizeGame.
    function authorizeGame(address game, bool allowed) external {
        authorizedGame[msg.sender][game] = allowed;
        emit GameAuthorized(msg.sender, game, allowed);
    }

    /// @notice Player opts a game in/out of pulling its stake from the player's standing escrow
    /// allowance. Self-sovereign: only the player (msg.sender) controls which games may draw its
    /// funds. Without this a malicious game could name any approver as the `player` in lockExposure
    /// and drain their allowance. Set once for the game(s) a player actually plays.
    function setPlayerGame(address game, bool allowed) external {
        playerAllowsGame[msg.sender][game] = allowed;
        emit PlayerGameSet(msg.sender, game, allowed);
    }

    /// @notice Pre-collateralize a bet. The game calls this at bet-accept: exposure (payout - stake)
    /// is debited from the operator's bankroll (reverting if short — graceful bankruptcy), and the
    /// player's stake is pulled in fresh, balance-delta checked. After this returns, the escrow holds
    /// the FULL payout for this bet, so settlement can never be under-collateralized. The recorded
    /// game is the ONLY address that may settle/refund this bet. Only a game the `operator` has
    /// authorized may lock exposure against that operator's bankroll — closes the drain where any
    /// caller could name an arbitrary operator and payout to steal its idle funds.
    function lockExposure(
        bytes32 betId,
        address operator,
        address token,
        address player,
        uint256 stake,
        uint256 payout
    ) external nonReentrant {
        if (!authorizedGame[operator][msg.sender]) revert UnauthorizedGame();
        if (!playerAllowsGame[player][msg.sender]) revert PlayerNotConsented();
        bytes32 betKey = _betKey(msg.sender, betId);
        if (_bets[betKey].open) revert BetExists();
        if (payout < stake) revert BadPayout();
        uint256 exposure;
        unchecked { exposure = payout - stake; }

        ledgers[_ledgerKey(operator, token)].lock(exposure, payout);

        // Effects BEFORE the external interaction: reserve the betId now, so a hostile token that
        // re-enters lockExposure with the SAME betId mid-transferFrom hits BetExists instead of
        // double-locking exposure and double-pulling the stake. A failed pull below still unwinds
        // this write atomically via Solidity's revert semantics — nothing is left dangling.
        _bets[betKey] = Bet({
            game: msg.sender,
            operator: operator,
            token: token,
            player: player,
            payout: payout,
            stake: stake,
            open: true
        });

        uint256 received = _pullVerified(token, player, stake);
        if (received < stake) revert StakeUnderDelivered();

        emit ExposureLocked(betId, operator, token, player, stake, payout);
    }

    /// @notice Look up an open bet in the caller's own namespace. Because bets are keyed by
    /// (game, betId), a caller that did not lock this betId simply finds no open bet here (UnknownBet)
    /// — "only the recording game may act on it" is enforced structurally by the key, so no separate
    /// caller check is needed.
    function _openBet(bytes32 betId) internal view returns (Bet storage b) {
        b = _bets[_betKey(msg.sender, betId)];
        if (!b.open) revert UnknownBet();
    }

    /// @notice Player won: pay the full payout out of `locked`. CEI — the bet is closed BEFORE the
    /// token leaves the contract, so a hostile token cannot re-enter and settle the same bet twice.
    function settleWin(bytes32 betId) external nonReentrant {
        Bet storage b = _openBet(betId);
        b.open = false;
        ledgers[_ledgerKey(b.operator, b.token)].settleWin(b.payout);
        b.token.safeTransfer(b.player, b.payout);
        emit Settled(betId, b.operator, b.token, true, b.payout, 0);
    }

    /// @notice Player lost: rake is taken on the forfeited stake, the remainder of the reservation
    /// returns to the operator's bankroll. No external transfer — funds simply stay in escrow.
    function settleLoss(bytes32 betId) external nonReentrant {
        Bet storage b = _openBet(betId);
        b.open = false;
        uint16 bps = OperatorRegistry(registry).rakeBps(b.operator, b.game);
        uint256 rakeAmt = uint256(b.stake) * bps / 10000;
        ledgers[_ledgerKey(b.operator, b.token)].settleLoss(b.payout, rakeAmt);
        emit Settled(betId, b.operator, b.token, false, 0, rakeAmt);
    }

    /// @notice Abort/timeout: the operator's exposure returns to bankroll, the player reclaims their
    /// own stake. CEI — closed BEFORE the stake transfer.
    function refund(bytes32 betId) external nonReentrant {
        Bet storage b = _openBet(betId);
        b.open = false;
        uint256 exposure;
        unchecked { exposure = b.payout - b.stake; }
        ledgers[_ledgerKey(b.operator, b.token)].refundExposure(b.payout, exposure);
        b.token.safeTransfer(b.player, b.stake);
        emit Refunded(betId, b.operator, b.token, b.player, b.stake);
    }

    /// @notice Operator sweeps its accrued rake for one token to its configured recipient (defaults
    /// to the operator itself). No-op if nothing has accrued — skips the transfer so a non-compliant
    /// token that reverts on a zero-value transfer can't brick the sweep.
    function withdrawRake(address token) external nonReentrant {
        uint256 amt = ledgers[_ledgerKey(msg.sender, token)].takeRake();
        if (amt == 0) return;
        address recipient = OperatorRegistry(registry).rakeRecipientOf(msg.sender, token);
        token.safeTransfer(recipient, amt);
        emit RakeWithdrawn(msg.sender, token, recipient, amt);
    }
}
