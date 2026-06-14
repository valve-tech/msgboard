import { createRequire } from 'node:module'
import { createServer } from 'prool'
import { anvil } from 'prool/instances'
import {
  type Hex,
  type Address,
  createTestClient,
  createPublicClient,
  createWalletClient,
  http,
  publicActions,
  walletActions,
  encodeFunctionData,
  decodeEventLog,
  parseAbi,
} from 'viem'
import { foundry } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import {
  getSafeSingletonDeployment,
  getProxyFactoryDeployment,
  getCompatibilityFallbackHandlerDeployment,
} from '@safe-global/safe-deployments'

const VERSION = '1.4.1'

// Bytecode source: @safe-global/safe-deployments (>=1.33) no longer ships deployedBytecode —
// only the canonical address + codeHash. The audited canonical v1.4.1 runtime bytecode is
// shipped by @safe-global/safe-contracts as hardhat artifacts. The deps smoke test asserts
// keccak256(artifact.deployedBytecode) === safe-deployments' canonical codeHash, so the
// bytecode we setCode is byte-identical to the real on-chain Safe.
const require = createRequire(import.meta.url)
const SafeArtifact = require('@safe-global/safe-contracts/build/artifacts/contracts/Safe.sol/Safe.json')
const FactoryArtifact = require('@safe-global/safe-contracts/build/artifacts/contracts/proxies/SafeProxyFactory.sol/SafeProxyFactory.json')
const FallbackArtifact = require('@safe-global/safe-contracts/build/artifacts/contracts/handler/CompatibilityFallbackHandler.sol/CompatibilityFallbackHandler.json')

export const FACTORY_ABI = parseAbi([
  'function createProxyWithNonce(address singleton, bytes initializer, uint256 saltNonce) returns (address proxy)',
  'event ProxyCreation(address indexed proxy, address singleton)',
])

export const SETUP_ABI = parseAbi([
  'function setup(address[] _owners, uint256 _threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)',
])

export interface SafeFixture {
  rpcUrl: string
  chainId: number
  publicClient: ReturnType<typeof createPublicClient>
  walletClient: ReturnType<typeof createWalletClient>
  safe: Address
  owners: ReturnType<typeof privateKeyToAccount>[]
  threshold: number
  stop: () => Promise<void>
}

/**
 * Boots an anvil instance, sets the Safe v1.4.1 singleton / proxy factory / fallback-handler
 * runtime bytecode at their canonical addresses via setCode, then creates a `threshold`-of-N
 * Safe owned by `ownerPks`. Returns clients + the Safe address.
 */
export async function deploySafeFixture(ownerPks: Hex[], threshold: number): Promise<SafeFixture> {
  const singleton = getSafeSingletonDeployment({ version: VERSION })!
  const factory = getProxyFactoryDeployment({ version: VERSION })!
  const fallback = getCompatibilityFallbackHandlerDeployment({ version: VERSION })!

  const singletonAddr = singleton.defaultAddress as Address
  const factoryAddr = factory.defaultAddress as Address
  const fallbackAddr = fallback.defaultAddress as Address

  // 1) start anvil (port 0 → prool assigns a free port).
  // A nightly Foundry build prints a stderr warning that breaks prool's readiness
  // detection ("Failed to start process anvil"); disable it so the instance starts cleanly.
  process.env.FOUNDRY_DISABLE_NIGHTLY_WARNING ??= '1'
  const server = createServer({ instance: anvil(), port: 0 })
  await server.start()
  const { port } = server.address()!
  const rpcUrl = `http://localhost:${port}/1` // prool pool id 1 (localhost: prool binds IPv6 ::)
  const chain = { ...foundry, id: foundry.id }
  const chainId = chain.id

  const test = createTestClient({ mode: 'anvil', chain, transport: http(rpcUrl) })
    .extend(publicActions)
    .extend(walletActions)
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) })

  // 2) inject the audited runtime bytecode at the canonical addresses
  await test.setCode({ address: singletonAddr, bytecode: SafeArtifact.deployedBytecode as Hex })
  await test.setCode({ address: factoryAddr, bytecode: FactoryArtifact.deployedBytecode as Hex })
  await test.setCode({ address: fallbackAddr, bytecode: FallbackArtifact.deployedBytecode as Hex })

  // 3) a funded deployer (anvil default account 0)
  const deployerPk = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex
  const deployer = privateKeyToAccount(deployerPk)
  const walletClient = createWalletClient({ account: deployer, chain, transport: http(rpcUrl) })

  // 4) build the setup() initializer for our owner set + threshold + fallback handler
  const owners = ownerPks.map((pk) => privateKeyToAccount(pk))
  const ownerAddrs = [...owners].map((o) => o.address).sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1))
  const initializer = encodeFunctionData({
    abi: SETUP_ABI,
    functionName: 'setup',
    args: [
      ownerAddrs,
      BigInt(threshold),
      '0x0000000000000000000000000000000000000000',
      '0x',
      fallbackAddr,
      '0x0000000000000000000000000000000000000000',
      0n,
      '0x0000000000000000000000000000000000000000',
    ],
  })

  // 5) deploy the proxy via the factory
  const saltNonce = 0n
  const hash = await walletClient.writeContract({
    address: factoryAddr,
    abi: FACTORY_ABI,
    functionName: 'createProxyWithNonce',
    args: [singletonAddr, initializer, saltNonce],
  })
  const receipt = await publicClient.waitForTransactionReceipt({ hash })

  // pull the proxy address from the ProxyCreation event
  let safe: Address | undefined
  for (const log of receipt.logs) {
    try {
      const ev = decodeEventLog({ abi: FACTORY_ABI, data: log.data, topics: log.topics })
      if (ev.eventName === 'ProxyCreation') safe = ev.args.proxy as Address
    } catch {
      /* not our event */
    }
  }
  if (!safe) throw new Error('ProxyCreation event not found — Safe proxy deploy failed')

  return {
    rpcUrl,
    chainId,
    publicClient,
    walletClient,
    safe,
    owners,
    threshold,
    stop: async () => {
      await server.stop()
    },
  }
}
