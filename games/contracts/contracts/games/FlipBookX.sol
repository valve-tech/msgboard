// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// The P2P coin flip, VARIANT B of examples/games/P2P_COINFLIP_DESIGN.md: fully OFF-CHAIN offers
/// over signed transfer authorizations, hidden guesses on both sides.
///
/// A maker's standing offer costs nothing to create: it is a commit (hidden choice) plus an
/// EIP-3009/7598 `receiveWithAuthorization` over the x402 wrapper token (stake + maker bond),
/// posted to msgboard. Funds move only when a taker executes `take`, which atomically pulls BOTH
/// sides' escrows via their authorizations — so offers can be sprayed freely and the book carries
/// zero locked capital.
///
/// THE FREE-OPTION CLOSURE (variant B form): the taker's guess is hidden too (guessCommit).
/// A maker watching the mempool cannot tell a winning take from a losing one, so cancelling an
/// authorization (the wrapper's own `cancelAuthorization`, no involvement of this contract) is
/// only ever noise — it cannot selectively dodge losses. The cost of this shape is TWO-SIDED
/// reveal liveness, priced by two bonds:
///   1. maker reveals `choice` within makerRevealWindow of the take   — else taker claims all;
///   2. taker reveals `guess` within takerRevealWindow of that reveal — else maker claims all.
/// Each side's bond returns at their own honest reveal, making reveal strictly dominant even on
/// a lost flip (same even-money-indifference argument as variant A's single bond).
///
/// TERM AUTHENTICATION: the offer's id — keccak over EVERY term plus this contract + chainid —
/// IS the maker's authorization nonce. A taker who alters any term recomputes a different id,
/// the wrapper's EIP-712 check then fails against the maker's signature, and the take reverts.
/// The wrapper burns nonces on use, so a settled offer can never be replayed. The taker's
/// authorization nonce is keccak(offerId, taker), binding it to this exact offer.
///
/// TOKEN: an x402 wrapper (EIP-3009 + EIP-7598 + payee-only receive). 65-byte signatures route
/// through the universal (v,r,s) overload — compatible with the older wrapper build on 943 —
/// while any other length uses the 7598 `bytes` overload (ERC-1271 / Safe signers).
interface IX402Token {
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;

    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) external;

    function transfer(address to, uint256 value) external returns (bool);
}

contract FlipBookX {
    struct Offer {
        address maker;
        bytes32 commit; // keccak256(abi.encode(maker, choice, salt)) — maker-bound, salt-blinded
        uint256 stake; // per-side stake (wrapper token units)
        uint256 makerBond; // maker's reveal-liveness bond
        uint256 takerBond; // taker's reveal-liveness bond
        uint64 takeDeadline; // offer takeable until this timestamp (== the authorization's validBefore)
        uint32 makerRevealWindow; // seconds after take for the maker's choice reveal
        uint32 takerRevealWindow; // seconds after the choice reveal for the taker's guess reveal
    }

    struct Flip {
        address maker;
        address taker;
        bytes32 commit;
        bytes32 guessCommit; // keccak256(abi.encode(taker, guess, salt2)) — taker-bound, hidden
        uint256 stake;
        uint256 makerBond;
        uint256 takerBond;
        uint64 takenAt;
        uint64 choiceRevealedAt; // 0 until the maker reveals
        uint32 makerRevealWindow;
        uint32 takerRevealWindow;
        bool choice; // meaningful once choiceRevealedAt != 0
    }

    uint32 public constant MIN_REVEAL_WINDOW = 5 minutes;
    uint32 public constant MAX_REVEAL_WINDOW = 7 days;

    /// The x402 wrapper this book settles in (e.g. x402PLS — same address on 943 and 369).
    IX402Token public immutable token;

    mapping(bytes32 offerId => Flip) public flips;

    error ZeroStake();
    error ZeroBond(); // both bonds must be positive — they price the two reveal duties
    error BadWindow(); // a reveal window outside [MIN_REVEAL_WINDOW, MAX_REVEAL_WINDOW]
    error SelfTake();
    error OfferExpired(); // take after takeDeadline
    error AlreadyTaken(); // this offer is already in flight
    error UnknownFlip(); // no such in-flight flip (never taken, or already settled)
    error ChoiceAlreadyRevealed();
    error ChoiceNotRevealed(); // guess reveal / taker-default claim before the choice reveal
    error BadReveal(); // (choice, salt) or (guess, salt2) does not open the matching commit
    error RevealWindowOver(); // reveal after the window — the default path owns the flip now
    error RevealWindowOpen(); // default claim before the window lapsed

    event Taken(
        bytes32 indexed offerId,
        address indexed maker,
        address indexed taker,
        uint256 stake,
        bytes32 guessCommit,
        uint256 choiceRevealBy
    );
    event ChoiceRevealed(bytes32 indexed offerId, bool choice, uint256 guessRevealBy);
    /// The flip settled by both honest reveals: `winner` took the 2·stake pot.
    event Settled(bytes32 indexed offerId, bool choice, bool guess, address indexed winner, uint256 pot);
    /// The maker never revealed: the taker took pot + both bonds.
    event MakerDefaulted(bytes32 indexed offerId, address indexed taker, uint256 amount);
    /// The taker never revealed their guess: the maker took pot + the taker's bond.
    event TakerDefaulted(bytes32 indexed offerId, address indexed maker, uint256 amount);

    constructor(address token_) {
        token = IX402Token(token_);
    }

    /// The offer's canonical id — and the maker's authorization nonce. Binds every term to this
    /// contract on this chain, so a signature authorizes exactly one offer shape, nothing else.
    function offerId(Offer calldata o) public view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("FlipBookX.Offer"),
                block.chainid,
                address(this),
                o.maker,
                o.commit,
                o.stake,
                o.makerBond,
                o.takerBond,
                o.takeDeadline,
                o.makerRevealWindow,
                o.takerRevealWindow
            )
        );
    }

    /// The taker-side authorization nonce for an offer — binds the taker's escrow to this offer.
    function takerNonce(bytes32 id, address taker) public pure returns (bytes32) {
        return keccak256(abi.encode(keccak256("FlipBookX.Take"), id, taker));
    }

    /// Execute a standing offer: pull BOTH escrows via their signed authorizations and lock the
    /// flip. Fully relayable — `taker` is bound inside their authorization nonce and guessCommit,
    /// so whoever submits the transaction changes nothing. This is the first on-chain footprint
    /// an offer ever has.
    function take(
        Offer calldata o,
        bytes calldata makerSig,
        address taker,
        bytes32 guessCommit,
        bytes calldata takerSig
    ) external returns (bytes32 id) {
        if (o.stake == 0) revert ZeroStake();
        if (o.makerBond == 0 || o.takerBond == 0) revert ZeroBond();
        if (
            o.makerRevealWindow < MIN_REVEAL_WINDOW || o.makerRevealWindow > MAX_REVEAL_WINDOW
                || o.takerRevealWindow < MIN_REVEAL_WINDOW || o.takerRevealWindow > MAX_REVEAL_WINDOW
        ) revert BadWindow();
        if (taker == o.maker) revert SelfTake();
        if (block.timestamp > o.takeDeadline) revert OfferExpired();

        id = offerId(o);
        if (flips[id].maker != address(0)) revert AlreadyTaken();

        // Both pulls are atomic with the lock: either the whole flip exists, or nothing moved.
        // The wrapper burns each nonce, so neither authorization can ever be executed again.
        _pull(o.maker, o.stake + o.makerBond, o.takeDeadline, id, makerSig);
        _pull(taker, o.stake + o.takerBond, o.takeDeadline, takerNonce(id, taker), takerSig);

        flips[id] = Flip({
            maker: o.maker,
            taker: taker,
            commit: o.commit,
            guessCommit: guessCommit,
            stake: o.stake,
            makerBond: o.makerBond,
            takerBond: o.takerBond,
            takenAt: uint64(block.timestamp),
            choiceRevealedAt: 0,
            makerRevealWindow: o.makerRevealWindow,
            takerRevealWindow: o.takerRevealWindow,
            choice: false
        });
        emit Taken(id, o.maker, taker, o.stake, guessCommit, block.timestamp + o.makerRevealWindow);
    }

    /// Phase 1: the maker opens their commit. Permissionless (the secret is the authorization);
    /// the maker's bond returns HERE — their liveness duty is done, win or lose, before anyone
    /// knows the outcome (the guess is still hidden).
    function revealChoice(bytes32 id, bool choice, bytes32 salt) external {
        Flip storage f = flips[id];
        if (f.maker == address(0)) revert UnknownFlip();
        if (f.choiceRevealedAt != 0) revert ChoiceAlreadyRevealed();
        if (block.timestamp > uint256(f.takenAt) + f.makerRevealWindow) revert RevealWindowOver();
        if (keccak256(abi.encode(f.maker, choice, salt)) != f.commit) revert BadReveal();

        f.choice = choice;
        f.choiceRevealedAt = uint64(block.timestamp);
        token.transfer(f.maker, f.makerBond);
        emit ChoiceRevealed(id, choice, block.timestamp + f.takerRevealWindow);
    }

    /// Phase 2: the taker opens their guess and the flip settles. Permissionless with the secret.
    /// Both sides are now public: winner takes the pot, the taker's bond returns with their reveal.
    function revealGuess(bytes32 id, bool guess, bytes32 salt2) external {
        Flip memory f = flips[id];
        if (f.maker == address(0)) revert UnknownFlip();
        if (f.choiceRevealedAt == 0) revert ChoiceNotRevealed();
        if (block.timestamp > uint256(f.choiceRevealedAt) + f.takerRevealWindow) revert RevealWindowOver();
        if (keccak256(abi.encode(f.taker, guess, salt2)) != f.guessCommit) revert BadReveal();

        delete flips[id];
        address winner = (guess == f.choice) ? f.taker : f.maker;
        uint256 pot = f.stake * 2;
        emit Settled(id, f.choice, guess, winner, pot);
        token.transfer(f.taker, f.takerBond);
        token.transfer(winner, pot);
    }

    /// The maker sat out phase 1: the take is public record, the reveal is absent — the taker
    /// takes the pot and BOTH bonds. Permissionless crank; funds always go to the taker.
    function claimMakerDefault(bytes32 id) external {
        Flip memory f = flips[id];
        if (f.maker == address(0)) revert UnknownFlip();
        if (f.choiceRevealedAt != 0) revert ChoiceAlreadyRevealed();
        if (block.timestamp <= uint256(f.takenAt) + f.makerRevealWindow) revert RevealWindowOpen();

        delete flips[id];
        uint256 amount = f.stake * 2 + f.makerBond + f.takerBond;
        emit MakerDefaulted(id, f.taker, amount);
        token.transfer(f.taker, amount);
    }

    /// The taker sat out phase 2 (their guess must have been a loser — an honest reveal was free):
    /// the maker takes the pot and the taker's bond. Permissionless crank; funds go to the maker
    /// (whose own bond already returned at their reveal).
    function claimTakerDefault(bytes32 id) external {
        Flip memory f = flips[id];
        if (f.maker == address(0)) revert UnknownFlip();
        if (f.choiceRevealedAt == 0) revert ChoiceNotRevealed();
        if (block.timestamp <= uint256(f.choiceRevealedAt) + f.takerRevealWindow) revert RevealWindowOpen();

        delete flips[id];
        uint256 amount = f.stake * 2 + f.takerBond;
        emit TakerDefaulted(id, f.maker, amount);
        token.transfer(f.maker, amount);
    }

    /// Route to the wrapper's matching authorization overload: exactly-65-byte signatures use the
    /// universal (v,r,s) form (works on every wrapper build, incl. 943's older impl); any other
    /// length is an ERC-1271 payload for the EIP-7598 `bytes` form (Safes / smart accounts).
    function _pull(address from, uint256 value, uint64 validBefore, bytes32 nonce, bytes calldata sig) private {
        if (sig.length == 65) {
            bytes32 r = bytes32(sig[0:32]);
            bytes32 s = bytes32(sig[32:64]);
            uint8 v = uint8(sig[64]);
            token.receiveWithAuthorization(from, address(this), value, 0, validBefore, nonce, v, r, s);
        } else {
            token.receiveWithAuthorization(from, address(this), value, 0, validBefore, nonce, sig);
        }
    }
}
