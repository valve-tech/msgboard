import { buildModule } from "@nomicfoundation/hardhat-ignition/modules"
import RandomModule from "./Random"

const RaffleModule = buildModule("RaffleModule", (m) => {
  const { random } = m.useModule(RandomModule)
  const randomContract = m.contractAt('Random', random, {
    after: [random],
  })
  const raffle = m.contract('Raffle', [randomContract.address], {
    after: [randomContract],
  })

  return { raffle }
})

export default RaffleModule
