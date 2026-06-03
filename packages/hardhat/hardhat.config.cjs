require('@nomicfoundation/hardhat-network-helpers')
require('./dist')
require('./dist/tasks')

module.exports = {
  solidity: '0.8.24',
  networks: {
    hardhat: {
      initialBaseFeePerGas: 0,
    },
  },
}
