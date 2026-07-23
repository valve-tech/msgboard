import * as viem from 'viem'
import { expect } from 'chai'
import hre from 'hardhat'
import { makeDomainN, hashStateN, type ChannelStateN, type SidePot } from '@msgboard/holdem'

/// EIP-712 dynamic-array hashing (uint256[] balances + SidePot[] sidePots) is the
/// likeliest silent parity bug. These tests pin the TS hashStateN digest to the on-chain
/// HoldemTableN.stateDigest for fully-populated N-seat states across N and side-pot counts.
describe('ChannelN digest parity', () => {
  async function deploy() {
    const zk = await hre.viem.deployContract('HoldemTableN', [
      '0x000000000000000000000000000000000000bEEF',
    ])
    const publicClient = await hre.viem.getPublicClient()
    const chainId = await publicClient.getChainId()
    const domain = makeDomainN(chainId, zk.address)
    return { zk, domain }
  }

  it('matches for a fully populated N=3 state with two side-pots', async () => {
    const { zk, domain } = await deploy()
    const sidePots: SidePot[] = [
      { amount: viem.parseEther('0.4'), eligibleMask: 0b101n },
      { amount: viem.parseEther('0.2'), eligibleMask: 0b011n },
    ]
    const state: ChannelStateN = {
      tableId: viem.keccak256(viem.toHex('table-N-1')),
      nonce: 9n,
      balances: [viem.parseEther('1.5'), viem.parseEther('0.25'), viem.parseEther('0.75')],
      pot: viem.parseEther('0.6'),
      sidePots,
      rakeAccrued: viem.parseEther('0.05'),
      deckCommitment: viem.keccak256(viem.toHex('deck')),
      phase: 5,
      gameStateHash: viem.keccak256(viem.toHex('game-state')),
    }
    const offChain = hashStateN(domain, state)
    const onChain = await zk.read.stateDigest([state])
    expect(onChain).to.equal(offChain)
  })

  it('matches with empty balances/sidePots edge (N=2, no side-pots)', async () => {
    const { zk, domain } = await deploy()
    const state: ChannelStateN = {
      tableId: viem.keccak256(viem.toHex('table-N-2')),
      nonce: 0n,
      balances: [viem.parseEther('1'), viem.parseEther('1')],
      pot: 0n,
      sidePots: [],
      rakeAccrued: 0n,
      deckCommitment: ('0x' + '00'.repeat(32)) as viem.Hex,
      phase: 0,
      gameStateHash: ('0x' + '00'.repeat(32)) as viem.Hex,
    }
    const offChain = hashStateN(domain, state)
    const onChain = await zk.read.stateDigest([state])
    expect(onChain).to.equal(offChain)
  })

  it('matches across fuzzed N-seat states (vector hashing parity)', async () => {
    const { zk, domain } = await deploy()
    // simple deterministic PRNG (mulberry32) for reproducible fuzzing
    let seed = 0x1234abcd
    const rng = () => {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    const wei = () => BigInt(Math.floor(rng() * 1e15))
    for (let iter = 0; iter < 40; iter++) {
      const n = 2 + Math.floor(rng() * 8) // 2..9
      const balances = Array.from({ length: n }, () => wei())
      const nSide = Math.floor(rng() * 4)
      const sidePots: SidePot[] = Array.from({ length: nSide }, () => ({
        amount: wei(),
        eligibleMask: BigInt(Math.floor(rng() * (1 << n))),
      }))
      const state: ChannelStateN = {
        tableId: viem.keccak256(viem.toHex(`fuzz-${iter}`)),
        nonce: BigInt(Math.floor(rng() * 1e6)),
        balances,
        pot: wei(),
        sidePots,
        rakeAccrued: wei(),
        deckCommitment: viem.keccak256(viem.toHex(`deck-${iter}`)),
        phase: Math.floor(rng() * 256),
        gameStateHash: viem.keccak256(viem.toHex(`gs-${iter}`)),
      }
      const offChain = hashStateN(domain, state)
      const onChain = await zk.read.stateDigest([state])
      expect(onChain, `iter ${iter} (n=${n}, sidePots=${nSide})`).to.equal(offChain)
    }
  })
})
