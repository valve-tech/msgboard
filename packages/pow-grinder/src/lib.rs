//! Fast MsgBoard proof-of-work grinder.
//!
//! Bit-identical to the node's verifier (`reth/crates/net/msgboard-types/src/pow.rs`): for a winning
//! nonce, `sha256(challenge ‖ category ‖ data) % difficulty == 0`, where
//! `challenge = x(G · ((nonce·digest + block_hash) mod n))`,
//! `digest = sha256(wm_be8 ‖ wd_be8)[16..]`, `difficulty = (2^24 + size·10000)·wm/wd` (wrapping u64).
//!
//! Speed comes from the same trick the JS `createChallengeSearch` uses — across consecutive nonces the
//! scalar grows by a constant `digest`, so the challenge POINT advances by a constant `D = G·digest`;
//! we replace the per-nonce scalar MULTIPLY with a single projective point ADDITION. With `k256`
//! (projective coords, no per-step field inversion) this is ~100x the old `elliptic` affine loop, and
//! it's pure Rust so it also targets wasm32 for the browser worker.
//!
//! Pure compute: the caller (TS) fetches `{wm, wd, block_hash, block_number}` from the node and
//! assembles + submits the RLP message; this crate only finds the nonce.

use k256::elliptic_curve::sec1::ToEncodedPoint;
use k256::elliptic_curve::PrimeField;
use k256::{ProjectivePoint, Scalar};
use primitive_types::{U256, U512};
use sha2::{Digest, Sha256};

/// secp256k1 group order n.
const SECP_N: [u8; 32] = [
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe,
    0xba, 0xae, 0xdc, 0xe6, 0xaf, 0x48, 0xa0, 0x3b, 0xbf, 0xd2, 0x5e, 0x8c, 0xd0, 0x36, 0x41, 0x41,
];

/// `difficulty = (2^24 + size·10000)·wm/wd`, wrapping u64 (mirrors pow.rs `difficulty()`).
pub fn difficulty(size: u64, wm: u64, wd: u64) -> u64 {
    if wd == 0 {
        return 0;
    }
    let base = (1u64 << 24).wrapping_add(size.wrapping_mul(10_000));
    base.wrapping_mul(wm).wrapping_div(wd)
}

/// Last 16 bytes of `sha256(wm_be8 ‖ wd_be8)` (mirrors pow.rs `difficulty_digest()`).
fn difficulty_digest(wm: u64, wd: u64) -> U256 {
    let mut h = Sha256::new();
    h.update(wm.to_be_bytes());
    h.update(wd.to_be_bytes());
    let full: [u8; 32] = h.finalize().into();
    let mut padded = [0u8; 32];
    padded[16..].copy_from_slice(&full[16..]); // high 16 bytes zero → 128-bit digest
    U256::from_big_endian(&padded)
}

/// `(nonce·digest + block_hash) mod n`, with pow.rs's exact carry handling. `None` iff the result is 0.
fn pow_scalar(nonce: u64, digest_u: U256, block_u: U256, n: U256) -> Option<U256> {
    let product = U256::from(nonce).overflowing_mul(digest_u).0; // < 2^192, no real overflow
    let (sum, carry) = product.overflowing_add(block_u);
    let scalar = if carry {
        let nc = U256::zero().overflowing_sub(n).0; // 2^256 - n
        let (adjusted, carry2) = nc.overflowing_add(sum);
        if carry2 {
            nc.overflowing_add(adjusted).0
        } else if adjusted >= n {
            adjusted - n
        } else {
            adjusted
        }
    } else if sum >= n {
        sum - n
    } else {
        sum
    };
    if scalar.is_zero() {
        None
    } else {
        Some(scalar)
    }
}

/// `G · scalar` for a reduced scalar (< n).
fn point_for_scalar(scalar_u: U256) -> ProjectivePoint {
    let mut b = [0u8; 32];
    scalar_u.to_big_endian(&mut b);
    // scalar_u < n, so from_repr succeeds.
    let s: Scalar = Option::from(Scalar::from_repr(b.into())).expect("reduced scalar < n");
    ProjectivePoint::GENERATOR * s
}

/// 32-byte big-endian x-coordinate of a point; zeros for the identity (matches pow.rs).
fn x_of(p: &ProjectivePoint) -> [u8; 32] {
    let enc = p.to_affine().to_encoded_point(false);
    match enc.x() {
        Some(x) => {
            let mut out = [0u8; 32];
            out.copy_from_slice(x.as_ref());
            out
        }
        None => [0u8; 32],
    }
}

/// Full from-scratch challenge x for a nonce (the verifier path; also used to rebase the grind).
pub fn challenge_x(nonce: u64, digest_u: U256, block_u: U256, n: U256) -> [u8; 32] {
    match pow_scalar(nonce, digest_u, block_u, n) {
        Some(s) => x_of(&point_for_scalar(s)),
        None => [0u8; 32],
    }
}

fn pow_hash(challenge: &[u8; 32], category: &[u8; 32], data: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(challenge);
    h.update(category);
    h.update(data);
    h.finalize().into()
}

/// The winning nonce + its PoW hash, or `None` if `max_iters` was exhausted.
pub struct Found {
    pub nonce: u64,
    pub hash: [u8; 32],
    pub iters: u64,
}

/// Grind consecutive nonces from `start_nonce` against a FIXED `block_hash` until one satisfies the
/// difficulty, or `max_iters` is reached. Pure compute — no RPC, no block polling (the caller passes a
/// fresh block and re-grinds if needed; on a fast machine the grind finishes well inside one block).
pub fn grind(
    category: &[u8; 32],
    data: &[u8],
    wm: u64,
    wd: u64,
    block_hash: &[u8; 32],
    start_nonce: u64,
    max_iters: u64,
) -> Option<Found> {
    let diff = difficulty(data.len() as u64, wm, wd);
    if diff == 0 {
        return None;
    }
    let diff_u = U256::from(diff);
    let digest_u = difficulty_digest(wm, wd);
    let block_u = U256::from_big_endian(block_hash);
    let n = U256::from_big_endian(&SECP_N);
    let step = point_for_scalar(digest_u); // D = G·digest (digest < n)

    let mut point: Option<ProjectivePoint> = None;
    let mut nonce = start_nonce;
    let mut iters = 0u64;
    while iters < max_iters {
        nonce = nonce.wrapping_add(1);
        iters += 1;
        let p = match point {
            // consecutive nonce: advance the running point by the constant D (the fast path).
            Some(prev) => prev + step,
            // first iteration (or after a skip): rebase with a full scalar multiply.
            None => match pow_scalar(nonce, digest_u, block_u, n) {
                Some(s) => point_for_scalar(s),
                None => continue, // scalar ≡ 0 (≈2^-256) — skip; forces a rebase next iter
            },
        };
        point = Some(p);
        let challenge = x_of(&p);
        let hash = pow_hash(&challenge, category, data);
        if (U256::from_big_endian(&hash) % diff_u).is_zero() {
            return Some(Found { nonce, hash, iters });
        }
    }
    None
}

/// Binding-friendly grind: returns 40 bytes `nonce_be(8) ‖ hash(32)` on success, else `None`.
/// (Packing keeps the napi/wasm bindings trivial — JS reads the u64 nonce from the first 8 bytes.)
pub fn grind_packed(
    category: &[u8],
    data: &[u8],
    wm: u64,
    wd: u64,
    block_hash: &[u8],
    start_nonce: u64,
    max_iters: u64,
) -> Option<Vec<u8>> {
    if category.len() != 32 || block_hash.len() != 32 {
        return None;
    }
    let mut cat = [0u8; 32];
    cat.copy_from_slice(category);
    let mut bh = [0u8; 32];
    bh.copy_from_slice(block_hash);
    grind(&cat, data, wm, wd, &bh, start_nonce, max_iters).map(|f| {
        let mut out = Vec::with_capacity(40);
        out.extend_from_slice(&f.nonce.to_be_bytes());
        out.extend_from_slice(&f.hash);
        out
    })
}

// ── Revised PoW algorithm (v2) ───────────────────────────────────────────────────────────────────
//
// Bit-identical to the TS reference (`packages/core/src/utils.ts`: payloadHash, scalarHash, powTarget,
// checkWorkV2). v2 differs from the legacy path above in three ways:
//   1. The scalar is a SHA256 of the whole transcript, not `nonce·digest + block_hash`. So each nonce
//      has an INDEPENDENT scalar — there is no constant point step, and the incremental point-addition
//      trick the legacy `grind()` uses does NOT apply. Every nonce pays a full scalar multiply.
//   2. The work hash is over the 33-byte COMPRESSED point, not the raw 32-byte x-coordinate.
//   3. Acceptance is `workHash < 2^256 / D` (below `pow_target_v2`), not `workHash % D == 0`.
// An out-of-range scalar is REJECTED, not reduced (mirrors Go's ScalarBaseMult).

/// v2 payload commit: `SHA256(category(32) ‖ data)`.
fn payload_hash_v2(category: &[u8; 32], data: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(category);
    h.update(data);
    h.finalize().into()
}

/// v2 transcript: `SHA256(version(1) ‖ block_hash(32) ‖ payload_hash(32) ‖ wm(8) ‖ wd(8) ‖ nonce(8))`,
/// all fields big-endian.
fn scalar_hash_v2(
    version: u8,
    block_hash: &[u8; 32],
    payload_hash: &[u8; 32],
    wm: u64,
    wd: u64,
    nonce: u64,
) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update([version]);
    h.update(block_hash);
    h.update(payload_hash);
    h.update(wm.to_be_bytes());
    h.update(wd.to_be_bytes());
    h.update(nonce.to_be_bytes());
    h.finalize().into()
}

/// v2 acceptance target: `floor(2^256 / D)`. Returned as `U512` because `D == 1` gives `2^256`, which
/// overflows `U256`; the exact floor also rules out the `workHash * D < 2^256` shortcut. Zero for `D == 0`.
fn pow_target_v2(d: u64) -> U512 {
    if d == 0 {
        return U512::zero();
    }
    (U512::one() << 256) / U512::from(d)
}

/// v2 work hash: `SHA256(compressed_point)`, where `compressed_point` is the 33-byte SEC1 encoding
/// `0x02/0x03 ‖ x`.
fn work_hash_v2(point: &ProjectivePoint) -> [u8; 32] {
    let enc = point.to_affine().to_encoded_point(true);
    let mut h = Sha256::new();
    h.update(enc.as_bytes());
    h.finalize().into()
}

/// Grind consecutive nonces from `start_nonce` under the revised (v2) algorithm against a FIXED
/// `block_hash`, until one satisfies the difficulty or `max_iters` is reached. `start_nonce` is
/// exclusive — the first nonce tried is `start_nonce + 1` (matches the legacy `grind`). Pure compute.
pub fn grind_v2(
    category: &[u8; 32],
    data: &[u8],
    wm: u64,
    wd: u64,
    block_hash: &[u8; 32],
    version: u8,
    start_nonce: u64,
    max_iters: u64,
) -> Option<Found> {
    let diff = difficulty(data.len() as u64, wm, wd);
    if diff == 0 {
        return None;
    }
    let target = pow_target_v2(diff);
    let n = U256::from_big_endian(&SECP_N);
    let payload_hash = payload_hash_v2(category, data); // constant across nonces

    let mut nonce = start_nonce;
    let mut iters = 0u64;
    while iters < max_iters {
        nonce = nonce.wrapping_add(1);
        iters += 1;
        let sh = scalar_hash_v2(version, block_hash, &payload_hash, wm, wd, nonce);
        let scalar_u = U256::from_big_endian(&sh);
        // Reject rather than reduce: require 1 <= scalar < n (mirrors Go's ScalarBaseMult).
        if scalar_u.is_zero() || scalar_u >= n {
            continue;
        }
        let point = point_for_scalar(scalar_u);
        if point == ProjectivePoint::IDENTITY {
            continue;
        }
        let hash = work_hash_v2(&point);
        if U512::from_big_endian(&hash) < target {
            return Some(Found { nonce, hash, iters });
        }
    }
    None
}

/// Binding-friendly v2 grind: returns 40 bytes `nonce_be(8) ‖ hash(32)` on success, else `None`.
pub fn grind_v2_packed(
    category: &[u8],
    data: &[u8],
    wm: u64,
    wd: u64,
    block_hash: &[u8],
    version: u8,
    start_nonce: u64,
    max_iters: u64,
) -> Option<Vec<u8>> {
    if category.len() != 32 || block_hash.len() != 32 {
        return None;
    }
    let mut cat = [0u8; 32];
    cat.copy_from_slice(category);
    let mut bh = [0u8; 32];
    bh.copy_from_slice(block_hash);
    grind_v2(&cat, data, wm, wd, &bh, version, start_nonce, max_iters).map(|f| {
        let mut out = Vec::with_capacity(40);
        out.extend_from_slice(&f.nonce.to_be_bytes());
        out.extend_from_slice(&f.hash);
        out
    })
}

// ── napi (native node addon for the bots' worker_threads grinder) ───────────────────────────────
#[cfg(feature = "napi")]
mod napi_binding {
    use napi::bindgen_prelude::Buffer;
    use napi_derive::napi;

    /// Single-object input to `stamp` (JS sees camelCase: category, data, workMultiplier, …).
    #[napi(object)]
    pub struct StampRequest {
        pub category: Buffer,
        pub data: Buffer,
        pub work_multiplier: u32,
        pub work_divisor: u32,
        pub block_hash: Buffer,
        pub start_nonce: u32,
        pub max_iters: u32,
    }

    /// Mint a MsgBoard PoW stamp natively. Returns a 40-byte Buffer `nonce_be(8) ‖ hash(32)`, or null
    /// if `maxIters` was exhausted. Pure compute — no keys, no RPC. (SDK verb: `stamp`.)
    #[napi]
    pub fn stamp(req: StampRequest) -> Option<Buffer> {
        super::grind_packed(
            &req.category,
            &req.data,
            req.work_multiplier as u64,
            req.work_divisor as u64,
            &req.block_hash,
            req.start_nonce as u64,
            req.max_iters as u64,
        )
        .map(Buffer::from)
    }

    /// Single-object input to `stamp_v2` — `stamp` plus a `version` field for the revised algorithm.
    #[napi(object)]
    pub struct StampRequestV2 {
        pub category: Buffer,
        pub data: Buffer,
        pub work_multiplier: u32,
        pub work_divisor: u32,
        pub block_hash: Buffer,
        pub version: u32,
        pub start_nonce: u32,
        pub max_iters: u32,
    }

    /// Mint a MsgBoard PoW stamp with the revised (v2) algorithm. Same return shape as `stamp` — a
    /// 40-byte Buffer `nonce_be(8) ‖ hash(32)`, or null if `maxIters` was exhausted. (SDK verb: `stampV2`.)
    #[napi]
    pub fn stamp_v2(req: StampRequestV2) -> Option<Buffer> {
        super::grind_v2_packed(
            &req.category,
            &req.data,
            req.work_multiplier as u64,
            req.work_divisor as u64,
            &req.block_hash,
            req.version as u8,
            req.start_nonce as u64,
            req.max_iters as u64,
        )
        .map(Buffer::from)
    }
}

// ── wasm (browser Web Worker grinder) ───────────────────────────────────────────────────────────
#[cfg(feature = "wasm")]
mod wasm_binding {
    use wasm_bindgen::prelude::{wasm_bindgen, JsValue};

    /// Single-object input to `stamp` (the byte fields are Uint8Arrays in JS).
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct StampRequest {
        category: Vec<u8>,
        data: Vec<u8>,
        work_multiplier: u32,
        work_divisor: u32,
        block_hash: Vec<u8>,
        start_nonce: u32,
        max_iters: u32,
    }

    /// Mint a MsgBoard PoW stamp in WASM. Takes one object `{ category, data, workMultiplier,
    /// workDivisor, blockHash, startNonce, maxIters }`; returns a 40-byte Uint8Array
    /// `nonce_be(8) ‖ hash(32)`, or undefined if `maxIters` was exhausted. Pure compute — no keys,
    /// no RPC. (SDK verb: `stamp`.)
    #[wasm_bindgen]
    pub fn stamp(req: JsValue) -> Result<Option<Vec<u8>>, JsValue> {
        let r: StampRequest =
            serde_wasm_bindgen::from_value(req).map_err(|e| JsValue::from_str(&e.to_string()))?;
        Ok(super::grind_packed(
            &r.category,
            &r.data,
            r.work_multiplier as u64,
            r.work_divisor as u64,
            &r.block_hash,
            r.start_nonce as u64,
            r.max_iters as u64,
        ))
    }

    /// Single-object input to `stamp_v2` — `stamp` plus a `version` field for the revised algorithm.
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct StampRequestV2 {
        category: Vec<u8>,
        data: Vec<u8>,
        work_multiplier: u32,
        work_divisor: u32,
        block_hash: Vec<u8>,
        version: u32,
        start_nonce: u32,
        max_iters: u32,
    }

    /// Mint a MsgBoard PoW stamp with the revised (v2) algorithm. Takes one object `{ category, data,
    /// workMultiplier, workDivisor, blockHash, version, startNonce, maxIters }`; returns a 40-byte
    /// Uint8Array `nonce_be(8) ‖ hash(32)`, or undefined if `maxIters` was exhausted. (SDK verb: `stampV2`.)
    #[wasm_bindgen]
    pub fn stamp_v2(req: JsValue) -> Result<Option<Vec<u8>>, JsValue> {
        let r: StampRequestV2 =
            serde_wasm_bindgen::from_value(req).map_err(|e| JsValue::from_str(&e.to_string()))?;
        Ok(super::grind_v2_packed(
            &r.category,
            &r.data,
            r.work_multiplier as u64,
            r.work_divisor as u64,
            &r.block_hash,
            r.version as u8,
            r.start_nonce as u64,
            r.max_iters as u64,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn n() -> U256 {
        U256::from_big_endian(&SECP_N)
    }

    fn hx(s: &str) -> Vec<u8> {
        let s = s.strip_prefix("0x").unwrap_or(s);
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    }
    fn hx32(s: &str) -> [u8; 32] {
        let v = hx(s);
        let mut a = [0u8; 32];
        a[..v.len()].copy_from_slice(&v); // right-pad with zeros (categories are text + zero fill)
        a
    }

    #[test]
    fn matches_a_real_on_board_message() {
        // A live message fetched from the 943 board (msgboard_content) — produced by the JS grinder and
        // ACCEPTED by the Rust node. If we reproduce its hash from its nonce, we're bit-identical to both.
        let category = hx32("0x6d7573696e6773000000000000000000000000000000000000000000000000");
        let data = hx("0x53756e7420657520766f6c75707461746520657820717569732063756c706120616420616e696d2070726f6964656e7420657520696e6369646964756e74206e756c6c61206972757265207175692e");
        let block_hash = hx32("0xdb7a30f8bebadab51c2d1d3bdddabed4a695ff51e9982cbd03ad01ebe39e6767");
        let (wm, wd) = (0x2710u64, 0xf4240u64);
        let nonce = 0x941au64;
        let expected_hash = hx32("0xae531e1c907dc088a8048bb46810bc2cc1e6e83d7e9bec8ba2cf236cc93b9438");

        let digest_u = difficulty_digest(wm, wd);
        let block_u = U256::from_big_endian(&block_hash);
        let challenge = challenge_x(nonce, digest_u, block_u, n());
        let hash = pow_hash(&challenge, &category, &data);
        assert_eq!(hash, expected_hash, "Rust PoW must match the on-board message exactly");

        let diff = difficulty(data.len() as u64, wm, wd);
        assert!(
            (U256::from_big_endian(&hash) % U256::from(diff)).is_zero(),
            "the accepted message must satisfy its difficulty"
        );
    }

    #[test]
    fn incremental_matches_from_scratch() {
        // The point-addition fast path must produce the SAME challenge x as a from-scratch scalar mult.
        let digest_u = difficulty_digest(10_000, 1_000_000);
        let block_u = U256::from_big_endian(&[7u8; 32]);
        let step = point_for_scalar(digest_u);
        // rebase at nonce=1, then step.
        let mut point = point_for_scalar(pow_scalar(1, digest_u, block_u, n()).unwrap());
        for nonce in 2..200u64 {
            point += step;
            let incremental = x_of(&point);
            let scratch = challenge_x(nonce, digest_u, block_u, n());
            assert_eq!(incremental, scratch, "mismatch at nonce {nonce}");
        }
    }

    #[test]
    #[ignore = "timing only; run with `cargo test --release bench_real_difficulty -- --ignored --nocapture`"]
    fn bench_real_difficulty() {
        // Grind at the REAL 943 board floor (wm=10000, wd=1000000) to compare against the JS ~55s.
        let category = hx32("0x6d7573696e6773");
        let data = b"games.msgboard.xyz:lobby:943 open dice commit 0x2c928c9ac5d1 player 0x1bcb";
        let block_hash = hx32("0xdb7a30f8bebadab51c2d1d3bdddabed4a695ff51e9982cbd03ad01ebe39e6767");
        let (wm, wd) = (10_000u64, 1_000_000u64);
        let t = std::time::Instant::now();
        let found = grind(&category, data, wm, wd, &block_hash, 0, 100_000_000).expect("found");
        let dt = t.elapsed();
        eprintln!(
            "BENCH real-difficulty: nonce={} iters={} in {:.3}s ({:.0} iters/s)",
            found.nonce,
            found.iters,
            dt.as_secs_f64(),
            found.iters as f64 / dt.as_secs_f64(),
        );
    }

    #[test]
    fn v2_reproduces_the_ts_golden_fixture() {
        // Fixed vector from packages/core/src/pow-v2.test.ts. blockHash + category are the keccak256 of
        // the ASCII strings (viem `keccak256(toHex(...))`); we pin the digests here so the whole v2
        // transcript stays byte-for-byte with the TS reference.
        // block = keccak256("v2-golden-block"), cat = keccak256("v2-golden-cat").
        let block_hash =
            hx32("0x2e4283657020515742f1cdee8b4a01b1920e459419be89a5316152be3bb122e2");
        let category = hx32("0xda5195d22a0b240b14559bfd687e228acb43f8c5b1a7f876b1761584306b3c45");
        let data = hx("0x0102030405");
        let (version, wm, wd, nonce) = (2u8, 1u64, 1u64, 42u64);

        let ph = payload_hash_v2(&category, &data);
        let sh = scalar_hash_v2(version, &block_hash, &ph, wm, wd, nonce);
        assert_eq!(
            hx32("0xd73f3e001a3e81f1483ac0cdc9c56e2fe4d8b0fff3d8e9c4b385be4941289671"),
            ph,
            "v2 payloadHash must match the TS golden fixture"
        );
        assert_eq!(
            hx32("0xb30158e41c77b19c5fa193978fc81310a3690db47085eb2e62bf819fa4311a89"),
            sh,
            "v2 scalarHash must match the TS golden fixture"
        );
    }

    #[test]
    fn v2_grind_finds_a_nonce_that_reverifies() {
        // Easy difficulty (wd = base so D == 1 → target == 2^256, any in-range scalar passes), then
        // independently recompute the winning nonce's work hash from scratch.
        let category = [0x11u8; 32];
        let data = hx("0x0102030405");
        let (version, wm) = (2u8, 1u64);
        let wd = (1u64 << 24) + (data.len() as u64) * 10_000; // makes difficulty()==1
        assert_eq!(difficulty(data.len() as u64, wm, wd), 1);
        let block_hash = [0x42u8; 32];

        let found = grind_v2(&category, &data, wm, wd, &block_hash, version, 0, 1_000).expect("found");

        let ph = payload_hash_v2(&category, &data);
        let sh = scalar_hash_v2(version, &block_hash, &ph, wm, wd, found.nonce);
        let scalar_u = U256::from_big_endian(&sh);
        assert!(!scalar_u.is_zero() && scalar_u < n(), "winning scalar must be in [1, n)");
        let point = point_for_scalar(scalar_u);
        let hash = work_hash_v2(&point);
        assert_eq!(hash, found.hash, "v2 grind hash must match the from-scratch hash");
        assert!(U512::from_big_endian(&hash) < pow_target_v2(1), "hash must be below the target");
    }

    #[test]
    fn grind_finds_a_valid_nonce() {
        let category = [0xabu8; 32];
        let data = b"games.msgboard.xyz lobby notice";
        // Moderate difficulty so the loop actually runs (wd large → diff ~ 167).
        let (wm, wd) = (1u64, 100_000u64);
        let block_hash = [0x42u8; 32];
        let found = grind(&category, data, wm, wd, &block_hash, 0, 5_000_000).expect("should find");

        // Independently re-verify exactly as the node would: recompute challenge from scratch, hash,
        // and check divisibility.
        let digest_u = difficulty_digest(wm, wd);
        let block_u = U256::from_big_endian(&block_hash);
        let challenge = challenge_x(found.nonce, digest_u, block_u, n());
        let hash = pow_hash(&challenge, &category, data);
        assert_eq!(hash, found.hash, "grind hash must match from-scratch hash");
        let diff = difficulty(data.len() as u64, wm, wd);
        assert!(diff > 1, "test difficulty should be > 1");
        assert!(
            (U256::from_big_endian(&hash) % U256::from(diff)).is_zero(),
            "winning hash must satisfy difficulty"
        );
    }
}

