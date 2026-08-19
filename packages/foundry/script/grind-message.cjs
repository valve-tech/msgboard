// Grinds a valid msgboard proof-of-work message via @msgboard/core and prints its RLP
// (0x-hex) to stdout, for consumption by Foundry's vm.ffi (see script/PostMessage.s.sol).
//
// v1 (default) — grinds against a LIVE node so the block + difficulty factors match:
//   node script/grind-message.cjs <rpcUrl> [data]
//
// v2 (revised algorithm) — grinds OFFLINE from explicit inputs (no live node needed):
//   MSG_VERSION=2 node script/grind-message.cjs \
//     --category <string|0xhex> --data <0xhex> --block <0x32-byte hash> \
//     --wm <workMultiplier> --wd <workDivisor>
//
// NOTE: proof of work takes MINUTES at production difficulty. Only the RLP hex is written to
// stdout; everything else goes to stderr so vm.ffi gets a clean result.
const path = require('node:path')
const repo = path.resolve(__dirname, '..', '..', '..')
const core = require(path.join(repo, 'packages/core/dist/index.js'))

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback
}

// ── v2: offline grind with the revised algorithm ──────────────────────────────────
async function grindV2() {
  const category = core.categoryHash(arg('category', 'gasmoneyplease'))
  const data = core.encodeData(arg('data', '0x'))
  const blockHash = arg('block', '0x' + '00'.repeat(32))
  const workMultiplier = BigInt(arg('wm', '1'))
  const workDivisor = BigInt(arg('wd', '65536'))
  const dataLen = (data.length - 2) / 2
  const difficulty = core.difficulty({ workMultiplier, workDivisor }, dataLen)

  const message = { version: 2, blockHash, category, data, nonce: 0n, workMultiplier, workDivisor }
  console.error(`grinding v2 (difficulty ${difficulty}, factors ${workMultiplier}/${workDivisor})...`)
  const search = core.createChallengeSearchV2(message)
  while (message.nonce < 100000000n) {
    if (search.next(difficulty)) {
      process.stdout.write(core.toRLP(message)) // 0x-hex; vm.ffi decodes to bytes
      return
    }
  }
  throw new Error('no v2 nonce found')
}

// ── v1: grind against a live node (legacy algorithm) ──────────────────────────────
async function grindV1() {
  const { createPublicClient, http } = require(path.join(repo, 'node_modules/viem'))
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

async function main() {
  if (process.env.MSG_VERSION === '2') return grindV2()
  return grindV1()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
