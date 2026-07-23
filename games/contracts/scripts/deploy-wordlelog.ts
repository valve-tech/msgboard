/**
 * Deploy WordleLog — the NON-WAGERED "play with friends" ZK-Wordle record. Reuses an already-deployed
 * WordleRules verifier + the committed real dictionary root; there is no Chips, no house, no escrow
 * (that was the retired SkillSettle). WordleLog(wordleRules, dictRoot). Legacy type-0 gas. DRY-RUNS
 * unless DEPLOY_EXECUTE=1. Never sends on import.
 *
 *   MNEMONIC=... RPC_URL=https://rpc.pulsechain.com CHAIN_ID=369 \
 *     WORDLE_RULES=0x… npx tsx scripts/deploy-wordlelog.ts            # dry-run
 *   … DEPLOY_EXECUTE=1 npx tsx scripts/deploy-wordlelog.ts           # broadcast
 */
import * as viem from 'viem'
import { resolveLegacyFee } from './gas'
import { deployContractLegacy, type SkillArtifact } from './deploy-skill'
import { PROD_WORDLE_DICT_ROOT } from './configure-skill'

function loadWordleLogArtifact(): SkillArtifact {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const path = require('node:path') as typeof import('node:path')
  const a = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../artifacts/contracts/games/WordleLog.sol/WordleLog.json'), 'utf8'))
  return { abi: a.abi as viem.Abi, bytecode: a.bytecode as viem.Hex }
}

const readAbi = [
  { name: 'wordleRules', type: 'function', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { name: 'dictRoot', type: 'function', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
] as const satisfies viem.Abi

async function main(): Promise<void> {
  /* eslint-disable no-console */
  const { mnemonicToAccount } = await import('viem/accounts')

  const RPC = process.env.RPC_URL ?? 'https://rpc.v4.testnet.pulsechain.com'
  const CHAIN_ID = Number(process.env.CHAIN_ID ?? 943)
  const DICT_ROOT = BigInt(process.env.WORDLE_DICT_ROOT ?? PROD_WORDLE_DICT_ROOT)
  const WORDLE_RULES = process.env.WORDLE_RULES as viem.Hex | undefined
  const BUFFER_BPS = BigInt(process.env.GAS_BUFFER_BPS ?? 20_000n)
  const EXECUTE = process.env.DEPLOY_EXECUTE === '1'

  if (!WORDLE_RULES || !viem.isAddress(WORDLE_RULES)) throw new Error('set WORDLE_RULES to the deployed WordleRules address')
  const mnemonic = process.env.MNEMONIC
  if (!mnemonic) throw new Error('set MNEMONIC in the environment (games/contracts/.env)')
  const owner = mnemonicToAccount(mnemonic)

  const chain = { id: CHAIN_ID, name: `chain-${CHAIN_ID}`, nativeCurrency: { name: 'PLS', symbol: 'PLS', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const
  const publicClient = viem.createPublicClient({ chain, transport: viem.http(RPC) })
  const walletClient = viem.createWalletClient({ account: owner, chain, transport: viem.http(RPC) })

  const art = loadWordleLogArtifact()
  const fee = await resolveLegacyFee(publicClient, { bufferBps: BUFFER_BPS })
  const balance = await publicClient.getBalance({ address: owner.address })
  const nonce = await publicClient.getTransactionCount({ address: owner.address })
  const predicted = viem.getContractAddress({ from: owner.address, nonce: BigInt(nonce) })

  console.log('── deploy WordleLog (non-wagered "play with friends" ZK-Wordle) ──')
  console.log('chain:', CHAIN_ID, RPC)
  console.log('owner/deployer:', owner.address, '| balance', viem.formatEther(balance), 'PLS | nonce', nonce)
  console.log('args: wordleRules =', WORDLE_RULES, '| dictRoot =', DICT_ROOT.toString())
  console.log('predicted WordleLog:', predicted, `(${(art.bytecode.length - 2) / 2}B init)`)
  console.log('gas: legacy', viem.formatGwei(fee.gasPrice), 'gwei (type-0)')

  if (!EXECUTE) {
    console.log('\nDRY RUN — nothing sent. Re-run with DEPLOY_EXECUTE=1 to broadcast.')
    return
  }

  console.log('\nEXECUTING…')
  const wordleLog = await deployContractLegacy({ walletClient, publicClient, abi: art.abi, bytecode: art.bytecode, args: [WORDLE_RULES, DICT_ROOT], fee, label: 'WordleLog' })
  const vRules = await publicClient.readContract({ address: wordleLog, abi: readAbi, functionName: 'wordleRules' })
  const vRoot = await publicClient.readContract({ address: wordleLog, abi: readAbi, functionName: 'dictRoot' })
  console.log('\n✅ deployed WordleLog:', wordleLog)
  console.log('verified wordleRules:', vRules, vRules.toLowerCase() === WORDLE_RULES.toLowerCase() ? '✓' : '✗')
  console.log('verified dictRoot:', (vRoot as bigint).toString(), (vRoot as bigint) === DICT_ROOT ? '✓' : '✗')
  console.log('\nNext: friends call openChallenge(id, commit); solvers call logSolve(id, proof, guessesCommit, dictRoot, guessesUsed).')
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
