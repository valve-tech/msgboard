import { encodeAbiParameters, type Hex } from 'viem'
import type { Game, RoundOutcome } from '../game'

/** Which face the player bet on. */
export type CoinSide = 'heads' | 'tails'

export interface CoinFlipParams {
  /** The face the player bet on. A win pays 2x (no house edge). */
  pick: CoinSide
}

// pick <-> on-chain uint8 code, mirroring the encodeRound / paramsCodec encoding.
const PICK_CODE: Record<CoinSide, bigint> = { heads: 0n, tails: 1n }
export function pickCode(pick: CoinSide): bigint {
  const code = PICK_CODE[pick]
  if (code === undefined) throw new Error(`coinflip: unknown pick "${String(pick)}"`)
  return code
}

/**
 * Outcome side from round randomness: parity of `raw` — even -> heads, odd -> tails.
 * Same convention as `coinFlipOutcome` (games/core/src/secrets.ts) and the landing UI.
 */
export function coinFlipSide(raw: bigint): CoinSide {
  return (raw & 1n) === 0n ? 'heads' : 'tails'
}

/**
 * coinflip — a FAIR 50/50 coin paying exactly 2x with NO house edge. This is an honest showcase of a
 * provably-fair coin: a sub-2x "fair" coin would be dishonest, so `maxMultiplierX100` is a flat 200n.
 * The side is the parity of `raw = roundRandom(serverSeed, clientSeed, nonce)`; neither party can bias
 * it (house commits its seed blind, player reveals its seed only after OPEN is co-signed).
 */
export const coinflip: Game<CoinFlipParams> = {
  gameId: 5,
  maxMultiplierX100(params): bigint {
    pickCode(params.pick) // validate the pick; the ceiling itself is fixed at 2.00x.
    return 200n
  },
  settleRound(stake, params, raw): RoundOutcome {
    pickCode(params.pick) // reject a malformed pick before settling.
    const side = coinFlipSide(raw)
    const win = side === params.pick
    if (!win) return { win: false, playerDelta: -stake, multiplierX100: 0n }
    return { win: true, playerDelta: stake, multiplierX100: 200n }
  },
  encodeRound(stake, params, raw): Hex {
    return encodeAbiParameters(
      [{ type: 'uint8' }, { type: 'uint256' }, { type: 'uint8' }, { type: 'uint256' }],
      [this.gameId, stake, Number(pickCode(params.pick)), raw],
    )
  },
}
