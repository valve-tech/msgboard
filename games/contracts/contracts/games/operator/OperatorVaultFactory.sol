// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {LibClone} from "solady/src/utils/LibClone.sol";
import {OperatorVault} from "./OperatorVault.sol";

/// @notice Atomic clone+init factory for OperatorVault. `OperatorVault.initialize` is a plain external
/// function (no constructor, since clones share one implementation's code) — calling `clone()` and
/// `initialize()` as two separate transactions leaves a window between them where anyone can front-run
/// the intended owner's `initialize` call and claim the fresh clone for themselves. Combining both
/// steps into one atomic call closes that window entirely: the clone is never observable in an
/// uninitialized state by anyone but this transaction.
contract OperatorVaultFactory {
    address public immutable implementation;
    address public immutable escrow;

    event VaultCreated(address indexed owner, address vault);

    constructor(address implementation_, address escrow_) {
        implementation = implementation_;
        escrow = escrow_;
    }

    /// @notice Clone the OperatorVault implementation and initialize it for `owner_` in one atomic
    /// call. No caller other than this function ever sees the clone before it is initialized.
    function createVault(address owner_) external returns (address vault) {
        vault = LibClone.clone(implementation);
        OperatorVault(vault).initialize(owner_, escrow);
        emit VaultCreated(owner_, vault);
    }
}
