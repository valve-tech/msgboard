// Generates a golden msgpow vector from @msgboard/core at a LOW difficulty so a
// valid nonce is found instantly. Writes packages/foundry/test/vectors/valid.json.
const path = require('node:path')
const fs = require('node:fs')
const repo = path.resolve(__dirname, '..', '..', '..')
const core = require(path.join(repo, 'packages/core/dist/index.js'))
const { bytesToHex } = require(path.join(repo, 'node_modules/viem'))

// workMultiplier/workDivisor chosen so difficulty = (2^24 * wm)/wd = 256
const workMultiplier = 1n
const workDivisor = 65536n
const category = core.categoryHash('gasmoneyplease') // 32-byte hex
const data = '0x'
const blockHash = '0x' + '00'.repeat(32)
const difficulty = core.difficulty({ workMultiplier, workDivisor }, 0) // 256n

let nonce = 0n
let valid = null
while (nonce < 10000000n) {
  nonce += 1n
  const msg = { version: 1, blockHash, category, data, nonce, workMultiplier, workDivisor }
  if (core.checkWork(msg, difficulty)) {
    valid = msg
    break
  }
}
if (!valid) throw new Error('no vector found')

const vector = {
  nonce: valid.nonce.toString(),
  blockHash,
  category,
  data,
  workMultiplier: workMultiplier.toString(),
  workDivisor: workDivisor.toString(),
  difficulty: difficulty.toString(),
  challengeX: bytesToHex(core.getChallenge(valid)),
  workHash: core.checkWork(valid, difficulty),
}
const outDir = path.join(__dirname, '..', 'test', 'vectors')
fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(path.join(outDir, 'valid.json'), JSON.stringify(vector, null, 2) + '\n')
console.log('wrote test/vectors/valid.json:', vector)
