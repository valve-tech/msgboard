// Task 2 GATE probe - keccak / roundRandom parity + 256-bit-r reduction.
//
// Pins, byte-for-byte against viem (and the on-chain GamePayouts), the two
// DISTINCT keccak preimages the protocol depends on:
//
//   1. seedCommit = keccak256(serverSeed)
//        serverSeed is a single bytes32; Solidity's keccak256(abi.encodePacked(
//        serverSeed)) is just those 32 bytes - no padding, no abi wrapper.
//
//   2. r = uint256(keccak256(abi.encode(serverSeed, clientSeed, uint64(1))))
//        abi.encode (NOT packed) of (bytes32, bytes32, uint64) = 96 bytes:
//        serverSeed(32) || clientSeed(32) || nonce left-padded big-endian to 32.
//        nonce is hardcoded 1 (never a witness - an attacker-grindable nonce is
//        unsound, same rule as settleWithSeeds).
//
// r is a full 256-bit value but bn254's scalar field is ~254 bits, so r can
// NEVER be carried as a single Field (it would silently wrap at 254 bits and
// corrupt r % m). We keep r as its 32 big-endian bytes and reduce on the WIDE
// value via Horner's method in u64.
use keccak256::keccak256;

// r % m for a 256-bit big-endian byte array, computed on the wide value.
// Horner: acc = (acc * 256 + byte) % m, folding the most-significant byte first.
// u64 is safe: the max intermediate is 256*(m-1)+255, which for m <= 1_000_000
// is < 2^32, far below u64 overflow. This is what makes the reduction correct
// for high-bit r (top bits set) where a 254-bit Field truncation would not be.
fn mod_be_bytes(bytes: [u8; 32], m: u64) -> u64 {
    let mut acc: u64 = 0;
    for i in 0..32 {
        acc = (acc * 256 + bytes[i] as u64) % m;
    }
    acc
}

// Returns:
//   seedCommit : keccak256(serverSeed)                      [u8; 32]
//   rBytes     : keccak256(abi.encode(seed,client,1u64))    [u8; 32] (big-endian r)
//   roll       : r % 10_000     (dice/limbo basis-point roll)   u64
//   u          : r % 1_000_000  (finer reduction)               u64
fn main(serverSeed: [u8; 32], clientSeed: [u8; 32]) -> pub ([u8; 32], [u8; 32], u64, u64) {
    let seedCommit = keccak256(serverSeed, 32);

    // Build the 96-byte abi.encode preimage in-circuit.
    let mut pre: [u8; 96] = [0; 96];
    for i in 0..32 {
        pre[i] = serverSeed[i];
        pre[32 + i] = clientSeed[i];
    }
    // uint64(1) occupies the third 32-byte word, big-endian => only the very
    // last byte is set. (The first 24 bytes of that word are the uint64's
    // zero-padding; bytes 88..95 are the 8-byte big-endian 1 => byte 95 == 1.)
    pre[95] = 1;

    let rBytes = keccak256(pre, 96);

    let roll = mod_be_bytes(rBytes, 10000);
    let u = mod_be_bytes(rBytes, 1000000);

    (seedCommit, rBytes, roll, u)
}
