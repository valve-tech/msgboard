/**
 * Deploy a FRESH games stack — a new Chips token + HouseChannel (with the close-authorization +
 * walk-away-forfeiture fixes) — owned by valve_deployer, fully off the gibs-affiliated 0xaf2ce018.
 *
 * The old Chips (0xa527…) + HouseChannel (0x74bb…) are owned by 0xaf2ce018 (gibs), whose key we don't
 * hold; this deploys clean replacements from valve_deployer, which becomes the Chips owner/minter and
 * the HouseChannel owner + house key (single testnet identity, per the dice-slice design). NEW play-
 * money token → old CHIPS balances do NOT carry over (clean slate).
 *
 * Gas: base-fee-matched via the fixed resolveLegacyFee (NOT the node's ~100k-gwei suggestion) — the
 * whole stack costs a fraction of a cent.
 *
 *   DEPLOY_EXECUTE=1 CHAIN_ID=943 PRIVATE_KEY=<valve_deployer> npx tsx scripts/deploy-games-valve.ts
 *   (omit DEPLOY_EXECUTE for a dry run)
 */
import * as viem from 'viem'
import { privateKeyToAccount, mnemonicToAccount } from 'viem/accounts'
import { resolveLegacyFee } from './gas'
import { deployAndConfigureHouse } from './deploy-house'

async function main(): Promise<void> {
  /* eslint-disable no-console */
  const fs = await import('node:fs')
  const path = await import('node:path')

  const RPC = process.env.RPC_URL ?? 'https://rpc.v4.testnet.pulsechain.com'
  const CHAIN_ID = Number(process.env.CHAIN_ID ?? 943)
  const TREASURY = BigInt(process.env.TREASURY ?? 1_000_000n * 10n ** 18n)
  const FUND = BigInt(process.env.FUND ?? 500_000n * 10n ** 18n)
  const EXECUTE = process.env.DEPLOY_EXECUTE === '1'

  const pk = process.env.PRIVATE_KEY
  const mnemonic = process.env.MNEMONIC
  if (!pk && !mnemonic) throw new Error('set PRIVATE_KEY (valve_deployer) or MNEMONIC')
  const owner = pk ? privateKeyToAccount((pk.startsWith('0x') ? pk : `0x${pk}`) as viem.Hex) : mnemonicToAccount(mnemonic!)
  // Single testnet identity: valve_deployer is owner (bankroll control) AND house key (co-signs).
  const houseKey = (process.env.HOUSE_KEY as viem.Hex) ?? owner.address

  const chain = {
    id: CHAIN_ID, name: `chain-${CHAIN_ID}`, nativeCurrency: { name: 'PLS', symbol: 'PLS', decimals: 18 },
    rpcUrls: { default: { http: [RPC] } },
  } as const
  const publicClient = viem.createPublicClient({ chain, transport: viem.http(RPC) })
  const walletClient = viem.createWalletClient({ account: owner, chain, transport: viem.http(RPC) })

  const load = (name: string, sol: string) =>
    JSON.parse(fs.readFileSync(path.resolve(__dirname, `../forge-out/${sol}/${name}.json`), 'utf8'))
  const chipsArt = load('Chips', 'Chips.sol')
  const houseArt = load('HouseChannel', 'HouseChannel.sol')

  const fee = await resolveLegacyFee(publicClient)
  const balance = await publicClient.getBalance({ address: owner.address })

  console.log('── deploy FRESH games stack (Chips + HouseChannel) from valve_deployer ──')
  console.log('chain:', CHAIN_ID, RPC)
  console.log('deployer/owner:', owner.address, '| balance', viem.formatEther(balance), 'PLS')
  console.log('house key (single identity):', houseKey)
  console.log('gasPrice:', viem.formatGwei(fee.gasPrice), 'gwei (base + tip)')
  console.log('treasury mint:', viem.formatEther(TREASURY), 'CHIPS | fund pool:', viem.formatEther(FUND), 'CHIPS')

  if (!EXECUTE) {
    console.log('\nDRY RUN — nothing sent. Re-run with DEPLOY_EXECUTE=1 to broadcast.')
    return
  }

  console.log('\nEXECUTING…')
  // 1) fresh Chips (valve_deployer becomes owner + minter)
  const chipsHash = await walletClient.deployContract({
    abi: chipsArt.abi, bytecode: (chipsArt.bytecode.object ?? chipsArt.bytecode) as viem.Hex, args: [],
    account: owner, chain, gasPrice: fee.gasPrice, type: 'legacy',
  })
  const chipsRcpt = await publicClient.waitForTransactionReceipt({ hash: chipsHash })
  if (chipsRcpt.status !== 'success' || !chipsRcpt.contractAddress) throw new Error(`Chips deploy failed (${chipsHash})`)
  const chips = chipsRcpt.contractAddress
  console.log('  Chips:', chips)

  // 2) HouseChannel(chips) + configure (setHouseKey → mint → approve → fundHouse)
  const result = await deployAndConfigureHouse({
    walletClient, publicClient,
    abi: houseArt.abi, bytecode: (houseArt.bytecode.object ?? houseArt.bytecode) as viem.Hex,
    chips, houseKey, treasury: TREASURY, fund: FUND,
  })

  console.log('\n✅ deployed + configured')
  console.log('Chips:        ', chips)
  console.log('HouseChannel: ', result.channel, '| deploy block', chipsRcpt.blockNumber)
  console.log('verified owner:', result.verified.owner)
  console.log('verified houseKey:', result.verified.houseKey)
  console.log('verified housePool:', viem.formatEther(result.verified.housePool), 'CHIPS')
  console.log('verified chips:', result.verified.chips)
  console.log('\nUpdate the new addresses in:')
  console.log('  - games/web/src/config.ts (943 houseChannel + chips)')
  console.log('  - games/house-service/src/liveConfig.ts (houseChannel + chips)')
  console.log('  - deploy/games-indexer/ponder.config.ts (HOUSE_CHANNEL + HOUSE_CHANNEL_START_BLOCK)')
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
