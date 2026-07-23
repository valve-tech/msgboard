// @msgboard/zk-settle — Track 2 ZK privacy (Noir) off-chain prove/verify.
// Public API filled out incrementally per task (final surface in Task 6).
export const PACKAGE = '@msgboard/zk-settle'

export { compileCircuit, type Compiled } from './compile'
export { prove, type Proof } from './prove'
export { verify } from './verify'
export { execute, type AbiValue } from './execute'
export { roundRandomPreimage } from './abiEncode'
export { GAME_DICE, GAME_LIMBO } from './gameId'
export { pedersenCommit, type PedersenPoint } from './pedersen'
export {
  diceOutcome,
  diceSettleCommitments,
  commitmentsToPublicInputs,
  diceSettleInputs,
  type DiceSettleAmounts,
  type DiceSettleBlindings,
  type DiceSettleWitness,
  type DiceSettleCommitments,
} from './diceSettle'
export {
  limboOutcome,
  limboSettleCommitments,
  commitmentsToPublicInputs as limboCommitmentsToPublicInputs,
  limboSettleInputs,
  type LimboSettleAmounts,
  type LimboSettleBlindings,
  type LimboSettleWitness,
  type LimboSettleCommitments,
} from './limboSettle'

// M2 (Track-2, Milestone 2) — the ON-CHAIN dice settle witness builder. The
// circuit/proof feed the generated Solidity UltraHonk verifier (mode-2 settle).
export {
  diceOnchainPayout,
  diceOnchainPublics,
  diceOnchainInputs,
  type DiceOnchainRound,
  type DiceOnchainPublics,
} from './diceSettleOnchain'

// Task 6 — the unified off-chain M1 E2E settle API (dice + limbo).
export {
  proveSettle,
  verifySettle,
  trackOneSettle,
  settleAmounts,
  settleGameId,
  type SettleGame,
  type SettleRound,
  type SettleBlindings,
  type SettleAmounts,
  type SettleOutcome,
  type SettleProof,
} from './settle'
