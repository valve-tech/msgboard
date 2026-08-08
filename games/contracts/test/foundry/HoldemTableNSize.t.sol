// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {HoldemTableN} from "../../contracts/zk/HoldemTableN.sol";

/// @notice EIP-170 REGRESSION GUARD for HoldemTableN (mirrors ZkTableSize.test.ts's rationale —
/// see that file's header for the full "why a dedicated size guard, not just a deploy attempt"
/// case). The C1 (disputeSetup) + C2 (DEMAND_SHOWDOWN) fund-safety hardening pass added enough
/// dispute-machine surface that HoldemTableN needed the SAME EIP-170 mitigation ZkTable already
/// carries: heavy/cold-path logic (the secp256k1 point arithmetic, the 52-card decode table, the
/// per-share DLEQ verify+store, the whole-showdown decode, the try/catch settle dispatch, the
/// tiered pot split) all live in the EXTERNAL `HoldemShowdownLib` (see that file's header),
/// deployed+linked separately — `new HoldemTableN(...)` here exercises the REAL linked deploy
/// (forge auto-links external libraries transparently), so `address(zk).code` is the exact
/// runtime bytecode that would land on mainnet.
///
/// Run: cd games/contracts && forge test --match-path 'test/foundry/HoldemTableNSize.t.sol'
contract HoldemTableNSizeTest is Test {
    uint256 internal constant EIP170_LIMIT = 24_576;

    function test_deployedBytecodeStaysUnderEip170Limit() public {
        HoldemTableN zk = new HoldemTableN(address(0), address(0));
        uint256 deployedBytes = address(zk).code.length;

        assertLt(
            deployedBytes,
            EIP170_LIMIT,
            "HoldemTableN deployed bytecode exceeds EIP-170's 24,576-byte hard limit - undeployable on mainnet. "
            "Extract more cold-path dispute-machine logic into HoldemShowdownLib (see that file's header) before this can ship."
        );
    }
}
