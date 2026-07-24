/**
 * Deploy StealthMessenger (ERC-5564 / ERC-6538 stealth-address private messaging) to a chain.
 *
 * Fund-less contract: no constructor args, holds no funds, needs no minter — so ANY funded EOA can
 * deploy it (unlike HouseChannel, which requires the Chips owner). Uses the same 943 legacy-fee
 * pattern as deploy-house.ts.
 *
 *   DEPLOY_EXECUTE=1 CHAIN_ID=943 MNEMONIC='…' npx tsx scripts/deploy-stealth.ts
 *   (omit DEPLOY_EXECUTE for a dry run — resolves gas + balance, sends nothing)
 */
import * as viem from 'viem'
import { resolveLegacyFee } from './gas'

async function main(): Promise<void> {
  /* eslint-disable no-console */
  const fs = await import('node:fs')
  const path = await import('node:path')
  const { mnemonicToAccount } = await import('viem/accounts')

  const RPC = process.env.RPC_URL ?? 'https://rpc.v4.testnet.pulsechain.com'
  const CHAIN_ID = Number(process.env.CHAIN_ID ?? 943)
  const BUFFER_BPS = BigInt(process.env.GAS_BUFFER_BPS ?? 20_000n)
  const EXECUTE = process.env.DEPLOY_EXECUTE === '1'

  const mnemonic = process.env.MNEMONIC
  if (!mnemonic) throw new Error('set MNEMONIC in the environment')
  const owner = mnemonicToAccount(mnemonic) // account index 0 = deployer

  const chain = {
    id: CHAIN_ID, name: `chain-${CHAIN_ID}`, nativeCurrency: { name: 'PLS', symbol: 'PLS', decimals: 18 },
    rpcUrls: { default: { http: [RPC] } },
  } as const
  const publicClient = viem.createPublicClient({ chain, transport: viem.http(RPC) })
  const walletClient = viem.createWalletClient({ account: owner, chain, transport: viem.http(RPC) })

  // forge artifact (kept in sync by `forge build`); bytecode object is under .bytecode.object.
  const artifact = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../forge-out/StealthMessenger.sol/StealthMessenger.json'), 'utf8'),
  )
  const bytecode = (artifact.bytecode.object ?? artifact.bytecode) as viem.Hex
  const fee = await resolveLegacyFee(publicClient, { bufferBps: BUFFER_BPS })
  const balance = await publicClient.getBalance({ address: owner.address })

  console.log('── deploy StealthMessenger ──')
  console.log('chain:', CHAIN_ID, RPC)
  console.log('deployer:', owner.address, '| balance', viem.formatEther(balance), 'PLS')
  console.log('legacy gasPrice:', viem.formatGwei(fee.gasPrice), `gwei (buffer ${BUFFER_BPS} bps)`)
  console.log('bytecode size:', (bytecode.length - 2) / 2, 'bytes')

  if (!EXECUTE) {
    console.log('\nDRY RUN — nothing sent. Re-run with DEPLOY_EXECUTE=1 to broadcast.')
    return
  }

  console.log('\nEXECUTING…')
  const hash = await walletClient.deployContract({
    abi: artifact.abi, bytecode, args: [], gasPrice: fee.gasPrice, type: 'legacy',
  })
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`deploy reverted (tx ${hash})`)
  const address = receipt.contractAddress!
  // sanity read: SCHEME_ID() == 1
  const schemeId = await publicClient.readContract({ address, abi: artifact.abi, functionName: 'SCHEME_ID' })
  console.log('\n✅ deployed')
  console.log('StealthMessenger:', address)
  console.log('verified SCHEME_ID:', schemeId)
  console.log('tx:', hash, '| block', receipt.blockNumber)
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
