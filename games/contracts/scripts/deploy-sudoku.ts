/**
 * Deploy ONLY the ZK-Sudoku leaderboard chain — the Chips-free, money-free subset of the skill DAG:
 *
 *     SudokuSolvePlonkVerifier → SudokuRules(verifier) → SudokuLog(sudokuRules)
 *
 * Used for a mainnet (369) bring-up where there is NO Chips token, so the Wordle house (SkillSettle,
 * which escrows Chips) cannot be deployed. Sudoku is a trustless timed leaderboard with no escrow and
 * no payout, so it needs no Chips, no house key, and no configure step — the owner just calls
 * openPuzzle(puzzleId, puzzle[81]) later.
 *
 * Reuses deploy-skill.ts's building blocks (loadSkillArtifacts, deployContractLegacy) + gas.ts's
 * resolveLegacyFee. Legacy type-0 gas (PulseChain ~0 base fee). DRY-RUNS unless DEPLOY_EXECUTE=1.
 * Never sends on import.
 *
 *   MNEMONIC=... RPC_URL=https://rpc.pulsechain.com CHAIN_ID=369 npx tsx scripts/deploy-sudoku.ts            # dry-run
 *   MNEMONIC=... RPC_URL=https://rpc.pulsechain.com CHAIN_ID=369 DEPLOY_EXECUTE=1 npx tsx scripts/deploy-sudoku.ts
 */
import * as viem from 'viem'
import { resolveLegacyFee } from './gas'
import { loadSkillArtifacts, deployContractLegacy } from './deploy-skill'

const readAbi = [
  { name: 'owner', type: 'function', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { name: 'sudokuRules', type: 'function', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { name: 'verifier', type: 'function', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
] as const satisfies viem.Abi

async function main(): Promise<void> {
  /* eslint-disable no-console */
  const { mnemonicToAccount } = await import('viem/accounts')

  const RPC = process.env.RPC_URL ?? 'https://rpc.v4.testnet.pulsechain.com'
  const CHAIN_ID = Number(process.env.CHAIN_ID ?? 943)
  const BUFFER_BPS = BigInt(process.env.GAS_BUFFER_BPS ?? 20_000n)
  const EXECUTE = process.env.DEPLOY_EXECUTE === '1'

  const mnemonic = process.env.MNEMONIC
  if (!mnemonic) throw new Error('set MNEMONIC in the environment (games/contracts/.env)')
  const owner = mnemonicToAccount(mnemonic) // account index 0 = owner/deployer

  const chain = { id: CHAIN_ID, name: `chain-${CHAIN_ID}`, nativeCurrency: { name: 'PLS', symbol: 'PLS', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const
  const publicClient = viem.createPublicClient({ chain, transport: viem.http(RPC) })
  const walletClient = viem.createWalletClient({ account: owner, chain, transport: viem.http(RPC) })

  const artifacts = loadSkillArtifacts()
  const fee = await resolveLegacyFee(publicClient, { bufferBps: BUFFER_BPS })
  const livePrice = await publicClient.getGasPrice()
  const balance = await publicClient.getBalance({ address: owner.address })
  const nonce = await publicClient.getTransactionCount({ address: owner.address })

  const initSize = (a: { bytecode: viem.Hex }) => (a.bytecode.length - 2) / 2
  const at = (offset: number) => viem.getContractAddress({ from: owner.address, nonce: BigInt(nonce + offset) })
  const predicted = { sudokuSolveVerifier: at(0), sudokuRules: at(1), sudokuLog: at(2) }
  const plan: Array<[string, { bytecode: viem.Hex }, string[], viem.Hex]> = [
    ['SudokuSolvePlonkVerifier', artifacts.sudokuSolveVerifier, [], predicted.sudokuSolveVerifier],
    ['SudokuRules', artifacts.sudokuRules, [`verifier=${predicted.sudokuSolveVerifier}`], predicted.sudokuRules],
    ['SudokuLog', artifacts.sudokuLog, [`sudokuRules=${predicted.sudokuRules}`], predicted.sudokuLog],
  ]

  console.log('── deploy ZK-SUDOKU leaderboard (Chips-free; no Wordle, no configure) ──')
  console.log('chain:', CHAIN_ID, RPC)
  console.log('owner/deployer:', owner.address, '| balance', viem.formatEther(balance), 'PLS | nonce', nonce)
  console.log('gas: live', viem.formatGwei(livePrice), 'gwei → legacy', viem.formatGwei(fee.gasPrice), `gwei (buffer ${BUFFER_BPS} bps, type-0)`)
  console.log('\ndeploy plan (dependency order — 3 contracts, predicted CREATE addresses):')
  plan.forEach(([name, art, args, addr], i) => {
    console.log(`  ${i + 1}. ${name.padEnd(26)} ${initSize(art).toString().padStart(5)}B init  → ${addr}`)
    if (args.length) console.log(`       args: ${args.join(', ')}`)
  })
  console.log('  SudokuLog: NO configure — owner calls openPuzzle(puzzleId, puzzle[81]) later.')

  if (!EXECUTE) {
    console.log('\nDRY RUN — nothing sent. Re-run with DEPLOY_EXECUTE=1 to broadcast.')
    return
  }

  console.log('\nEXECUTING…')
  const d = (art: { abi: viem.Abi; bytecode: viem.Hex }, args: readonly unknown[], label: string) =>
    deployContractLegacy({ walletClient, publicClient, abi: art.abi, bytecode: art.bytecode, args, fee, label })

  const sudokuSolveVerifier = await d(artifacts.sudokuSolveVerifier, [], 'SudokuSolvePlonkVerifier')
  const sudokuRules = await d(artifacts.sudokuRules, [sudokuSolveVerifier], 'SudokuRules')
  const sudokuLog = await d(artifacts.sudokuLog, [sudokuRules], 'SudokuLog')

  // read-back verification
  const read = (address: viem.Hex, fn: 'owner' | 'sudokuRules' | 'verifier') =>
    publicClient.readContract({ address, abi: readAbi, functionName: fn }) as Promise<viem.Hex>
  const vRules = await read(sudokuLog, 'sudokuRules')
  const vOwner = await read(sudokuLog, 'owner')
  const vVerifier = await read(sudokuRules, 'verifier')

  console.log('\n✅ deployed')
  console.log('SudokuSolvePlonkVerifier:', sudokuSolveVerifier)
  console.log('SudokuRules:             ', sudokuRules)
  console.log('SudokuLog (leaderboard): ', sudokuLog)
  console.log('verified SudokuLog.sudokuRules:', vRules, vRules.toLowerCase() === sudokuRules.toLowerCase() ? '✓' : '✗ MISMATCH')
  console.log('verified SudokuLog.owner:', vOwner, vOwner.toLowerCase() === owner.address.toLowerCase() ? '✓' : '✗ MISMATCH')
  console.log('verified SudokuRules.verifier:', vVerifier, vVerifier.toLowerCase() === sudokuSolveVerifier.toLowerCase() ? '✓' : '✗ MISMATCH')
  console.log('\nNext: SudokuLog.openPuzzle(puzzleId, puzzle[81]) to start a leaderboard puzzle.')
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
