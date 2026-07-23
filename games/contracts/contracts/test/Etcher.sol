// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MulticallerEtcher} from "multicaller/src/MulticallerEtcher.sol";

contract Etcher {
    function multicallerWithSender() external {
        MulticallerEtcher.multicallerWithSender();
    }
}
