/**
 * Headless walkthrough: performs exactly the transactions the UI's buttons send, as anvil
 * account 9 (the "browser wallet" player), against the dev-local deployment. Verifies the
 * whole loop the screens drive: pair the seeded flip, fill + arm the seeded raffle round,
 * then (after dev-cast + mining) reveal and finalise, asserting both verify panels' parity
 * conditions. Run: seed -> walkthrough -> cast -> walkthrough (it resumes where it left off).
 * One-button version: `pnpm dev:walkthrough full` drives all phases including casts/mining.
 */
import * as viem from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { execFileSync } from 'child_process'
import { makePublicClient, makeWalletClient, coinFlipAbi, raffleAbi, randomAbi, buildHeatLocations } from '@msgboard/games-core'
import { makePresets as coinflipPresets, coinflip } from '@msgboard/coinflip'
import { makePresets as rafflePresets, raffle as raffleGame } from '@msgboard/raffle'

const TEST_MNEMONIC = 'test test test test test test test test test test test junk'
const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const generatedDir = path.join(scriptDir, '..', 'src', 'generated')
const FULL = process.argv.includes('full')

const main = async () => {
  const config = JSON.parse(fs.readFileSync(path.join(generatedDir, 'local.json'), 'utf8')) as {
    coinFlip: viem.Hex
    raffle: viem.Hex
    random: viem.Hex
    canonicalSubset: viem.Hex[]
    poolOffsets: Record<string, string>
  }
  const publicClient = makePublicClient(31337)
  const me = mnemonicToAccount(TEST_MNEMONIC, { addressIndex: 9 })
  const wallet = makeWalletClient(31337, me)
  const subset = config.canonicalSubset

  const send = async (address: viem.Hex, abi: viem.Abi, functionName: string, args: readonly unknown[], value = 0n) => {
    const { request } = await publicClient.simulateContract({ address, abi, functionName, args, account: me, value })
    return publicClient.waitForTransactionReceipt({ hash: await wallet.writeContract(request) })
  }
  const devCast = (...args: string[]) => {
    execFileSync('npx', ['tsx', path.join(scriptDir, 'dev-cast.ts'), ...args], { stdio: 'inherit' })
  }
  // the UI's nextHeatLocations: index = consumed heats so far
  const nextLocations = async () => {
    const [heated, armed] = await Promise.all([
      publicClient.getContractEvents({ address: config.coinFlip, abi: coinFlipAbi, eventName: 'Heated', fromBlock: 0n }),
      publicClient.getContractEvents({ address: config.raffle, abi: raffleAbi, eventName: 'Armed', fromBlock: 0n }),
    ])
    const offsets = Object.fromEntries(Object.entries(config.poolOffsets).map(([k, v]) => [k, BigInt(v)]))
    return buildHeatLocations(subset, offsets).map((l) => ({ ...l, index: BigInt(heated.length + armed.length) }))
  }

  const flipPreset = coinflipPresets(subset)[0]!.params // 0.1
  const rafflePreset = rafflePresets(subset)[0]!.params // 0.1 / 3 / 30

  // === Coin flip: enter tails against the seeded heads entry (pairs + heats) ============
  const settledBefore = await publicClient.getContractEvents({ address: config.coinFlip, abi: coinFlipAbi, eventName: 'Settled', fromBlock: 0n })
  if (settledBefore.length === 0) {
    console.log('[flip] entering tails against the seeded heads entry')
    const receipt = await send(config.coinFlip, coinFlipAbi, 'enterAndMatch', [1, subset, await nextLocations()], flipPreset.stake)
    const heated = viem.parseEventLogs({ abi: coinFlipAbi, eventName: 'Heated', logs: receipt.logs })[0]
    if (!heated) throw new Error('expected the entry to pair and heat')
    console.log('  paired + heated')
    if (FULL) devCast()
    const settled = await publicClient.getContractEvents({ address: config.coinFlip, abi: coinFlipAbi, eventName: 'Settled', fromBlock: 0n })
    if (settled.length > 0) {
      const args = settled[0]!.args as { winner: viem.Hex; seed: viem.Hex }
      const heads = mnemonicToAccount(TEST_MNEMONIC, { addressIndex: 6 })
      const offChain = coinflip.settle(flipPreset, [{ player: heads.address, side: 'heads' }, { player: me.address, side: 'tails' }], args.seed)
      if (!viem.isAddressEqual(offChain.winner, args.winner)) throw new Error('FLIP VERIFY PANEL WOULD MISMATCH')
      console.log(`  settled — winner ${args.winner}; verify panel parity ✓`)
    } else {
      console.log('  waiting on the validators: run `pnpm dev:cast`, then re-run this walkthrough')
    }
  } else {
    console.log('[flip] already settled — skipping')
  }

  // === Raffle: commit the third ticket, arm, (cast), reveal, finalise ====================
  const myGuess = 42n
  const opened = await publicClient.getContractEvents({ address: config.raffle, abi: raffleAbi, eventName: 'RoundOpened', fromBlock: 0n })
  const roundId = (opened[0]!.args as { roundId: viem.Hex }).roundId
  const roundState = async () =>
    (await publicClient.readContract({ address: config.raffle, abi: raffleAbi, functionName: 'rounds', args: [roundId] })) as any[]

  let round = await roundState()
  if (Number(round[7]) === 1) {
    // Filling: commit ticket 3 (the UI's commit button), then arm (the UI's arm button)
    console.log('[raffle] committing the third ticket (guess 42)')
    const salt = viem.keccak256(viem.toHex('walkthrough-salt'))
    const commitment = viem.keccak256(
      viem.encodeAbiParameters([{ type: 'uint256' }, { type: 'bytes32' }, { type: 'address' }], [myGuess, salt, me.address]),
    )
    await send(config.raffle, raffleAbi, 'commit', [rafflePreset.stake, rafflePreset.threshold, rafflePreset.period, subset, commitment], rafflePreset.stake)
    if (FULL) devCast('mine', '31') // pass the 30-block period
    console.log('[raffle] arming')
    await send(config.raffle, raffleAbi, 'arm', [roundId, await nextLocations()])
    if (FULL) devCast() // cast the seed + reveal seeded tickets
  }

  round = await roundState()
  if (Number(round[7]) === 3) {
    // Claiming: reveal mine (the UI loads the salt from storage; here it's deterministic)
    const myTickets = (await publicClient.getContractEvents({ address: config.raffle, abi: raffleAbi, eventName: 'Committed', fromBlock: 0n }))
      .map((l) => l.args as { ticketId: bigint; player: viem.Hex })
      .filter((t) => viem.isAddressEqual(t.player, me.address))
    const revealed = new Set(
      (await publicClient.getContractEvents({ address: config.raffle, abi: raffleAbi, eventName: 'Revealed', fromBlock: 0n })).map(
        (l) => (l.args as { ticketId: bigint }).ticketId,
      ),
    )
    for (const t of myTickets) {
      if (revealed.has(t.ticketId)) continue
      console.log(`[raffle] revealing my ticket ${t.ticketId}`)
      await send(config.raffle, raffleAbi, 'reveal', [t.ticketId, myGuess, viem.keccak256(viem.toHex('walkthrough-salt'))])
    }
    if (FULL) {
      devCast() // reveal the seeded tickets too
      devCast('mine', '101') // close the reveal window
      console.log('[raffle] finalising')
      await send(config.raffle, raffleAbi, 'finalise', [roundId])
    }
  }

  round = await roundState()
  if (Number(round[7]) === 4) {
    // Paid: assert the verify-panel parity over the full entry set
    const key = round[8] as viem.Hex
    const seed = ((await publicClient.readContract({ address: config.random, abi: randomAbi, functionName: 'randomness', args: [key] })) as { seed: viem.Hex }).seed
    const committed = (await publicClient.getContractEvents({ address: config.raffle, abi: raffleAbi, eventName: 'Committed', fromBlock: 0n })).map(
      (l) => ({ ...(l.args as { ticketId: bigint; player: viem.Hex }), blockNumber: l.blockNumber }),
    )
    const reveals = new Map(
      (await publicClient.getContractEvents({ address: config.raffle, abi: raffleAbi, eventName: 'Revealed', fromBlock: 0n })).map((l) => {
        const a = l.args as { ticketId: bigint; guess: bigint }
        return [a.ticketId, a.guess]
      }),
    )
    const entries = committed.map((c) => ({
      ticketId: c.ticketId,
      player: c.player,
      guess: reveals.get(c.ticketId) ?? 0n,
      committedAtBlock: c.blockNumber,
      revealed: reveals.has(c.ticketId),
    }))
    const offChain = raffleGame.settle(rafflePreset, entries, seed)
    const finalised = (await publicClient.getContractEvents({ address: config.raffle, abi: raffleAbi, eventName: 'Finalised', fromBlock: 0n }))[0]!
      .args as { winner: viem.Hex }
    if (!offChain || !viem.isAddressEqual(offChain.player, finalised.winner)) throw new Error('RAFFLE VERIFY PANEL WOULD MISMATCH')
    console.log(`  paid — winner ${finalised.winner} (ticket ${offChain.ticketId}); verify panel parity ✓`)
    console.log('\nWALKTHROUGH COMPLETE — both screens’ flows verified end to end.')
  } else if (!FULL) {
    console.log('\nPartial pass done. Use `pnpm dev:cast` / `pnpm dev:cast mine <n>` between steps, or run with `full`.')
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
