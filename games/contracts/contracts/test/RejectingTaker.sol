// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {FlipBook} from "../games/FlipBook.sol";

/// Test helper: a contract taker whose receive path reverts, to prove a hostile winner cannot
/// block FlipBook settlement (payment parks in `owed` instead). `accept` can be flipped on to
/// exercise the later `withdraw` happy path.
contract RejectingTaker {
    FlipBook public immutable book;
    bool public accept;

    constructor(FlipBook book_) {
        book = book_;
    }

    function take(uint256 offerId, bool guess) external payable {
        book.take{value: msg.value}(offerId, guess);
    }

    function withdraw() external {
        book.withdraw();
    }

    function setAccept(bool accept_) external {
        accept = accept_;
    }

    receive() external payable {
        if (!accept) revert("no thanks");
    }
}
