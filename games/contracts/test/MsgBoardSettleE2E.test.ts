import * as viem from 'viem'
import { expect } from 'chai'
import hre from 'hardhat'
import { privateKeyToAccount } from 'viem/accounts'
import { HouseSession, dice, makeDomain } from '@msgboard/games'
import { OptimisticSettlement, EscrowedSettlement, signOpenTerms, paramsHashOf, type OpenTerms } from '@msgboard/settle'

const playerKey = privateKeyToAccount(`0x${'11'.repeat(32)}`)
const houseKey = privateKeyToAccount(`0x${'22'.repeat(32)}`)
const tip = `0x${'77'.repeat(32)}` as viem.Hex

// playerKey (0x11..) is NOT a hardhat-managed account, so it cannot be signed via the node's
// eth_sendTransaction. Build a LOCAL-account wallet client (viem signs locally and submits via
// eth_sendRawTransaction over the hardhat provider) and fund its gas with hardhat_setBalance.
async function makePlayerWallet() {
  const publicClient = await hre.viem.getPublicClient()
  await hre.network.provider.request({
    method: 'hardhat_setBalance',
    params: [playerKey.address, viem.numberToHex(10n ** 18n)],
  })
  return viem.createWalletClient({
    account: playerKey,
    chain: publicClient.chain,
    transport: viem.custom(hre.network.provider),
  })
}

async function playSession(domain: any, tableId: viem.Hex, mode: number, rounds = 5) {
  const s = new HouseSession({
    domain, tableId, game: dice, player: playerKey, house: houseKey, seedTip: tip, chainLength: 16,
    openBalances: { player: 200n, house: 200n }, settlementMode: mode,
  })
  await s.open()
  for (let i = 0; i < rounds; i++) {
    await s.playRound({ stake: 20n, params: { targetX100: 5000n }, clientSeed: `0x${(i + 1).toString(16).padStart(64, '0')}` as viem.Hex })
  }
  return s
}

describe('MsgBoard settlement E2E', () => {
  it('optimistic: play off-chain, settle the net delta from the transcript alone', async () => {
    const [house] = await hre.viem.getWalletClients()
    const publicClient = await hre.viem.getPublicClient()
    const chainId = await publicClient.getChainId()
    const playerWallet = await makePlayerWallet()

    const chips = await hre.viem.deployContract('Chips')
    const bank = await hre.viem.deployContract('HouseBankroll', [chips.address])
    await chips.write.mint([house.account.address, 10_000n])
    await chips.write.mint([playerKey.address, 1_000n])
    await bank.write.setHouseKey([houseKey.address])
    await chips.write.approve([bank.address, viem.maxUint256])
    await bank.write.fundHouse([5_000n])

    // player funds its session-key deposit (optimistic keys by signing address)
    await playerWallet.writeContract({ address: chips.address, abi: chips.abi, functionName: 'approve', args: [bank.address, viem.maxUint256] })
    await playerWallet.writeContract({ address: bank.address, abi: bank.abi, functionName: 'deposit', args: [1_000n] })

    const domain = makeDomain(chainId, bank.address)
    const tableId = viem.keccak256(viem.toHex('opt-table'))
    const s = await playSession(domain, tableId, 0)

    const opt = new OptimisticSettlement({
      parties: { player: playerKey.address, house: houseKey.address }, commit: s.chain.commit,
      game: dice, domain, settlementMode: 0, bankroll: bank.address,
    })
    const tx = await opt.buildSettle(s.transcript.toJSON())
    await house.writeContract({ address: tx.address, abi: tx.abi as viem.Abi, functionName: tx.functionName, args: tx.args })

    const expectedDelta = s.state.balancePlayer - 200n
    const dep = await bank.read.deposits([playerKey.address])
    expect(dep).to.equal(1_000n + expectedDelta)
  })

  it('escrowed: open (house-signed terms), play, settle from escrow', async () => {
    const [house] = await hre.viem.getWalletClients()
    const publicClient = await hre.viem.getPublicClient()
    const chainId = await publicClient.getChainId()
    const playerWallet = await makePlayerWallet()

    const chips = await hre.viem.deployContract('Chips')
    const ch = await hre.viem.deployContract('HouseChannel', [chips.address])
    await chips.write.mint([house.account.address, 10_000n])
    await chips.write.mint([playerKey.address, 1_000n])
    await ch.write.setHouseKey([houseKey.address])
    await chips.write.approve([ch.address, viem.maxUint256])
    await ch.write.fundHouse([5_000n])
    await playerWallet.writeContract({ address: chips.address, abi: chips.abi, functionName: 'approve', args: [ch.address, viem.maxUint256] })

    const domain = makeDomain(chainId, ch.address)
    const tableId = viem.keccak256(viem.toHex('esc-table'))
    const s = await playSession(domain, tableId, 1)

    const terms: OpenTerms = {
      tableId, player: playerKey.address, playerKey: playerKey.address,
      escrowPlayer: 200n, escrowHouse: 200n, gameId: 1, rngCommit: s.chain.commit,
      clockBlocks: 30n, expiry: BigInt(Math.floor(Date.now() / 1000) + 3600),
      // clientSeedCommit + paramsHash are bound into the house-signed terms (recompute-settle,
      // mode 1). This escrow path settles from the both-signed final state, so they are recorded
      // here, not recomputed; paramsHash matches the dice targetX100=5000 the session played.
      clientSeedCommit: viem.keccak256(viem.toHex('esc-table-client-seed')),
      paramsHash: paramsHashOf(5000n),
    }
    const houseSig = await signOpenTerms(houseKey, domain, terms)
    await playerWallet.writeContract({ address: ch.address, abi: ch.abi, functionName: 'open', args: [terms, houseSig] })

    const esc = new EscrowedSettlement({
      parties: { player: playerKey.address, house: houseKey.address }, commit: s.chain.commit,
      game: dice, domain, settlementMode: 1, channel: ch.address,
    })
    const tx = await esc.buildSettle(s.transcript.toJSON())
    await house.writeContract({ address: tx.address, abi: tx.abi as viem.Abi, functionName: tx.functionName, args: tx.args })

    const bal = await chips.read.balanceOf([playerKey.address])
    expect(bal).to.equal(1_000n - 200n + s.state.balancePlayer)
  })
})
