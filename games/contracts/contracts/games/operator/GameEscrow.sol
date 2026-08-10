// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {SafeTransferLib} from "solady/src/utils/SafeTransferLib.sol";
import {EscrowLib} from "./EscrowLib.sol";
import {OperatorRegistry} from "./OperatorRegistry.sol";

/// @notice The standardized settlement seam — the safety-critical core of the table-maintainer
/// substrate. Holds ALL player and operator funds in per-(operator, token) isolated ledgers, pulls
/// every deposit with balance-delta verification (fee-on-transfer / rebasing safe), and pays out
/// deterministically. It is token-agnostic (any ERC-20, no whitelist, no oracle). Bet lifecycle
/// (lockExposure / settle / refund / rake) is added in Tasks 4–6.
contract GameEscrow {
    using SafeTransferLib for address;
    using EscrowLib for EscrowLib.Ledger;

    address public immutable registry;

    mapping(bytes32 key => EscrowLib.Ledger) internal ledgers;

    error BetExists();
    error BadPayout();
    error StakeUnderDelivered();
    error UnknownBet();
    error NotBetGame();

    struct Bet {
        address game;
        address operator;
        address token;
        address player;
        uint256 payout;
        uint256 stake;
        bool    open;
    }

    mapping(bytes32 betId => Bet) public bets;

    event BankrollDeposited(address indexed operator, address indexed token, address indexed from, uint256 credited);
    event BankrollWithdrawn(address indexed operator, address indexed token, uint256 amount);
    event ExposureLocked(bytes32 indexed betId, address indexed operator, address token, address player, uint256 stake, uint256 payout);
    event Settled(bytes32 indexed betId, bool playerWon, uint256 paidToPlayer, uint256 rake);
    event Refunded(bytes32 indexed betId, address indexed player, uint256 stake);
    event RakeWithdrawn(address indexed operator, address indexed token, address recipient, uint256 amount);

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

    /// @notice Pull `amount` of `token` from `from` and return the MEASURED delta actually received.
    /// Crediting the delta (not the requested amount) keeps the books exact for fee-on-transfer and
    /// rebasing tokens, and contains any such token to its own bucket.
    function _pullVerified(address token, address from, uint256 amount) internal returns (uint256 received) {
        uint256 balBefore = token.balanceOf(address(this));
        token.safeTransferFrom(from, address(this), amount);
        received = token.balanceOf(address(this)) - balBefore;
    }

    /// @notice Fund an operator's (operator, token) bankroll from msg.sender — the BYO funding source
    /// (EOA, Safe, OperatorVault clone). Anyone may fund any operator; only the measured delta is
    /// credited.
    function depositBankroll(address operator, address token, uint256 amount) external {
        uint256 credited = _pullVerified(token, msg.sender, amount);
        ledgers[_ledgerKey(operator, token)].creditBankroll(credited);
        emit BankrollDeposited(operator, token, msg.sender, credited);
    }

    /// @notice Operator withdraws its own idle bankroll. Debits its (operator, token) ledger only —
    /// locked and rake are untouchable here.
    function withdrawBankroll(address token, uint256 amount) external {
        ledgers[_ledgerKey(msg.sender, token)].debitBankroll(amount);
        token.safeTransfer(msg.sender, amount);
        emit BankrollWithdrawn(msg.sender, token, amount);
    }

    /// @notice Pre-collateralize a bet. The game calls this at bet-accept: exposure (payout - stake)
    /// is debited from the operator's bankroll (reverting if short — graceful bankruptcy), and the
    /// player's stake is pulled in fresh, balance-delta checked. After this returns, the escrow holds
    /// the FULL payout for this bet, so settlement can never be under-collateralized. The recorded
    /// game is the ONLY address that may settle/refund this bet.
    function lockExposure(
        bytes32 betId,
        address operator,
        address token,
        address player,
        uint256 stake,
        uint256 payout
    ) external {
        if (bets[betId].open) revert BetExists();
        if (payout < stake) revert BadPayout();
        uint256 exposure;
        unchecked { exposure = payout - stake; }

        ledgers[_ledgerKey(operator, token)].lock(exposure, payout);

        // Effects BEFORE the external interaction: reserve the betId now, so a hostile token that
        // re-enters lockExposure with the SAME betId mid-transferFrom hits BetExists instead of
        // double-locking exposure and double-pulling the stake. A failed pull below still unwinds
        // this write atomically via Solidity's revert semantics — nothing is left dangling.
        bets[betId] = Bet({
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

    /// @notice Look up an open bet and enforce that only the game which locked it may act on it.
    function _openBet(bytes32 betId) internal view returns (Bet storage b) {
        b = bets[betId];
        if (!b.open) revert UnknownBet();
        if (b.game != msg.sender) revert NotBetGame();
    }

    /// @notice Player won: pay the full payout out of `locked`. CEI — the bet is closed BEFORE the
    /// token leaves the contract, so a hostile token cannot re-enter and settle the same bet twice.
    function settleWin(bytes32 betId) external {
        Bet storage b = _openBet(betId);
        b.open = false;
        ledgers[_ledgerKey(b.operator, b.token)].settleWin(b.payout);
        b.token.safeTransfer(b.player, b.payout);
        emit Settled(betId, true, b.payout, 0);
    }

    /// @notice Player lost: rake is taken on the forfeited stake, the remainder of the reservation
    /// returns to the operator's bankroll. No external transfer — funds simply stay in escrow.
    function settleLoss(bytes32 betId) external {
        Bet storage b = _openBet(betId);
        b.open = false;
        uint16 bps = OperatorRegistry(registry).rakeBps(b.operator, b.game);
        uint256 rakeAmt = uint256(b.stake) * bps / 10000;
        ledgers[_ledgerKey(b.operator, b.token)].settleLoss(b.payout, rakeAmt);
        emit Settled(betId, false, 0, rakeAmt);
    }

    /// @notice Abort/timeout: the operator's exposure returns to bankroll, the player reclaims their
    /// own stake. CEI — closed BEFORE the stake transfer.
    function refund(bytes32 betId) external {
        Bet storage b = _openBet(betId);
        b.open = false;
        uint256 exposure;
        unchecked { exposure = b.payout - b.stake; }
        ledgers[_ledgerKey(b.operator, b.token)].refundExposure(b.payout, exposure);
        b.token.safeTransfer(b.player, b.stake);
        emit Refunded(betId, b.player, b.stake);
    }

    /// @notice Operator sweeps its accrued rake for one token to its configured recipient (defaults
    /// to the operator itself).
    function withdrawRake(address token) external {
        uint256 amt = ledgers[_ledgerKey(msg.sender, token)].takeRake();
        address recipient = OperatorRegistry(registry).rakeRecipientOf(msg.sender, token);
        token.safeTransfer(recipient, amt);
        emit RakeWithdrawn(msg.sender, token, recipient, amt);
    }
}
