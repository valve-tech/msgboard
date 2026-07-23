// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// A side-pot: `amount` wei earmarked for the seats whose bit is set in `eligibleMask`
/// (bit i set => seat i eligible). Mirrors SidePot in the holdem stateSigN.ts.
struct SidePot {
    uint256 amount;
    uint256 eligibleMask;
}

/// The N-party channel state. Generalizes the 2-party ChannelState to N seats:
/// `balances` is a per-seat vector, `sidePots` carries layered all-in pots, and
/// `rakeAccrued` is taken at settle. Conservation everywhere a state is accepted:
///   Σ balances + pot + Σ sidePots.amount + rakeAccrued == Σ escrow.
/// Mirrors the holdem stateSigN.ts CHANNEL_STATE_N_TYPES exactly.
struct ChannelStateN {
    bytes32 tableId;
    uint64 nonce;
    uint256[] balances;
    uint256 pot;
    SidePot[] sidePots;
    uint256 rakeAccrued;
    bytes32 deckCommitment;
    uint8 phase;
    bytes32 gameStateHash;
}

/// EIP-712 struct hashing for ChannelStateN. The dynamic arrays are the parity-bug-prone
/// part and are hashed per EIP-712:
///   - `uint256[] balances` => keccak256(abi.encodePacked(each 32-byte word))
///   - `SidePot[] sidePots` => keccak256(concatenation of each element's struct hash)
/// The referenced SidePot type is appended to the primary type string (EIP-712 orders
/// referenced types alphabetically; SidePot is the only one). viem's hashTypedData in
/// stateSigN.ts produces the identical digest — guarded by the ZkChannelNSig parity test.
library ChannelStateNLib {
    bytes32 internal constant SIDEPOT_TYPEHASH = keccak256(
        "SidePot(uint256 amount,uint256 eligibleMask)"
    );

    bytes32 internal constant TYPEHASH = keccak256(
        "ChannelStateN(bytes32 tableId,uint64 nonce,uint256[] balances,uint256 pot,SidePot[] sidePots,uint256 rakeAccrued,bytes32 deckCommitment,uint8 phase,bytes32 gameStateHash)SidePot(uint256 amount,uint256 eligibleMask)"
    );

    function _hashBalances(uint256[] memory balances) private pure returns (bytes32) {
        return keccak256(abi.encodePacked(balances));
    }

    function _hashSidePots(SidePot[] memory sidePots) private pure returns (bytes32) {
        bytes memory acc = new bytes(0);
        for (uint256 i = 0; i < sidePots.length; i++) {
            bytes32 h = keccak256(abi.encode(SIDEPOT_TYPEHASH, sidePots[i].amount, sidePots[i].eligibleMask));
            acc = bytes.concat(acc, h);
        }
        return keccak256(acc);
    }

    function structHash(ChannelStateN calldata s) internal pure returns (bytes32) {
        return keccak256(abi.encode(
            TYPEHASH,
            s.tableId,
            s.nonce,
            _hashBalances(s.balances),
            s.pot,
            _hashSidePots(s.sidePots),
            s.rakeAccrued,
            s.deckCommitment,
            s.phase,
            s.gameStateHash
        ));
    }

    /// Identical body for a `memory` state — lets Solidity callers (tests, other
    /// contracts holding a memory struct) hash without a calldata source.
    function structHashMem(ChannelStateN memory s) internal pure returns (bytes32) {
        return keccak256(abi.encode(
            TYPEHASH,
            s.tableId,
            s.nonce,
            _hashBalances(s.balances),
            s.pot,
            _hashSidePots(s.sidePots),
            s.rakeAccrued,
            s.deckCommitment,
            s.phase,
            s.gameStateHash
        ));
    }

    /// Σ balances + pot + Σ sidePots.amount + rakeAccrued (the conservation target).
    function totalLocked(ChannelStateN memory s) internal pure returns (uint256 sum) {
        sum = s.pot + s.rakeAccrued;
        for (uint256 i = 0; i < s.balances.length; i++) sum += s.balances[i];
        for (uint256 i = 0; i < s.sidePots.length; i++) sum += s.sidePots[i].amount;
    }

    /// Calldata variant of totalLocked (hot path in HoldemTableN._checkCoSigned).
    function totalLockedCalldata(ChannelStateN calldata s) internal pure returns (uint256 sum) {
        sum = s.pot + s.rakeAccrued;
        for (uint256 i = 0; i < s.balances.length; i++) sum += s.balances[i];
        for (uint256 i = 0; i < s.sidePots.length; i++) sum += s.sidePots[i].amount;
    }
}
