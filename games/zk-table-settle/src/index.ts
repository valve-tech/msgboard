// @msgboard/zk-table-settle — the GENERIC table-driven ZK settle: ONE Noir
// circuit + ONE UltraHonk verifier for the whole pure-RNG game family (dice,
// limbo, roulette, wheel, keno, plinko, monte, ...) instead of one generated
// verifier per game. The payout is a piecewise-constant paytable lookup bound to
// the OpenTerms paramsHash; seeds stay private (mode-2 seed privacy).
export const PACKAGE = '@msgboard/zk-table-settle'

export { compileCircuit, type Compiled } from './compile'
export { prove, type Proof } from './prove'
export { verify } from './verify'

export {
  MAX_SEG,
  ROULETTE_RED,
  assertWellFormed,
  lookupMultX100,
  diceTable,
  rouletteStraightUpTable,
  rouletteColorTable,
  encodeTableParams,
  paramsHashOfTable,
  type Segment,
  type RangeTable,
} from './paytable'

export {
  tableBucket,
  tablePayout,
  tablePublics,
  tableSettleInputs,
  type TableRound,
  type TablePublics,
} from './tableSettle'
