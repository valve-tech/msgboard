// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// Mirrors @gibs/zk-cards-core stateSig.ts CHANNEL_STATE_TYPES exactly.
struct ChannelState {
    bytes32 tableId;
    uint64 nonce;
    uint256 balanceA;
    uint256 balanceB;
    uint256 pot;
    bytes32 deckCommitment;
    uint8 phase;
    bytes32 gameStateHash;
    bytes32 jointKeyCommit; // keccak256(abi.encode(aggX, aggY, pkc[24])) — see B1/B2 spec
    bytes32 shuffleRoot;    // keccak256 of the ordered shuffle transcript — see B2 spec
}

library ChannelStateLib {
    bytes32 internal constant TYPEHASH = keccak256(
        "ChannelState(bytes32 tableId,uint64 nonce,uint256 balanceA,uint256 balanceB,uint256 pot,bytes32 deckCommitment,uint8 phase,bytes32 gameStateHash,bytes32 jointKeyCommit,bytes32 shuffleRoot)"
    );

    function structHash(ChannelState calldata s) internal pure returns (bytes32) {
        return keccak256(abi.encode(
            TYPEHASH, s.tableId, s.nonce, s.balanceA, s.balanceB, s.pot,
            s.deckCommitment, s.phase, s.gameStateHash, s.jointKeyCommit, s.shuffleRoot
        ));
    }

    /// Identical body for a `memory` state — lets Solidity callers (tests, other
    /// contracts holding a memory struct) hash without a calldata source.
    function structHashMem(ChannelState memory s) internal pure returns (bytes32) {
        return keccak256(abi.encode(
            TYPEHASH, s.tableId, s.nonce, s.balanceA, s.balanceB, s.pot,
            s.deckCommitment, s.phase, s.gameStateHash, s.jointKeyCommit, s.shuffleRoot
        ));
    }
}
