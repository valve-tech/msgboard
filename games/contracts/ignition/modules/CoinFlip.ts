import { buildModule } from "@nomicfoundation/hardhat-ignition/modules"
import RandomModule from "./Random"

const CoinFlipModule = buildModule("CoinFlipModule", (m) => {
  const { random } = m.useModule(RandomModule)
  const randomContract = m.contractAt('Random', random, {
    after: [random],
  })
  const coinFlip = m.contract('CoinFlip', [randomContract.address], {
    after: [randomContract],
  })

  return { coinFlip }
})

export default CoinFlipModule
