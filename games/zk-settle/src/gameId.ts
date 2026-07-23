// Canonical gameId constants — MUST mirror the `gameId` field on each game in
// @msgboard/games (dice.ts gameId: 1, limbo.ts gameId: 2) and the on-chain
// GamePayouts switch. These are the values fed into encodeRound's keccak and the
// circuit's gameId branch; a mismatch silently changes the round hash.
export const GAME_DICE = 1
export const GAME_LIMBO = 2
