// Generates golden msgpow vectors from @msgboard/core at a LOW difficulty so a valid nonce is
// found instantly. Every message is version 1; the scheme is chosen by which core function grinds
// it. Writes three files under packages/foundry/test/vectors/:
//   valid.json    — a LEGACY stamp (fixed 32-byte challenge encoding), asserted with verifyLegacy
//   boundary.json — a LEGACY stamp whose challengeX < 2^248 (a leading zero byte), so the suite
//                   exercises the 31-vs-32-byte case the old `minimalBytes` encoding got wrong
//   v2.json       — a REVISED (canonical) stamp plus intermediate digests and a pinned digest fixture
const path = require('node:path')
const fs = require('node:fs')
const repo = path.resolve(__dirname, '..', '..', '..')
const core = require(path.join(repo, 'packages/core/dist/index.js'))
const { bytesToHex, keccak256, toHex, numberToHex } = require(path.join(repo, 'node_modules/viem'))

const outDir = path.join(__dirname, '..', 'test', 'vectors')
fs.mkdirSync(outDir, { recursive: true })

function write(name, obj) {
  fs.writeFileSync(path.join(outDir, name), JSON.stringify(obj, null, 2) + '\n')
  console.log(`wrote test/vectors/${name}:`, obj)
}

// ── legacy: valid stamp ──────────────────────────────────────────────────────────
// workMultiplier/workDivisor chosen so difficulty = 2^24 * wm / wd = 256.
{
  const workMultiplier = 1n
  const workDivisor = 65536n
  const category = core.categoryHash('gasmoneyplease')
  const data = '0x'
  const blockHash = '0x' + '00'.repeat(32)
  const difficulty = core.difficulty({ workMultiplier, workDivisor }, 0) // 256n

  let nonce = 0n
  let valid = null
  while (nonce < 10000000n) {
    nonce += 1n
    const msg = { version: 1, blockHash, category, data, nonce, workMultiplier, workDivisor }
    if (core.checkWorkLegacy(msg, difficulty)) {
      valid = msg
      break
    }
  }
  if (!valid) throw new Error('no legacy vector found')

  write('valid.json', {
    version: 1,
    nonce: valid.nonce.toString(),
    blockHash,
    category,
    data,
    workMultiplier: workMultiplier.toString(),
    workDivisor: workDivisor.toString(),
    difficulty: difficulty.toString(),
    challengeX: bytesToHex(core.getChallengeLegacy(valid)),
    workHash: core.checkWorkLegacy(valid, difficulty),
  })
}

// ── legacy: boundary stamp (challengeX < 2^248, leading zero byte) ─────────────────
// factors give difficulty 1, so EVERY nonce is a winner; we scan for the first nonce whose
// challenge x-coordinate has a leading zero byte. Under the old `minimalBytes` encoding this x
// would emit 31 bytes and the workHash would differ from core — so this vector fails against the
// bug and passes only with the 32-byte fix.
{
  const BOUNDARY = 2n ** 248n
  const category = keccak256(toHex('pow-encoding-test'))
  const data = '0x00'
  const blockHash = keccak256(toHex('pow-encoding-block'))
  const workMultiplier = 1n
  const workDivisor = BigInt(2 ** 24 + 1 * 10000) // dataLen = 1
  const difficulty = core.difficulty({ workMultiplier, workDivisor }, 1) // 1n

  let nonce = 0n
  let found = null
  while (nonce < 10000000n) {
    nonce += 1n
    const msg = { version: 1, blockHash, category, data, nonce, workMultiplier, workDivisor }
    const x = core.getChallengeLegacy(msg)
    if (x.length !== 32) throw new Error(`core.getChallengeLegacy returned ${x.length} bytes — expected 32`)
    if (BigInt(bytesToHex(x)) < BOUNDARY) {
      // sanity: a value below 2^248 must have a leading zero byte in its 32-byte encoding
      if (x[0] !== 0) throw new Error('boundary value has no leading zero byte')
      found = msg
      break
    }
  }
  if (!found) throw new Error('no boundary vector found')

  write('boundary.json', {
    version: 1,
    nonce: found.nonce.toString(),
    blockHash,
    category,
    data,
    workMultiplier: workMultiplier.toString(),
    workDivisor: workDivisor.toString(),
    difficulty: difficulty.toString(),
    challengeX: bytesToHex(core.getChallengeLegacy(found)),
    workHash: core.checkWorkLegacy(found, difficulty),
  })
}

// ── revised: valid stamp + intermediate digests + pinned digest fixture ──────────
{
  // Pinned digest fixture (cross-check target). wm=wd=1 makes the difficulty huge, so this is a
  // DIGEST fixture only — we assert payloadHash/scalarHash, not that it clears the target. The
  // version byte here is fixed transcript input for the raw digest cross-check; it pins the
  // scalarHash constant and is not a message-version marker.
  const fixtureMsg = {
    version: 2,
    blockHash: keccak256(toHex('v2-golden-block')),
    category: keccak256(toHex('v2-golden-cat')),
    data: '0x0102030405',
    nonce: 42n,
    workMultiplier: 1n,
    workDivisor: 1n,
  }
  const fixturePayloadHash = core.payloadHash(fixtureMsg)
  const fixtureScalarHash = core.scalarHash(fixtureMsg, Buffer.from(fixturePayloadHash.slice(2), 'hex'))

  // Valid revised stamp (version 1). difficulty = 256 → target = 2^256/256 = 2^248, so ~1 nonce in
  // 256 passes.
  const workMultiplier = 1n
  const workDivisor = 65536n
  const category = keccak256(toHex('v2-stamp-cat'))
  const data = '0x'
  const blockHash = keccak256(toHex('v2-stamp-block'))
  const difficulty = core.difficulty({ workMultiplier, workDivisor }, 0) // 256n

  let nonce = 0n
  let valid = null
  let validHash = null
  while (nonce < 10000000n) {
    nonce += 1n
    const msg = { version: 1, blockHash, category, data, nonce, workMultiplier, workDivisor }
    const h = core.checkWork(msg, difficulty)
    if (h) {
      valid = msg
      validHash = h
      break
    }
  }
  if (!valid) throw new Error('no revised vector found')

  const ph = core.payloadHash(valid)
  const sh = core.scalarHash(valid, Buffer.from(ph.slice(2), 'hex'))

  write('v2.json', {
    fixture: {
      version: 2,
      nonce: fixtureMsg.nonce.toString(),
      blockHash: fixtureMsg.blockHash,
      category: fixtureMsg.category,
      data: fixtureMsg.data,
      workMultiplier: fixtureMsg.workMultiplier.toString(),
      workDivisor: fixtureMsg.workDivisor.toString(),
      payloadHash: fixturePayloadHash,
      scalarHash: fixtureScalarHash,
    },
    stamp: {
      version: 1,
      nonce: valid.nonce.toString(),
      blockHash,
      category,
      data,
      workMultiplier: workMultiplier.toString(),
      workDivisor: workDivisor.toString(),
      difficulty: difficulty.toString(),
      powTarget: numberToHex(core.powTarget(difficulty), { size: 32 }),
      payloadHash: ph,
      scalarHash: sh,
      workHash: validHash,
    },
  })
}
