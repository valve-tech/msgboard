/**
 * Deploy PetitionSignatures (on-chain EIP-712 co-signature ledger for MsgBoard petitions) to a
 * chain.
 *
 * Fund-less contract: no constructor args, holds no funds, needs no minter — so ANY funded EOA can
 * deploy it (unlike HouseChannel, which requires the Chips owner). Uses the same 943 legacy-fee
 * pattern as deploy-stealth.ts / deploy-house.ts.
 *
 *   DEPLOY_EXECUTE=1 CHAIN_ID=943 MNEMONIC='…' npx tsx scripts/deploy-petition.ts
 *   (omit DEPLOY_EXECUTE for a dry run — resolves gas + balance, sends nothing)
 *
 * After a real deploy, record {chainId, address, deployBlock} into
 * packages/petition/src/contract.ts `deployments`.
 */
import * as viem from 'viem'
import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts'

async function main(): Promise<void> {
  /* eslint-disable no-console */
  const fs = await import('node:fs')
  const path = await import('node:path')

  const RPC = process.env.RPC_URL ?? 'https://rpc.v4.testnet.pulsechain.com'
  const CHAIN_ID = Number(process.env.CHAIN_ID ?? 943)
  // GAS: PulseChain's eth_gasPrice / maxPriorityFeePerGas return an absurd ~100,000 gwei suggestion,
  // but the real base fee is ~7 wei and blocks are empty. We MATCH THE BASE FEE (+ a tiny tip for
  // inclusion) — never the node's priority suggestion. GAS_GWEI overrides the tip (default 0.5 gwei,
  // proven to mine on 943; a deploy then costs a fraction of a cent, not 170 PLS).
  const TIP = viem.parseGwei(process.env.GAS_GWEI ?? '0.5')
  const EXECUTE = process.env.DEPLOY_EXECUTE === '1'

  // Deployer: PRIVATE_KEY (e.g. valve_deployer) takes precedence; else MNEMONIC index 0.
  const pk = process.env.PRIVATE_KEY
  const mnemonic = process.env.MNEMONIC
  if (!pk && !mnemonic) throw new Error('set PRIVATE_KEY or MNEMONIC in the environment')
  const owner = pk ? privateKeyToAccount((pk.startsWith('0x') ? pk : `0x${pk}`) as viem.Hex) : mnemonicToAccount(mnemonic!)

  const chain = {
    id: CHAIN_ID, name: `chain-${CHAIN_ID}`, nativeCurrency: { name: 'PLS', symbol: 'PLS', decimals: 18 },
    rpcUrls: { default: { http: [RPC] } },
  } as const
  const publicClient = viem.createPublicClient({ chain, transport: viem.http(RPC) })
  const walletClient = viem.createWalletClient({ account: owner, chain, transport: viem.http(RPC) })

  // forge artifact (kept in sync by `forge build`); bytecode object is under .bytecode.object.
  const artifact = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../forge-out/PetitionSignatures.sol/PetitionSignatures.json'), 'utf8'),
  )
  const bytecode = (artifact.bytecode.object ?? artifact.bytecode) as viem.Hex
  const block = await publicClient.getBlock({ blockTag: 'latest' })
  const baseFee = block.baseFeePerGas ?? 0n
  // legacy gasPrice = base fee + a tiny tip (type-0; PulseChain nodes prefer legacy).
  const gasPrice = baseFee + TIP
  const balance = await publicClient.getBalance({ address: owner.address })
  const estCost = viem.formatEther(gasPrice * 1_000_000n) // ~1M gas upper bound

  console.log('── deploy PetitionSignatures ──')
  console.log('chain:', CHAIN_ID, RPC)
  console.log('deployer:', owner.address, '| balance', viem.formatEther(balance), 'PLS')
  console.log('baseFee:', baseFee, 'wei | gasPrice:', viem.formatGwei(gasPrice), 'gwei (base + tip)')
  console.log('bytecode size:', (bytecode.length - 2) / 2, 'bytes | est. max cost ~', estCost, 'PLS')

  if (!EXECUTE) {
    console.log('\nDRY RUN — nothing sent. Re-run with DEPLOY_EXECUTE=1 to broadcast.')
    return
  }

  console.log('\nEXECUTING…')
  const hash = await walletClient.deployContract({
    abi: artifact.abi, bytecode, args: [], gasPrice, type: 'legacy',
  })
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`deploy reverted (tx ${hash})`)
  const address = receipt.contractAddress!
  // sanity read: count() on a fresh petitionId is 0
  const zeroCount = await publicClient.readContract({
    address, abi: artifact.abi, functionName: 'count', args: [viem.zeroHash],
  })
  console.log('\n✅ deployed')
  console.log('PetitionSignatures:', address)
  console.log('verified count(0x0):', zeroCount)
  console.log('tx:', hash, '| block', receipt.blockNumber)
  console.log('\nRecord this into packages/petition/src/contract.ts `deployments`:')
  console.log(`  ${CHAIN_ID}: { chainId: ${CHAIN_ID}, address: '${address}', deployBlock: ${receipt.blockNumber} },`)
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
