import { BarretenbergSync } from '@aztec/bb.js'

/**
 * An affine Grumpkin point: the output of a Pedersen commitment. `x`/`y` are
 * bn254-base-field elements (the curve over which Grumpkin is defined), returned
 * as bigints. A Pedersen commitment to a hidden amount is published as this
 * point; it reveals nothing about the amount given a random blinding factor.
 */
export interface PedersenPoint {
  x: bigint
  y: bigint
}

let syncApi: BarretenbergSync | undefined

/**
 * Why bb.js's OWN Pedersen export is the parity reference (NOT a hand-rolled
 * Grumpkin generator set):
 *
 * Noir's `std::hash::pedersen_commitment` commits with a specific set of
 * Grumpkin generators baked into barretenberg. There is no off-the-shelf
 * viem/JS equivalent of those generators, and re-deriving them by hand is the
 * single most likely way to get a silent parity mismatch. bb.js ships the exact
 * same barretenberg implementation the Noir circuit compiles against, so
 * `pedersenCommit({ inputs, hashIndex: 0 })` is generator-identical to the
 * circuit's `pedersen_commitment(...)`. Empirically confirmed byte-for-byte
 * (both x and y) against the in-circuit output for fixed vectors.
 *
 * `hashIndex` 0 is the default separator Noir's `pedersen_commitment` uses.
 */
async function api(): Promise<BarretenbergSync> {
  if (!syncApi) syncApi = await BarretenbergSync.initSingleton()
  return syncApi
}

/** A bn254 field element (32-byte big-endian) as a Buffer, the shape bb.js wants. */
function frBuffer(v: bigint): Buffer {
  if (v < 0n) throw new Error('pedersen input must be non-negative')
  return Buffer.from(v.toString(16).padStart(64, '0'), 'hex')
}

/**
 * Pedersen commitment to `(amount, blinding)`, computed with bb.js so it equals
 * the in-circuit `std::hash::pedersen_commitment([amount as Field, blinding])`
 * exactly. `amount` and `blinding` are field elements (bigints).
 *
 * The returned point is what a circuit using this scheme exposes as its public
 * input/output; the opening `(amount, blinding)` stays private.
 */
export async function pedersenCommit(amount: bigint, blinding: bigint): Promise<PedersenPoint> {
  const bb = await api()
  const resp = bb.pedersenCommit({ inputs: [frBuffer(amount), frBuffer(blinding)], hashIndex: 0 })
  return {
    x: BigInt('0x' + Buffer.from(resp.point.x).toString('hex')),
    y: BigInt('0x' + Buffer.from(resp.point.y).toString('hex')),
  }
}
