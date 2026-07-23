/**
 * Deploy the EAS solve resolvers (SudokuSolveResolver + WordleSolveResolver) and register their
 * schemas — the SKILL_GAMES_DESIGN.md "leaderboard = EAS attestation" layer. The EAS +
 * SchemaRegistry instances are the Provex-controlled PulseChain deployments pinned in @provex/eas
 * (EAS has no canonical PulseChain deployment); the game contracts (SudokuLog / WordleLog) are the
 * chain's live ones, pinned below to match the web config.
 *
 * Both schemas register with revocable=false (a proven solve cannot un-happen) and their resolver,
 * so an attestation can only ever exist if the PLONK solve proof verifies (test/foundry/
 * SolveResolvers.t.sol proves every path against a real EAS).
 *
 * Reuses deploy-skill.ts's deployContractLegacy + gas.ts's resolveLegacyFee. Legacy type-0 gas
 * (PulseChain ~0 base fee). DRY-RUNS unless DEPLOY_EXECUTE=1. Never sends on import.
 *
 *   MNEMONIC=... RPC_URL=... CHAIN_ID=943 npx tsx scripts/deploy-eas-resolvers.ts            # dry-run
 *   MNEMONIC=... RPC_URL=... CHAIN_ID=943 DEPLOY_EXECUTE=1 npx tsx scripts/deploy-eas-resolvers.ts
 */
import * as viem from 'viem'
import { resolveLegacyFee } from './gas'
import { deployContractLegacy } from './deploy-skill'

// The live game contracts per chain (mirrors examples/games/web/src/config.ts).
const GAME_LOGS: Record<number, { sudokuLog: viem.Hex; wordleLog: viem.Hex }> = {
  943: {
    sudokuLog: '0xf700e0c1fd235719738cca1cdef6f41bfaef163c',
    wordleLog: '0xcd57eee1c31045d0d63153cf1d7c74a69402a8cb',
  },
  369: {
    sudokuLog: '0x939cbb0f10b5f9e76861a179fbe666e1cae50ba7',
    wordleLog: '0x202255faa269a3d59ed45bd583539b9bd759b32b',
  },
}

// Field order is load-bearing — it IS the attestation encoding (see the resolvers' headers).
const SUDOKU_SCHEMA = 'uint256 puzzleId,uint256 player,uint256 nullifier,uint256[24] proof,uint256[81] puzzle'
const WORDLE_SCHEMA = 'uint256 challengeId,uint256 guessesUsed,uint256 guessesCommit,uint256[24] proof'

const registryAbi = [
  {
    type: 'function',
    name: 'register',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'schema', type: 'string' },
      { name: 'resolver', type: 'address' },
      { name: 'revocable', type: 'bool' },
    ],
    outputs: [{ type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'getSchema',
    stateMutability: 'view',
    inputs: [{ name: 'uid', type: 'bytes32' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'uid', type: 'bytes32' },
          { name: 'resolver', type: 'address' },
          { name: 'revocable', type: 'bool' },
          { name: 'schema', type: 'string' },
        ],
      },
    ],
  },
] as const satisfies viem.Abi

/** The registry's deterministic UID: keccak256(abi.encodePacked(schema, resolver, revocable)). */
const schemaUid = (schema: string, resolver: viem.Hex, revocable: boolean): viem.Hex =>
  viem.keccak256(
    viem.encodePacked(['string', 'address', 'bool'], [schema, resolver, revocable]),
  )

function loadArtifact(name: string): { abi: viem.Abi; bytecode: viem.Hex } {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const path = require('node:path') as typeof import('node:path')
  const a = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, `../artifacts/contracts/eas/${name}.sol/${name}.json`), 'utf8'),
  )
  return { abi: a.abi as viem.Abi, bytecode: a.bytecode as viem.Hex }
}

async function main(): Promise<void> {
  /* eslint-disable no-console */
  const { mnemonicToAccount } = await import('viem/accounts')
  // ESM-only package — the per-chain Provex EAS deployment addresses (self-deployed on 943 + 369).
  const provexEas = (await import('@provex/eas/eas')) as {
    EAS_ADDRESSES_BY_CHAIN_ID: Record<number, viem.Hex | null>
    SCHEMA_REGISTRY_ADDRESSES_BY_CHAIN_ID: Record<number, viem.Hex | null>
  }

  const RPC = process.env.RPC_URL ?? 'https://rpc.v4.testnet.pulsechain.com'
  const CHAIN_ID = Number(process.env.CHAIN_ID ?? 943)
  const BUFFER_BPS = BigInt(process.env.GAS_BUFFER_BPS ?? 20_000n)
  const EXECUTE = process.env.DEPLOY_EXECUTE === '1'

  const mnemonic = process.env.MNEMONIC
  if (!mnemonic) throw new Error('set MNEMONIC in the environment (games/contracts/.env)')
  const deployer = mnemonicToAccount(mnemonic)

  const eas = provexEas.EAS_ADDRESSES_BY_CHAIN_ID[CHAIN_ID]
  const registry = provexEas.SCHEMA_REGISTRY_ADDRESSES_BY_CHAIN_ID[CHAIN_ID]
  const logs = GAME_LOGS[CHAIN_ID]
  if (!eas || !registry) throw new Error(`no Provex EAS deployment pinned for chain ${CHAIN_ID} (@provex/eas)`)
  if (!logs) throw new Error(`no SudokuLog/WordleLog pinned for chain ${CHAIN_ID}`)

  const chain = { id: CHAIN_ID, name: `chain-${CHAIN_ID}`, nativeCurrency: { name: 'PLS', symbol: 'PLS', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const
  const publicClient = viem.createPublicClient({ chain, transport: viem.http(RPC) })
  const walletClient = viem.createWalletClient({ account: deployer, chain, transport: viem.http(RPC) })

  // The pinned EAS instances must actually be live on this chain before anything is sent.
  for (const [label, addr] of [['EAS', eas], ['SchemaRegistry', registry]] as const) {
    const code = await publicClient.getCode({ address: addr })
    if (!code || code === '0x') throw new Error(`${label} ${addr} has no code on chain ${CHAIN_ID}`)
  }

  const sudokuArtifact = loadArtifact('SudokuSolveResolver')
  const wordleArtifact = loadArtifact('WordleSolveResolver')
  const fee = await resolveLegacyFee(publicClient, { bufferBps: BUFFER_BPS })
  const balance = await publicClient.getBalance({ address: deployer.address })
  const nonce = await publicClient.getTransactionCount({ address: deployer.address })

  console.log('── deploy EAS solve resolvers + register schemas (revocable=false) ──')
  console.log('chain:', CHAIN_ID, RPC)
  console.log('deployer:', deployer.address, '| balance', viem.formatEther(balance), 'PLS | nonce', nonce)
  console.log('EAS:', eas, '| SchemaRegistry:', registry)
  console.log('SudokuLog:', logs.sudokuLog, '| WordleLog:', logs.wordleLog)
  console.log('plan: SudokuSolveResolver + WordleSolveResolver + 2x SchemaRegistry.register')

  if (!EXECUTE) {
    console.log('\nDRY RUN — nothing sent. Re-run with DEPLOY_EXECUTE=1 to broadcast.')
    return
  }

  console.log('\nEXECUTING…')
  const sudokuResolver = await deployContractLegacy({
    walletClient, publicClient, abi: sudokuArtifact.abi, bytecode: sudokuArtifact.bytecode,
    args: [eas, logs.sudokuLog], fee, label: 'SudokuSolveResolver',
  })
  const wordleResolver = await deployContractLegacy({
    walletClient, publicClient, abi: wordleArtifact.abi, bytecode: wordleArtifact.bytecode,
    args: [eas, logs.wordleLog], fee, label: 'WordleSolveResolver',
  })

  const register = async (schema: string, resolver: viem.Hex): Promise<viem.Hex> => {
    const { request } = await publicClient.simulateContract({
      address: registry, abi: registryAbi, functionName: 'register',
      args: [schema, resolver, false], account: deployer, gasPrice: fee.gasPrice, type: 'legacy',
    })
    const hash = await walletClient.writeContract(request)
    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success') throw new Error(`register reverted: ${hash}`)
    const uid = schemaUid(schema, resolver, false)
    // Read-back: the registry must hold exactly this schema + resolver under the deterministic UID.
    const rec = (await publicClient.readContract({
      address: registry, abi: registryAbi, functionName: 'getSchema', args: [uid],
    })) as { uid: viem.Hex; resolver: viem.Hex; revocable: boolean; schema: string }
    if (rec.uid !== uid || rec.schema !== schema || rec.resolver.toLowerCase() !== resolver.toLowerCase() || rec.revocable) {
      throw new Error(`schema read-back mismatch for ${uid}`)
    }
    console.log(`registered ✓ ${uid} (tx ${hash})`)
    return uid
  }

  console.log('\nregistering sudoku schema…')
  const sudokuUid = await register(SUDOKU_SCHEMA, sudokuResolver)
  console.log('registering wordle schema…')
  const wordleUid = await register(WORDLE_SCHEMA, wordleResolver)

  console.log('\n✅ deployed + registered — pin these:')
  console.log(`chain ${CHAIN_ID}:`)
  console.log('  sudokuSolveResolver:', sudokuResolver)
  console.log('  sudokuSchemaUid:   ', sudokuUid)
  console.log('  wordleSolveResolver:', wordleResolver)
  console.log('  wordleSchemaUid:   ', wordleUid)
  /* eslint-enable no-console */
}

const invokedDirectly = typeof require !== 'undefined' && require.main === module
if (invokedDirectly) {
  main().catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e)
    process.exit(1)
  })
}
