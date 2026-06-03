// Grinds a valid msgboard proof-of-work message via @msgboard/core and prints its RLP
// (0x-hex) to stdout, for consumption by Foundry's vm.ffi (see script/PostMessage.s.sol).
//
// Usage: node script/grind-message.cjs <rpcUrl> [data]
// NOTE: proof of work takes MINUTES at production difficulty. Only the RLP hex is written to
// stdout; everything else goes to stderr so vm.ffi gets a clean result.
const path = require('node:path')
const repo = path.resolve(__dirname, '..', '..', '..')
const core = require(path.join(repo, 'packages/core/dist/index.js'))
const { createPublicClient, http } = require(path.join(repo, 'node_modules/viem'))

async function main() {
  const rpcUrl = process.argv[2]
  const data = process.argv[3] || 'hello from foundry'
  if (!rpcUrl) {
    console.error('usage: node script/grind-message.cjs <rpcUrl> [data]')
    process.exit(1)
  }
  const client = createPublicClient({ transport: http(rpcUrl) })
  const board = new core.MsgBoardClient(client)
  // sync the board's difficulty factors so the grind matches what the node will accept
  const status = await board.status()
  board.setDifficultyFactors(BigInt(status.workMultiplier), BigInt(status.workDivisor))
  console.error(`grinding (difficulty factors ${status.workMultiplier}/${status.workDivisor})...`)
  const work = await board.doPoW('gasmoneyplease', data)
  process.stdout.write(core.toRLP(work.message)) // 0x-hex; vm.ffi decodes to bytes
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
