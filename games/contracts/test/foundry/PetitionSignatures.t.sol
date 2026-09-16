// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.25;

import {Test} from "forge-std/Test.sol";
import {PetitionSignatures} from "../../contracts/PetitionSignatures.sol";

/// Minimal forge smoke test. The exhaustive behavioral suite (including the cross-consistency
/// check against the petition package's off-chain digest) lives in
/// test/PetitionSignatures.test.ts — this file exists mainly so `forge build` compiles
/// PetitionSignatures.sol into forge-out/, which scripts/deploy-petition.ts reads its bytecode
/// from (mirrors StealthMessenger.t.sol's role for deploy-stealth.ts).
contract PetitionSignaturesTest is Test {
    PetitionSignatures internal p;

    uint256 internal pkSigner = 0xA11CE;
    address internal signer;

    bytes32 internal constant TYPEHASH = keccak256("Petition(bytes32 petitionId,string statement)");
    bytes32 internal constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    function setUp() public {
        p = new PetitionSignatures();
        signer = vm.addr(pkSigner);
    }

    function _domainSeparator() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes("MsgBoard Petition")),
                keccak256(bytes("1")),
                block.chainid,
                address(p)
            )
        );
    }

    function _digest(bytes32 petitionId, string memory statement) internal view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(TYPEHASH, petitionId, keccak256(bytes(statement))));
        return keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function test_submitRecordsAndEmits() public {
        bytes32 petitionId = keccak256("petition-1");
        string memory statement = "we petition for X";
        bytes memory sig = _sign(pkSigner, _digest(petitionId, statement));

        vm.expectEmit(true, true, true, true, address(p));
        emit Signed(petitionId, signer);
        p.submit(petitionId, statement, signer, sig);

        assertTrue(p.signed(petitionId, signer));
        assertEq(p.count(petitionId), 1);
    }

    function test_submitRejectsWrongSigner() public {
        bytes32 petitionId = keccak256("petition-1");
        string memory statement = "we petition for X";
        bytes memory sig = _sign(pkSigner, _digest(petitionId, statement));
        address notSigner = vm.addr(0xB0B);

        vm.expectRevert(bytes("bad sig"));
        p.submit(petitionId, statement, notSigner, sig);
    }

    // Declared to match PetitionSignatures.Signed exactly (name + types) so its topic0 lines up
    // for vm.expectEmit's comparison.
    event Signed(bytes32 indexed petitionId, address indexed signer);
}
