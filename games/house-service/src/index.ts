/**
 * @msgboard/games-house-service — public surface.
 *
 * Re-exports the public API: startHouse, handleOpenRequest, coSignRound, handleRoundRequest (pure units),
 * faucetMint, and relevant types.
 */
export {
  handleOpenRequest,
  handleRoundRequest,
  coSignRound,
  startHouse,
  type OpenRequest,
  type Limits,
  type OpenCtx,
  type GrantEnvelope,
  type OpenGrantEnvelope,
  type OpenDeclineEnvelope,
  type RoundReq,
  type RoundCtx,
  type CoSignResult,
  type RoundResult,
  type HouseCfg,
  type HouseDeps,
} from './houseLoop'

export { faucetMint, type FaucetWalletClient } from './faucet'

export { makeBoardHouseDeps, type BoardHouseDepsOpts } from './boardDeps'
