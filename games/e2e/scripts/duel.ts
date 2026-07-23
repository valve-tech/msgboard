import * as viem from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import {
  makeWalletClient,
  coinFlipAbi,
  randomAbi,
  castSeed,
  type Info,
  type GamesChainId,
} from '@msgboard/games-core'
import { coinflip } from '@msgboard/coinflip'
import { deployLocal } from '../src/deploy'

const env = process.env
const CHAIN: GamesChainId = env.CHAIN === '943' ? 943 : 31337
const STAKE = viem.parseEther(env.STAKE || '0.1')

const main = async () => {
  if (CHAIN === 943 && !env.MNEMONIC) throw new Error('MNEMONIC required for 943')

  if (CHAIN === 31337) {
    const d = await deployLocal(3)
    const subset = d.validators.map((v) => v.address)
    const locations = d.validators.map((v) => v.location)
    const secrets = d.validators.map((v) => v.secret)
    const mnemonic = 'test test test test test test test test test test test junk'
    const heads = mnemonicToAccount(mnemonic, { addressIndex: 7 })
    const tails = mnemonicToAccount(mnemonic, { addressIndex: 8 })

    const enter = async (acct: viem.Account, side: number, locs: Info[]) => {
      const w = makeWalletClient(31337, acct)
      const { request } = await d.publicClient.simulateContract({
        address: d.coinFlip,
        abi: coinFlipAbi,
        functionName: 'enterAndMatch',
        args: [side, subset, locs],
        account: acct,
        value: STAKE,
      })
      await d.publicClient.waitForTransactionReceipt({ hash: await w.writeContract(request) })
    }
    await enter(heads, 0, [])
    await enter(tails, 1, locations)
    const heatedEvents = await d.publicClient.getContractEvents({
      address: d.coinFlip,
      abi: coinFlipAbi,
      eventName: 'Heated',
      fromBlock: 0n,
    })
    const key = (heatedEvents[0]!.args as any).key as viem.Hex
    await d.publicClient.waitForTransactionReceipt({
      hash: await castSeed(d.caster, d.publicClient, d.random, key, locations, secrets),
    })
    const seed = (await d.publicClient.readContract({
      address: d.random,
      abi: randomAbi,
      functionName: 'randomness',
      args: [key],
    })) as { seed: viem.Hex }
    const offChain = coinflip.settle(
      { stake: STAKE, validatorSubset: subset },
      [
        { player: heads.address, side: 'heads' },
        { player: tails.address, side: 'tails' },
      ],
      seed.seed,
    )
    const settledEvents = await d.publicClient.getContractEvents({
      address: d.coinFlip,
      abi: coinFlipAbi,
      eventName: 'Settled',
      fromBlock: 0n,
    })
    const settled = settledEvents[0]!.args as any
    console.log('seed        :', seed.seed)
    console.log('off-chain   :', offChain.winner, offChain.winningSide)
    console.log('on-chain    :', settled.winner)
    if (viem.getAddress(offChain.winner) !== viem.getAddress(settled.winner)) throw new Error('PARITY MISMATCH')
    console.log('PARITY OK')
    return
  }

  throw new Error('943 path: supply COINFLIP and run with the funded MNEMONIC; mirror duel-943.ts funding')
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
