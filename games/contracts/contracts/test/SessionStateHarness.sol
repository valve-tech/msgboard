// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {SessionStateEIP712} from "../games/SessionState.sol";

/// Minimal concrete SessionStateEIP712 so the TS↔Solidity digest parity test can deploy
/// something and call stateDigest(). Both real backends inherit the same base/domain, so
/// parity proven here holds for HouseBankroll/HouseChannel at their own addresses.
contract SessionStateHarness is SessionStateEIP712 {}
