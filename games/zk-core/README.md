# @msgboard/zk-cards-core

Game-agnostic rails for card games with cryptographically hidden state.

## What it provides

- **Card codec** (`cards.ts`) — integer encoding/decoding for a standard 52-card deck.
- **ElGamal masked deck** (`elgamal.ts`, `maskedDeck.ts`) — per-card ElGamal encryption over
  secp256k1; joint encryption under a shared public key so no single party knows the deck order.
- **`MaskedDeckProvider` seam** (`maskedDeck.ts`) — interface that decouples the shuffle and
  deal primitives from their proof system; swap implementations without touching game logic.
- **Chaum–Pedersen share proofs** (`chaumPedersen.ts`) — interactive-style proofs that a
  decryption share was computed from the correct secret key.
- **`AttestedElGamalDeck`** (`attestedDeck.ts`) — the v0 provider bundled in this package.
  Gives real hiding (cards are encrypted) and share soundness (Chaum–Pedersen), but its shuffle
  proof is a signature (attested), not a SNARK. A future provider replaces it behind the same
  `MaskedDeckProvider` interface once the SNARK SDK spike (Zypher vs Manta zkShuffle) completes.
- **EIP-712 channel-state signing** (`stateSig.ts`) — typed-data signatures for two-party
  channel states; domain is a `TEST_DOMAIN` placeholder until the contracts plan pins the real
  deployed address.
- **Co-signed two-party channel** (`channel.ts`) — state machine that enforces conservation of
  the pot balance, nonce ordering, tableId pinning, and uint64/uint8 range bounds; finalize is
  bound to the pending-proposal hash.
- **Hash-chained transcript** (`transcript.ts`) — each party maintains a signed, hash-chained
  log of their own sends; `fromJSON` re-derives the head hash rather than trusting the stored
  value.
- **Untrusted-transport interface** (`transport.ts`) — `LocalTransport` for in-process tests,
  with fault-injection hooks for adversarial scenarios.
- **Dispute-evidence builder** (`dispute.ts`) — assembles on-chain evidence anchored with
  `tableId` and `transcriptHead`.

## v0 honesty note

`AttestedElGamalDeck` gives real card hiding and cryptographic share soundness, but the shuffle
step is attested by a signature rather than proved in zero knowledge. A SNARK-based
`MaskedDeckProvider` replaces it behind the same interface; no game code changes when that lands.

## Testing

```
pnpm --filter @msgboard/zk-cards-core test
```
