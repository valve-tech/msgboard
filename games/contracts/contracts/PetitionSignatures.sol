// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @notice On-chain co-signature ledger for MsgBoard petitions. A petition itself (its statement,
/// category, author) lives off-chain (the board and the petition package's descriptor codec);
/// this contract is ONLY the trustless proof that a given address cryptographically co-signed a
/// given statement. Anyone holding a valid EIP-712 signature over (petitionId, statement) can
/// relay it here — the relayer need not be the signer (permissionless submission), and the same
/// signature validates identically on the board (off-chain tally) and here (on-chain tally)
/// because both sides derive the digest from the exact same domain and type:
/// EIP712("MsgBoard Petition","1"), `Petition(bytes32 petitionId,string statement)`. See the
/// petition package's digest module (packages/petition/src/digest.ts) — the domain, type, and
/// message shape there are LAW; this contract must byte-for-byte match them.
///
/// Ownerless, fund-less, no constructor args beyond the EIP-712 domain: any funded EOA can deploy
/// it, and it never escrows or moves value.
contract PetitionSignatures is EIP712 {
    /// keccak256("Petition(bytes32 petitionId,string statement)") — order is law, mirrors
    /// PETITION_TYPES in packages/petition/src/digest.ts.
    bytes32 private constant _TYPEHASH = keccak256("Petition(bytes32 petitionId,string statement)");

    /// petitionId => signer => whether that signer's co-signature has been recorded.
    mapping(bytes32 => mapping(address => bool)) public signed;

    /// petitionId => count of distinct signers recorded so far.
    mapping(bytes32 => uint256) public count;

    event Signed(bytes32 indexed petitionId, address indexed signer);

    constructor() EIP712("MsgBoard Petition", "1") {}

    /// @notice Submit one co-signature. Recomputes the EIP-712 digest for (petitionId, statement)
    /// and requires it to recover to `signer`. Permissionless: msg.sender need not be `signer` —
    /// anyone may relay a signature they collected off-chain. Idempotent: if `signer` already has
    /// a recorded co-signature for `petitionId`, this is a silent no-op (no revert, no re-emit,
    /// no double count) rather than an error, so relayers can freely retry/overlap submissions.
    function submit(bytes32 petitionId, string calldata statement, address signer, bytes calldata signature)
        public
    {
        bytes32 structHash = keccak256(abi.encode(_TYPEHASH, petitionId, keccak256(bytes(statement))));
        bytes32 digest = _hashTypedDataV4(structHash);
        require(ECDSA.recover(digest, signature) == signer, "bad sig");

        if (!signed[petitionId][signer]) {
            signed[petitionId][signer] = true;
            count[petitionId]++;
            emit Signed(petitionId, signer);
        }
    }

    /// @notice Submit a batch of co-signatures for the same petition in one transaction. Every
    /// entry is independently signature-checked, so ANY invalid (signer, signature) pair reverts
    /// the whole batch (a relayer cannot force through good signatures by burying one bad one, but
    /// also can't be griefed by mixing in a bad one silently). Already-recorded signers within the
    /// batch are skipped (not re-counted, no duplicate event) exactly like `submit`.
    function submitBatch(
        bytes32 petitionId,
        string calldata statement,
        address[] calldata signers,
        bytes[] calldata signatures
    ) external {
        require(signers.length == signatures.length, "length mismatch");
        for (uint256 i = 0; i < signers.length; i++) {
            submit(petitionId, statement, signers[i], signatures[i]);
        }
    }
}
