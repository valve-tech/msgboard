// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {SessionState} from "../../contracts/games/SessionState.sol";
import {SessionStateHarness} from "../../contracts/test/SessionStateHarness.sol";

contract SessionStateDigestTest is Test {
    SessionStateHarness internal h;

    function setUp() public {
        h = new SessionStateHarness();
    }

    function _base() internal pure returns (SessionState memory s) {
        s.tableId = keccak256("table");
        s.nonce = 7;
        s.balancePlayer = 1500;
        s.balanceHouse = 500;
        s.settlementMode = 1;
        s.gameId = 2;
        s.gameStateHash = keccak256("gs");
        s.rngCommit = keccak256("commit");
    }

    function test_digestDeterministic() public view {
        assertEq(h.stateDigest(_base()), h.stateDigest(_base()));
    }

    function test_digestSensitiveToEveryField() public view {
        bytes32 d = h.stateDigest(_base());
        SessionState memory s = _base(); s.nonce = 8; assertTrue(h.stateDigest(s) != d);
        s = _base(); s.balancePlayer = 1499; assertTrue(h.stateDigest(s) != d);
        s = _base(); s.balanceHouse = 501; assertTrue(h.stateDigest(s) != d);
        s = _base(); s.settlementMode = 0; assertTrue(h.stateDigest(s) != d);
        s = _base(); s.gameId = 1; assertTrue(h.stateDigest(s) != d);
        s = _base(); s.gameStateHash = keccak256("gs2"); assertTrue(h.stateDigest(s) != d);
        s = _base(); s.rngCommit = keccak256("commit2"); assertTrue(h.stateDigest(s) != d);
    }
}
