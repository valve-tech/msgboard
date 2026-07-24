// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {EIP712} from "solady/src/utils/EIP712.sol";

/// Mirrors the gibs/msgboard-games sessionState.ts SESSION_STATE_TYPES exactly.
/// Field order is consensus — the off-chain EIP-712 typing and every TYPEHASH must match.
struct SessionState {
    bytes32 tableId;
    uint64 nonce;
    uint256 balancePlayer;
    uint256 balanceHouse;
    uint8 settlementMode; // 0 optimistic, 1 escrowed, 2 zk
    uint8 gameId;         // 1 dice, 2 limbo
    bytes32 gameStateHash;
    bytes32 rngCommit;
}

library SessionStateLib {
    bytes32 internal constant TYPEHASH = keccak256(
        "SessionState(bytes32 tableId,uint64 nonce,uint256 balancePlayer,uint256 balanceHouse,uint8 settlementMode,uint8 gameId,bytes32 gameStateHash,bytes32 rngCommit)"
    );

    function structHash(SessionState calldata s) internal pure returns (bytes32) {
        return keccak256(abi.encode(
            TYPEHASH, s.tableId, s.nonce, s.balancePlayer, s.balanceHouse,
            s.settlementMode, s.gameId, s.gameStateHash, s.rngCommit
        ));
    }

    function structHashMem(SessionState memory s) internal pure returns (bytes32) {
        return keccak256(abi.encode(
            TYPEHASH, s.tableId, s.nonce, s.balancePlayer, s.balanceHouse,
            s.settlementMode, s.gameId, s.gameStateHash, s.rngCommit
        ));
    }
}

/// A mutual-CLOSE authorization. Both parties sign this — and ONLY this — when they agree to finalize
/// a table NOW at these balances. It is a DISTINCT EIP-712 type from the running SessionState, so a
/// co-signature collected mid-play (a running checkpoint) can never be replayed on the cooperative
/// `settle()` path: the house only ever signs a SessionClose for the state it agrees is the true
/// latest, which closes both the nonce-0 open-refund free-roll and the earlier-nonce peak-lock.
/// Mirrors the off-chain SESSION_CLOSE_TYPES; field order is consensus.
struct SessionClose {
    bytes32 tableId;
    uint64 nonce;
    uint256 balancePlayer;
    uint256 balanceHouse;
    uint8 gameId;
}

library SessionCloseLib {
    bytes32 internal constant TYPEHASH = keccak256(
        "SessionClose(bytes32 tableId,uint64 nonce,uint256 balancePlayer,uint256 balanceHouse,uint8 gameId)"
    );

    function structHash(SessionClose calldata c) internal pure returns (bytes32) {
        return keccak256(abi.encode(
            TYPEHASH, c.tableId, c.nonce, c.balancePlayer, c.balanceHouse, c.gameId
        ));
    }

    function structHashMem(SessionClose memory c) internal pure returns (bytes32) {
        return keccak256(abi.encode(
            TYPEHASH, c.tableId, c.nonce, c.balancePlayer, c.balanceHouse, c.gameId
        ));
    }
}

/// EIP-712 domain shared by both settlement backends. Matches makeDomain() in the
/// gibs/msgboard-games package: { name: 'MsgBoardGames', version: '1' }. Solady EIP712
/// (not OZ: OZ 5.6's Strings->Bytes uses MCOPY, rejected by solc targeting shanghai for 943).
abstract contract SessionStateEIP712 is EIP712 {
    using SessionStateLib for SessionState;
    using SessionCloseLib for SessionClose;

    function _domainNameAndVersion() internal pure override returns (string memory, string memory) {
        return ("MsgBoardGames", "1");
    }

    /// Public so off-chain code can parity-test the EIP-712 digest. `memory` arg so Solidity
    /// callers holding a memory struct can hash directly; external ABI signature unchanged.
    function stateDigest(SessionState memory state) public view returns (bytes32) {
        return _hashTypedData(state.structHashMem());
    }

    /// The mutual-close digest (parity + house signing). Same domain as stateDigest, distinct type.
    function closeDigest(SessionClose memory c) public view returns (bytes32) {
        return _hashTypedData(c.structHashMem());
    }
}
