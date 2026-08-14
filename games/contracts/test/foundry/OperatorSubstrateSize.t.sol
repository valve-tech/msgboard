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
import {MintSale} from "../../contracts/games/operator/MintSale.sol";
import {Marketplace} from "../../contracts/games/operator/Marketplace.sol";

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
///
/// System 2 slice S2b (openBoosted game integration, 2026-08-14): OperatorCoinFlip gained the boosted
/// paired-bet flow (openBoosted + boosted branches in _settle/_routeForfeit/refundStale, setBonusInfra/
/// setBonusSeries, claimParkedCharge, the 1155 receiver, 3 appended Round fields). Re-scanned the same
/// way: zero MCOPY(0x5e) and TSTORE(0x5d); stripped runtime 16,604 bytes (full deployed 16,657) — up
/// from Slice 0's 11,482 but still ~7.9KB under the 24,576 hard limit and under this file's margin. No
/// series-resolution helper extraction was needed.
///
/// S2b security-review hardening (M1/L4/L1, 2026-08-14): BonusChips1155.createSeries gained the O6
/// zero-value-transfer-revert probe (M1); OperatorCoinFlip.setBonusInfra gained the pool/chips
/// consistency cross-check (L4) plus a CEI-reliance doc comment on _settle (L1, no bytecode). Re-scanned
/// the same way: zero MCOPY(0x5e) and TSTORE(0x5d) in both. BonusChips1155 stripped runtime rose from
/// 5,024 to 5,339 bytes; OperatorCoinFlip stripped runtime rose from 16,604 to 16,842 bytes (full
/// deployed 16,895). Both moves are small and both contracts stay far under the 24,576 hard limit and
/// this file's 24,300 safety margin.
///
/// System 2 slice S2c (price-side vesting, 2026-08-14): BonusChips1155 gained the `priceLedger` burn
/// hook + `burnWithBeneficiary` + setter; OperatorCoinFlip's one chop-burn site moved to
/// `burnWithBeneficiary`; MintSale is new. Re-scanned the same way (CBOR-stripped, opcode-aligned,
/// PUSH-immediate-aware) over .deployedBytecode.object: zero MCOPY(0x5e) and TSTORE(0x5d) in all.
/// Stripped runtimes: BonusChips1155 5,913 bytes (up from 5,339), OperatorCoinFlip 16,829 bytes (down
/// from 16,842 — the one-line burn change), MintSale 5,058 bytes; BackingPool stays byte-identical at
/// 6,243 (its logic is untouched). All far under the 24,576 hard limit and this file's safety margin.
///
/// System 2 slice S2c-3 (charge resale marketplace, 2026-08-14): Marketplace is new (approval-fill, no
/// custody). Re-scanned the same way (CBOR-stripped, opcode-aligned, PUSH-immediate-aware) over
/// .deployedBytecode.object: zero MCOPY(0x5e) and TSTORE(0x5d). Its constructor stores only the chips
/// reference + owner, so a fresh chips address is enough for the size check. Stripped runtime 3,486 bytes
/// (full deployed 3,539) — far under the 24,576 hard limit and this file's 24,300 safety margin.
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

        // System 2 slice S2c: MintSale (the purchase-price vesting escrow + primary sale). It must also
        // deploy on 943; the constructor only stores the chips reference and owner, so a fresh chips
        // address is enough for the size check.
        assertLt(
            address(new MintSale(address(chips))).code.length,
            SIZE_CEILING,
            "MintSale deployed bytecode exceeds the 24,300-byte safety margin"
        );

        // System 2 slice S2c-3: Marketplace (approval-fill charge resale, no custody). Must also deploy
        // on 943; the constructor stores only the chips reference + owner, so a fresh chips address is
        // enough for the size check.
        assertLt(
            address(new Marketplace(address(chips))).code.length,
            SIZE_CEILING,
            "Marketplace deployed bytecode exceeds the 24,300-byte safety margin"
        );
    }
}
