import * as viem from 'viem'

/** The phases shared by both games (a superset; a game uses the subset it needs). */
export type Phase = 'open' | 'filling' | 'armed' | 'drawing' | 'settled' | 'paid' | 'refunded' | 'chopped'

/** A reconstructed instance state: its decoded entries plus the current phase and (if cast) seed. */
export type RoundState<TEntry> = {
  instanceId: viem.Hex
  phase: Phase
  entries: TEntry[]
  seed?: viem.Hex
  draw?: bigint
}

/**
 * Build a RoundState from raw entry records using a game's decodeEntry. The phase and seed are
 * supplied by the caller (read from contract events/state); this keeps the reader game-agnostic —
 * it only maps raw entries through the game's pure decoder.
 */
export const toRoundState = <TEntry>(
  instanceId: viem.Hex,
  phase: Phase,
  rawEntries: unknown[],
  decodeEntry: (raw: unknown) => TEntry,
  extras: { seed?: viem.Hex; draw?: bigint } = {},
): RoundState<TEntry> => ({
  instanceId,
  phase,
  entries: rawEntries.map(decodeEntry),
  ...extras,
})
