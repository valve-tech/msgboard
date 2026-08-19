/**
 * The proof-of-work scheme the board verifies with. Both schemes are message version 1; the board
 * selects one. 'legacy' is the pre-revision scheme (the live 943 board still runs it). 'revised' is
 * the canonical spec scheme. The default is 'legacy'.
 */
export type PowAlgorithm = 'legacy' | 'revised'

export type MsgBoardSettings = {
  enabled: boolean
  workMultiplier: bigint
  workDivisor: bigint
  messageSizeLimit: bigint
  boardCountLimit: bigint
  blockRangeLimit: bigint
  algorithm: PowAlgorithm
}
