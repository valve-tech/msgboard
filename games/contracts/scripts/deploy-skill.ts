/**
 * Deploy + configure the ZK SKILL games DAG — the skill-game analog of deploy-house.ts.
 *
 * Two independent games share one deploy:
 *   • Sudoku — a TIMED, Chips-FREE leaderboard (NOT a wager). DAG:
 *       SudokuSolvePlonkVerifier → SudokuRules(verifier) → SudokuLog(sudokuRules)
 *     SudokuLog needs NO configure (no house key, no dict root, no funding). After deploy the owner
 *     just calls SudokuLog.openPuzzle(puzzleId, puzzle[81]) to start a puzzle's clock.
 *   • Wordle — a WAGERED house game. DAG:
 *       WordleCluePlonkVerifier + WordleSolvePlonkVerifier → WordleRules(verifier, solveVerifier)
 *         → SkillSettle(chips, wordleRules)
 *     SkillSettle reuses the EXISTING Chips ERC-20 (never redeployed here) and is configured by
 *     configure-skill.ts (setHouseKey + setWordleDictRoot + mint/approve/fundHouse).
 *
 * Deploy order (dependency-topological), 7 contracts:
 *   1. SudokuSolvePlonkVerifier()          (no args)
 *   2. WordleCluePlonkVerifier()           (no args)
 *   3. WordleSolvePlonkVerifier()          (no args)
 *   4. SudokuRules(sudokuSolveVerifier)
 *   5. WordleRules(wordleClueVerifier, wordleSolveVerifier)
 *   6. SudokuLog(sudokuRules)
 *   7. SkillSettle(chips, wordleRules)
 *
 * PULSECHAIN GAS: every transaction is sent LEGACY (type-0) with a gas price read live from the chain
 * and buffered (scripts/gas.ts). Default EIP-1559 estimation is NOT used — on PulseChain the ~0 base
 * fee makes it unreliable. SkillPayouts.sol is an INTERNAL library inlined into SkillSettle — it is
 * NOT a separate deploy node and needs no linking.
 *
 * Safety: `main()` DRY-RUNS by default (prints the plan + predicted addresses + resolved gas, sends
 * nothing). It only broadcasts when DEPLOY_EXECUTE=1. Importing this module never sends anything.
 *
 * Target 943 (testnet) or 369 (mainnet) via env: RPC_URL + CHAIN_ID + MNEMONIC (mirrors deploy-house).
 */
import * as viem from 'viem'
import { configureSkill, type ConfigureSkillResult, PROD_WORDLE_DICT_ROOT } from './configure-skill'
import { resolveLegacyFee, type LegacyFee } from './gas'

const readAbi = [
  { name: 'owner', type: 'function', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { name: 'houseKey', type: 'function', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { name: 'housePool', type: 'function', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { name: 'chips', type: 'function', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { name: 'wordleRules', type: 'function', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { name: 'wordleDictRoot', type: 'function', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
] as const satisfies viem.Abi

// ── Generic legacy-fee deploy ─────────────────────────────────────────────────

export interface DeployContractOpts {
  walletClient: viem.WalletClient
  publicClient: viem.PublicClient
  abi: viem.Abi
  bytecode: viem.Hex
  args: readonly unknown[]
  fee: LegacyFee
  label: string
  gas?: bigint
}

/** Deploy one contract with a legacy (type-0) fee; return its address. Mirrors deployHouseChannel. */
export async function deployContractLegacy(opts: DeployContractOpts): Promise<viem.Hex> {
  const { walletClient, publicClient, abi, bytecode, args, fee, label, gas } = opts
  const account = walletClient.account
  if (!account) throw new Error('walletClient must have an account set')

  const hash = await walletClient.deployContract({
    abi, bytecode, args: args as unknown[],
    account, chain: walletClient.chain,
    gasPrice: fee.gasPrice, type: 'legacy', // legacy type-0; never 1559 on PulseChain
    ...(gas !== undefined ? { gas } : {}),
  })
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`${label} deploy reverted (tx ${hash})`)
  if (!receipt.contractAddress) throw new Error(`${label} deploy receipt has no contractAddress`)
  return receipt.contractAddress
}

// ── Artifacts ─────────────────────────────────────────────────────────────────

export interface SkillArtifact {
  abi: viem.Abi
  bytecode: viem.Hex
}

export interface SkillArtifacts {
  sudokuSolveVerifier: SkillArtifact
  wordleClueVerifier: SkillArtifact
  wordleSolveVerifier: SkillArtifact
  sudokuRules: SkillArtifact
  wordleRules: SkillArtifact
  sudokuLog: SkillArtifact
  skillSettle: SkillArtifact
}

/** Load the seven hardhat artifacts (abi + init bytecode) from ../artifacts. */
export function loadSkillArtifacts(): SkillArtifacts {
  // Lazy requires so importing this module in a test/browser context doesn't touch the filesystem.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const path = require('node:path') as typeof import('node:path')
  const load = (rel: string): SkillArtifact => {
    const a = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../artifacts', rel), 'utf8'))
    return { abi: a.abi as viem.Abi, bytecode: a.bytecode as viem.Hex }
  }
  return {
    sudokuSolveVerifier: load('contracts/zk/generated/SudokuSolvePlonkVerifier.sol/SudokuSolvePlonkVerifier.json'),
    wordleClueVerifier: load('contracts/zk/generated/WordleCluePlonkVerifier.sol/WordleCluePlonkVerifier.json'),
    wordleSolveVerifier: load('contracts/zk/generated/WordleSolvePlonkVerifier.sol/WordleSolvePlonkVerifier.json'),
    sudokuRules: load('contracts/zk/SudokuRules.sol/SudokuRules.json'),
    wordleRules: load('contracts/zk/WordleRules.sol/WordleRules.json'),
    sudokuLog: load('contracts/games/SudokuLog.sol/SudokuLog.json'),
    skillSettle: load('contracts/games/SkillSettle.sol/SkillSettle.json'),
  }
}

// ── Deploy the DAG ──────────────────────────────────────────────────────────

export interface DeploySkillDagOpts {
  walletClient: viem.WalletClient
  publicClient: viem.PublicClient
  artifacts: SkillArtifacts
  /** existing Chips ERC-20 the SkillSettle house game escrows (NEVER redeployed). */
  chips: viem.Hex
  fee: LegacyFee
}

export interface DeploySkillAddresses {
  sudokuSolveVerifier: viem.Hex
  wordleClueVerifier: viem.Hex
  wordleSolveVerifier: viem.Hex
  sudokuRules: viem.Hex
  wordleRules: viem.Hex
  sudokuLog: viem.Hex
  skillSettle: viem.Hex
}

/** Deploy the 7-contract skill DAG in dependency order and return every address. */
export async function deploySkillDag(opts: DeploySkillDagOpts): Promise<DeploySkillAddresses> {
  const { walletClient, publicClient, artifacts: a, chips, fee } = opts
  const deploy = (art: SkillArtifact, args: readonly unknown[], label: string) =>
    deployContractLegacy({ walletClient, publicClient, abi: art.abi, bytecode: art.bytecode, args, fee, label })

  const sudokuSolveVerifier = await deploy(a.sudokuSolveVerifier, [], 'SudokuSolvePlonkVerifier')
  const wordleClueVerifier = await deploy(a.wordleClueVerifier, [], 'WordleCluePlonkVerifier')
  const wordleSolveVerifier = await deploy(a.wordleSolveVerifier, [], 'WordleSolvePlonkVerifier')
  const sudokuRules = await deploy(a.sudokuRules, [sudokuSolveVerifier], 'SudokuRules')
  const wordleRules = await deploy(a.wordleRules, [wordleClueVerifier, wordleSolveVerifier], 'WordleRules')
  const sudokuLog = await deploy(a.sudokuLog, [sudokuRules], 'SudokuLog')
  const skillSettle = await deploy(a.skillSettle, [chips, wordleRules], 'SkillSettle')

  return { sudokuSolveVerifier, wordleClueVerifier, wordleSolveVerifier, sudokuRules, wordleRules, sudokuLog, skillSettle }
}

// ── Full deploy + configure ──────────────────────────────────────────────────

export interface DeployAndConfigureSkillOpts {
  walletClient: viem.WalletClient
  publicClient: viem.PublicClient
  artifacts: SkillArtifacts
  chips: viem.Hex
  houseKey: viem.Hex
  dictRoot: bigint
  treasury: bigint
  fund: bigint
  bufferBps?: bigint
}

export interface DeployAndConfigureSkillResult {
  addresses: DeploySkillAddresses
  fee: LegacyFee
  configure: ConfigureSkillResult
  verified: { owner: viem.Hex; houseKey: viem.Hex; housePool: bigint; chips: viem.Hex; wordleRules: viem.Hex; wordleDictRoot: bigint }
}

/**
 * Full path: resolve legacy fee once → deploy the 7-contract skill DAG → configure SkillSettle
 * (setHouseKey + setWordleDictRoot + mint/approve/fundHouse) with the SAME legacy fee → read back the
 * SkillSettle state for verification. SudokuLog is left as-deployed (no configure needed).
 */
export async function deployAndConfigureSkill(opts: DeployAndConfigureSkillOpts): Promise<DeployAndConfigureSkillResult> {
  const { walletClient, publicClient, artifacts, chips, houseKey, dictRoot, treasury, fund, bufferBps } = opts
  if (fund > treasury) throw new Error(`fund (${fund}) exceeds treasury (${treasury})`)

  const fee = await resolveLegacyFee(publicClient, { bufferBps })

  const addresses = await deploySkillDag({ walletClient, publicClient, artifacts, chips, fee })

  const configure = await configureSkill({
    walletClient, chips, skillSettle: addresses.skillSettle, houseKey, dictRoot, treasury, fund, gasPrice: fee.gasPrice,
  })

  const read = async (functionName: 'owner' | 'houseKey' | 'chips' | 'wordleRules') =>
    (await publicClient.readContract({ address: addresses.skillSettle, abi: readAbi, functionName })) as viem.Hex
  const housePool = (await publicClient.readContract({ address: addresses.skillSettle, abi: readAbi, functionName: 'housePool' })) as bigint
  const wordleDictRoot = (await publicClient.readContract({ address: addresses.skillSettle, abi: readAbi, functionName: 'wordleDictRoot' })) as bigint

  return {
    addresses,
    fee,
    configure,
    verified: {
      owner: await read('owner'),
      houseKey: await read('houseKey'),
      housePool,
      chips: await read('chips'),
      wordleRules: await read('wordleRules'),
      wordleDictRoot,
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI — dry-runs unless DEPLOY_EXECUTE=1. Never sends on import.
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  /* eslint-disable no-console */
  const { mnemonicToAccount } = await import('viem/accounts')

  const RPC = process.env.RPC_URL ?? 'https://rpc.v4.testnet.pulsechain.com'
  const CHAIN_ID = Number(process.env.CHAIN_ID ?? 943)
  const CHIPS = (process.env.CHIPS ?? '0xA5276259e544C86438566cB28cc87daCce060910') as viem.Hex
  const DICT_ROOT = BigInt(process.env.WORDLE_DICT_ROOT ?? PROD_WORDLE_DICT_ROOT)
  const TREASURY = BigInt(process.env.TREASURY ?? 1_000_000n * 10n ** 18n)
  const FUND = BigInt(process.env.FUND ?? 500_000n * 10n ** 18n)
  const HOUSE_INDEX = Number(process.env.HOUSE_ACCOUNT_INDEX ?? 1) // house signer = derived index 1
  const BUFFER_BPS = BigInt(process.env.GAS_BUFFER_BPS ?? 20_000n)
  const EXECUTE = process.env.DEPLOY_EXECUTE === '1'

  const mnemonic = process.env.MNEMONIC
  if (!mnemonic) throw new Error('set MNEMONIC in the environment (games/contracts/.env)')
  const owner = mnemonicToAccount(mnemonic) // account index 0 = owner/deployer
  const house = mnemonicToAccount(mnemonic, { addressIndex: HOUSE_INDEX })

  const chain = { id: CHAIN_ID, name: `chain-${CHAIN_ID}`, nativeCurrency: { name: 'PLS', symbol: 'PLS', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const
  const publicClient = viem.createPublicClient({ chain, transport: viem.http(RPC) })
  const walletClient = viem.createWalletClient({ account: owner, chain, transport: viem.http(RPC) })

  const artifacts = loadSkillArtifacts()
  const fee = await resolveLegacyFee(publicClient, { bufferBps: BUFFER_BPS })
  const livePrice = await publicClient.getGasPrice()
  const balance = await publicClient.getBalance({ address: owner.address })
  const nonce = await publicClient.getTransactionCount({ address: owner.address })

  // Deploy order + constructor arg wiring (predicted CREATE addresses use the deployer's live nonce).
  const initSize = (a: SkillArtifact) => (a.bytecode.length - 2) / 2
  const at = (offset: number) => viem.getContractAddress({ from: owner.address, nonce: BigInt(nonce + offset) })
  const predicted = {
    sudokuSolveVerifier: at(0),
    wordleClueVerifier: at(1),
    wordleSolveVerifier: at(2),
    sudokuRules: at(3),
    wordleRules: at(4),
    sudokuLog: at(5),
    skillSettle: at(6),
  }
  const plan: Array<[string, SkillArtifact, string[], viem.Hex]> = [
    ['SudokuSolvePlonkVerifier', artifacts.sudokuSolveVerifier, [], predicted.sudokuSolveVerifier],
    ['WordleCluePlonkVerifier', artifacts.wordleClueVerifier, [], predicted.wordleClueVerifier],
    ['WordleSolvePlonkVerifier', artifacts.wordleSolveVerifier, [], predicted.wordleSolveVerifier],
    ['SudokuRules', artifacts.sudokuRules, [`verifier=${predicted.sudokuSolveVerifier}`], predicted.sudokuRules],
    ['WordleRules', artifacts.wordleRules, [`verifier=${predicted.wordleClueVerifier}`, `solveVerifier=${predicted.wordleSolveVerifier}`], predicted.wordleRules],
    ['SudokuLog', artifacts.sudokuLog, [`sudokuRules=${predicted.sudokuRules}`], predicted.sudokuLog],
    ['SkillSettle', artifacts.skillSettle, [`chips=${CHIPS}`, `wordleRules=${predicted.wordleRules}`], predicted.skillSettle],
  ]
  const totalInit = plan.reduce((s, [, a]) => s + initSize(a), 0)

  console.log('── deploy + configure ZK SKILL games (Sudoku leaderboard + Wordle house) ──')
  console.log('chain:', CHAIN_ID, RPC)
  console.log('owner/deployer:', owner.address, '| balance', viem.formatEther(balance), 'PLS | nonce', nonce)
  console.log('house signer (index', HOUSE_INDEX + '):', house.address)
  console.log('chips (existing, REUSED — not deployed):', CHIPS)
  console.log('wordle dict root:', DICT_ROOT.toString())
  console.log('treasury mint:', viem.formatEther(TREASURY), 'CHIPS | fund pool:', viem.formatEther(FUND), 'CHIPS')
  console.log('gas: live', viem.formatGwei(livePrice), 'gwei → legacy', viem.formatGwei(fee.gasPrice), `gwei (buffer ${BUFFER_BPS} bps, type-0)`)
  console.log('\ndeploy plan (dependency order — 7 contracts, predicted CREATE addresses):')
  plan.forEach(([name, art, args, addr], i) => {
    console.log(`  ${i + 1}. ${name.padEnd(26)} ${initSize(art).toString().padStart(5)}B init  → ${addr}`)
    if (args.length) console.log(`       args: ${args.join(', ')}`)
  })
  console.log('  total init bytecode:', totalInit, 'bytes across 7 deploys')
  console.log('\nconfigure SkillSettle (after deploy):')
  console.log('  1. setHouseKey(', house.address, ')')
  console.log('  2. setWordleDictRoot(', DICT_ROOT.toString(), ')')
  console.log('  3. Chips.mint(owner,', viem.formatEther(TREASURY), 'CHIPS )')
  console.log('  4. Chips.approve(SkillSettle,', viem.formatEther(FUND), 'CHIPS )')
  console.log('  5. SkillSettle.fundHouse(', viem.formatEther(FUND), 'CHIPS )')
  console.log('  SudokuLog: NO configure — owner calls openPuzzle(puzzleId, puzzle[81]) later.')

  if (!EXECUTE) {
    console.log('\nDRY RUN — nothing sent. Re-run with DEPLOY_EXECUTE=1 to broadcast.')
    return
  }

  console.log('\nEXECUTING…')
  const result = await deployAndConfigureSkill({
    walletClient, publicClient, artifacts,
    chips: CHIPS, houseKey: house.address, dictRoot: DICT_ROOT, treasury: TREASURY, fund: FUND, bufferBps: BUFFER_BPS,
  })
  console.log('\n✅ deployed + configured')
  console.log('SudokuSolvePlonkVerifier:', result.addresses.sudokuSolveVerifier)
  console.log('WordleCluePlonkVerifier: ', result.addresses.wordleClueVerifier)
  console.log('WordleSolvePlonkVerifier:', result.addresses.wordleSolveVerifier)
  console.log('SudokuRules:             ', result.addresses.sudokuRules)
  console.log('WordleRules:             ', result.addresses.wordleRules)
  console.log('SudokuLog (leaderboard): ', result.addresses.sudokuLog)
  console.log('SkillSettle (Wordle):    ', result.addresses.skillSettle)
  console.log('verified owner:', result.verified.owner)
  console.log('verified houseKey:', result.verified.houseKey)
  console.log('verified housePool:', viem.formatEther(result.verified.housePool), 'CHIPS')
  console.log('verified chips:', result.verified.chips)
  console.log('verified wordleRules:', result.verified.wordleRules)
  console.log('verified wordleDictRoot:', result.verified.wordleDictRoot.toString())
  console.log('\nNext:')
  console.log('  - SudokuLog.openPuzzle(puzzleId, puzzle[81]) to start a leaderboard puzzle.')
  console.log('  - Wire the new addresses into games/web/src/config.ts + the indexer.')
  /* eslint-enable no-console */
}

// run only when invoked directly (never on import)
const invokedDirectly = typeof require !== 'undefined' && require.main === module
if (invokedDirectly) {
  main().catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e)
    process.exit(1)
  })
}
