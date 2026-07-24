// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {ECDSA} from "solady/src/utils/ECDSA.sol";
import {EIP712} from "solady/src/utils/EIP712.sol";

/// ────────────────────────────────────────────────────────────────────────────────────────────
/// StealthMessenger — "send a private message to an address", on-chain.
/// ────────────────────────────────────────────────────────────────────────────────────────────
///
/// A stealth-address messaging primitive following ERC-5564 (stealth addresses) + ERC-6538
/// (stealth meta-address registry) over secp256k1 (schemeId 1). Two properties hold at once,
/// and they are the whole point of this contract:
///
///   1. THE SENDER IS PROVABLE. Unlike a msgboard post — where the "from" is a self-typed label
///      anyone can spoof — every message carries an ECDSA signature over an EIP-712 digest that
///      binds the exact message contents (scheme, recipient stealth address, ephemeral pubkey,
///      view tag, ciphertext hash) to the sender's key, and to THIS chain + THIS contract (the
///      EIP-712 domain carries chainId + verifyingContract). The contract recovers the signer,
///      requires it to equal the claimed `sender`, and emits `sender` as an indexed topic. So
///      "who sent this" is a cryptographic fact recoverable from the log, not a claim to trust.
///
///   2. THE RECIPIENT IS HIDDEN. The message is addressed to a one-time STEALTH address that is
///      derived (ERC-5564) from the recipient's published meta-address + a fresh per-message
///      ephemeral key. The stealth address is public in the log but is UNLINKABLE to the
///      recipient's real identity: only the recipient, scanning announcements with their private
///      viewing key, can recognise which messages are theirs. Nobody else — not the sender's
///      RPC, not a log indexer, not another registrant — learns who the recipient is. The 1-byte
///      ERC-5564 `viewTag` lets a scanner reject ~255/256 of non-matching announcements with a
///      single hash+compare before doing the elliptic-curve work, so scanning is cheap.
///
/// PRIVACY MODEL — surfaced honestly:
///   ✓ Recipient anonymity vs. everyone but the recipient (needs their viewing key to detect).
///   ✓ Sender authenticity: the emitted `sender` is cryptographically bound to the payload.
///   ✗ Metadata is public: that A message exists, its size, timing, the sender's address, and the
///     (unlinkable) stealth address are all on-chain. This hides the RECIPIENT, not the traffic.
///   ✗ Confidentiality of the body is the CIPHERTEXT's job (off-chain, keyed by the ERC-5564
///     shared secret); this contract treats `ciphertext` as opaque bytes and only authenticates it.
///
/// SAFETY: the contract only recovers a signature (pure) and then stores/emits bytes. It makes no
/// external calls and holds no funds, so it is trivially reentrancy-free.
contract StealthMessenger is EIP712 {
    error BadSig();
    error EmptyMetaAddress();

    /// ERC-5564 scheme id for the secp256k1 construction this contract + its off-chain lib implement.
    uint256 public constant SCHEME_ID = 1;

    /// ERC-6538 registry: a registrant's published stealth meta-address (spendingPub ‖ viewingPub,
    /// 66 bytes compressed for schemeId 1). Senders read this to derive a fresh stealth address.
    mapping(address registrant => bytes stealthMetaAddress) public stealthMetaAddressOf;

    /// Per-registrant replay nonce for `registerStealthMetaAddressOnBehalf` (EIP-712). Incremented
    /// on every accepted meta-address update so a captured signature cannot be replayed.
    mapping(address registrant => uint256) public nonces;

    /// ERC-6538 registration event. `schemeId` is carried explicitly so indexers can filter schemes.
    event StealthMetaAddressSet(address indexed registrant, uint256 schemeId, bytes stealthMetaAddress);

    /// ERC-5564 announcement. `stealthAddress` indexed lets a recipient confirm a candidate they
    /// derived while scanning; `sender` indexed makes the authenticated sender provable/queryable.
    event MessageSent(
        uint256 indexed schemeId,
        address indexed stealthAddress,
        address indexed sender,
        bytes ephemeralPubKey,
        bytes1 viewTag,
        bytes ciphertext
    );

    /// EIP-712 type for the sender authentication. Dynamic `ephemeralPubKey` / `ciphertext` are
    /// bound by their keccak256 hash (EIP-712 rule for `bytes`); `viewTag` is an atomic `bytes1`.
    bytes32 internal constant MESSAGE_TYPEHASH = keccak256(
        "Message(uint256 schemeId,address sender,address stealthAddress,bytes32 ephemeralPubKeyHash,bytes1 viewTag,bytes32 ciphertextHash)"
    );

    /// EIP-712 type for a delegated (gasless) registration.
    bytes32 internal constant REGISTRATION_TYPEHASH = keccak256(
        "Registration(address registrant,uint256 schemeId,bytes32 stealthMetaAddressHash,uint256 nonce)"
    );

    /// Domain: name "MsgBoardStealth", version "1". Solady EIP712 folds chainId + verifyingContract
    /// into the separator, so a signature is automatically bound to THIS chain + THIS contract.
    function _domainNameAndVersion() internal pure override returns (string memory, string memory) {
        return ("MsgBoardStealth", "1");
    }

    // ── ERC-6538 registry ─────────────────────────────────────────────────────────────────────

    /// Publish (or update) your stealth meta-address. For schemeId 1 this is the 66-byte
    /// `spendingPubKey(33) ‖ viewingPubKey(33)` compressed secp256k1 pair (see stealth.ts).
    function registerStealthMetaAddress(bytes calldata stealthMetaAddress) external {
        if (stealthMetaAddress.length == 0) revert EmptyMetaAddress();
        stealthMetaAddressOf[msg.sender] = stealthMetaAddress;
        emit StealthMetaAddressSet(msg.sender, SCHEME_ID, stealthMetaAddress);
    }

    /// Delegated registration: anyone may submit `registrant`'s meta-address if they present the
    /// registrant's EIP-712 signature over it (lets a third party pay the gas). Replay-guarded by
    /// the registrant's monotonically-increasing `nonces` entry.
    function registerStealthMetaAddressOnBehalf(
        address registrant,
        bytes calldata stealthMetaAddress,
        bytes calldata sig
    ) external {
        if (stealthMetaAddress.length == 0) revert EmptyMetaAddress();
        bytes32 digest = _hashTypedData(
            keccak256(
                abi.encode(
                    REGISTRATION_TYPEHASH, registrant, SCHEME_ID, keccak256(stealthMetaAddress), nonces[registrant]
                )
            )
        );
        if (ECDSA.recoverCalldata(digest, sig) != registrant) revert BadSig();
        unchecked {
            ++nonces[registrant];
        }
        stealthMetaAddressOf[registrant] = stealthMetaAddress;
        emit StealthMetaAddressSet(registrant, SCHEME_ID, stealthMetaAddress);
    }

    /// The EIP-712 digest a registrant signs for `registerStealthMetaAddressOnBehalf` (off-chain
    /// parity + signing). Uses the registrant's CURRENT nonce.
    function registrationDigest(address registrant, bytes calldata stealthMetaAddress)
        external
        view
        returns (bytes32)
    {
        return _hashTypedData(
            keccak256(
                abi.encode(
                    REGISTRATION_TYPEHASH, registrant, SCHEME_ID, keccak256(stealthMetaAddress), nonces[registrant]
                )
            )
        );
    }

    // ── ERC-5564 announcement ─────────────────────────────────────────────────────────────────

    /// The exact EIP-712 digest the sender signs. Public for off-chain parity + signing. Binds
    /// (schemeId, sender, stealthAddress, ephemeralPubKey, viewTag, ciphertext) — and, via the
    /// domain separator, chainId + address(this) — so a signature authorizes exactly one message
    /// on exactly this contract + chain and can never be lifted onto a different payload.
    function messageDigest(
        uint256 schemeId,
        address sender,
        address stealthAddress,
        bytes calldata ephemeralPubKey,
        bytes1 viewTag,
        bytes calldata ciphertext
    ) public view returns (bytes32) {
        return _hashTypedData(
            keccak256(
                abi.encode(
                    MESSAGE_TYPEHASH,
                    schemeId,
                    sender,
                    stealthAddress,
                    keccak256(ephemeralPubKey),
                    viewTag,
                    keccak256(ciphertext)
                )
            )
        );
    }

    /// Send an authenticated message to a stealth address. `senderSig` must be `sender`'s ECDSA
    /// signature over `messageDigest(...)`; the contract recovers it and reverts `BadSig` unless it
    /// equals the claimed `sender` — so the emitted `sender` topic is a proven fact, and any tamper
    /// with the payload (which changes the digest) makes recovery miss `sender` and reverts.
    /// Anyone may relay a message on a sender's behalf, but nobody can forge WHO it is from.
    function sendMessage(
        uint256 schemeId,
        address sender,
        address stealthAddress,
        bytes calldata ephemeralPubKey,
        bytes1 viewTag,
        bytes calldata ciphertext,
        bytes calldata senderSig
    ) external {
        bytes32 digest = messageDigest(schemeId, sender, stealthAddress, ephemeralPubKey, viewTag, ciphertext);
        if (ECDSA.recoverCalldata(digest, senderSig) != sender) revert BadSig();
        emit MessageSent(schemeId, stealthAddress, sender, ephemeralPubKey, viewTag, ciphertext);
    }
}
