/**
 * The stand-in validator/operator for local development. Each run:
 *   1. casts every outstanding request key (Heated flips + Armed rounds with no seed yet),
 *      revealing the correct one-shot preimage per validator in heat order;
 *   2. reveals the SEEDED raffle tickets (accounts 7-8) in any claiming round;
 *   3. with `mine <n>` argv, mines n blocks (anvil only advances on transactions — use
 *      `pnpm dev:cast mine 31` to pass the raffle period, `mine 101` to close a reveal window).
 *
 * In production this is the always-on validator node service; locally it's a button.
 */
import * as viem from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { makePublicClient, makeWalletClient, coinFlipAbi, raffleAbi, randomAbi, type Info } from '@msgboard/games-core'

const TEST_MNEMONIC = 'test test test test test test test test test test test junk'
const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const generatedDir = path.join(scriptDir, '..', 'src', 'generated')

type Generated = {
  chainId: number
  coinFlip: viem.Hex
  raffle: viem.Hex
  random: viem.Hex
  canonicalSubset: viem.Hex[]
}
type Secrets = {
  validators: { address: viem.Hex; secrets: viem.Hex[] }[]
  seededTickets: { ticketId: string; guess: string; salt: viem.Hex; addressIndex: number }[]
}

const main = async () => {
  const config = JSON.parse(fs.readFileSync(path.join(generatedDir, 'local.json'), 'utf8')) as Generated
  const secrets = JSON.parse(fs.readFileSync(path.join(generatedDir, 'local-secrets.json'), 'utf8')) as Secrets
  const publicClient = makePublicClient(31337)
  const caster = makeWalletClient(31337, mnemonicToAccount(TEST_MNEMONIC))

  const mineArg = process.argv.indexOf('mine')
  if (mineArg !== -1) {
    const blocks = Number(process.argv[mineArg + 1] ?? '1')
    await publicClient.request({ method: 'anvil_mine' as any, params: [viem.toHex(blocks) as any] })
    console.log(`mined ${blocks} blocks -> now at ${await publicClient.getBlockNumber()}`)
  }

  const send = async (wallet: viem.WalletClient, address: viem.Hex, abi: viem.Abi, functionName: string, args: readonly unknown[]) => {
    const { request } = await publicClient.simulateContract({ address, abi, functionName, args, account: wallet.account! })
    return publicClient.waitForTransactionReceipt({ hash: await wallet.writeContract(request) })
  }

  // --- 1. cast outstanding keys, preimage index = position in chronological heat order ---
  const [heated, armed] = await Promise.all([
    publicClient.getContractEvents({ address: config.coinFlip, abi: coinFlipAbi, eventName: 'Heated', fromBlock: 0n }),
    publicClient.getContractEvents({ address: config.raffle, abi: raffleAbi, eventName: 'Armed', fromBlock: 0n }),
  ])
  const heats = [...heated, ...armed]
    .map((log) => ({ key: (log.args as { key: viem.Hex }).key, blockNumber: log.blockNumber, logIndex: log.logIndex }))
    .sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1))

  for (const [index, heat] of heats.entries()) {
    const randomness = (await publicClient.readContract({
      address: config.random,
      abi: randomAbi,
      functionName: 'randomness',
      args: [heat.key],
    })) as { seed: viem.Hex }
    if (randomness.seed !== viem.padHex('0x0', { size: 32 })) continue
    const locations: Info[] = config.canonicalSubset.map((provider) => ({
      provider,
      callAtChange: false,
      durationIsTimestamp: false,
      duration: 12n,
      token: viem.zeroAddress,
      price: 0n,
      offset: 0n,
      index: BigInt(index),
    }))
    const reveals = secrets.validators.map((v) => v.secrets[index]!)
    await send(caster, config.random, randomAbi, 'cast', [heat.key, locations, reveals])
    console.log(`cast seed for key ${heat.key} (preimage index ${index})`)
  }

  // --- 2. reveal seeded tickets in claiming rounds ----------------------------------------
  for (const ticket of secrets.seededTickets) {
    const onChain = (await publicClient.readContract({
      address: config.raffle,
      abi: raffleAbi,
      functionName: 'tickets',
      args: [BigInt(ticket.ticketId)],
    })) as unknown[]
    const [roundId, , , , active, revealed] = onChain as [viem.Hex, viem.Hex, viem.Hex, bigint, boolean, boolean]
    if (!active || revealed) continue
    const round = (await publicClient.readContract({
      address: config.raffle,
      abi: raffleAbi,
      functionName: 'rounds',
      args: [roundId],
    })) as unknown[]
    if (Number(round[7]) !== 3) continue // Round.status enum: 3 == Claiming
    const player = mnemonicToAccount(TEST_MNEMONIC, { addressIndex: ticket.addressIndex })
    await send(makeWalletClient(31337, player), config.raffle, raffleAbi, 'reveal', [
      BigInt(ticket.ticketId),
      BigInt(ticket.guess),
      ticket.salt,
    ])
    console.log(`revealed seeded ticket ${ticket.ticketId} (guess ${ticket.guess})`)
  }
  console.log('done')
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
