import { describe, it, expect, beforeAll } from 'vitest'
import * as viem from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import { deployLocal, type Deployment } from '../src/deploy'
import { makeWalletClient, coinFlipAbi, randomAbi, castSeed, seedFromSecrets, type Info } from '@msgboard/games-core'
import { coinflip } from '@msgboard/coinflip'

const TEST_MNEMONIC = 'test test test test test test test test test test test junk'
const stake = viem.parseEther('1')

describe('cross-layer parity (coin flip)', () => {
  let d: Deployment
  beforeAll(async () => {
    d = await deployLocal(3)
  }, 120_000)

  it('the off-chain settle names the same winner the contract pays', async () => {
    const subset = d.validators.map((v) => v.address)
    const locations = d.validators.map((v) => v.location)
    const secrets = d.validators.map((v) => v.secret)
    const heads = mnemonicToAccount(TEST_MNEMONIC, { addressIndex: 7 })
    const tails = mnemonicToAccount(TEST_MNEMONIC, { addressIndex: 8 })

    const enter = async (acct: viem.Account, side: number, locs: Info[]) => {
      const w = makeWalletClient(31337, acct)
      const { request } = await d.publicClient.simulateContract({
        address: d.coinFlip,
        abi: coinFlipAbi,
        functionName: 'enterAndMatch',
        args: [side, subset, locs],
        account: acct,
        value: stake,
      })
      return d.publicClient.waitForTransactionReceipt({ hash: await w.writeContract(request) })
    }
    await enter(heads, 0, [])
    const matchReceipt = await enter(tails, 1, locations)
    const heated = viem.parseEventLogs({ abi: coinFlipAbi, eventName: 'Heated', logs: matchReceipt.logs })[0]
      ?.args as { key?: viem.Hex } | undefined
    expect(heated?.key, 'pairing must heat the subset').to.not.equal(undefined)

    const castReceipt = await d.publicClient.waitForTransactionReceipt({
      hash: await castSeed(d.caster, d.publicClient, d.random, heated!.key!, locations, secrets),
    })
    const settled = viem.parseEventLogs({ abi: coinFlipAbi, eventName: 'Settled', logs: castReceipt.logs })[0]
      ?.args as { winner?: viem.Hex; seed?: viem.Hex } | undefined
    expect(settled?.winner, 'cast must settle the flip in the same transaction').to.not.equal(undefined)

    // the on-chain seed must equal the off-chain reduction over the same secrets in heat order
    const onChainSeed = (await d.publicClient.readContract({
      address: d.random,
      abi: randomAbi,
      functionName: 'randomness',
      args: [heated!.key!],
    })) as { seed: viem.Hex }
    expect(onChainSeed.seed).to.equal(seedFromSecrets(secrets))
    expect(settled!.seed).to.equal(onChainSeed.seed)

    const offChain = coinflip.settle(
      { stake, validatorSubset: subset },
      [
        { player: heads.address, side: 'heads' },
        { player: tails.address, side: 'tails' },
      ],
      onChainSeed.seed,
    )
    expect(viem.getAddress(offChain.winner)).to.equal(viem.getAddress(settled!.winner!))
  })
})
