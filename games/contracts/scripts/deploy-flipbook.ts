/**
 * Deploy FlipBook — the P2P guessing-game coin flip (matching pennies), variant A of
 * examples/games/P2P_COINFLIP_DESIGN.md. One contract, no constructor args, no configure step,
 * no owner (fully permissionless): maker posts escrowed offers, taker guesses, maker reveals or
 * forfeits. Native-PLS stakes, so no Chips dependency.
 *
 * Reuses deploy-skill.ts's deployContractLegacy + gas.ts's resolveLegacyFee. Legacy type-0 gas
 * (PulseChain ~0 base fee). DRY-RUNS unless DEPLOY_EXECUTE=1. Never sends on import.
 *
 *   MNEMONIC=... RPC_URL=https://rpc.v4.testnet.pulsechain.com CHAIN_ID=943 npx tsx scripts/deploy-flipbook.ts            # dry-run
 *   MNEMONIC=... RPC_URL=https://rpc.v4.testnet.pulsechain.com CHAIN_ID=943 DEPLOY_EXECUTE=1 npx tsx scripts/deploy-flipbook.ts
 */
import * as viem from 'viem'
import { resolveLegacyFee } from './gas'
import { deployContractLegacy } from './deploy-skill'

const readAbi = [
  { name: 'nextOfferId', type: 'function', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { name: 'MIN_REVEAL_WINDOW', type: 'function', inputs: [], outputs: [{ type: 'uint32' }], stateMutability: 'view' },
  { name: 'MAX_REVEAL_WINDOW', type: 'function', inputs: [], outputs: [{ type: 'uint32' }], stateMutability: 'view' },
] as const satisfies viem.Abi

function loadFlipBookArtifact(): { abi: viem.Abi; bytecode: viem.Hex } {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const path = require('node:path') as typeof import('node:path')
  const a = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../artifacts/contracts/games/FlipBook.sol/FlipBook.json'), 'utf8'),
  )
  return { abi: a.abi as viem.Abi, bytecode: a.bytecode as viem.Hex }
}

async function main(): Promise<void> {
  /* eslint-disable no-console */
  const { mnemonicToAccount } = await import('viem/accounts')

  const RPC = process.env.RPC_URL ?? 'https://rpc.v4.testnet.pulsechain.com'
  const CHAIN_ID = Number(process.env.CHAIN_ID ?? 943)
  const BUFFER_BPS = BigInt(process.env.GAS_BUFFER_BPS ?? 20_000n)
  const EXECUTE = process.env.DEPLOY_EXECUTE === '1'

  const mnemonic = process.env.MNEMONIC
  if (!mnemonic) throw new Error('set MNEMONIC in the environment (games/contracts/.env)')
  const deployer = mnemonicToAccount(mnemonic)

  const chain = { id: CHAIN_ID, name: `chain-${CHAIN_ID}`, nativeCurrency: { name: 'PLS', symbol: 'PLS', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const
  const publicClient = viem.createPublicClient({ chain, transport: viem.http(RPC) })
  const walletClient = viem.createWalletClient({ account: deployer, chain, transport: viem.http(RPC) })

  const artifact = loadFlipBookArtifact()
  const fee = await resolveLegacyFee(publicClient, { bufferBps: BUFFER_BPS })
  const livePrice = await publicClient.getGasPrice()
  const balance = await publicClient.getBalance({ address: deployer.address })
  const nonce = await publicClient.getTransactionCount({ address: deployer.address })
  const predicted = viem.getContractAddress({ from: deployer.address, nonce: BigInt(nonce) })

  console.log('── deploy FlipBook (P2P guessing-game coinflip — no owner, no configure) ──')
  console.log('chain:', CHAIN_ID, RPC)
  console.log('deployer:', deployer.address, '| balance', viem.formatEther(balance), 'PLS | nonce', nonce)
  console.log('gas: live', viem.formatGwei(livePrice), 'gwei → legacy', viem.formatGwei(fee.gasPrice), `gwei (buffer ${BUFFER_BPS} bps, type-0)`)
  console.log(`plan: FlipBook ${(artifact.bytecode.length - 2) / 2}B init → ${predicted} (no args)`)

  if (!EXECUTE) {
    console.log('\nDRY RUN — nothing sent. Re-run with DEPLOY_EXECUTE=1 to broadcast.')
    return
  }

  console.log('\nEXECUTING…')
  const flipBook = await deployContractLegacy({
    walletClient, publicClient, abi: artifact.abi, bytecode: artifact.bytecode, args: [], fee, label: 'FlipBook',
  })

  // read-back verification: constants + fresh counter prove the right bytecode is live
  const read = <T>(fn: 'nextOfferId' | 'MIN_REVEAL_WINDOW' | 'MAX_REVEAL_WINDOW') =>
    publicClient.readContract({ address: flipBook, abi: readAbi, functionName: fn }) as Promise<T>
  const nextId = await read<bigint>('nextOfferId')
  const minW = await read<number>('MIN_REVEAL_WINDOW')
  const maxW = await read<number>('MAX_REVEAL_WINDOW')

  console.log('\n✅ deployed')
  console.log('FlipBook:', flipBook)
  console.log('verified nextOfferId:', nextId, nextId === 1n ? '✓' : '✗ MISMATCH')
  console.log('verified MIN_REVEAL_WINDOW:', minW, minW === 300 ? '✓' : '✗ MISMATCH')
  console.log('verified MAX_REVEAL_WINDOW:', maxW, maxW === 604800 ? '✓' : '✗ MISMATCH')
  console.log('\nNext: post/take/reveal exercise, Sourcify verification, web config wiring.')
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
