/**
 * Redeploy ONLY the OperatorCoinFlip reference game against the ALREADY-DEPLOYED substrate on 943.
 *
 * The forfeit build changes the game contract alone — OperatorRegistry, GameEscrow, OperatorBond,
 * OperatorVault(+Factory) are unchanged and are REUSED from deployments/943-operator-substrate.json.
 * This script deploys a fresh OperatorCoinFlip(random, escrow, registry), re-allowlists the canonical
 * validators on it, verifies its wiring, then rewrites the deployment record: the new game becomes
 * `contracts.OperatorCoinFlip` and the prior address is appended to `operatorCoinFlipRetired`.
 *
 * Onboarding (register → authorizeGame → setPlayerGame → depositBankroll/depositFees) is per-operator
 * and NOT part of this deploy — the live QA harness (qa-operator-coinflip.ts) exercises it against the
 * new game address.
 *
 * Legacy type-0 gas (PulseChain quotes a bogus eth_gasPrice). Loads the HARDHAT artifact (shanghai,
 * MCOPY/TSTORE-free — verified by the deployability guard). DRY-RUNS unless DEPLOY_EXECUTE=1.
 *
 *   # dry run
 *   PRIVATE_KEY="$(op read op://valve/valve_deployer/pk)" CHAIN_ID=943 npx tsx scripts/redeploy-operator-coinflip.ts
 *   # broadcast
 *   PRIVATE_KEY="$(op read op://valve/valve_deployer/pk)" CHAIN_ID=943 DEPLOY_EXECUTE=1 npx tsx scripts/redeploy-operator-coinflip.ts
 */
import * as viem from 'viem'
import { privateKeyToAccount, mnemonicToAccount } from 'viem/accounts'
import { resolveLegacyFee } from './gas'
import { deployContractLegacy } from './deploy-skill'

const GAMEBASE_ABI = [
  { name: 'addValidator', type: 'function', inputs: [{ name: 'validator', type: 'address' }], outputs: [], stateMutability: 'nonpayable' },
  { name: 'isValidator', type: 'function', inputs: [{ name: '', type: 'address' }], outputs: [{ type: 'bool' }], stateMutability: 'view' },
  { name: 'validatorCount', type: 'function', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { name: 'owner', type: 'function', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { name: 'random', type: 'function', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { name: 'escrow', type: 'function', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { name: 'registry', type: 'function', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
] as const satisfies viem.Abi

function loadArtifact(contractName: string): { abi: viem.Abi; bytecode: viem.Hex } {
  const fs = require('node:fs') as typeof import('node:fs')
  const path = require('node:path') as typeof import('node:path')
  const a = JSON.parse(
    fs.readFileSync(
      path.resolve(__dirname, `../artifacts/contracts/games/operator/${contractName}.sol/${contractName}.json`),
      'utf8',
    ),
  )
  return { abi: a.abi as viem.Abi, bytecode: a.bytecode as viem.Hex }
}

async function main(): Promise<void> {
  /* eslint-disable no-console */
  const RPC = process.env.RPC_URL ?? 'https://rpc.v4.testnet.pulsechain.com'
  const CHAIN_ID = Number(process.env.CHAIN_ID ?? 943)
  const EXECUTE = process.env.DEPLOY_EXECUTE === '1'
  const OUT_JSON = process.env.OUT_JSON ?? 'deployments/943-operator-substrate.json'

  const fs = require('node:fs') as typeof import('node:fs')
  const path = require('node:path') as typeof import('node:path')
  const outPath = path.resolve(__dirname, '..', OUT_JSON)
  const prior = JSON.parse(fs.readFileSync(outPath, 'utf8')) as {
    chainId: number
    deployer: string
    random: viem.Hex
    contracts: Record<string, viem.Hex>
    validators: viem.Hex[]
    operatorCoinFlipRetired?: viem.Hex[]
  }

  // Reuse the already-deployed, unchanged substrate pieces.
  const RANDOM = (process.env.RANDOM ?? prior.random) as viem.Hex
  const REGISTRY = prior.contracts.OperatorRegistry
  const ESCROW = prior.contracts.GameEscrow
  const PRIOR_GAME = prior.contracts.OperatorCoinFlip
  const VALIDATORS = (process.env.VALIDATORS ? process.env.VALIDATORS.split(',') : prior.validators).map((v) =>
    viem.getAddress(v.trim()),
  )

  const pk = process.env.PRIVATE_KEY
  const mnemonic = process.env.MNEMONIC
  if (!pk && !mnemonic) throw new Error('set PRIVATE_KEY (valve_deployer) or MNEMONIC in the environment')
  const deployer = pk
    ? privateKeyToAccount((pk.startsWith('0x') ? pk : `0x${pk}`) as viem.Hex)
    : mnemonicToAccount(mnemonic!)

  const chain = {
    id: CHAIN_ID,
    name: `chain-${CHAIN_ID}`,
    nativeCurrency: { name: 'PLS', symbol: 'PLS', decimals: 18 },
    rpcUrls: { default: { http: [RPC] } },
  } as const
  const publicClient = viem.createPublicClient({ chain, transport: viem.http(RPC) })
  const walletClient = viem.createWalletClient({ account: deployer, chain, transport: viem.http(RPC) })

  const fee = await resolveLegacyFee(publicClient)
  const balance = await publicClient.getBalance({ address: deployer.address })
  const runtime = loadArtifact('OperatorCoinFlip')

  console.log('── redeploy OperatorCoinFlip (forfeit build) ──')
  console.log('chain:', CHAIN_ID, RPC)
  console.log('deployer/owner:', deployer.address, '| balance', viem.formatEther(balance), 'PLS')
  console.log('reuse: random  ', RANDOM)
  console.log('reuse: registry', REGISTRY)
  console.log('reuse: escrow  ', ESCROW)
  console.log('retire: prior OperatorCoinFlip', PRIOR_GAME)
  console.log('validators to allowlist:', VALIDATORS.join(', '))
  console.log('gas: legacy', viem.formatGwei(fee.gasPrice), 'gwei (type-0)')

  if (!EXECUTE) {
    console.log('\nDRY RUN — nothing sent. Re-run with DEPLOY_EXECUTE=1 to broadcast.')
    return
  }

  console.log('\nEXECUTING…')
  const coinflip = await deployContractLegacy({
    walletClient,
    publicClient,
    abi: runtime.abi,
    bytecode: runtime.bytecode,
    args: [RANDOM, ESCROW, REGISTRY],
    fee,
    label: 'OperatorCoinFlip',
  })
  console.log('  OperatorCoinFlip (new):', coinflip)
  const deployBlock = await publicClient.getBlockNumber()

  // Deploy a fresh DefaultValidatorPolicy alongside the game (its per-table config is keyed by the game
  // address, so a new game needs a policy that will be configured against it). Operators opt in per table
  // via game.setValidatorPolicy + policy.setConfig; tables default to the floor-only (no policy).
  const policyArtifact = loadArtifact('DefaultValidatorPolicy')
  const validatorPolicy = await deployContractLegacy({
    walletClient, publicClient, abi: policyArtifact.abi, bytecode: policyArtifact.bytecode, args: [], fee,
    label: 'DefaultValidatorPolicy',
  })
  console.log('  DefaultValidatorPolicy:', validatorPolicy)

  for (const v of VALIDATORS) {
    const already = (await publicClient.readContract({
      address: coinflip, abi: GAMEBASE_ABI, functionName: 'isValidator', args: [v],
    })) as boolean
    if (already) { console.log('  validator already allowlisted:', v); continue }
    const { request } = await publicClient.simulateContract({
      address: coinflip, abi: GAMEBASE_ABI, functionName: 'addValidator', args: [v],
      account: deployer, gasPrice: fee.gasPrice,
    })
    await publicClient.waitForTransactionReceipt({ hash: await walletClient.writeContract(request) })
    console.log('  addValidator:', v)
  }

  // read-back verification: the new game must point at the reused escrow/registry/random.
  const wiredRandom = (await publicClient.readContract({ address: coinflip, abi: GAMEBASE_ABI, functionName: 'random' })) as viem.Hex
  const wiredEscrow = (await publicClient.readContract({ address: coinflip, abi: GAMEBASE_ABI, functionName: 'escrow' })) as viem.Hex
  const wiredRegistry = (await publicClient.readContract({ address: coinflip, abi: GAMEBASE_ABI, functionName: 'registry' })) as viem.Hex
  const vcount = (await publicClient.readContract({ address: coinflip, abi: GAMEBASE_ABI, functionName: 'validatorCount' })) as bigint
  if (viem.getAddress(wiredRandom) !== viem.getAddress(RANDOM)) throw new Error('new OperatorCoinFlip.random mismatch')
  if (viem.getAddress(wiredEscrow) !== viem.getAddress(ESCROW)) throw new Error('new OperatorCoinFlip.escrow mismatch')
  if (viem.getAddress(wiredRegistry) !== viem.getAddress(REGISTRY)) throw new Error('new OperatorCoinFlip.registry mismatch')
  if (vcount < BigInt(VALIDATORS.length)) throw new Error('validatorCount below the allowlisted set')

  const retired = [...(prior.operatorCoinFlipRetired ?? [])]
  if (PRIOR_GAME && viem.getAddress(PRIOR_GAME) !== viem.getAddress(coinflip)) retired.push(PRIOR_GAME)
  const record = {
    ...prior,
    deployBlock: deployBlock.toString(),
    deployer: deployer.address,
    contracts: { ...prior.contracts, OperatorCoinFlip: coinflip, DefaultValidatorPolicy: validatorPolicy },
    operatorCoinFlipRetired: retired,
  }
  fs.writeFileSync(outPath, JSON.stringify(record, null, 2) + '\n')

  // Keep the caster/QA config (e2e/scripts/943-deployment.json) in lockstep: repoint operatorCoinFlip and
  // append the prior game to operatorCoinFlipRetired, so heatsSincePriced keeps counting the old game's
  // permanently-consumed priced slots (else the chronological slot counter drops → SecretMismatch).
  const e2ePath = path.resolve(__dirname, '../../e2e/scripts', `${CHAIN_ID}-deployment.json`)
  if (fs.existsSync(e2ePath)) {
    const e2e = JSON.parse(fs.readFileSync(e2ePath, 'utf8')) as { operatorCoinFlip?: viem.Hex; operatorCoinFlipRetired?: viem.Hex[] }
    const priorE2E = e2e.operatorCoinFlip
    const e2eRetired = [...(e2e.operatorCoinFlipRetired ?? [])]
    if (priorE2E && viem.getAddress(priorE2E) !== viem.getAddress(coinflip) && !e2eRetired.some((a) => viem.getAddress(a) === viem.getAddress(priorE2E)))
      e2eRetired.push(priorE2E)
    fs.writeFileSync(e2ePath, JSON.stringify({ ...e2e, operatorCoinFlip: coinflip, operatorCoinFlipRetired: e2eRetired }, null, 2) + '\n')
    console.log('  e2e config synced:', e2ePath)
  }

  console.log('\n✓ redeployed OperatorCoinFlip (forfeit build)')
  console.log('  deployBlock:   ', deployBlock.toString())
  console.log('  validatorCount:', vcount.toString())
  console.log('  record updated:', outPath, '(prior game retired)')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
