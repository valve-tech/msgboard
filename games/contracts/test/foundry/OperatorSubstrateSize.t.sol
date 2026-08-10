// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {OperatorRegistry} from "../../contracts/games/operator/OperatorRegistry.sol";
import {GameEscrow} from "../../contracts/games/operator/GameEscrow.sol";
import {OperatorBond} from "../../contracts/games/operator/OperatorBond.sol";
import {OperatorVault} from "../../contracts/games/operator/OperatorVault.sol";
import {OperatorCoinFlip} from "../../contracts/games/operator/OperatorCoinFlip.sol";

/// @notice EIP-170 deployability guard for the table-maintainer substrate (mirrors
/// HoldemTableNSize.t.sol's rationale). Every new substrate contract must stay under the
/// 24,300-byte safety margin (hard limit 24,576) so it deploys cleanly on 943/369.
/// Companion check: an MCOPY(0x5e)/shanghai opcode scan was run manually against each contract's
/// `forge-out/<C>.sol/<C>.json` .deployedBytecode.object via `cast disassemble | grep -iw MCOPY` —
/// zero genuine MCOPY mnemonics found (foundry.toml pins evm_version = shanghai, which is
/// authoritative: solc simply never emits MCOPY/TSTORE for a shanghai target). See
/// task-11-report.md for the full scan output.
contract OperatorSubstrateSizeTest is Test {
    uint256 internal constant SIZE_CEILING = 24_300;

    function test_deployedSizesUnderCeiling() public {
        assertLt(
            address(new OperatorRegistry()).code.length,
            SIZE_CEILING,
            "OperatorRegistry deployed bytecode exceeds the 24,300-byte safety margin"
        );

        OperatorRegistry reg = new OperatorRegistry();

        assertLt(
            address(new GameEscrow(address(reg))).code.length,
            SIZE_CEILING,
            "GameEscrow deployed bytecode exceeds the 24,300-byte safety margin"
        );

        assertLt(
            address(new OperatorBond(address(reg))).code.length,
            SIZE_CEILING,
            "OperatorBond deployed bytecode exceeds the 24,300-byte safety margin"
        );

        assertLt(
            address(new OperatorVault()).code.length,
            SIZE_CEILING,
            "OperatorVault deployed bytecode exceeds the 24,300-byte safety margin"
        );

        assertLt(
            address(new OperatorCoinFlip(address(1), address(2), address(reg))).code.length,
            SIZE_CEILING,
            "OperatorCoinFlip deployed bytecode exceeds the 24,300-byte safety margin"
        );
    }
}
