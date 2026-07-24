import { encodeAbiParameters, type Hex } from 'viem'
import { encodeRouletteParams, type RouletteParams } from './roulette'

/**
 * paramsCodec — the ONE routed `gameId -> canonical param bytes` encoder.
 *
 * These bytes are the `params` blob the on-chain settle path binds to the house-signed
 * `OpenTerms.paramsHash` (`keccak256(params) == paramsHash`) and then DECODES per game in
 * `GamePayouts._<game>` (contracts/contracts/games/GamePayouts.sol). Off-chain the house computes
 * `paramsHash = keccak256(encodeGameParams(gameId, params))` at open time, and the permissionless
 * `HouseChannel.settleWithSeeds` / `GamePayouts.settle` decode this EXACT byte string on-chain — so the
 * encoding here MUST mirror each game's `abi.decode(params, …)` signature bit-for-bit.
 *
 * NOTE: this is DISTINCT from a game's `encodeRound` (the gameStateHash co-sign preimage), which encodes
 * (gameId, stake, …, raw) and, for the table games, encodes `risk` as a STRING rather than the on-chain
 * `riskIdx`. Do not confuse the two: only the encoding below is what the contract's `params` decode sees.
 */

const U256 = [{ type: 'uint256' }] as const
const U256_U256 = [{ type: 'uint256' }, { type: 'uint256' }] as const
const U256_ARR = [{ type: 'uint256[]' }] as const

// risk profile -> on-chain riskIdx (GamePayouts + GameTables: 0=low 1=medium 2=high).
const RISK_IDX: Record<string, bigint> = { low: 0n, medium: 1n, high: 2n }
function riskIdxOf(risk: unknown): bigint {
  const idx = RISK_IDX[String(risk)]
  if (idx === undefined) throw new Error(`paramsCodec: unknown risk "${String(risk)}"`)
  return idx
}

// bet label -> on-chain bet code, mirroring each game module's internal `betCode`.
const BACCARAT_BET: Record<string, bigint> = { player: 0n, banker: 1n, tie: 2n }
const DRAGON_TIGER_BET: Record<string, bigint> = { dragon: 0n, tiger: 1n, tie: 2n }
const ANDAR_BAHAR_BET: Record<string, bigint> = { andar: 0n, bahar: 1n }
function betCodeOf(map: Record<string, bigint>, bet: unknown): bigint {
  const code = map[String(bet)]
  if (code === undefined) throw new Error(`paramsCodec: unknown bet "${String(bet)}"`)
  return code
}

/**
 * Canonical `params` bytes for a game round, routed by `gameId`. The returned bytes hash (keccak256) to
 * the `OpenTerms.paramsHash` and are the exact blob `GamePayouts._<game>` decodes on-chain. Throws on an
 * unsupported gameId or malformed params (the caller surfaces this as an open-review decline).
 */
export function encodeGameParams(gameId: number, params: unknown): Hex {
  const p = params as Record<string, unknown>
  switch (gameId) {
    // ── single uint256 target games ──
    case 1: // dice — abi.decode(params, (uint256)) => targetX100
    case 2: // limbo — (uint256) => targetX100
      return encodeAbiParameters(U256, [BigInt(p.targetX100 as bigint)])
    case 6: // crash — (uint256) => autoCashout (== limbo target curve)
      return encodeAbiParameters(U256, [BigInt(p.autoCashoutX100 as bigint)])
    case 9: // monte — (uint256) => pick
      return encodeAbiParameters(U256, [BigInt(p.pick as number)])
    case 11: // baccarat — (uint256) => bet {player:0,banker:1,tie:2}
      return encodeAbiParameters(U256, [betCodeOf(BACCARAT_BET, p.bet)])
    case 12: // dragon-tiger — (uint256) => bet {dragon:0,tiger:1,tie:2}
      return encodeAbiParameters(U256, [betCodeOf(DRAGON_TIGER_BET, p.bet)])
    case 13: // andar-bahar — (uint256) => bet {andar:0,bahar:1}
      return encodeAbiParameters(U256, [betCodeOf(ANDAR_BAHAR_BET, p.bet)])

    // ── two-uint256 games ──
    case 10: // dicex2 — (uint256 targetX100, uint256 mode) mode 0=both 1=either
      return encodeAbiParameters(U256_U256, [BigInt(p.targetX100 as bigint), p.mode === 'both' ? 0n : 1n])
    case 3: // plinko — (uint256 rows, uint256 riskIdx)
    case 7: // pachinko — (uint256 rows, uint256 riskIdx)
      return encodeAbiParameters(U256_U256, [BigInt(p.rows as number), riskIdxOf(p.risk)])
    case 8: // wheel — (uint256 segments, uint256 riskIdx)
      return encodeAbiParameters(U256_U256, [BigInt(p.segments as number), riskIdxOf(p.risk)])

    // ── dynamic-array / tuple games ──
    case 4: // keno — (uint256[] picks)
      return encodeAbiParameters(U256_ARR, [(p.picks as number[]).map((x) => BigInt(x))])
    case 25: // roulette — RouletteBet[] (tuple[] of (uint8,uint8,uint256))
      return encodeRouletteParams(p as unknown as RouletteParams)

    // ── no-params games ──
    case 24: // cascade — GamePayouts._cascade takes no params; the blob is empty bytes.
      return '0x'

    default:
      throw new Error(`paramsCodec: unsupported gameId ${gameId}`)
  }
}
