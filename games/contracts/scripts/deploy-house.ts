/**
 * Deploy the PATCHED HouseChannel and configure it — one operator script.
 *
 * The live HouseChannel (0x5787…) predates the funds-safety fixes (gameId binding in settle,
 * disputeFromOpen refund floor, gameId emitted in Opened). This deploys the patched contract
 * against the EXISTING Chips token, then runs configureHouse (setHouseKey → mint → fund).
 *
 * PULSECHAIN GAS: every transaction is sent LEGACY (type-0) with a gas price read live from the
 * chain and buffered (scripts/gas.ts). Default EIP-1559 estimation is NOT used — on PulseChain the
 * ~0 base fee makes it unreliable.
 *
 * Safety: `main()` DRY-RUNS by default (prints the plan + resolved gas, sends nothing). It only
 * broadcasts when DEPLOY_EXECUTE=1. Importing this module never sends anything.
 */
import * as viem from 'viem'
import { configureHouse, type ConfigureHouseResult } from './configure-house'
import { resolveLegacyFee, type LegacyFee } from './gas'

const ownableAbi = [
  { name: 'owner', type: 'function', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { name: 'houseKey', type: 'function', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { name: 'housePool', type: 'function', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { name: 'chips', type: 'function', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
] as const satisfies viem.Abi

export interface DeployHouseChannelOpts {
  walletClient: viem.WalletClient
  publicClient: viem.PublicClient
  abi: viem.Abi
  bytecode: viem.Hex
  /** existing Chips ERC-20 the new channel will escrow. */
  chips: viem.Hex
  /** resolved legacy fee (so the caller controls / can log the exact gas price). */
  fee: LegacyFee
  /** optional explicit deploy gas limit; omit to let the node estimate. */
  gas?: bigint
}

/** Deploy HouseChannel(chips) with a legacy fee and return its address. */
export async function deployHouseChannel(opts: DeployHouseChannelOpts): Promise<viem.Hex> {
  const { walletClient, publicClient, abi, bytecode, chips, fee, gas } = opts
  const account = walletClient.account
  if (!account) throw new Error('walletClient must have an account set')

  const hash = await walletClient.deployContract({
    abi, bytecode, args: [chips],
    account, chain: walletClient.chain,
    gasPrice: fee.gasPrice, type: 'legacy', // legacy type-0; never 1559 on PulseChain
    ...(gas !== undefined ? { gas } : {}),
  })
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`HouseChannel deploy reverted (tx ${hash})`)
  if (!receipt.contractAddress) throw new Error('deploy receipt has no contractAddress')
  return receipt.contractAddress
}

export interface DeployAndConfigureOpts {
  walletClient: viem.WalletClient
  publicClient: viem.PublicClient
  abi: viem.Abi
  bytecode: viem.Hex
  chips: viem.Hex
  houseKey: viem.Hex
  treasury: bigint
  fund: bigint
  /** gas-price buffer over the live price (bps; 20000 = 2x). */
  bufferBps?: bigint
}

export interface DeployAndConfigureResult {
  channel: viem.Hex
  fee: LegacyFee
  configure: ConfigureHouseResult
  verified: { owner: viem.Hex; houseKey: viem.Hex; housePool: bigint; chips: viem.Hex }
}

/**
 * Full path: resolve legacy fee once → deploy the patched HouseChannel → configureHouse with the
 * SAME legacy fee → read back owner/houseKey/housePool/chips for verification. Returns everything.
 */
export async function deployAndConfigureHouse(opts: DeployAndConfigureOpts): Promise<DeployAndConfigureResult> {
  const { walletClient, publicClient, abi, bytecode, chips, houseKey, treasury, fund, bufferBps } = opts
  if (fund > treasury) throw new Error(`fund (${fund}) exceeds treasury (${treasury})`)

  const fee = await resolveLegacyFee(publicClient, { bufferBps })

  const channel = await deployHouseChannel({ walletClient, publicClient, abi, bytecode, chips, fee })

  const configure = await configureHouse({
    walletClient, chips, channel, houseKey, treasury, fund, gasPrice: fee.gasPrice,
  })

  const read = async (functionName: 'owner' | 'houseKey' | 'chips') =>
    (await publicClient.readContract({ address: channel, abi: ownableAbi, functionName })) as viem.Hex
  const housePool = (await publicClient.readContract({ address: channel, abi: ownableAbi, functionName: 'housePool' })) as bigint

  return {
    channel,
    fee,
    configure,
    verified: { owner: await read('owner'), houseKey: await read('houseKey'), housePool, chips: await read('chips') },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI — dry-runs unless DEPLOY_EXECUTE=1. Never sends on import.
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  /* eslint-disable no-console */
  const fs = await import('node:fs')
  const path = await import('node:path')
  const { mnemonicToAccount } = await import('viem/accounts')

  const RPC = process.env.RPC_URL ?? 'https://rpc.v4.testnet.pulsechain.com'
  const CHAIN_ID = Number(process.env.CHAIN_ID ?? 943)
  const CHIPS = (process.env.CHIPS ?? '0xA5276259e544C86438566cB28cc87daCce060910') as viem.Hex
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

  const artifact = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../artifacts/contracts/games/HouseChannel.sol/HouseChannel.json'), 'utf8'))
  const fee = await resolveLegacyFee(publicClient, { bufferBps: BUFFER_BPS })
  const livePrice = await publicClient.getGasPrice()
  const balance = await publicClient.getBalance({ address: owner.address })

  console.log('── deploy + configure patched HouseChannel ──')
  console.log('chain:', CHAIN_ID, RPC)
  console.log('owner/deployer:', owner.address, '| balance', viem.formatEther(balance), 'PLS')
  console.log('house signer (index', HOUSE_INDEX + '):', house.address)
  console.log('chips (existing):', CHIPS)
  console.log('treasury mint:', viem.formatEther(TREASURY), 'CHIPS | fund pool:', viem.formatEther(FUND), 'CHIPS')
  console.log('gas: live', viem.formatGwei(livePrice), 'gwei → legacy', viem.formatGwei(fee.gasPrice), `gwei (buffer ${BUFFER_BPS} bps)`)
  console.log('bytecode size:', (artifact.bytecode.length - 2) / 2, 'bytes')

  if (!EXECUTE) {
    console.log('\nDRY RUN — nothing sent. Re-run with DEPLOY_EXECUTE=1 to broadcast.')
    return
  }

  console.log('\nEXECUTING…')
  const result = await deployAndConfigureHouse({
    walletClient, publicClient, abi: artifact.abi, bytecode: artifact.bytecode as viem.Hex,
    chips: CHIPS, houseKey: house.address, treasury: TREASURY, fund: FUND, bufferBps: BUFFER_BPS,
  })
  console.log('\n✅ deployed + configured')
  console.log('NEW HouseChannel:', result.channel)
  console.log('verified owner:', result.verified.owner)
  console.log('verified houseKey:', result.verified.houseKey)
  console.log('verified housePool:', viem.formatEther(result.verified.housePool), 'CHIPS')
  console.log('verified chips:', result.verified.chips)
  console.log('\nUpdate the new address in:')
  console.log('  - games/web/src/config.ts (943 houseChannel)')
  console.log('  - deploy/games-indexer/ponder.config.ts (HOUSE_CHANNEL + HOUSE_CHANNEL_START_BLOCK)')
  console.log('  - the makeSettleDomain verifyingContract')
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
