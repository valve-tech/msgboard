import type { Address, Hex } from 'viem'

export type OpenedLog = {
  roundId: Hex; tableId: Hex; player: Address; side: number
  stake: bigint; payout: bigint; subsetHash: Hex; key: Hex; openedAtBlock: bigint
}
export type SettledLog = {
  roundId: Hex; tableId: Hex; player: Address; won: boolean
  payout: bigint; seed: Hex; settledAtBlock: bigint
}

/**
 * Replay a settled round purely from its block-anchored logs. No contract getters, no server: given
 * the RoundOpened + RoundSettled logs (and the seed they carry, which also lives permanently in
 * IRandom for the round's key), recompute the winner and payout and confirm the settle log agrees.
 */
export const verifyRound = (opened: OpenedLog, settled: SettledLog): { ok: boolean; reasons: string[] } => {
  const reasons: string[] = []
  if (opened.roundId !== settled.roundId) reasons.push('roundId mismatch between open and settle logs')
  if (opened.payout !== settled.payout) reasons.push('payout differs from the open-snapshot payout')
  const parityWin = (BigInt(settled.seed) & 1n) === BigInt(opened.side)
  if (parityWin !== settled.won) reasons.push(`won=${settled.won} contradicts seed parity (${parityWin})`)
  return { ok: reasons.length === 0, reasons }
}
