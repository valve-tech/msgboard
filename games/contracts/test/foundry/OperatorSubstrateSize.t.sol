// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {OperatorRegistry} from "../../contracts/games/operator/OperatorRegistry.sol";
import {GameEscrow} from "../../contracts/games/operator/GameEscrow.sol";
import {OperatorBond} from "../../contracts/games/operator/OperatorBond.sol";
import {OperatorVault} from "../../contracts/games/operator/OperatorVault.sol";
import {OperatorVaultFactory} from "../../contracts/games/operator/OperatorVaultFactory.sol";
import {OperatorCoinFlip} from "../../contracts/games/operator/OperatorCoinFlip.sol";
import {BurnFeePolicy} from "../../contracts/games/operator/BurnFeePolicy.sol";
import {BonusChips1155} from "../../contracts/games/operator/BonusChips1155.sol";
import {BackingPool} from "../../contracts/games/operator/BackingPool.sol";

/// @notice EIP-170 deployability guard for the table-maintainer substrate (mirrors
/// HoldemTableNSize.t.sol's rationale). Every new substrate contract must stay under the
/// 24,300-byte safety margin (hard limit 24,576) so it deploys cleanly on 943/369.
/// Companion check: an MCOPY(0x5e)/shanghai opcode scan was run manually against each contract's
/// `forge-out/<C>.sol/<C>.json` .deployedBytecode.object via `cast disassemble | grep -iw MCOPY` —
/// zero genuine MCOPY mnemonics found (foundry.toml pins evm_version = shanghai, which is
/// authoritative: solc simply never emits MCOPY/TSTORE for a shanghai target). See
/// task-11-report.md for the full scan output.
///
/// Slice 0 (fee-policy forfeit re-route, 2026-08-13): BurnFeePolicy + the extended OperatorCoinFlip
/// were re-scanned with a CBOR-metadata-stripped, opcode-aligned walker (PUSH-immediate-aware) over
/// .deployedBytecode.object, cross-checked against `cast disassemble`. Both zero MCOPY(0x5e) and
/// TSTORE(0x5d): BurnFeePolicy stripped runtime 411 bytes, OperatorCoinFlip stripped runtime 11,482
/// bytes — both well under the 24,576 EIP-170 hard limit and this file's 24,300 safety margin.
///
/// System 2 slice S2a (bonus economy, 2026-08-14): BonusChips1155 + BackingPool re-scanned the same
/// way (CBOR-stripped, opcode-aligned, cross-checked against `cast disassemble`). Both zero
/// MCOPY(0x5e) and TSTORE(0x5d). After the S2a fund-safety hardening (circ counter + pool-enforced
/// P2, atomic mint-and-fund, game kill-switch, createSeries validation) the stripped runtimes are
/// BonusChips1155 5,024 bytes and BackingPool 6,243 bytes — both far under the EIP-170 hard limit and
/// this file's safety margin.
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

        OperatorVault vaultImpl = new OperatorVault();

        assertLt(
            address(vaultImpl).code.length,
            SIZE_CEILING,
            "OperatorVault deployed bytecode exceeds the 24,300-byte safety margin"
        );

        GameEscrow escForFactory = new GameEscrow(address(reg));
        assertLt(
            address(new OperatorVaultFactory(address(vaultImpl), address(escForFactory))).code.length,
            SIZE_CEILING,
            "OperatorVaultFactory deployed bytecode exceeds the 24,300-byte safety margin"
        );

        BurnFeePolicy burn = new BurnFeePolicy();
        assertLt(
            address(burn).code.length,
            SIZE_CEILING,
            "BurnFeePolicy deployed bytecode exceeds the 24,300-byte safety margin"
        );

        address[] memory menu = new address[](1);
        menu[0] = address(burn);
        assertLt(
            address(new OperatorCoinFlip(address(1), address(2), address(reg), menu, address(burn))).code.length,
            SIZE_CEILING,
            "OperatorCoinFlip deployed bytecode exceeds the 24,300-byte safety margin"
        );

        // System 2 slice S2a: BonusChips1155 + BackingPool (the collateralization). Both must deploy
        // on 943, so both stay under the safety margin. BackingPool's constructor self-authorizes its
        // game against a fresh escrow (permissionless), so a fresh escrow + chips are wired here.
        BonusChips1155 chips = new BonusChips1155();
        assertLt(
            address(chips).code.length,
            SIZE_CEILING,
            "BonusChips1155 deployed bytecode exceeds the 24,300-byte safety margin"
        );

        GameEscrow escForPool = new GameEscrow(address(reg));
        assertLt(
            address(new BackingPool(address(escForPool), address(chips), address(0x6a3e))).code.length,
            SIZE_CEILING,
            "BackingPool deployed bytecode exceeds the 24,300-byte safety margin"
        );
    }
}
