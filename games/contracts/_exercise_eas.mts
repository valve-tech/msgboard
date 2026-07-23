/**
 * On-chain exercise of the DEPLOYED EAS leaderboard layer (test artifact, not committed).
 *
 * Read-backs on BOTH chains: each live resolver's immutable wiring (sudokuLog/wordleLog/rules/EAS)
 * and each registered schema record (uid → resolver/revocable/schema string).
 *
 * On 943 additionally a REAL end-to-end attestation through the production contracts:
 *   openPuzzle(fixture board, fresh id) → EAS.attest(real PLONK fixture proof) → getAttestation
 *   read-back + resolver spent-book check + duplicate-attest and tampered-proof rejections.
 *
 *   MNEMONIC=... RPC_URL=... CHAIN_ID=943 [EAS_EXECUTE=1] npx tsx _exercise_eas.mts
 */
import * as viem from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import { readFileSync } from 'node:fs'

const RPC = process.env.RPC_URL ?? 'https://one.valve.city/rpc/vk_demo/evm/943'
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 943)
const EXECUTE = process.env.EAS_EXECUTE === '1'
const mnemonic = process.env.MNEMONIC
if (!mnemonic) throw new Error('set MNEMONIC')

// Pinned from the deploy run (mirrors examples/games/web/src/config.ts).
const PINS: Record<number, Record<string, viem.Hex>> = {
  943: {
    eas: '0x9e84Aa4BD0C1931A34B14C1EC918A53C33e2B0F8',
    registry: '0x0a36739bAc658b0E3222CFe372077382Dc60a318',
    sudokuLog: '0xf700e0c1fd235719738cca1cdef6f41bfaef163c',
    wordleLog: '0xcd57eee1c31045d0d63153cf1d7c74a69402a8cb',
    sudokuResolver: '0x0e58f22a9fd1c7260d0add6eea809f49bf6fc75c',
    sudokuUid: '0x0de9a3bb2e72a1116f44d1a4a5e612d315143af9916e27572d073663e9877fc5',
    wordleResolver: '0x603e32ddaf5f4b6ada77e04bb7c44c4603f59eee',
    wordleUid: '0x68880687b7c28fa1618ad4f612173b23aef8443fc5df354d2e6693f6df243f37',
  },
  369: {
    eas: '0x9e84Aa4BD0C1931A34B14C1EC918A53C33e2B0F8',
    registry: '0x0a36739bAc658b0E3222CFe372077382Dc60a318',
    sudokuLog: '0x939cbb0f10b5f9e76861a179fbe666e1cae50ba7',
    wordleLog: '0x202255faa269a3d59ed45bd583539b9bd759b32b',
    sudokuResolver: '0x9e232e84e80fcac3c78de0820dabccf660511275',
    sudokuUid: '0x3a8ce1bd299f82fb7f25a88386fbf6320fa066db643f5bb995c67ec46b6a129e',
    wordleResolver: '0x921bfc21e69c65ed295dbdb7ed69c8c5161b1b1f',
    wordleUid: '0xd827ebf0849a1328cb1527195b426db2a8c65a2e18102fd79cdb39fff358fde8',
  },
}
const P = PINS[CHAIN_ID]
if (!P) throw new Error(`no pins for chain ${CHAIN_ID}`)

const SUDOKU_SCHEMA = 'uint256 puzzleId,uint256 player,uint256 nullifier,uint256[24] proof,uint256[81] puzzle'
const WORDLE_SCHEMA = 'uint256 challengeId,uint256 guessesUsed,uint256 guessesCommit,uint256[24] proof'
const EXERCISE_PUZZLE_ID = 774_421n // fresh id for the fixture board (leaves the canonical #1 alone)

const resolverAbi = viem.parseAbi([
  'function sudokuLog() view returns (address)',
  'function sudokuRules() view returns (address)',
  'function wordleLog() view returns (address)',
  'function wordleRules() view returns (address)',
  'function attestedNullifier(uint256) view returns (bool)',
  'function version() view returns (string)',
])
const registryAbi = viem.parseAbi([
  'function getSchema(bytes32 uid) view returns ((bytes32 uid, address resolver, bool revocable, string schema))',
])
const logAbi = viem.parseAbi([
  'function owner() view returns (address)',
  'function sudokuRules() view returns (address)',
  'function wordleRules() view returns (address)',
  'function puzzles(uint256) view returns (bytes32 puzzleHash, uint256 openedAt)',
  'function openPuzzle(uint256 puzzleId, uint256[81] puzzle)',
])
const easAbi = viem.parseAbi([
  'struct AttestationRequestData { address recipient; uint64 expirationTime; bool revocable; bytes32 refUID; bytes data; uint256 value; }',
  'struct AttestationRequest { bytes32 schema; AttestationRequestData data; }',
  'function attest(AttestationRequest request) payable returns (bytes32)',
  'function getAttestation(bytes32 uid) view returns ((bytes32 uid, bytes32 schema, uint64 time, uint64 expirationTime, uint64 revocationTime, bytes32 refUID, address recipient, address attester, bool revocable, bytes data))',
  'event Attested(address indexed recipient, address indexed attester, bytes32 uid, bytes32 indexed schemaUID)',
])

const chain = { id: CHAIN_ID, name: `chain-${CHAIN_ID}`, nativeCurrency: { name: 'PLS', symbol: 'PLS', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const
const pc = viem.createPublicClient({ chain, transport: viem.http(RPC) })
const account = mnemonicToAccount(mnemonic)
const wc = viem.createWalletClient({ account, chain, transport: viem.http(RPC) })
// Floor the legacy fee: 943's node quotes ~wei-level prices that never mine (same guard as the
// flipbook exercise) — anything under 0.1 gwei becomes 1 gwei.
const quoted = (await pc.getGasPrice()) * 3n
const gasPrice = quoted < viem.parseGwei('0.1') ? viem.parseGwei('1') : quoted
const legacy = { gasPrice, type: 'legacy' as const }

let failures = 0
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗ FAIL'} ${label}${detail ? ` (${detail})` : ''}`)
  if (!ok) failures++
}

console.log(`── EAS layer read-backs on chain ${CHAIN_ID} ──`)
const read = <T,>(address: viem.Hex, abi: viem.Abi, functionName: string, args: unknown[] = []) =>
  pc.readContract({ address, abi, functionName, args }) as Promise<T>

// Resolver immutables point at the exact live game contracts + verifiers.
const sLog = await read<viem.Hex>(P.sudokuResolver, resolverAbi, 'sudokuLog')
const sRules = await read<viem.Hex>(P.sudokuResolver, resolverAbi, 'sudokuRules')
const sLogRules = await read<viem.Hex>(P.sudokuLog, logAbi, 'sudokuRules')
check('SudokuSolveResolver.sudokuLog == live SudokuLog', sLog.toLowerCase() === P.sudokuLog.toLowerCase(), sLog)
check('SudokuSolveResolver.sudokuRules == SudokuLog.sudokuRules', sRules.toLowerCase() === sLogRules.toLowerCase(), sRules)
const wLog = await read<viem.Hex>(P.wordleResolver, resolverAbi, 'wordleLog')
const wRules = await read<viem.Hex>(P.wordleResolver, resolverAbi, 'wordleRules')
const wLogRules = await read<viem.Hex>(P.wordleLog, logAbi, 'wordleRules')
check('WordleSolveResolver.wordleLog == live WordleLog', wLog.toLowerCase() === P.wordleLog.toLowerCase(), wLog)
check('WordleSolveResolver.wordleRules == WordleLog.wordleRules', wRules.toLowerCase() === wLogRules.toLowerCase(), wRules)

// Registered schema records: exact string, exact resolver, irrevocable.
for (const [label, uid, resolver, schema] of [
  ['sudoku', P.sudokuUid, P.sudokuResolver, SUDOKU_SCHEMA],
  ['wordle', P.wordleUid, P.wordleResolver, WORDLE_SCHEMA],
] as const) {
  const rec = (await read<{ uid: viem.Hex; resolver: viem.Hex; revocable: boolean; schema: string }>(
    P.registry, registryAbi, 'getSchema', [uid],
  ))
  check(`${label} schema record intact`, rec.uid === uid && rec.schema === schema && rec.resolver.toLowerCase() === resolver.toLowerCase() && !rec.revocable)
}

if (!EXECUTE) {
  console.log(failures ? `\n${failures} FAILURES` : '\nread-backs complete (set EAS_EXECUTE=1 on 943 for the live attest)')
  process.exit(failures ? 1 : 0)
}

// ── live end-to-end attest (943): fixture board opened under a fresh id, fixture proof attested ──
console.log(`\n── live attestation exercise (chain ${CHAIN_ID}) ──`)
const fx = JSON.parse(readFileSync('test/foundry/fixtures/sudokuSolveProof.json', 'utf8'))
const proof = (fx.proof as string[]).map(BigInt)
const [nullifier, , , player] = (fx.pubSignals as string[]).map(BigInt)
const puzzle = (fx.vector.puzzle as number[]).map(BigInt)

const owner = await read<viem.Hex>(P.sudokuLog, logAbi, 'owner')
check('deployer owns SudokuLog (can open the fixture board)', owner.toLowerCase() === account.address.toLowerCase(), owner)

const [, openedAt] = await read<[viem.Hex, bigint]>(P.sudokuLog, logAbi, 'puzzles', [EXERCISE_PUZZLE_ID])
if (openedAt === 0n) {
  const hash = await wc.writeContract({ address: P.sudokuLog, abi: logAbi, functionName: 'openPuzzle', args: [EXERCISE_PUZZLE_ID, puzzle], ...legacy })
  const r = await pc.waitForTransactionReceipt({ hash })
  check('openPuzzle(fixture board)', r.status === 'success', hash)
} else {
  console.log(`  (puzzle ${EXERCISE_PUZZLE_ID} already open — reusing)`)
}

const data = viem.encodeAbiParameters(
  [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256[24]' }, { type: 'uint256[81]' }],
  [EXERCISE_PUZZLE_ID, player, nullifier, proof as never, puzzle as never],
)
const request = {
  schema: P.sudokuUid,
  data: { recipient: account.address, expirationTime: 0n, revocable: false, refUID: viem.zeroHash, data, value: 0n },
} as const

const alreadySpent = await read<boolean>(P.sudokuResolver, resolverAbi, 'attestedNullifier', [nullifier])
if (alreadySpent) {
  console.log('  (fixture nullifier already attested on this chain — asserting the terminal state instead)')
  check('resolver spent-book holds the fixture nullifier', alreadySpent)
} else {
  const attestHash = await wc.writeContract({ address: P.eas, abi: easAbi, functionName: 'attest', args: [request], ...legacy })
  const rcpt = await pc.waitForTransactionReceipt({ hash: attestHash })
  check('EAS.attest through the live resolver', rcpt.status === 'success', attestHash)
  const attested = viem.parseEventLogs({ abi: easAbi, logs: rcpt.logs, eventName: 'Attested' })[0]
  const uid = (attested?.args as { uid?: viem.Hex })?.uid
  check('Attested event carries a uid', !!uid, uid)
  const att = await read<{ schema: viem.Hex; attester: viem.Hex; recipient: viem.Hex; time: bigint; revocable: boolean; data: viem.Hex }>(
    P.eas, easAbi, 'getAttestation', [uid!],
  )
  check('attestation stored under the sudoku schema', att.schema === P.sudokuUid)
  check('attester + recipient are the exerciser', att.attester.toLowerCase() === account.address.toLowerCase() && att.recipient.toLowerCase() === account.address.toLowerCase())
  check('attestation is irrevocable', !att.revocable)
  check('attestation data round-trips', att.data === data)
  const [, oAt] = await read<[viem.Hex, bigint]>(P.sudokuLog, logAbi, 'puzzles', [EXERCISE_PUZZLE_ID])
  console.log(`  derived leaderboard elapsed = ${att.time - oAt}s (attestation.time - openedAt)`)
  check('resolver spent-book now holds the nullifier', await read<boolean>(P.sudokuResolver, resolverAbi, 'attestedNullifier', [nullifier]))
}

// Rejections must hold on the LIVE deployment too (simulation only — nothing sent).
const expectRevert = async (label: string, req: typeof request) => {
  try {
    await pc.simulateContract({ address: P.eas, abi: easAbi, functionName: 'attest', args: [req], account: account.address })
    check(label, false, 'simulation unexpectedly succeeded')
  } catch {
    check(label, true)
  }
}
await expectRevert('duplicate attest rejected (NullifierSpent)', request)
const tamperedProof = [...proof]
tamperedProof[0] ^= 1n
await expectRevert('tampered proof rejected (BadProof)', {
  ...request,
  data: {
    ...request.data,
    data: viem.encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256[24]' }, { type: 'uint256[81]' }],
      [EXERCISE_PUZZLE_ID, player, nullifier, tamperedProof as never, puzzle as never],
    ),
  },
})

console.log(failures ? `\n${failures} FAILURES` : '\n✅ live EAS layer exercised and verified')
process.exit(failures ? 1 : 0)
