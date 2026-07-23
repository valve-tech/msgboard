import { describe, it, expect, beforeAll } from 'vitest'
import * as viem from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import { deployLocal, type Deployment } from '../src/deploy'
import { makeWalletClient, raffleAbi, randomAbi } from '@msgboard/games-core'
import { raffle } from '@msgboard/raffle'

const TEST_MNEMONIC = 'test test test test test test test test test test test junk'
const stake = viem.parseEther('1')
const threshold = 3n
const period = 2n

const commitmentFor = (guess: bigint, salt: viem.Hex, player: viem.Hex): viem.Hex =>
  viem.keccak256(
    viem.encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'bytes32' }, { type: 'address' }],
      [guess, salt, player],
    ),
  )

describe('cross-layer parity (raffle)', () => {
  let d: Deployment
  beforeAll(async () => {
    d = await deployLocal(3)
  }, 120_000)

  it('the off-chain settle names the same winner the contract pays', async () => {
    const subset = d.validators.map((v) => v.address)
    // three players (anvil accounts 4,5,6) commit hidden guesses
    const players = [4, 5, 6].map((i) => mnemonicToAccount(TEST_MNEMONIC, { addressIndex: i }))
    const guesses = [10n, 128n, 250n]
    const salts = guesses.map((_g, i) => viem.keccak256(viem.toHex(`psalt-${i}`)))
    const committedAtBlocks: bigint[] = []
    for (let i = 0; i < 3; i++) {
      const player = players[i]!
      const w = makeWalletClient(31337, player)
      const { request } = await d.publicClient.simulateContract({
        address: d.raffle,
        abi: raffleAbi,
        functionName: 'commit',
        args: [stake, threshold, period, subset, commitmentFor(guesses[i]!, salts[i]!, player.address)],
        account: player,
        value: stake,
      })
      const receipt = await d.publicClient.waitForTransactionReceipt({ hash: await w.writeContract(request) })
      committedAtBlocks.push(receipt.blockNumber)
    }
    const opened = await d.publicClient.getContractEvents({
      address: d.raffle,
      abi: raffleAbi,
      eventName: 'RoundOpened',
      fromBlock: 0n,
    })
    const roundId = (opened[0]!.args as any).roundId as viem.Hex

    // mine past the period, arm
    await d.publicClient.request({ method: 'anvil_mine' as any, params: ['0x3' as any] })
    const locations = d.validators.map((v) => v.location)
    const { request: armReq } = await d.publicClient.simulateContract({
      address: d.raffle,
      abi: raffleAbi,
      functionName: 'arm',
      args: [roundId, locations],
      account: d.caster.account!,
    })
    const armReceipt = await d.publicClient.waitForTransactionReceipt({ hash: await d.caster.writeContract(armReq) })
    const armedEvents = await d.publicClient.getContractEvents({
      address: d.raffle,
      abi: raffleAbi,
      eventName: 'Armed',
      blockHash: armReceipt.blockHash,
    })
    const requestKey = (armedEvents[0]!.args as any).key as viem.Hex

    // cast the validator secrets in subset order
    const secrets = d.validators.map((v) => v.secret)
    const { request: castReq } = await d.publicClient.simulateContract({
      address: d.random,
      abi: randomAbi,
      functionName: 'cast',
      args: [requestKey, locations, secrets],
      account: d.caster.account!,
    })
    await d.publicClient.waitForTransactionReceipt({ hash: await d.caster.writeContract(castReq) })

    const seed = (await d.publicClient.readContract({
      address: d.random,
      abi: randomAbi,
      functionName: 'randomness',
      args: [requestKey],
    })) as { seed: viem.Hex }

    // all three reveal
    for (let i = 0; i < 3; i++) {
      const player = players[i]!
      const w = makeWalletClient(31337, player)
      const { request } = await d.publicClient.simulateContract({
        address: d.raffle,
        abi: raffleAbi,
        functionName: 'reveal',
        args: [BigInt(i + 1), guesses[i]!, salts[i]!],
        account: player,
      })
      await d.publicClient.waitForTransactionReceipt({ hash: await w.writeContract(request) })
    }

    // on-chain provisional winner
    const round = (await d.publicClient.readContract({
      address: d.raffle,
      abi: raffleAbi,
      functionName: 'rounds',
      args: [roundId],
    })) as any[]
    const onChainBestTicket = round[12] as bigint

    // off-chain settle over the same entries + seed
    const entries = guesses.map((g, i) => ({
      ticketId: BigInt(i + 1),
      player: players[i]!.address as viem.Hex,
      guess: g,
      committedAtBlock: committedAtBlocks[i]!,
      revealed: true,
    }))
    const offChain = raffle.settle({ stake, threshold, period, validatorSubset: subset }, entries, seed.seed)

    expect(offChain?.ticketId).to.equal(onChainBestTicket)
  })
})
