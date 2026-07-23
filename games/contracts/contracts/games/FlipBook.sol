// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// A P2P coin flip as a two-sided GUESSING game (matching pennies) — no validators, no house,
/// no joint entropy. See examples/games/P2P_COINFLIP_DESIGN.md (variant A: escrowed offers).
///
/// A maker escrows `stake + bond` behind a hidden choice commit as a standing offer; a taker
/// picks it up by escrowing `stake` and stating a public guess in the same transaction. The
/// maker then reveals within a window or forfeits stake AND bond to the taker. Fairness needs
/// no trusted randomness anywhere: a taker who guesses uniformly wins exactly half against ANY
/// maker strategy (and a uniform maker concedes exactly half to any taker) — each side's EV is
/// protected by their own coin, not the counterparty's.
///
/// The design's load-bearing property is closing the maker's FREE OPTION (selectively killing
/// an offer upon seeing a losing guess): escrow at post time makes the offer physically
/// un-yankable — `cancel` requires the offer to be untaken, and `take` locks it atomically.
///
/// Liveness is one-sided by construction: the taker's guess IS their entire move, so only the
/// maker ever reveals and only the maker posts a bond. The bond breaks the even-money
/// indifference between revealing a loss (costs `stake`) and bailing (costs `stake + bond`):
/// any positive bond makes honest reveal strictly dominant; size it to at least cover the
/// taker's claim gas.
///
/// Settlement pushes native value with a pull fallback (`owed`/`withdraw`), so a
/// revert-on-receive winner can never block settlement.
contract FlipBook {
    struct Offer {
        address maker;
        bytes32 commit; // keccak256(abi.encode(maker, choice, salt)) — maker-bound, salt-blinded
        uint256 stake; // per-side stake (native)
        uint256 bond; // maker's liveness bond, refunded on reveal, forfeited on bail
        uint64 takeDeadline; // offer is takeable until this timestamp (inclusive)
        uint32 revealWindow; // seconds after take in which the maker must reveal
        address taker; // zero until taken
        uint64 takenAt;
        bool guess; // taker's public move
    }

    /// Reveal-window bounds: enough time for an honest maker to come online, short enough that
    /// a taker is never parked for long. The taker sees the window before taking and accepts it.
    uint32 public constant MIN_REVEAL_WINDOW = 5 minutes;
    uint32 public constant MAX_REVEAL_WINDOW = 7 days;

    uint256 public nextOfferId = 1;
    mapping(uint256 offerId => Offer) public offers;
    /// Pull-fallback balances for payees whose push payment reverted.
    mapping(address payee => uint256) public owed;

    error ZeroStake(); // msg.value must exceed the bond so the flip has a stake
    error ZeroBond(); // bond == 0 makes bailing on a loss free (even-money indifference)
    error BadDeadline(); // takeDeadline not in the future
    error BadWindow(); // revealWindow outside [MIN_REVEAL_WINDOW, MAX_REVEAL_WINDOW]
    error UnknownOffer(); // no such offer (never existed, cancelled, or already settled)
    error NotMaker(); // cancel by someone other than the maker
    error AlreadyTaken(); // take/cancel on an offer that is already locked to a taker
    error NotTaken(); // reveal/claim on an offer with no taker
    error SelfTake(); // maker taking their own offer (wash flip)
    error OfferExpired(); // take after takeDeadline
    error WrongValue(); // take's msg.value != the offer's stake
    error BadReveal(); // (choice, salt) does not hash to the commit
    error RevealWindowOver(); // reveal after the window — the forfeit path owns the offer now
    error RevealWindowOpen(); // claim before the window has lapsed
    error NothingOwed(); // withdraw with a zero balance

    event OfferPosted(
        uint256 indexed offerId,
        address indexed maker,
        bytes32 commit,
        uint256 stake,
        uint256 bond,
        uint64 takeDeadline,
        uint32 revealWindow
    );
    event OfferCancelled(uint256 indexed offerId);
    event OfferTaken(uint256 indexed offerId, address indexed taker, bool guess, uint256 revealBy);
    /// A settled flip: `choice` was the maker's hidden side, `winner` took 2·stake.
    event Revealed(uint256 indexed offerId, bool choice, address indexed winner, uint256 pot);
    /// The maker bailed: the taker took 2·stake + the maker's bond.
    event Forfeited(uint256 indexed offerId, address indexed taker, uint256 amount);
    event Withdrawn(address indexed payee, uint256 amount);

    /// Post a standing offer: msg.value = stake + bond, with `bond_` carved out explicitly.
    /// The commit MUST be keccak256(abi.encode(msg.sender, choice, salt)) — binding it to the
    /// maker means a copied commit is useless to anyone who doesn't know (choice, salt): they
    /// could escrow behind it but never reveal, and would only ever forfeit.
    function post(bytes32 commit, uint256 bond_, uint64 takeDeadline, uint32 revealWindow)
        external
        payable
        returns (uint256 offerId)
    {
        if (bond_ == 0) revert ZeroBond();
        if (msg.value <= bond_) revert ZeroStake();
        if (takeDeadline <= block.timestamp) revert BadDeadline();
        if (revealWindow < MIN_REVEAL_WINDOW || revealWindow > MAX_REVEAL_WINDOW) revert BadWindow();

        offerId = nextOfferId++;
        offers[offerId] = Offer({
            maker: msg.sender,
            commit: commit,
            stake: msg.value - bond_,
            bond: bond_,
            takeDeadline: takeDeadline,
            revealWindow: revealWindow,
            taker: address(0),
            takenAt: 0,
            guess: false
        });
        emit OfferPosted(offerId, msg.sender, commit, msg.value - bond_, bond_, takeDeadline, revealWindow);
    }

    /// Withdraw an UNTAKEN offer. Cancelling before a take cannot be selective — nothing has
    /// happened yet — while cancelling after a take is impossible by construction: that is the
    /// closure of the maker's free option.
    function cancel(uint256 offerId) external {
        Offer memory o = offers[offerId];
        if (o.maker == address(0)) revert UnknownOffer();
        if (o.maker != msg.sender) revert NotMaker();
        if (o.taker != address(0)) revert AlreadyTaken();

        delete offers[offerId];
        emit OfferCancelled(offerId);
        _pay(o.maker, o.stake + o.bond);
    }

    /// Pick up an offer: escrow the matching stake and state the guess. Atomic — once this
    /// lands the maker is locked in and the reveal clock starts.
    function take(uint256 offerId, bool guess) external payable {
        Offer storage o = offers[offerId];
        if (o.maker == address(0)) revert UnknownOffer();
        if (o.taker != address(0)) revert AlreadyTaken();
        if (msg.sender == o.maker) revert SelfTake();
        if (block.timestamp > o.takeDeadline) revert OfferExpired();
        if (msg.value != o.stake) revert WrongValue();

        o.taker = msg.sender;
        o.guess = guess;
        o.takenAt = uint64(block.timestamp);
        emit OfferTaken(offerId, msg.sender, guess, block.timestamp + o.revealWindow);
    }

    /// Settle a taken flip by opening the commit. Permissionless: the commit is the
    /// authorization — anyone holding (choice, salt) settles the SAME outcome, fixed at take
    /// time, so relaying gains a front-runner nothing. Taker wins iff their guess matched.
    function reveal(uint256 offerId, bool choice, bytes32 salt) external {
        Offer memory o = offers[offerId];
        if (o.maker == address(0)) revert UnknownOffer();
        if (o.taker == address(0)) revert NotTaken();
        if (block.timestamp > uint256(o.takenAt) + o.revealWindow) revert RevealWindowOver();
        if (keccak256(abi.encode(o.maker, choice, salt)) != o.commit) revert BadReveal();

        delete offers[offerId];
        address winner = (o.guess == choice) ? o.taker : o.maker;
        uint256 pot = o.stake * 2;
        emit Revealed(offerId, choice, winner, pot);
        if (winner == o.maker) {
            _pay(o.maker, pot + o.bond);
        } else {
            _pay(winner, pot);
            _pay(o.maker, o.bond);
        }
    }

    /// The bail path: the reveal was due on-chain, so its absence after the window is directly
    /// observable — no challenge dance. Permissionless crank; funds always go to the taker.
    /// Bailing therefore costs the maker their stake AND bond, making honest reveal strictly
    /// dominant even on a lost flip.
    function claim(uint256 offerId) external {
        Offer memory o = offers[offerId];
        if (o.maker == address(0)) revert UnknownOffer();
        if (o.taker == address(0)) revert NotTaken();
        if (block.timestamp <= uint256(o.takenAt) + o.revealWindow) revert RevealWindowOpen();

        delete offers[offerId];
        uint256 amount = o.stake * 2 + o.bond;
        emit Forfeited(offerId, o.taker, amount);
        _pay(o.taker, amount);
    }

    /// Collect a balance credited when a push payment reverted (e.g. a contract payee).
    function withdraw() external {
        uint256 amount = owed[msg.sender];
        if (amount == 0) revert NothingOwed();
        owed[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) {
            // Restore and signal: the payee's receive path is still broken.
            owed[msg.sender] = amount;
            revert NothingOwed();
        }
        emit Withdrawn(msg.sender, amount);
    }

    /// Push with pull fallback: a reverting payee can never block settlement — their funds
    /// park in `owed` for a later `withdraw`. All callers delete offer state BEFORE paying.
    function _pay(address to, uint256 amount) private {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) owed[to] += amount;
    }
}
