/**
 * Deploy the Table-Maintainer Substrate (Slice A) — the bonded-operator rails over which independent
 * casino operators run games. Deploys, in order:
 *   1. OperatorRegistry()                              — permissionless operator identity + rake/funding cfg
 *   2. GameEscrow(registry)                            — the settlement seam (pre-collateralized, per-(op,token))
 *   3. OperatorBond(registry)                          — protocol-held accountability bond
 *   4. OperatorVault()                                 — the cloneable funding-vault IMPLEMENTATION
 *   5. OperatorVaultFactory(vaultImpl, escrow)         — atomic clone+init factory (closes the init front-run)
 *   6. OperatorCoinFlip(random, escrow, registry)      — the reference game; then addValidator the 943 set
 *
 * The deployer becomes the GameBase owner of OperatorCoinFlip (validator allowlister). The substrate
 * itself has NO admin: operators self-register and self-authorize their game via
 * GameEscrow.authorizeGame — that is a per-operator onboarding step, NOT part of this deploy.
 *
 * Legacy type-0 gas (PulseChain reports a bogus eth_gasPrice; we match live baseFee + a small tip —
 * see gas.ts). Reuses deploy-skill.ts's deployContractLegacy + gas.ts's resolveLegacyFee. Loads the
 * HARDHAT artifacts (compiled shanghai per hardhat.config.ts overrides — MCOPY-free, verified).
 * DRY-RUNS unless DEPLOY_EXECUTE=1. Never sends on import.
 *
 *   # dry run (prints deployer, balance, plan — nothing sent)
 *   PRIVATE_KEY=<valve_deployer> CHAIN_ID=943 npx tsx scripts/deploy-operator-substrate.ts
 *   # broadcast
 *   PRIVATE_KEY=<valve_deployer> CHAIN_ID=943 DEPLOY_EXECUTE=1 npx tsx scripts/deploy-operator-substrate.ts
 *
 * Env (943 defaults baked in; override for other chains):
 *   PRIVATE_KEY | MNEMONIC  — the valve_deployer (owner + validator-allowlister). REQUIRED.
 *   RANDOM   (default 0x775AF72d62c85d2F7f0Bcc05BAa4Be0830087217)  — the IRandom contract on 943.
 *   VALIDATORS (default = the 943 canonicalSubset)                 — comma-separated addrs to addValidator.
 *   OUT_JSON (default deployments/943-operator-substrate.json)     — where addresses are written on execute.
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

const DEFAULT_RANDOM = '0x775AF72d62c85d2F7f0Bcc05BAa4Be0830087217'
const DEFAULT_VALIDATORS = [
  '0xAe96b0748f933914867d59486251043790cB2896',
  '0x2a638D7135966a5cA1973c930bD0317cd7d6874c',
  '0x0D3148A85608708Fe944EE71E13B4C9181b7cc83',
]

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
  const RANDOM = (process.env.RANDOM ?? DEFAULT_RANDOM) as viem.Hex
  const VALIDATORS = (process.env.VALIDATORS ? process.env.VALIDATORS.split(',') : DEFAULT_VALIDATORS).map(
    (v) => viem.getAddress(v.trim()),
  )
  const OUT_JSON = process.env.OUT_JSON ?? 'deployments/943-operator-substrate.json'

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

  console.log('── deploy Table-Maintainer Substrate (Slice A) ──')
  console.log('chain:', CHAIN_ID, RPC)
  console.log('deployer/owner:', deployer.address, '| balance', viem.formatEther(balance), 'PLS')
  console.log('args: random', RANDOM)
  console.log('validators to allowlist on OperatorCoinFlip:', VALIDATORS.join(', '))
  console.log('gas: legacy', viem.formatGwei(fee.gasPrice), 'gwei (type-0)')
  console.log('plan: Registry → GameEscrow(reg) → OperatorBond(reg) → OperatorVault(impl) → OperatorVaultFactory(impl,escrow) → OperatorCoinFlip(random,escrow,reg) + addValidator×' + VALIDATORS.length)

  if (!EXECUTE) {
    console.log('\nDRY RUN — nothing sent. Re-run with DEPLOY_EXECUTE=1 to broadcast.')
    return
  }

  console.log('\nEXECUTING…')
  const deploy = (contractName: string, args: unknown[]) =>
    deployContractLegacy({
      walletClient,
      publicClient,
      abi: loadArtifact(contractName).abi,
      bytecode: loadArtifact(contractName).bytecode,
      args,
      fee,
      label: contractName,
    })

  const registry = await deploy('OperatorRegistry', [])
  console.log('  OperatorRegistry:', registry)
  const escrow = await deploy('GameEscrow', [registry])
  console.log('  GameEscrow:', escrow)
  const bond = await deploy('OperatorBond', [registry])
  console.log('  OperatorBond:', bond)
  const vaultImpl = await deploy('OperatorVault', [])
  console.log('  OperatorVault (impl):', vaultImpl)
  const vaultFactory = await deploy('OperatorVaultFactory', [vaultImpl, escrow])
  console.log('  OperatorVaultFactory:', vaultFactory)
  const coinflip = await deploy('OperatorCoinFlip', [RANDOM, escrow, registry])
  console.log('  OperatorCoinFlip:', coinflip)
  const deployBlock = await publicClient.getBlockNumber()

  // Allowlist the canonical validators on the reference game (owner-only addValidator).
  for (const v of VALIDATORS) {
    const already = (await publicClient.readContract({
      address: coinflip, abi: GAMEBASE_ABI, functionName: 'isValidator', args: [v],
    })) as boolean
    if (already) {
      console.log('  validator already allowlisted:', v)
      continue
    }
    const { request } = await publicClient.simulateContract({
      address: coinflip, abi: GAMEBASE_ABI, functionName: 'addValidator', args: [v],
      account: deployer, gasPrice: fee.gasPrice,
    })
    await publicClient.waitForTransactionReceipt({ hash: await walletClient.writeContract(request) })
    console.log('  addValidator:', v)
  }

  // read-back verification: OperatorCoinFlip wiring
  const owner = (await publicClient.readContract({ address: coinflip, abi: GAMEBASE_ABI, functionName: 'owner' })) as viem.Hex
  const wiredRandom = (await publicClient.readContract({ address: coinflip, abi: GAMEBASE_ABI, functionName: 'random' })) as viem.Hex
  const wiredEscrow = (await publicClient.readContract({ address: coinflip, abi: GAMEBASE_ABI, functionName: 'escrow' })) as viem.Hex
  const wiredRegistry = (await publicClient.readContract({ address: coinflip, abi: GAMEBASE_ABI, functionName: 'registry' })) as viem.Hex
  const vcount = (await publicClient.readContract({ address: coinflip, abi: GAMEBASE_ABI, functionName: 'validatorCount' })) as bigint

  if (viem.getAddress(wiredEscrow) !== viem.getAddress(escrow)) throw new Error('OperatorCoinFlip.escrow mismatch')
  if (viem.getAddress(wiredRegistry) !== viem.getAddress(registry)) throw new Error('OperatorCoinFlip.registry mismatch')

  const record = {
    chainId: CHAIN_ID,
    deployBlock: deployBlock.toString(),
    deployer: deployer.address,
    random: RANDOM,
    contracts: {
      OperatorRegistry: registry,
      GameEscrow: escrow,
      OperatorBond: bond,
      OperatorVault: vaultImpl,
      OperatorVaultFactory: vaultFactory,
      OperatorCoinFlip: coinflip,
    },
    validators: VALIDATORS,
  }
  const fs = require('node:fs') as typeof import('node:fs')
  const path = require('node:path') as typeof import('node:path')
  const outPath = path.resolve(__dirname, '..', OUT_JSON)
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, JSON.stringify(record, null, 2) + '\n')

  console.log('\n✓ deployed Table-Maintainer Substrate (Slice A)')
  console.log('  deployBlock:  ', deployBlock.toString())
  console.log('  owner:        ', owner)
  console.log('  random:       ', wiredRandom)
  console.log('  validatorCount:', vcount.toString())
  console.log('  addresses written to:', outPath)
  console.log('\nOperator onboarding (per operator, NOT part of deploy):')
  console.log('  1. registry.register()')
  console.log('  2. escrow.authorizeGame(<OperatorCoinFlip>, true)   ← REQUIRED before a game can lock')
  console.log('  3. fund bankroll: approve escrow + escrow.depositBankroll(op, token, amt)  (or via OperatorVaultFactory)')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
