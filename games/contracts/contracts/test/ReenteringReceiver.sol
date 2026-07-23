// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

interface IZkTableReenter {
    function create(address rules, uint256 joinStake, uint64 clockBlocks, address channelKey, uint256[2] calldata deckKey)
        external
        payable
        returns (bytes32 tableId);
    function join(bytes32 tableId, address channelKey, uint256[2] calldata deckKey) external payable;
    function resolveTimeout(bytes32 tableId) external;
}

/// @notice Test-only ZkTable player that re-enters on payout. It registers itself as the table's
/// wallet seat (so the forced payout lands here, firing `receive()`) while delegating channel
/// signing to a supplied EOA `channelKey`. When `attack` is armed, the first incoming ETH re-enters
/// `ZkTable.resolveTimeout` on the same table — which must hit `BadStatus` (the table is already
/// Settled before the transfers). forceSafeTransferETH's 100k gas stipend lets the reentrant call
/// run, so this pins CEI/no-double-payout: the inner call reverts internally and is swallowed by the
/// force-send, the outer tx still settles, and this contract is paid exactly once.
contract ReenteringReceiver {
    IZkTableReenter public immutable zk;
    bytes32 public table;
    bool public attack;
    uint256 public received;
    uint256 public reentryCalls;
    bool public lastReentryReverted;

    constructor(address zkTable) {
        zk = IZkTableReenter(zkTable);
    }

    function createTable(address rules, uint256 joinStake, uint64 clockBlocks, address channelKey, uint256[2] calldata deckKey)
        external
        payable
        returns (bytes32 tableId)
    {
        tableId = zk.create{value: msg.value}(rules, joinStake, clockBlocks, channelKey, deckKey);
        table = tableId;
    }

    function joinTable(bytes32 tableId, address channelKey, uint256[2] calldata deckKey) external payable {
        zk.join{value: msg.value}(tableId, channelKey, deckKey);
        table = tableId;
    }

    function arm(bool on) external {
        attack = on;
    }

    receive() external payable {
        received += msg.value;
        if (!attack) return;
        attack = false; // single-shot: do not recurse forever within the stipend
        reentryCalls += 1;
        try zk.resolveTimeout(table) {
            lastReentryReverted = false;
        } catch {
            lastReentryReverted = true; // expected: BadStatus, table already Settled
        }
    }
}
