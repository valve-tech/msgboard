import { privateKeyToAccount } from 'viem/accounts'
import { type Hex } from 'viem'
import { HouseSession, verifyFinishedSession, dice, limbo, TEST_DOMAIN } from '../src/index'

async function run(name: string, game: any, params: any, stake: bigint) {
  const player = privateKeyToAccount(`0x${'11'.repeat(32)}`)
  const house = privateKeyToAccount(`0x${'22'.repeat(32)}`)
  const s = new HouseSession({
    domain: TEST_DOMAIN, tableId: `0x${'ab'.repeat(32)}` as Hex, game,
    player, house, seedTip: `0x${'77'.repeat(32)}` as Hex, chainLength: 16,
    openBalances: { player: 1000n, house: 1000n }, settlementMode: 0,
  })
  await s.open()
  console.log(`\n== ${name} ==`)
  for (let i = 0; i < 10; i++) {
    await s.playRound({ stake, params, clientSeed: `0x${(i + 1).toString(16).padStart(64, '0')}` as Hex })
    console.log(`round ${s.state.nonce}: player=${s.state.balancePlayer} house=${s.state.balanceHouse}`)
  }
  const ok = await verifyFinishedSession(s.transcript.toJSON(), {
    parties: { player: player.address, house: house.address }, commit: s.chain.commit, game, domain: TEST_DOMAIN,
  })
  console.log(`${name} transcript verifies from scratch: ${ok}`)
}

await run('DICE 50.00% target', dice, { targetX100: 5000n }, 100n)
await run('LIMBO 2.00x target', limbo, { targetX100: 200n }, 100n)
