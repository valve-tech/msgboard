// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

abstract contract ConsumerReceiver {
    function onReverse(
        bytes32 /*key*/,
        address /*token*/,
        uint256 /*amount*/
    ) external virtual;

    function onCast(bytes32 /*key*/, bytes32 /*seed*/) external virtual;

    function onChop(bytes32 /*key*/) external virtual;
}
