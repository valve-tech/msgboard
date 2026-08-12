/**
 * Resume helper for the live forfeit proof: chop ONE already-staged, withheld OperatorCoinFlip round and
 * verify the forfeit. qa-operator-coinflip.ts's forfeit path can leave a round Pending-with-seed-withheld if
 * the chopAndRoute submission hits a transient RPC hiccup (one.valve.city "all upstream attempts failed").
 * This retries the chop against that exact round — no wasted round — and asserts the same invariants the
 * anvil test proves: forfeit == tierPrice banked to the operator bankroll, player refunded, honest
 * validators keep stakes, fee pool restored.
 *
 *   ROUND=0x… [K=1] PRIVATE_KEY=… MNEMONIC=… SEEDS0=… RPC_URL=<valve rpc> npx tsx scripts/qa-operator-chop.ts
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import * as viem from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { randomAbi } from '@msgboard/games-core'
import { loadDeployment, sendAs, operatorLocationsAt } from './actor-common'

const __dirname = dirname(fileURLToPath(import.meta.url))
const RPC = process.env.RPC_URL ?? 'https://rpc.v4.testnet.pulsechain.com'
const CHAIN = 943
const chain = { id: CHAIN, name: 'pulse-943', nativeCurrency: { name: 'PLS', symbol: 'PLS', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const
const ROUND = process.env.ROUND as viem.Hex
const K = BigInt(process.env.K ?? '1')

const loadAbi = (n: string): viem.Abi => JSON.parse(readFileSync(resolve(__dirname, `../../contracts/artifacts/contracts/games/operator/${n}.sol/${n}.json`), 'utf8')).abi
const loadSub = () => JSON.parse(readFileSync(resolve(__dirname, '../../contracts/deployments/943-operator-substrate.json'), 'utf8'))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let PASS = 0, FAIL = 0
const check = (n: string, ok: boolean, d = '') => { console.log(`  ${ok ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`); ok ? PASS++ : FAIL++ }

async function main() {
  /* eslint-disable no-console */
  const pk = process.env.PRIVATE_KEY
  if (!pk) throw new Error('set PRIVATE_KEY (valve_deployer)')
  if (!ROUND) throw new Error('set ROUND (the Pending, withheld roundId to chop)')
  const account = privateKeyToAccount((pk.startsWith('0x') ? pk : `0x${pk}`) as viem.Hex)
  const sub = loadSub()
  const GAME = sub.contracts.OperatorCoinFlip as viem.Hex
  const ESCROW = sub.contracts.GameEscrow as viem.Hex
  const RANDOM = sub.random as viem.Hex
  const cfg = loadDeployment(CHAIN)
  const subset = cfg.canonicalSubset
  const poolSize = BigInt(cfg.poolSize)
  const gameAbi = loadAbi('OperatorCoinFlip')
  const escrowAbi = loadAbi('GameEscrow')

  const pc = viem.createPublicClient({ chain, transport: viem.http(RPC) })
  const wallet = viem.createWalletClient({ account, chain, transport: viem.http(RPC) })

  const round = (await pc.readContract({ address: GAME, abi: gameAbi, functionName: 'rounds', args: [ROUND] })) as unknown[]
  const tableId = round[0] as viem.Hex
  const stake = round[3] as bigint
  const payout = round[4] as bigint
  const tierPrice = round[5] as bigint
  const exposure = payout - stake // what open() locked out of the bankroll; chop's refund returns it
  const status = Number(round[8])
  const table = (await pc.readContract({ address: GAME, abi: gameAbi, functionName: 'tables', args: [tableId] })) as readonly [viem.Hex, viem.Hex, number, bigint, bigint, boolean]
  const token = table[1]
  check('round is Pending', status === 1, `status=${status}`)

  const bankrollOf = () => pc.readContract({ address: ESCROW, abi: escrowAbi, functionName: 'bankrollOf', args: [account.address, token] }) as Promise<bigint>
  const lockedOf = () => pc.readContract({ address: ESCROW, abi: escrowAbi, functionName: 'lockedOf', args: [account.address, token] }) as Promise<bigint>
  const feeBalanceOf = () => pc.readContract({ address: GAME, abi: gameAbi, functionName: 'feeBalance', args: [account.address, token] }) as Promise<bigint>
  const custodyOf = (a: viem.Hex) => pc.readContract({ address: RANDOM, abi: randomAbi, functionName: 'balanceOf', args: [a, token] }) as Promise<bigint>

  const bankrollBefore = await bankrollOf()
  const lockedBefore = await lockedOf()
  const feeBefore = await feeBalanceOf()
  // Note: honest validators' stakes were already flicked back by the partial cast in the interrupted run,
  // so their custody returns can't be re-observed here — the SETTLE path already proved stake return. This
  // resume proves the FORFEIT ROUTING: the withheld stake becomes the forfeit and lands in the bankroll.
  const withholder = subset[2]!
  const withholderBefore = await custodyOf(withholder)

  const locations = operatorLocationsAt(subset, K, poolSize, token, tierPrice)
  // retry the chop through transient RPC hiccups (InternalRpcError / "all upstream attempts failed")
  let chopReceipt: viem.TransactionReceipt | undefined
  for (let attempt = 1; attempt <= 6 && !chopReceipt; attempt++) {
    try {
      chopReceipt = await sendAs(pc, wallet, { address: GAME, abi: gameAbi, functionName: 'chopAndRoute', args: [ROUND, locations] })
    } catch (e) {
      const m = (e as Error).message.split('\n')[0]
      console.log(`  chop attempt ${attempt} failed: ${m?.slice(0, 90)} — retrying`)
      await sleep(6000)
    }
  }
  if (!chopReceipt) throw new Error('chopAndRoute failed after retries')

  const forfeitEv = (viem.parseEventLogs({ abi: gameAbi, logs: chopReceipt.logs, eventName: 'ForfeitRouted' })[0] as any)?.args as { forfeit: bigint } | undefined
  console.log(`  chop tx ${chopReceipt.transactionHash}`)
  check('ForfeitRouted forfeit == tierPrice', forfeitEv?.forfeit === tierPrice, forfeitEv ? viem.formatEther(forfeitEv.forfeit) : 'no event')
  check('round REFUNDED', Number(((await pc.readContract({ address: GAME, abi: gameAbi, functionName: 'rounds', args: [ROUND] })) as unknown[])[8]) === 3)
  // resume baseline is mid-round (post-open): chop both banks the forfeit AND returns the locked exposure.
  check('bankroll += exposure + forfeit', (await bankrollOf()) - bankrollBefore === exposure + tierPrice, viem.formatEther((await bankrollOf()) - bankrollBefore))
  check('exposure released (locked -= payout)', lockedBefore - (await lockedOf()) === payout, viem.formatEther(lockedBefore - (await lockedOf())))
  // the withholder's committed slot stake leaves the system as the forfeit (it was never flicked back to it)
  check('withholder (#3) stake not returned to it', (await custodyOf(withholder)) - withholderBefore === 0n)
  check('operator fee pool restored (+n*tierPrice)', (await feeBalanceOf()) === feeBefore + tierPrice * BigInt(subset.length))

  console.log(`\n=== chop resume complete: ${PASS} passed, ${FAIL} failed ===`)
  process.exit(FAIL ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
