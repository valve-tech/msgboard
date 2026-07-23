/**
 * Deploy the ZK-WORDLE house game — Chips + the Wordle chain — WITHOUT touching an already-deployed
 * Sudoku leaderboard on the same chain. Used for a 369 mainnet bring-up where Sudoku is already live
 * (deploy-sudoku.ts) but there is no Chips token yet, so the wagered Wordle game needs its own Chips.
 *
 *     Chips → WordleCluePlonkVerifier + WordleSolvePlonkVerifier → WordleRules → SkillSettle(Chips, WordleRules)
 *     then configure SkillSettle: setHouseKey + setWordleDictRoot(REAL root) + mint/approve/fundHouse
 *
 * Chips is a MINTABLE game accounting unit (the house mints to pay; it is NOT a backed currency), so
 * this is game infrastructure, not a real-money commitment. Legacy type-0 gas. DRY-RUNS unless
 * DEPLOY_EXECUTE=1. Never sends on import. Env overrides: TREASURY, FUND, HOUSE_ACCOUNT_INDEX,
 * WORDLE_DICT_ROOT, GAS_BUFFER_BPS.
 */
import * as viem from 'viem'
import { resolveLegacyFee } from './gas'
import { loadSkillArtifacts, deployContractLegacy, type SkillArtifact } from './deploy-skill'
import { configureSkill, PROD_WORDLE_DICT_ROOT } from './configure-skill'

const readAbi = [
  { name: 'owner', type: 'function', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { name: 'houseKey', type: 'function', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { name: 'housePool', type: 'function', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { name: 'chips', type: 'function', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { name: 'wordleRules', type: 'function', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { name: 'wordleDictRoot', type: 'function', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
] as const satisfies viem.Abi

function loadChipsArtifact(): SkillArtifact {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const path = require('node:path') as typeof import('node:path')
  const a = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../artifacts/contracts/games/Chips.sol/Chips.json'), 'utf8'))
  return { abi: a.abi as viem.Abi, bytecode: a.bytecode as viem.Hex }
}

async function main(): Promise<void> {
  /* eslint-disable no-console */
  const { mnemonicToAccount } = await import('viem/accounts')

  const RPC = process.env.RPC_URL ?? 'https://rpc.v4.testnet.pulsechain.com'
  const CHAIN_ID = Number(process.env.CHAIN_ID ?? 943)
  const DICT_ROOT = BigInt(process.env.WORDLE_DICT_ROOT ?? PROD_WORDLE_DICT_ROOT)
  const TREASURY = BigInt(process.env.TREASURY ?? 1_000_000n * 10n ** 18n)
  const FUND = BigInt(process.env.FUND ?? 500_000n * 10n ** 18n)
  const HOUSE_INDEX = Number(process.env.HOUSE_ACCOUNT_INDEX ?? 1)
  const BUFFER_BPS = BigInt(process.env.GAS_BUFFER_BPS ?? 20_000n)
  const EXECUTE = process.env.DEPLOY_EXECUTE === '1'

  const mnemonic = process.env.MNEMONIC
  if (!mnemonic) throw new Error('set MNEMONIC in the environment (games/contracts/.env)')
  if (FUND > TREASURY) throw new Error(`FUND (${FUND}) exceeds TREASURY (${TREASURY})`)
  const owner = mnemonicToAccount(mnemonic)
  const house = mnemonicToAccount(mnemonic, { addressIndex: HOUSE_INDEX })

  const chain = { id: CHAIN_ID, name: `chain-${CHAIN_ID}`, nativeCurrency: { name: 'PLS', symbol: 'PLS', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const
  const publicClient = viem.createPublicClient({ chain, transport: viem.http(RPC) })
  const walletClient = viem.createWalletClient({ account: owner, chain, transport: viem.http(RPC) })

  const skill = loadSkillArtifacts()
  const chipsArt = loadChipsArtifact()
  const fee = await resolveLegacyFee(publicClient, { bufferBps: BUFFER_BPS })
  const livePrice = await publicClient.getGasPrice()
  const balance = await publicClient.getBalance({ address: owner.address })
  const nonce = await publicClient.getTransactionCount({ address: owner.address })

  const initSize = (a: SkillArtifact) => (a.bytecode.length - 2) / 2
  const at = (o: number) => viem.getContractAddress({ from: owner.address, nonce: BigInt(nonce + o) })
  const predicted = { chips: at(0), wordleClueVerifier: at(1), wordleSolveVerifier: at(2), wordleRules: at(3), skillSettle: at(4) }
  const plan: Array<[string, SkillArtifact, string[], viem.Hex]> = [
    ['Chips', chipsArt, [], predicted.chips],
    ['WordleCluePlonkVerifier', skill.wordleClueVerifier, [], predicted.wordleClueVerifier],
    ['WordleSolvePlonkVerifier', skill.wordleSolveVerifier, [], predicted.wordleSolveVerifier],
    ['WordleRules', skill.wordleRules, [`verifier=${predicted.wordleClueVerifier}`, `solveVerifier=${predicted.wordleSolveVerifier}`], predicted.wordleRules],
    ['SkillSettle', skill.skillSettle, [`chips=${predicted.chips}`, `wordleRules=${predicted.wordleRules}`], predicted.skillSettle],
  ]

  console.log('── deploy ZK-WORDLE house (Chips + Wordle chain; Sudoku untouched) ──')
  console.log('chain:', CHAIN_ID, RPC)
  console.log('owner/deployer:', owner.address, '| balance', viem.formatEther(balance), 'PLS | nonce', nonce)
  console.log('house signer (index', HOUSE_INDEX + '):', house.address)
  console.log('wordle dict root:', DICT_ROOT.toString())
  console.log('treasury mint:', viem.formatEther(TREASURY), 'CHIPS | fund pool:', viem.formatEther(FUND), 'CHIPS')
  console.log('gas: live', viem.formatGwei(livePrice), 'gwei → legacy', viem.formatGwei(fee.gasPrice), `gwei (buffer ${BUFFER_BPS} bps, type-0)`)
  console.log('\ndeploy plan (dependency order — 5 contracts, predicted CREATE addresses):')
  plan.forEach(([name, art, args, addr], i) => {
    console.log(`  ${i + 1}. ${name.padEnd(26)} ${initSize(art).toString().padStart(5)}B init  → ${addr}`)
    if (args.length) console.log(`       args: ${args.join(', ')}`)
  })
  console.log('\nconfigure SkillSettle (after deploy):')
  console.log('  1. setHouseKey(', house.address, ')')
  console.log('  2. setWordleDictRoot(', DICT_ROOT.toString(), ')')
  console.log('  3. Chips.mint(owner,', viem.formatEther(TREASURY), 'CHIPS ) / approve / fundHouse(', viem.formatEther(FUND), 'CHIPS )')

  if (!EXECUTE) {
    console.log('\nDRY RUN — nothing sent. Re-run with DEPLOY_EXECUTE=1 to broadcast.')
    return
  }

  console.log('\nEXECUTING…')
  const d = (art: SkillArtifact, args: readonly unknown[], label: string) =>
    deployContractLegacy({ walletClient, publicClient, abi: art.abi, bytecode: art.bytecode, args, fee, label })

  const chips = await d(chipsArt, [], 'Chips')
  const wordleClueVerifier = await d(skill.wordleClueVerifier, [], 'WordleCluePlonkVerifier')
  const wordleSolveVerifier = await d(skill.wordleSolveVerifier, [], 'WordleSolvePlonkVerifier')
  const wordleRules = await d(skill.wordleRules, [wordleClueVerifier, wordleSolveVerifier], 'WordleRules')
  const skillSettle = await d(skill.skillSettle, [chips, wordleRules], 'SkillSettle')

  const configure = await configureSkill({
    walletClient, chips, skillSettle, houseKey: house.address, dictRoot: DICT_ROOT, treasury: TREASURY, fund: FUND, gasPrice: fee.gasPrice,
  })

  const read = (address: viem.Hex, fn: 'houseKey' | 'housePool' | 'chips' | 'wordleRules' | 'wordleDictRoot') =>
    publicClient.readContract({ address, abi: readAbi, functionName: fn })

  console.log('\n✅ deployed + configured')
  console.log('Chips:                    ', chips)
  console.log('WordleCluePlonkVerifier:  ', wordleClueVerifier)
  console.log('WordleSolvePlonkVerifier: ', wordleSolveVerifier)
  console.log('WordleRules:              ', wordleRules)
  console.log('SkillSettle (Wordle):     ', skillSettle)
  console.log('configure txs:', configure)
  console.log('verified houseKey:', await read(skillSettle, 'houseKey'))
  console.log('verified housePool:', viem.formatEther((await read(skillSettle, 'housePool')) as bigint), 'CHIPS')
  console.log('verified chips:', await read(skillSettle, 'chips'))
  console.log('verified wordleRules:', await read(skillSettle, 'wordleRules'))
  console.log('verified wordleDictRoot:', ((await read(skillSettle, 'wordleDictRoot')) as bigint).toString())
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
