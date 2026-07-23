import { buildModule } from "@nomicfoundation/hardhat-ignition/modules"

// Deploys the MsgBoard-games settlement family: the Chips ERC20 unit of account, the optimistic
// HouseBankroll, and the escrowed HouseChannel (both bound to Chips). houseKey + pool funding are
// post-deploy operator steps (setHouseKey / fundHouse), not constructor args.
const MsgBoardGamesModule = buildModule("MsgBoardGamesModule", (m) => {
  const chips = m.contract("Chips", [])
  const bankroll = m.contract("HouseBankroll", [chips])
  const channel = m.contract("HouseChannel", [chips])
  return { chips, bankroll, channel }
})

export default MsgBoardGamesModule
