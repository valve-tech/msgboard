/** A canonical parameter preset surfaced prominently so liquidity concentrates (anti-fragmentation). */
export type Preset<TParams> = {
  label: string
  params: TParams
}

/**
 * A game is four pure methods plus its canonical presets. settle takes the seed as an INPUT only —
 * a game cannot route player data back into the seed (fairness-as-types).
 *
 * @typeParam TParams  the instance parameters (e.g. coin-flip stake+subset; raffle tuple)
 * @typeParam TEntry   a decoded player entry (e.g. a side; a committed/revealed ticket)
 * @typeParam TOutcome the settlement result (e.g. the winning side; the winning ticket)
 */
export type Game<TParams, TEntry, TOutcome> = {
  /** Validate and normalise raw instance parameters; throw on invalid input (fail fast). */
  parseParams: (raw: unknown) => TParams
  /** Decode one on-chain entry record into the game's entry shape. */
  decodeEntry: (raw: unknown) => TEntry
  /** Whether an instance with these entries may be armed (the fill condition). */
  canArm: (params: TParams, entries: TEntry[]) => boolean
  /** Settle deterministically from params, entries, and the validator seed (seed is input-only). */
  settle: (params: TParams, entries: TEntry[], seed: `0x${string}`) => TOutcome
  /** The canonical presets the front end nudges toward. */
  presets: Preset<TParams>[]
}
