import { encodeAbiParameters, type Hex } from 'viem'
import { HUNDREDTHS, type Game, type RoundOutcome } from '../game'
import { limboResultX100 } from './limbo'

/**
 * Crash — single-player auto-cashout form (the trustless one).
 *
 * The player commits an AUTO-CASHOUT target at OPEN (before the round random is known). The round's
 * "crash point" C is the same seed-derived curve as limbo: C = (1-edge)/(1-U). The player wins iff
 * their committed auto-cashout target is reached before the crash (autoCashout <= C), and is paid
 * exactly the auto-cashout multiplier. This is structurally identical to limbo — limbo's `target` is
 * crash's `autoCashout` — so it rides the same recompute-settle rails with ZERO new math.
 *
 * NOTE: a *live manual cashout* crash (cash out mid-rise) is a different, stateful game: it needs a
 * co-signed CASH_OUT step recorded BEFORE the seed-determined C is revealed, so the player cannot
 * cash out after seeing the crash. That is the P3/mines-style form (Phase 2). This module is the
 * pre-committed auto-cashout variant, which is fully stateless and trustless on its own.
 */
export interface CrashParams {
  /** auto-cashout target in hundredths: 2.00x == 200. Range [100 (1.00x), 99_000_000 (990000.00x)]. */
  autoCashoutX100: bigint
}

const U_SPACE = 1_000_000n // u in [0, 999_999] models U in [0,1) at 1e-6 resolution — mirror limbo.
const MIN_CASHOUT = 100n // 1.00x
// Largest C the curve can return (u = U_SPACE-1): (1-edge)*U_SPACE == 99_000_000 (990000.00x).
// Above this, no round can ever reach the target. Mirror limbo's MAX_TARGET.
const MAX_CASHOUT = limboResultX100(U_SPACE - 1n) // 99_000_000n

/** the round's crash point in hundredths, from the round random — identical curve to limbo. */
export function crashPointX100(raw: bigint): bigint {
  return limboResultX100(raw % U_SPACE)
}

export const crash: Game<CrashParams> = {
  gameId: 6,
  maxMultiplierX100(params): bigint {
    // Every win pays the player's chosen auto-cashout exactly — that IS the escrow ceiling.
    if (params.autoCashoutX100 < MIN_CASHOUT || params.autoCashoutX100 > MAX_CASHOUT) {
      throw new Error('crash: auto-cashout out of range')
    }
    return params.autoCashoutX100
  },
  settleRound(stake, params, raw): RoundOutcome {
    if (params.autoCashoutX100 < MIN_CASHOUT) throw new Error('crash: auto-cashout below 1.00x')
    if (params.autoCashoutX100 > MAX_CASHOUT) throw new Error('crash: auto-cashout above max (990000.00x)')
    const crashAtX100 = crashPointX100(raw)
    const win = crashAtX100 >= params.autoCashoutX100
    if (!win) return { win: false, playerDelta: -stake, multiplierX100: 0n }
    const playerDelta = (stake * params.autoCashoutX100) / HUNDREDTHS - stake
    return { win: true, playerDelta, multiplierX100: params.autoCashoutX100 }
  },
  encodeRound(stake, params, raw): Hex {
    return encodeAbiParameters(
      [{ type: 'uint8' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }] as const,
      [this.gameId, stake, params.autoCashoutX100, raw],
    ) as Hex
  },
}
