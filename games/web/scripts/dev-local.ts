/**
 * Local development harness: deploy Random + CoinFlip + Raffle to anvil, allowlist three
 * validators with one 16-preimage price-0 pool each (one preimage per heat — they are
 * one-shot), seed demo state (an open heads entry and a filling raffle round), and write
 * src/generated/local.json for the app plus local-secrets.json for the dev:cast helper.
 *
 * Anvil account map: 0 deployer/caster, 1-3 validators, 6 seeded heads player, 7-8 seeded
 * raffle players. Play from a browser wallet funded with any other anvil key (9 is free).
 *
 * Run with anvil up: pnpm dev:seed   (or pnpm dev:local to seed + start vite)
 */
import * as viem from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import {
  local,
  makePublicClient,
  makeWalletClient,
  makeSecret,
  coinFlipAbi,
  coinFlipBytecode,
  raffleAbi,
  raffleBytecode,
  randomAbi,
  type Info,
} from '@msgboard/games-core'
import { makePresets } from '@msgboard/raffle'
import RandomArtifact from '@gibs/random/artifacts/contracts/Random.sol/Random.json'

const TEST_MNEMONIC = 'test test test test test test test test test test test junk'
const POOL_SIZE = 16
const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const generatedDir = path.join(scriptDir, '..', 'src', 'generated')

const main = async () => {
  const account = mnemonicToAccount(TEST_MNEMONIC)
  const publicClient = makePublicClient(31337)
  const caster = makeWalletClient(31337, account)
  const salt = viem.bytesToHex(crypto.getRandomValues(new Uint8Array(32)))

  const deploy = async (abi: viem.Abi, bytecode: viem.Hex, args: unknown[]): Promise<viem.Hex> => {
    const hash = await caster.deployContract({ abi, bytecode, args, account, chain: local })
    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    if (!receipt.contractAddress) throw new Error('deploy reverted')
    return receipt.contractAddress
  }
  const send = async (
    wallet: viem.WalletClient,
    address: viem.Hex,
    abi: viem.Abi,
    functionName: string,
    args: readonly unknown[],
    value = 0n,
  ) => {
    const { request } = await publicClient.simulateContract({
      address,
      abi,
      functionName,
      args,
      account: wallet.account!,
      value,
    })
    return publicClient.waitForTransactionReceipt({ hash: await wallet.writeContract(request) })
  }

  console.log('[deploy] Random + CoinFlip + Raffle')
  const random = await deploy(RandomArtifact.abi as viem.Abi, RandomArtifact.bytecode as viem.Hex, [])
  const coinFlip = await deploy(coinFlipAbi, coinFlipBytecode, [random])
  const raffle = await deploy(raffleAbi, raffleBytecode, [random])
  console.log(`  random ${random}\n  coinFlip ${coinFlip}\n  raffle ${raffle}`)

  console.log('[validators] allowlist 3 + ink a 16-preimage pool each')
  const validators: { address: viem.Hex; secrets: viem.Hex[] }[] = []
  for (let i = 0; i < 3; i++) {
    const v = mnemonicToAccount(TEST_MNEMONIC, { addressIndex: i + 1 })
    for (const game of [coinFlip, raffle]) {
      await send(caster, game, raffleAbi, 'addValidator', [v.address])
    }
    const secrets = Array.from({ length: POOL_SIZE }, (_s, j) => makeSecret(`validator-${i}-${j}`, salt))
    const section: Info = {
      provider: v.address,
      callAtChange: false,
      durationIsTimestamp: false,
      duration: 12n,
      token: viem.zeroAddress,
      price: 0n,
      offset: 0n,
      index: 0n,
    }
    await send(caster, random, randomAbi, 'ink', [section, viem.concatHex(secrets.map((s) => s.preimage))])
    validators.push({ address: v.address, secrets: secrets.map((s) => s.secret) })
  }
  const canonicalSubset = validators.map((v) => v.address)

  // --- Seed demo state -----------------------------------------------------------------
  const demoStake = viem.parseEther('0.1') // matches the app's first preset
  console.log('[seed] one open heads entry (account 6) at the 0.1 preset')
  const headsPlayer = mnemonicToAccount(TEST_MNEMONIC, { addressIndex: 6 })
  await send(makeWalletClient(31337, headsPlayer), coinFlip, coinFlipAbi, 'enterAndMatch', [0, canonicalSubset, []], demoStake)

  console.log('[seed] a filling raffle round with 2 of 3 commits (accounts 7, 8)')
  const rafflePreset = makePresets(canonicalSubset)[0]!.params // 0.1 / threshold 3 / period 30
  const commitmentFor = (guess: bigint, s: viem.Hex, player: viem.Hex) =>
    viem.keccak256(
      viem.encodeAbiParameters([{ type: 'uint256' }, { type: 'bytes32' }, { type: 'address' }], [guess, s, player]),
    )
  const seededTickets: { ticketId: string; guess: string; salt: viem.Hex; addressIndex: number }[] = []
  for (const [j, guess] of [100n, 200n].entries()) {
    const player = mnemonicToAccount(TEST_MNEMONIC, { addressIndex: 7 + j })
    const ticketSalt = viem.keccak256(viem.toHex(`seed-ticket-${j}-${salt}`))
    const receipt = await send(
      makeWalletClient(31337, player),
      raffle,
      raffleAbi,
      'commit',
      [rafflePreset.stake, rafflePreset.threshold, rafflePreset.period, canonicalSubset, commitmentFor(guess, ticketSalt, player.address)],
      rafflePreset.stake,
    )
    const committed = viem.parseEventLogs({ abi: raffleAbi, eventName: 'Committed', logs: receipt.logs })[0]!
      .args as { ticketId: bigint }
    seededTickets.push({ ticketId: committed.ticketId.toString(), guess: guess.toString(), salt: ticketSalt, addressIndex: 7 + j })
  }

  fs.mkdirSync(generatedDir, { recursive: true })
  fs.writeFileSync(
    path.join(generatedDir, 'local.json'),
    JSON.stringify(
      {
        chainId: 31337,
        coinFlip,
        raffle,
        random,
        canonicalSubset,
        poolOffsets: Object.fromEntries(canonicalSubset.map((v) => [v.toLowerCase(), '0'])),
        poolSize: POOL_SIZE,
        deployBlock: '0',
      },
      null,
      2,
    ),
  )
  fs.writeFileSync(
    path.join(generatedDir, 'local-secrets.json'),
    JSON.stringify({ validators, seededTickets }, null, 2),
  )
  console.log('wrote src/generated/local.json + local-secrets.json')
  console.log('\nNow: pnpm dev (or this ran via dev:local and vite starts next).')
  console.log('Fund a browser wallet with an anvil key (account 9 is free) and play.')
  console.log('Run `pnpm dev:cast` whenever a flip or round is waiting on the validators.')
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
