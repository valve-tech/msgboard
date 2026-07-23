import { encodeAbiParameters, type Hex } from 'viem'

/**
 * The exact preimage hashed to derive a round's randomness `r`:
 *
 *   r = uint256(keccak256(abi.encode(serverSeed, clientSeed, uint64(1))))
 *
 * `abi.encode` (NOT `abi.encodePacked`) of `(bytes32, bytes32, uint64)` is a
 * fixed 96 bytes: serverSeed (32) || clientSeed (32) || nonce left-padded
 * big-endian to 32. `nonce` is hardcoded `1n` — same soundness rationale as the
 * on-chain `settleWithSeeds` (a free/attacker-grindable nonce is not allowed).
 *
 * This is the parity reference for the in-circuit preimage builder in
 * `keccakProbe.nr`: both must produce these exact 96 bytes, byte-for-byte, so
 * the circuit's `r` equals viem's `roundRandom(serverSeed, clientSeed, 1n)` and
 * the on-chain `GamePayouts` value. Note this is a DIFFERENT preimage from the
 * seed commit `keccak256(serverSeed)` (a single bytes32, no abi wrapper).
 */
export function roundRandomPreimage(serverSeed: Hex, clientSeed: Hex): Hex {
  return encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint64' }],
    [serverSeed, clientSeed, 1n],
  ) as Hex
}
