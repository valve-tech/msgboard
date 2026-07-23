// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {RevealShareDLEQ} from "../../contracts/zk/lib/RevealShareDLEQ.sol";
import {EllipticCurve} from "../../contracts/zk/lib/EllipticCurve.sol";

/// @notice Cross-implementation parity: every vector below is REAL output of the off-chain
/// secp256k1 prover `examples/games/zk-core/src/chaumPedersen.ts#proveShare` (captured via
/// the actual noble-curves secp256k1 deck). If the Solidity challenge/encoding or EC math
/// diverged from noble by a single byte, `verify` would return false. Tampering any field
/// must flip it to false — proving the verifier does real work, not an always-pass stub.
contract RevealShareDLEQTest is Test {
    using RevealShareDLEQ for RevealShareDLEQ.Statement;

    // ctxFor(0x..07, 4) — bytes32 tableId 7, slot 4.
    string internal constant CTX =
        "holdem/0x0000000000000000000000000000000000000000000000000000000000000007/slot/4";
    uint256 internal constant EXPECTED_E =
        102763457842587184510687430920205911058681876548192989769407895800544388982351;

    function _stmt() internal pure returns (RevealShareDLEQ.Statement memory s) {
        s.pkX = 11816351370051889568291333980578399386633011001929435158361884750753635944795;
        s.pkY = 73067863692975740465303682593197205904794252989938391954822116746175723595557;
        s.c1X = 64450997214760397039353401817971864887324479206305291097232127869868234826219;
        s.c1Y = 103164768097236449815475333443975048990300300327075029095867222537239333609676;
        s.c2X = 9931371996941445071291464008686091741646208574723254140383938845884547004443;
        s.c2Y = 112828313323730628695758036080886827410508374209781961613877246032633127119218;
        s.dX = 87218831212927408931573689031677051166776269088391797734433178912494251674884;
        s.dY = 83672772416884377719824971704315091540741550556042492157436563500335479840946;
        s.t1X = 2533321142643084229412121026323334730236117433817929513547560000045742885070;
        s.t1Y = 53533864825523290430175183373453744760978018723701412019510099865915202350755;
        s.t2X = 111326099100837279485478281258376712221230764488398194474841924308896675162059;
        s.t2Y = 18709458305676657529781209886463873926239935899816358039645851556515464932063;
        s.z = 55403980451610318833914469678893020298886980142234270300836812815717243844829;
    }

    /// secp256k1 sanity: 2·G via the on-chain doubler matches the published point.
    function test_ecMul_2G() public pure {
        (uint256 x, uint256 y) = EllipticCurve.ecMul(2, EllipticCurve.GX, EllipticCurve.GY);
        assertEq(x, 0xc6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5, "2G.x");
        assertEq(y, 0x1ae168fea63dc339a3c58419466ceaeef7f632653266d0e1236431a950cfe52a, "2G.y");
    }

    /// On-curve points add/round-trip: G + G == 2·G via ecAdd.
    function test_ecAdd_equalsDouble() public pure {
        (uint256 ax, uint256 ay) =
            EllipticCurve.ecAdd(EllipticCurve.GX, EllipticCurve.GY, EllipticCurve.GX, EllipticCurve.GY);
        (uint256 mx, uint256 my) = EllipticCurve.ecMul(2, EllipticCurve.GX, EllipticCurve.GY);
        assertEq(ax, mx, "add.x == 2G.x");
        assertEq(ay, my, "add.y == 2G.y");
    }

    /// The on-chain Fiat–Shamir challenge equals noble's, to the bit.
    function test_challengeParity() public pure {
        RevealShareDLEQ.Statement memory s = _stmt();
        assertEq(s.challenge(CTX), EXPECTED_E, "challenge matches off-chain noble e");
    }

    /// A real, honest share proof verifies on-chain.
    function test_verifyHonest() public pure {
        assertTrue(_stmt().verify(CTX), "honest DLEQ verifies");
    }

    /// Wrong ctx (slot swap) breaks the challenge => fails (no cross-slot replay).
    function test_rejectsCtxSwap() public pure {
        RevealShareDLEQ.Statement memory s = _stmt();
        assertFalse(
            s.verify("holdem/0x0000000000000000000000000000000000000000000000000000000000000007/slot/5"),
            "slot-swapped ctx rejected"
        );
    }

    /// Tampered response scalar z => fails.
    function test_rejectsForgedZ() public pure {
        RevealShareDLEQ.Statement memory s = _stmt();
        s.z ^= 1;
        assertFalse(s.verify(CTX), "forged z rejected");
    }

    /// Tampered share point d (wrong decryption) => fails.
    function test_rejectsForgedShare() public pure {
        RevealShareDLEQ.Statement memory s = _stmt();
        // swap d for another valid on-curve point (2·G) — still on-curve, but wrong DLEQ.
        (s.dX, s.dY) = EllipticCurve.ecMul(2, EllipticCurve.GX, EllipticCurve.GY);
        assertFalse(s.verify(CTX), "wrong share point rejected");
    }

    /// Off-curve point => fails (invalid-curve guard).
    function test_rejectsOffCurve() public pure {
        RevealShareDLEQ.Statement memory s = _stmt();
        s.pkY ^= 1; // no longer satisfies y^2 = x^3 + 7
        assertFalse(s.verify(CTX), "off-curve pk rejected");
    }
}
