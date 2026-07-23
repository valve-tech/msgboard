import * as viem from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import { makeWalletClient, raffleAbi, randomAbi } from '@msgboard/games-core'
import { raffle } from '@msgboard/raffle'
import { deployLocal } from '../src/deploy'

const TEST_MNEMONIC = 'test test test test test test test test test test test junk'
const stake = viem.parseEther('1')
const threshold = 3n
const period = 2n
const commitmentFor = (g: bigint, s: viem.Hex, p: viem.Hex) =>
  viem.keccak256(
    viem.encodeAbiParameters([{ type: 'uint256' }, { type: 'bytes32' }, { type: 'address' }], [g, s, p]),
  )

const main = async () => {
  const d = await deployLocal(3)
  const subset = d.validators.map((v) => v.address)
  const locations = d.validators.map((v) => v.location)
  const secrets = d.validators.map((v) => v.secret)
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
    const r = await d.publicClient.waitForTransactionReceipt({ hash: await w.writeContract(request) })
    committedAtBlocks.push(r.blockNumber)
  }
  const openedEvents = await d.publicClient.getContractEvents({
    address: d.raffle,
    abi: raffleAbi,
    eventName: 'RoundOpened',
    fromBlock: 0n,
  })
  const roundId = (openedEvents[0]!.args as any).roundId as viem.Hex
  await d.publicClient.request({ method: 'anvil_mine' as any, params: ['0x3' as any] })
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
  const key = (armedEvents[0]!.args as any).key as viem.Hex
  const { request: castReq } = await d.publicClient.simulateContract({
    address: d.random,
    abi: randomAbi,
    functionName: 'cast',
    args: [key, locations, secrets],
    account: d.caster.account!,
  })
  await d.publicClient.waitForTransactionReceipt({ hash: await d.caster.writeContract(castReq) })
  const seed = (await d.publicClient.readContract({
    address: d.random,
    abi: randomAbi,
    functionName: 'randomness',
    args: [key],
  })) as { seed: viem.Hex }
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
  await d.publicClient.request({ method: 'anvil_mine' as any, params: ['0x65' as any] }) // 101 blocks
  const { request: finReq } = await d.publicClient.simulateContract({
    address: d.raffle,
    abi: raffleAbi,
    functionName: 'finalise',
    args: [roundId],
    account: d.caster.account!,
  })
  await d.publicClient.waitForTransactionReceipt({ hash: await d.caster.writeContract(finReq) })
  const finalisedEvents = await d.publicClient.getContractEvents({
    address: d.raffle,
    abi: raffleAbi,
    eventName: 'Finalised',
    fromBlock: 0n,
  })
  const finalised = finalisedEvents[0]!.args as any
  const entries = guesses.map((g, i) => ({
    ticketId: BigInt(i + 1),
    player: players[i]!.address as viem.Hex,
    guess: g,
    committedAtBlock: committedAtBlocks[i]!,
    revealed: true,
  }))
  const offChain = raffle.settle({ stake, threshold, period, validatorSubset: subset }, entries, seed.seed)
  console.log('draw      :', 1n + (BigInt(seed.seed) % 256n))
  console.log('off-chain :', offChain?.player, 'ticket', offChain?.ticketId)
  console.log('on-chain  :', finalised.winner)
  if (viem.getAddress(offChain!.player) !== viem.getAddress(finalised.winner)) throw new Error('PARITY MISMATCH')
  console.log('PARITY OK')
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
