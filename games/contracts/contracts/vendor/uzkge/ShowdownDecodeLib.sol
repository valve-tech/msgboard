// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {EdOnBN254} from "./libraries/EdOnBN254.sol";
import {CardTable52} from "./CardTable52.sol";

/// @notice Decrypts and decodes a showdown's two cards from a masked deck + accumulated
/// decryption shares. Deliberately EXTERNAL (not internal): CardTable52.decode is an internal
/// library function (Solidity inlines internal library calls at every call site), and its
/// 52-branch body inlined into ZkTable.sol tipped that contract's viaIR/optimizer-runs:1000
/// build over solc's Yul "stack too deep" in an unrelated function (the auto-generated `tables`
/// getter) — a whole-contract codegen budget issue, not a defect in the arithmetic. Marking this
/// `external` compiles it as its own separately-deployed library (delegatecall-linked, the way
/// Foundry/Hardhat auto-link any external Solidity library), keeping the EdOnBN254 arithmetic and
/// CardTable52's decode table out of ZkTable's own bytecode entirely.
library ShowdownDecodeLib {
    /// reveals is flattened as [slotA seatA (x,y), slotA seatB (x,y), slotB seatA (x,y), slotB
    /// seatB (x,y)] — 8 words — matching ZkTable.ShowdownDispute's reveal[slotIdx][seatIdx]
    /// layout read out slot-major, seat-minor.
    ///
    /// Non-reverting (okA/okB flags): a snark-verified reveal only proves `reveal = sk*e1 AND
    /// pk = sk*G` for the CALLER's registered key — it does NOT prove that key is the one the
    /// deck was actually masked under (see ZkTable.sol's off-chain-obligation note). A seat that
    /// registered a decoy key can therefore make a slot decrypt to a point outside the fixed
    /// 52-card table. finalizeShowdown must be able to see that and fall back to splitting the
    /// pot instead of reverting the whole settlement (which would strand both seats' funds).
    function decodeBothCards(uint256[] memory deck, uint32 slotA, uint32 slotB, uint256[8] memory reveals)
        external
        view
        returns (bool okA, uint8 cardA, bool okB, uint8 cardB)
    {
        (okA, cardA) = _decodeOne(deck, slotA, reveals[0], reveals[1], reveals[2], reveals[3]);
        (okB, cardB) = _decodeOne(deck, slotB, reveals[4], reveals[5], reveals[6], reveals[7]);
    }

    function _decodeOne(uint256[] memory deck, uint32 slot, uint256 ax, uint256 ay, uint256 bx, uint256 by)
        private
        view
        returns (bool, uint8)
    {
        EdOnBN254.Point memory e2 = EdOnBN254.Point(deck[4 * slot + 2], deck[4 * slot + 3]);
        EdOnBN254.Point memory sum = EdOnBN254.add(EdOnBN254.Point(ax, ay), EdOnBN254.Point(bx, by));
        EdOnBN254.Point memory m = EdOnBN254.add(e2, EdOnBN254.neg(sum));
        return CardTable52.decode(m.x, m.y);
    }
}
