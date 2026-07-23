/**
 * Ink fresh price-0 validator pools for the WEB APP on a live chain (the parity gate inks only
 * its own two-preimage run pools). One pool per validator, POOL_SIZE preimages each.
 *
 * Secrets are DERIVED, not stored: validator i's preimage j is the private key of the seeds0
 * mnemonic's HD account at index i*1000 + j. Anything holding seeds0 (the cast watcher) can
 * re-derive every secret; nothing else needs to be persisted. seeds0 is a DEDICATED mnemonic
 * used only as a secret seed — never a funded wallet (the duel-943 "seeds0" convention).
 *
 * Env: MNEMONIC (funded payer; account 0 pays the ink gas), SEEDS0 (secret seed mnemonic),
 *      CHAIN (default 943), RPC, VALIDATORS (default 3), POOL_SIZE (default 16),
 *      RANDOM_ADDRESS (override; defaults to the core registry).
 *
 * Prints the deployment JSON snippet for web/src/config.ts and writes it next to this script
 * as <chainId>-deployment.json (addresses/offsets only — public data).
 */
import * as viem from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { seeds0Secret, SECRET_STRIDE } from './seeds0'
import {
  chains,
  defaultRpc,
  randomAddress as knownRandom,
  makePublicClient,
  randomAbi,
  type GamesChainId,
  type Info,
} from '@msgboard/games-core'

const env = process.env
const CHAIN = (env.CHAIN ? Number(env.CHAIN) : 943) as GamesChainId
const VALIDATOR_COUNT = env.VALIDATORS ? Number(env.VALIDATORS) : 3
const POOL_SIZE = env.POOL_SIZE ? Number(env.POOL_SIZE) : 64
const scriptDir = path.dirname(fileURLToPath(import.meta.url))

const main = async () => {
  if (!env.MNEMONIC) throw new Error('MNEMONIC (funded payer) required')
  if (!env.SEEDS0) throw new Error('SEEDS0 (secret seed mnemonic) required')
  const account = mnemonicToAccount(env.MNEMONIC)
  const rpc = env.RPC || defaultRpc[CHAIN]
  const publicClient = makePublicClient(CHAIN, rpc)
  const wallet = viem.createWalletClient({ account, chain: chains[CHAIN], transport: viem.http(rpc) })
  const random = (env.RANDOM_ADDRESS as viem.Hex | undefined) ?? knownRandom[CHAIN]
  if (!random) throw new Error('no Random address; set RANDOM_ADDRESS')

  const { flooredFees } = await import('./actor-common')
  const fees = await flooredFees(publicClient)

  console.log(`inking ${VALIDATOR_COUNT} pools of ${POOL_SIZE} on chain ${CHAIN} (payer ${account.address})`)
  const poolOffsets: Record<string, string> = {}
  const subset: viem.Hex[] = []
  for (let i = 0; i < VALIDATOR_COUNT; i++) {
    const validator = mnemonicToAccount(env.MNEMONIC, { addressIndex: i + 1 })
    subset.push(validator.address)
    const preimages = Array.from({ length: POOL_SIZE }, (_p, j) =>
      viem.keccak256(seeds0Secret(env.SEEDS0!, i * SECRET_STRIDE + j)),
    )
    const section: Info = {
      provider: validator.address,
      callAtChange: false,
      durationIsTimestamp: false,
      duration: 12n,
      token: viem.zeroAddress,
      price: 0n,
      offset: 0n,
      index: 0n,
    }
    const { request } = await publicClient.simulateContract({
      address: random,
      abi: randomAbi,
      functionName: 'ink',
      args: [section, viem.concatHex(preimages)],
      account,
      value: 0n,
      ...fees,
    })
    const receipt = await publicClient.waitForTransactionReceipt({ hash: await wallet.writeContract(request) })
    if (receipt.status !== 'success') throw new Error(`ink for validator ${i} reverted`)
    const inkArgs = viem.parseEventLogs({ abi: randomAbi, eventName: 'Ink', logs: receipt.logs })[0]?.args as
      | { offset?: bigint }
      | undefined
    const offset = inkArgs?.offset !== undefined ? BigInt.asUintN(128, inkArgs.offset >> 128n) : 0n
    poolOffsets[validator.address.toLowerCase()] = offset.toString()
    console.log(`  validator ${i} ${validator.address}: pool at offset ${offset} (block ${receipt.blockNumber})`)
  }

  const deployBlock = (await publicClient.getBlockNumber()).toString()
  const deployment = { chainId: CHAIN, random, canonicalSubset: subset, poolOffsets, deployBlock, poolSize: POOL_SIZE }
  const out = path.join(scriptDir, `${CHAIN}-deployment.json`)
  // merge with any existing file (the gate writes coinFlip/raffle addresses separately)
  const existing = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : {}
  fs.writeFileSync(out, JSON.stringify({ ...existing, ...deployment }, null, 2))
  console.log(`\nwrote ${out} — fill web/src/config.ts from it (deployBlock = pools' block, so the`)
  console.log('web app and cast watcher count heats from the same origin).')
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
