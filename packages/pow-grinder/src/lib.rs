//! Fast MsgBoard proof-of-work grinder (message version 1 — the one and only scheme).
//!
//! Bit-identical to the node's verifier and the TS reference (`packages/core/src/utils.ts`:
//! payloadHash, scalarHash, powTarget, checkWork):
//!   payload_hash = SHA256(category(32) ‖ data)
//!   scalar       = SHA256(version(1) ‖ block_hash(32) ‖ payload_hash(32) ‖ wm(8) ‖ wd(8) ‖ nonce(8))
//!   an out-of-range scalar (0 or ≥ n) is REJECTED, not reduced (mirrors Go's ScalarBaseMult)
//!   work_hash    = SHA256(compressed_point)   // 33-byte SEC1 `0x02/0x03 ‖ x`
//!   accept iff work_hash < 2^256 / difficulty,  difficulty = (2^24 + size·10000)·wm/wd (wrapping u64)
//!
//! Each nonce has an INDEPENDENT scalar, so there is no constant point step — every nonce pays a full
//! scalar multiply. `k256` (projective coords, no per-step field inversion) keeps this fast, and it's
//! pure Rust so it also targets wasm32 for the browser worker.
//!
//! Pure compute: the caller (TS) fetches `{wm, wd, block_hash, block_number}` from the node and
//! assembles + submits the RLP message; this crate only finds the nonce.
//!
//! (The pre-revision algorithm was removed once the node cut over and began rejecting it. The public
//! engine keeps the `_v2` suffix — `grind_v2` / `stamp_v2` — for API stability with existing consumers.)

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

/// `G · scalar` for a reduced scalar (< n).
fn point_for_scalar(scalar_u: U256) -> ProjectivePoint {
    let mut b = [0u8; 32];
    scalar_u.to_big_endian(&mut b);
    // scalar_u < n, so from_repr succeeds.
    let s: Scalar = Option::from(Scalar::from_repr(b.into())).expect("reduced scalar < n");
    ProjectivePoint::GENERATOR * s
}

/// The winning nonce + its PoW hash, or `None` if `max_iters` was exhausted.
pub struct Found {
    pub nonce: u64,
    pub hash: [u8; 32],
    pub iters: u64,
}

/// Payload commit: `SHA256(category(32) ‖ data)`.
fn payload_hash_v2(category: &[u8; 32], data: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(category);
    h.update(data);
    h.finalize().into()
}

/// Transcript: `SHA256(version(1) ‖ block_hash(32) ‖ payload_hash(32) ‖ wm(8) ‖ wd(8) ‖ nonce(8))`,
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

/// Acceptance target: `floor(2^256 / D)`. Returned as `U512` because `D == 1` gives `2^256`, which
/// overflows `U256`; the exact floor also rules out the `workHash * D < 2^256` shortcut. Zero for `D == 0`.
fn pow_target_v2(d: u64) -> U512 {
    if d == 0 {
        return U512::zero();
    }
    (U512::one() << 256) / U512::from(d)
}

/// Work hash: `SHA256(compressed_point)`, where `compressed_point` is the 33-byte SEC1 encoding
/// `0x02/0x03 ‖ x`.
fn work_hash_v2(point: &ProjectivePoint) -> [u8; 32] {
    let enc = point.to_affine().to_encoded_point(true);
    let mut h = Sha256::new();
    h.update(enc.as_bytes());
    h.finalize().into()
}

/// Grind consecutive nonces from `start_nonce` against a FIXED `block_hash`, until one satisfies the
/// difficulty or `max_iters` is reached. `start_nonce` is exclusive — the first nonce tried is
/// `start_nonce + 1`. Pure compute — no RPC, no block polling (the caller passes a fresh block and
/// re-grinds if needed; on a fast machine the grind finishes well inside one block).
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

/// Binding-friendly grind: returns 40 bytes `nonce_be(8) ‖ hash(32)` on success, else `None`.
/// (Packing keeps the napi/wasm bindings trivial — JS reads the u64 nonce from the first 8 bytes.)
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

    /// Single-object input to `stamp_v2` (JS sees camelCase: category, data, workMultiplier, …).
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

    /// Mint a MsgBoard PoW stamp natively. Returns a 40-byte Buffer `nonce_be(8) ‖ hash(32)`, or null
    /// if `maxIters` was exhausted. Pure compute — no keys, no RPC. (SDK verb: `stampV2`.)
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

    /// Single-object input to `stamp_v2` (the byte fields are Uint8Arrays in JS).
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

    /// Mint a MsgBoard PoW stamp in WASM. Takes one object `{ category, data, workMultiplier,
    /// workDivisor, blockHash, version, startNonce, maxIters }`; returns a 40-byte Uint8Array
    /// `nonce_be(8) ‖ hash(32)`, or undefined if `maxIters` was exhausted. (SDK verb: `stampV2`.)
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
    fn golden_vector_node_consensus() {
        // The node's Go golden vector — the authority for the byte layout. category = "chatter"
        // (padded to 32 bytes), data = "golden vector". Matching these hashes proves this grinder is
        // bit-identical to the node, not just internally consistent.
        let category = hx32("0x6368617474657200000000000000000000000000000000000000000000000000");
        let block_hash =
            hx32("0x3a2ca760216c5cb648c32aab73cbc1cdfdbcf02f77a4cd190995e3c46f3932b5");
        let data = hx("0x676f6c64656e20766563746f72"); // "golden vector", 13 bytes

        let ph = payload_hash_v2(&category, &data);
        assert_eq!(
            ph,
            hx32("0xb66106e111b0e6cd08a49c7a37afa3259541bee8e465bef5e55f6cd7223d789a"),
            "payloadHash must match the node golden vector"
        );

        // Vector A: nonce 1, wm 10000, wd 1000000 → D 169072. Pins the transcript + work hash, and must
        // NOT meet difficulty.
        let sh_a = scalar_hash_v2(1, &block_hash, &ph, 10_000, 1_000_000, 1);
        assert_eq!(
            sh_a,
            hx32("0x3caed3ea9a5caa6e1e069d0126e4dc6698190aa3eec8ebcdab227d3e5b0fd18d")
        );
        let d_a = difficulty(data.len() as u64, 10_000, 1_000_000);
        assert_eq!(d_a, 169072);
        let wh_a = work_hash_v2(&point_for_scalar(U256::from_big_endian(&sh_a)));
        assert_eq!(
            wh_a,
            hx32("0x5ba003ccdb08503a19326a201834198a49e062d2f3f0e9506ff086eddb011dee")
        );
        assert!(
            U512::from_big_endian(&wh_a) >= pow_target_v2(d_a),
            "vector A must not meet its difficulty"
        );

        // Vector B: nonce 57602, wm 1, wd 1000 → D 16907. Passes; the two neighbours do not.
        let d_b = difficulty(data.len() as u64, 1, 1000);
        assert_eq!(d_b, 16907);
        let target_b = pow_target_v2(d_b);
        let sh_b = scalar_hash_v2(1, &block_hash, &ph, 1, 1000, 57602);
        assert_eq!(
            sh_b,
            hx32("0xbcff3c0ddc5d02b05e282566461d4f30f35ce90b3bfd36cde0c694dcb54a5e7d")
        );
        // checkWork-equivalent: reject an out-of-range scalar, else compare the work hash to the target.
        let passes = |nonce: u64| -> bool {
            let sh = scalar_hash_v2(1, &block_hash, &ph, 1, 1000, nonce);
            let s = U256::from_big_endian(&sh);
            if s.is_zero() || s >= n() {
                return false;
            }
            U512::from_big_endian(&work_hash_v2(&point_for_scalar(s))) < target_b
        };
        let wh_b = work_hash_v2(&point_for_scalar(U256::from_big_endian(&sh_b)));
        assert_eq!(
            wh_b,
            hx32("0x00037212834e250723dc736508d445a0dbc01398040a980807641b4be2d1e361")
        );
        assert!(passes(57602), "vector B must meet its difficulty");
        assert!(!passes(57601), "57601 must not pass");
        assert!(!passes(57603), "57603 must not pass");
    }

    #[test]
    fn grind_finds_a_nonce_that_reverifies() {
        // Easy difficulty (wd = base so D == 1 → target == 2^256, any in-range scalar passes), then
        // independently recompute the winning nonce's work hash from scratch.
        let category = [0x11u8; 32];
        let data = hx("0x0102030405");
        let (version, wm) = (1u8, 1u64);
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
        assert_eq!(hash, found.hash, "grind hash must match the from-scratch hash");
        assert!(U512::from_big_endian(&hash) < pow_target_v2(1), "hash must be below the target");
    }
}
