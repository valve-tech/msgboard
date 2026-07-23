/**
 * Mint a MsgBoard proof-of-work stamp natively (Rust). Pure compute — no key, no network.
 *
 * @returns a 40-byte array `nonce_be(8) ‖ hash(32)`, or `null` if `maxIters` was exhausted.
 *          (Returned as a Node `Buffer` at runtime; typed as its `Uint8Array` supertype so this
 *          package needs no `@types/node`. Pass Node `Buffer`s for the inputs — they are Uint8Arrays.)
 */
export function stamp(req: {
  category: Uint8Array
  data: Uint8Array
  workMultiplier: number
  workDivisor: number
  blockHash: Uint8Array
  startNonce: number
  maxIters: number
}): Uint8Array | null
