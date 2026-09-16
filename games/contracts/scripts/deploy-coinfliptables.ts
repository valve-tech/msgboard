/**
 * Deploy CoinFlipTables — the permissionless player-run coin-flip tables (Slice 1). Operators fund a
 * two-tier hot/cold Chips bankroll; players bet a side + stake against a chosen table; the shared
 * validator set settles on-chain per round (GameBase heat/onCast); per-round escrow guarantees payout.
 *
 * Constructor: (address random, address chips). The deployer becomes the GameBase owner and this
 * script allowlists the canonical validator subset (the SAME validators CoinFlip/Raffle already use
 * on 943, so heat points at their existing inked pools). Legacy type-0 gas (PulseChain ~0 base fee).
 * Reuses deploy-skill.ts's deployContractLegacy + gas.ts's resolveLegacyFee. DRY-RUNS unless
 * DEPLOY_EXECUTE=1. Never sends on import.
 *
 *   # dry run (prints deployer, balance, plan — nothing sent)
 *   PRIVATE_KEY=<valve_deployer> CHAIN_ID=943 npx tsx scripts/deploy-coinfliptables.ts
 *   # broadcast
 *   PRIVATE_KEY=<valve_deployer> CHAIN_ID=943 DEPLOY_EXECUTE=1 npx tsx scripts/deploy-coinfliptables.ts
 *
 * Env (943 defaults baked in; override for other chains):
 *   PRIVATE_KEY | MNEMONIC  — the valve_deployer (owner + validator-allowlister). REQUIRED.
 *   RANDOM   (default 0x775AF72d62c85d2F7f0Bcc05BAa4Be0830087217)  — the IRandom contract on 943.
 *   CHIPS    (default 0x81f130c7d9ff020f46f3b01918424173f8d5ca64)  — the valve-owned Chips ERC-20 on 943.
 *   VALIDATORS (default = the 943 canonicalSubset)                 — comma-separated addresses to addValidator.
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
  { name: 'chips', type: 'function', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { name: 'random', type: 'function', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
] as const satisfies viem.Abi

const DEFAULT_RANDOM = '0x775AF72d62c85d2F7f0Bcc05BAa4Be0830087217'
const DEFAULT_CHIPS = '0x81f130c7d9ff020f46f3b01918424173f8d5ca64'
const DEFAULT_VALIDATORS = [
  '0xAe96b0748f933914867d59486251043790cB2896',
  '0x2a638D7135966a5cA1973c930bD0317cd7d6874c',
  '0x0D3148A85608708Fe944EE71E13B4C9181b7cc83',
]

function loadArtifact(): { abi: viem.Abi; bytecode: viem.Hex } {
  const fs = require('node:fs') as typeof import('node:fs')
  const path = require('node:path') as typeof import('node:path')
  const a = JSON.parse(
    fs.readFileSync(
      path.resolve(__dirname, '../artifacts/contracts/games/CoinFlipTables.sol/CoinFlipTables.json'),
      'utf8',
    ),
  )
  return { abi: a.abi as viem.Abi, bytecode: a.bytecode as viem.Hex }
}

async function main(): Promise<void> {
  /* eslint-disable no-console */
  const RPC = process.env.RPC_URL ?? 'https://rpc.v4.testnet.pulsechain.com'
  const CHAIN_ID = Number(process.env.CHAIN_ID ?? 943)
  const BUFFER_BPS = BigInt(process.env.GAS_BUFFER_BPS ?? 20_000n)
  const EXECUTE = process.env.DEPLOY_EXECUTE === '1'
  const RANDOM = (process.env.RANDOM ?? DEFAULT_RANDOM) as viem.Hex
  const CHIPS = (process.env.CHIPS ?? DEFAULT_CHIPS) as viem.Hex
  const VALIDATORS = (process.env.VALIDATORS ? process.env.VALIDATORS.split(',') : DEFAULT_VALIDATORS).map(
    (v) => viem.getAddress(v.trim()),
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

  const artifact = loadArtifact()
  const fee = await resolveLegacyFee(publicClient, { bufferBps: BUFFER_BPS })
  const balance = await publicClient.getBalance({ address: deployer.address })
  const nonce = await publicClient.getTransactionCount({ address: deployer.address })
  const predicted = viem.getContractAddress({ from: deployer.address, nonce: BigInt(nonce) })

  console.log('── deploy CoinFlipTables (permissionless player-run coin-flip tables) ──')
  console.log('chain:', CHAIN_ID, RPC)
  console.log('deployer/owner:', deployer.address, '| balance', viem.formatEther(balance), 'PLS | nonce', nonce)
  console.log('args: random', RANDOM, '| chips', CHIPS)
  console.log('validators to allowlist:', VALIDATORS.join(', '))
  console.log('gas: legacy', viem.formatGwei(fee.gasPrice), `gwei (buffer ${BUFFER_BPS} bps, type-0)`)
  console.log(`plan: CoinFlipTables ${(artifact.bytecode.length - 2) / 2}B init → ${predicted}, then ${VALIDATORS.length}× addValidator`)

  if (!EXECUTE) {
    console.log('\nDRY RUN — nothing sent. Re-run with DEPLOY_EXECUTE=1 to broadcast.')
    return
  }

  console.log('\nEXECUTING…')
  const address = await deployContractLegacy({
    walletClient,
    publicClient,
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    args: [RANDOM, CHIPS],
    fee,
    label: 'CoinFlipTables',
  })
  const deployBlock = await publicClient.getBlockNumber()

  // Allowlist the canonical validators (owner-only addValidator). Skip any already allowlisted.
  for (const v of VALIDATORS) {
    const already = (await publicClient.readContract({
      address,
      abi: GAMEBASE_ABI,
      functionName: 'isValidator',
      args: [v],
    })) as boolean
    if (already) {
      console.log('  validator already allowlisted:', v)
      continue
    }
    const { request } = await publicClient.simulateContract({
      address,
      abi: GAMEBASE_ABI,
      functionName: 'addValidator',
      args: [v],
      account: deployer,
      gasPrice: fee.gasPrice,
    })
    await publicClient.waitForTransactionReceipt({ hash: await walletClient.writeContract(request) })
    console.log('  addValidator:', v)
  }

  // read-back verification
  const owner = (await publicClient.readContract({ address, abi: GAMEBASE_ABI, functionName: 'owner' })) as viem.Hex
  const chips = (await publicClient.readContract({ address, abi: GAMEBASE_ABI, functionName: 'chips' })) as viem.Hex
  const random = (await publicClient.readContract({ address, abi: GAMEBASE_ABI, functionName: 'random' })) as viem.Hex
  const vcount = (await publicClient.readContract({ address, abi: GAMEBASE_ABI, functionName: 'validatorCount' })) as bigint

  console.log('\n✓ deployed CoinFlipTables')
  console.log('  address:      ', address)
  console.log('  deployBlock:  ', deployBlock.toString())
  console.log('  owner:        ', owner)
  console.log('  random:       ', random)
  console.log('  chips:        ', chips)
  console.log('  validatorCount:', vcount.toString())
  console.log('\nNext: set in games/web/src/config.ts (943 entry):')
  console.log(`  coinFlipTables: '${address.toLowerCase()}',`)
  console.log(`  coinFlipTablesDeployBlock: '${deployBlock.toString()}',`)
  console.log('then rebuild + deploy games-web via ansible/deploy-games-web.yml.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
