/**
 * Read-only proof of the operator coin-flip verify slip against LIVE 943 data. No wallet.
 *
 * For the current + retired OperatorCoinFlip addresses it fetches every RoundOpened / RoundSettled /
 * RoundRefunded log, folds them exactly as the UI does, then replays each SETTLED round through
 * `verifyOperatorRound` — the same pure function the on-screen slip calls. It asserts that the winner
 * recomputed from the seed parity matches what the chain paid out. A single mismatch exits non-zero.
 *
 * This is the headless stand-in for the "verify slip" half of the §8 walkthrough: it needs no key and
 * proves the slip's math on real, already-settled rounds. Run:
 *   npx tsx scripts/operator-verify-replay.ts
 */
import * as viem from 'viem'
import { operatorCoinFlipAbi } from '@msgboard/games-core'
import { foldOperatorRounds, verifyOperatorRound, type OperatorEvent } from '../src/lib/operatorIndex'

// 943 addresses — mirror games/web/src/config.ts (kept inline so this script needs no vite glob import).
const RPC = 'https://games.msgboard.xyz/rpc/evm/943'
const CURRENT: viem.Hex = '0x0c80607ec07999cdab97d4374d6b7a3b5a6f1833'
const DEPLOY_BLOCK = 25121394n
const RETIRED: viem.Hex[] = [
  '0x360f22c4b6b0a31cbff91226f20f557dbd0a6353',
  '0xbb9bc6851998bc979889a6d31c1994160a219d04',
  '0xb22ad173ee0ca5f9a3d36dc647d67bafa0e49e87',
  '0x30b855799990fa9c2d0dff461bfb905a269efe8e',
  '0xc3a4edb9601b55df3e25893a4e28971883a4b475',
]

const EVENT_NAMES = ['RoundOpened', 'RoundSettled', 'RoundRefunded'] as const
const MAX_RANGE = 90_000n // the proxy caps eth_getLogs at 100k blocks; stay under it

const client = viem.createPublicClient({ transport: viem.http(RPC) })

/** Fetch the three round events for one contract across [fromBlock, head], chunked under the RPC's
 *  block-range cap, and project them into the UI's OperatorEvent shape. */
const eventsFor = async (address: viem.Hex, fromBlock: bigint, head: bigint): Promise<OperatorEvent[]> => {
  const out: OperatorEvent[] = []
  for (const name of EVENT_NAMES) {
    for (let from = fromBlock; from <= head; from += MAX_RANGE) {
      const to = from + MAX_RANGE - 1n > head ? head : from + MAX_RANGE - 1n
      const logs = await client.getContractEvents({ address, abi: operatorCoinFlipAbi, eventName: name, fromBlock: from, toBlock: to })
      for (const log of logs) {
        out.push({ name, args: log.args as Record<string, unknown>, blockNumber: log.blockNumber })
      }
    }
  }
  return out
}

const main = async () => {
  const head = await client.getBlockNumber()
  console.log(`943 head ${head}; replaying operator coin-flip rounds through the live verify slip\n`)

  // Current contract from its deploy block; retired ones from a bounded lookback before it (they were
  // deployed in the same operator-substrate rollout window — cheap to cover without a full-chain scan).
  const retiredFrom = DEPLOY_BLOCK - 900_000n
  const events = (
    await Promise.all([eventsFor(CURRENT, DEPLOY_BLOCK, head), ...RETIRED.map((a) => eventsFor(a, retiredFrom, head))])
  ).flat()

  // Fold with no address filter (myAddress undefined = every player's rounds).
  const { myRounds, settledByRound, refundedByRound } = foldOperatorRounds(events, [], undefined)
  const openedByRound = new Map<string, (typeof myRounds)[number]>(myRounds.map((o) => [o.roundId, o]))

  console.log(
    `${myRounds.length} rounds opened · ${settledByRound.size} settled · ${refundedByRound.size} refunded\n`,
  )

  let checked = 0
  let failed = 0
  for (const [roundId, settled] of settledByRound) {
    const opened = openedByRound.get(roundId)
    if (!opened) {
      console.log(`⚠ settled round ${roundId.slice(0, 12)}… has no RoundOpened log — skipped`)
      continue
    }
    const { ok, reasons } = verifyOperatorRound(opened, settled)
    const parityEven = (BigInt(settled.seed) & 1n) === 0n
    const line =
      `${roundId.slice(0, 12)}…  side ${opened.side === 0 ? 'H' : 'T'}  ` +
      `seed…${settled.seed.slice(-4)} (${parityEven ? 'even' : 'odd'})  ` +
      `chain=${settled.won ? 'won' : 'lost'}  pays ${viem.formatEther(settled.payout)}`
    checked += 1
    if (ok) {
      console.log(`✓ ${line}`)
    } else {
      failed += 1
      console.log(`✗ ${line}  — ${reasons.join('; ')}`)
    }
  }

  console.log(`\n${checked} settled rounds replayed · ${checked - failed} verified · ${failed} mismatched`)
  if (failed > 0) {
    console.error('\nVERIFY REPLAY FAILED — the slip would disagree with the chain on the rounds above.')
    process.exit(1)
  }
  if (checked === 0) {
    console.warn('\nNo settled rounds found to replay (nothing to verify yet).')
    return
  }
  console.log('\nVERIFY REPLAY PASSED — every settled round matches the seed-parity recompute.')
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
