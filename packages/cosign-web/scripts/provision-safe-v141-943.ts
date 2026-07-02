/**
 * provision-safe-v141-943.ts — Provisions the canonical Safe v1.4.1 contract suite (SafeL2 singleton,
 * SafeProxyFactory, CompatibilityFallbackHandler) on PulseChain v4 testnet (chainId 943), so the
 * cosign-web "Create a Safe" feature (v1.4.1-only, feature-detected via isDeploySupported()) works
 * there. v1.3.0 is already on 943; this ADDS v1.4.1 alongside it.
 *
 * METHOD: Safe's canonical addresses are produced by sending each contract's raw CREATE2 creation
 * bytecode to the Safe "singleton factory" (a minimal, chain-agnostic CREATE2 relay present on
 * almost every EVM chain, incl. 943, at 0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7). IMPORTANT: the
 * factory's calldata format is `salt (32 bytes) ++ initCode`, NOT just the raw init code — its
 * bytecode does `calldataload(0)` for the salt and `calldatacopy` of `calldata[32:]` for the init
 * code, then `CREATE2(value=callvalue, offset=0, length=calldatasize-32, salt)`. We always use a
 * ZERO salt, so identical creation bytecode always yields the identical canonical address regardless
 * of chain or deployer. (A first draft of this script omitted the salt prefix and sent the creation
 * code alone — the factory silently reinterpreted the code's own first 32 bytes as the salt and
 * deployed garbage at an unrelated address; harmless on testnet, but the calldata format below is
 * the corrected, verified-working one — see the pre-broadcast address assertion in Step 1.)
 * This script:
 *   1. Predicts each contract's address (pure, offline) and asserts it equals the known canonical
 *      address BEFORE broadcasting anything — if the bytecode were wrong (wrong version/compiler),
 *      this assertion fails and the script aborts before spending any gas.
 *   2. Skips any contract already deployed on-chain (idempotent — safe to re-run).
 *   3. Deploys the rest via the singleton factory, waits for receipts, and re-asserts eth_getCode.
 *   4. Runs an integration proof: predicts a fresh Safe address via the app's OWN
 *      predictSafeAddress()/buildSetup() (src/lib/deploy-safe.ts), deploys it for real via the
 *      now-present SafeProxyFactory.createProxyWithNonce, and asserts the mined proxy address
 *      equals the predicted one — proving the cosign-web "Create a Safe" flow works end-to-end on 943.
 *
 * Creation bytecode source: @safe-global/safe-contracts@1.4.1 build artifacts (SafeL2.sol,
 * proxies/SafeProxyFactory.sol, handler/CompatibilityFallbackHandler.sol), extracted once into the
 * co-located safe-v141-bytecode.json so this script has no install-time dependency on npm/registry
 * availability and is byte-for-byte reproducible. To regenerate that file from scratch:
 *   mkdir /tmp/safe141 && cd /tmp/safe141 && npm init -y && npm install @safe-global/safe-contracts@1.4.1 --no-save
 *   # then read .bytecode from build/artifacts/contracts/{SafeL2.sol/SafeL2,
 *   #   proxies/SafeProxyFactory.sol/SafeProxyFactory,
 *   #   handler/CompatibilityFallbackHandler.sol/CompatibilityFallbackHandler}.json
 *
 * Run:
 *   cd packages/cosign-web
 *   PRIVATE_KEY=0x... npx tsx scripts/provision-safe-v141-943.ts
 *
 * PRIVATE_KEY must be a funded 943 key. Deployment is deployer-independent (CREATE2 via the
 * singleton factory yields the same canonical addresses regardless of sender) — any funded key works.
 * DO NOT COMMIT a private key. This script never logs it.
 */
import {
  type Hex,
  createPublicClient,
  createWalletClient,
  http,
  defineChain,
  getContractAddress,
  isAddressEqual,
  getAddress,
  concat,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  SAFE_V141,
  PROXY_FACTORY_ABI,
  buildSetup,
  predictSafeAddress,
  randomSaltNonce,
  confirmDeploy,
} from '../src/lib/deploy-safe'

const __dirname = dirname(fileURLToPath(import.meta.url))

const CHAIN_ID = 943
const RPC = 'https://one.valve.city/rpc/vk_demo/evm/943'
const SINGLETON_FACTORY = getAddress('0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7')
const ZERO_SALT = `0x${'00'.repeat(32)}` as Hex

type Asset = { canonical: Hex; creationBytecode: Hex }
type Assets = { SafeL2: Asset; SafeProxyFactory: Asset; CompatibilityFallbackHandler: Asset }

const assets = JSON.parse(readFileSync(join(__dirname, 'safe-v141-bytecode.json'), 'utf8')) as Assets

// Sanity: the assets file's canonical addresses must match the app's own SAFE_V141 constants.
if (!isAddressEqual(assets.SafeL2.canonical, SAFE_V141.singletonL2)) throw new Error('SafeL2 canonical mismatch vs deploy-safe.ts')
if (!isAddressEqual(assets.SafeProxyFactory.canonical, SAFE_V141.factory)) throw new Error('SafeProxyFactory canonical mismatch vs deploy-safe.ts')
if (!isAddressEqual(assets.CompatibilityFallbackHandler.canonical, SAFE_V141.fallbackHandler))
  throw new Error('CompatibilityFallbackHandler canonical mismatch vs deploy-safe.ts')

const pls943 = defineChain({
  id: CHAIN_ID,
  name: 'PulseChain v4',
  nativeCurrency: { name: 'tPLS', symbol: 'tPLS', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
})
const publicClient = createPublicClient({ chain: pls943, transport: http(RPC) })

async function main() {
  console.log('═'.repeat(92))
  console.log('Provision Safe v1.4.1 on PulseChain v4 testnet (943)')
  console.log('═'.repeat(92))

  const cid = await publicClient.getChainId()
  if (cid !== CHAIN_ID) throw new Error(`RPC is not 943 (got ${cid})`)

  const factoryCode = await publicClient.getCode({ address: SINGLETON_FACTORY })
  if (!factoryCode || factoryCode === '0x') throw new Error(`Safe singleton factory ${SINGLETON_FACTORY} has no code on 943`)
  console.log(`Singleton factory ${SINGLETON_FACTORY}: present ✓`)

  const pk = process.env.PRIVATE_KEY as Hex | undefined
  if (!pk) throw new Error('Set PRIVATE_KEY=0x... (a funded 943 key) in the environment')
  const account = privateKeyToAccount(pk.startsWith('0x') ? pk : (`0x${pk}` as Hex))
  const walletClient = createWalletClient({ account, chain: pls943, transport: http(RPC) })

  const balance = await publicClient.getBalance({ address: account.address })
  console.log(`Deployer: ${account.address}  balance: ${balance} wei`)
  if (balance === 0n) throw new Error('Deployer has zero balance — fund it before running')

  // ── Step 1: predict + assert BEFORE broadcasting anything ──────────────────────────────────
  const order: (keyof Assets)[] = ['SafeL2', 'SafeProxyFactory', 'CompatibilityFallbackHandler']
  for (const name of order) {
    const { canonical, creationBytecode } = assets[name]
    const predicted = getContractAddress({ opcode: 'CREATE2', from: SINGLETON_FACTORY, salt: ZERO_SALT, bytecode: creationBytecode })
    if (!isAddressEqual(predicted, canonical)) {
      throw new Error(`${name}: predicted CREATE2 address ${predicted} != canonical ${canonical} — WRONG BYTECODE, aborting before broadcast`)
    }
    console.log(`${name}: predicted address ${predicted} == canonical ✓ (pre-broadcast check)`)
  }

  // ── Step 2+3: deploy each (idempotent — skip if already present) ───────────────────────────
  const deployed: Record<string, { address: Hex; txHash: Hex | 'already-deployed' }> = {}
  for (const name of order) {
    const { canonical, creationBytecode } = assets[name]
    const existing = await publicClient.getCode({ address: canonical })
    if (existing && existing !== '0x') {
      console.log(`${name} (${canonical}): already deployed, skipping ✓`)
      deployed[name] = { address: canonical, txHash: 'already-deployed' }
      continue
    }
    console.log(`${name}: deploying via singleton factory...`)
    const factoryCalldata = concat([ZERO_SALT, creationBytecode])
    const txHash = await walletClient.sendTransaction({ to: SINGLETON_FACTORY, data: factoryCalldata })
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash })
    if (receipt.status !== 'success') throw new Error(`${name}: deploy tx ${txHash} reverted`)
    const code = await publicClient.getCode({ address: canonical })
    if (!code || code === '0x') throw new Error(`${name}: eth_getCode at ${canonical} is still empty after deploy tx ${txHash}`)
    console.log(`${name}: deployed ✓  tx=${txHash}  address=${canonical}`)
    deployed[name] = { address: canonical, txHash }
  }

  // ── Step 4: integration proof — predict + actually deploy a real Safe, assert match ─────────
  console.log('\n' + '─'.repeat(92))
  console.log('Integration proof: predict + deploy a real v1.4.1 Safe via the now-present factory')
  console.log('─'.repeat(92))
  const owners: Hex[] = [account.address, getAddress('0x2222222222222222222222222222222222222222')]
  const threshold = 1
  const saltNonce = randomSaltNonce()
  const predictedSafe = predictSafeAddress({ owners, threshold, saltNonce })
  console.log(`Predicted Safe address: ${predictedSafe}  (owners=${owners.join(',')}, threshold=${threshold}, saltNonce=${saltNonce})`)

  const initializer = buildSetup(owners, threshold)
  const createTxHash = await walletClient.writeContract({
    address: SAFE_V141.factory,
    abi: PROXY_FACTORY_ABI,
    functionName: 'createProxyWithNonce',
    args: [SAFE_V141.singletonL2, initializer, saltNonce],
  })
  const minedSafe = await confirmDeploy(publicClient, createTxHash, predictedSafe)
  console.log(`Deployed Safe: ${minedSafe}  tx=${createTxHash}`)
  if (!isAddressEqual(minedSafe, predictedSafe)) throw new Error('Mined Safe address != predicted (should be unreachable — confirmDeploy would have thrown)')
  console.log('Mined proxy == predicted ✓ — Create-a-Safe flow proven working on 943')

  // ── Summary ─────────────────────────────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(92))
  console.log('SUMMARY')
  console.log('═'.repeat(92))
  for (const name of order) console.log(`${name}: ${deployed[name].address}  (tx: ${deployed[name].txHash})`)
  console.log(`Integration-proof Safe: ${minedSafe}  (tx: ${createTxHash})`)
}

main().catch((e) => {
  console.error('\n💥 FATAL:', e)
  process.exit(1)
})
