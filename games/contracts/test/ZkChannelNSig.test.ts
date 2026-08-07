import * as viem from 'viem'
import { expect } from 'chai'
import hre from 'hardhat'
import { makeDomainN, hashStateN, type ChannelStateN, type SidePot } from '@msgboard/holdem'
import {
  hashStartIntentN, hashRegisterDeckKeyIntentN, hashLeaveIntentN, hashCancelIntentN,
  hashOpenDisputeIntentN, hashRespondMoveIntentN, channelStateNStructHash,
  signStartIntentN, type IntentDomainN,
} from '@msgboard/zk-cards-core'
import { deployHoldemTableN } from './x402'

// HoldemTableN's constructor takes (treasury, factory) — see HoldemTableN.sol's
// IWrapperFactory; factory=zeroAddress skips the create()-time clone-check, matching the
// Foundry unit suites' factory=address(0) escape hatch. (Previously called with only the
// treasury arg — stale from before the 2026-08 x402 conversion added `factory`; fixed here
// as part of the 2026-08 signed-intent relay pass's hardhat migration.) Shared by every
// describe block in this file.
async function deploy() {
  const zk = await deployHoldemTableN('0x000000000000000000000000000000000000bEEF', viem.zeroAddress)
  const publicClient = await hre.viem.getPublicClient()
  const chainId = await publicClient.getChainId()
  // `ChannelDomainN` (holdem) and `IntentDomainN` (zk-cards-core) are structurally identical
  // ({name:'HoldemTableN', version:'1', chainId, verifyingContract}) — no cast needed, TS
  // structural typing accepts one wherever the other is expected.
  const domain: IntentDomainN = makeDomainN(chainId, zk.address)
  return { zk, domain }
}

/// EIP-712 dynamic-array hashing (uint256[] balances + SidePot[] sidePots) is the
/// likeliest silent parity bug. These tests pin the TS hashStateN digest to the on-chain
/// HoldemTableN.stateDigest for fully-populated N-seat states across N and side-pot counts.
describe('ChannelN digest parity', () => {

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

// Solidity<->viem parity for the 2026-08 signed-intent relay's 6 HoldemTableN typehashes
// (HoldemTableN.sol's "Signed-intent typehashes" section / SignedIntentBase.sol). Mirrors
// ZkChannelSig.test.ts's own signed-intent parity block: nonzero/distinct values in every field
// so a transposed or missing field breaks parity, comparing the TS helper's digest against the
// matching on-chain `<name>IntentDigest` public view.
describe('ChannelN signed-intent relay — typehash parity', () => {
  const tableId = viem.keccak256(viem.toHex('table-relay-N-1'))
  const nonce = 42n
  const deadline = 1_999_999_999n

  it('StartIntent digest parity', async () => {
    const { zk, domain } = await deploy()
    const offChain = hashStartIntentN(domain, { tableId, nonce, deadline })
    const onChain = await zk.read.startIntentDigest([tableId, nonce, deadline])
    expect(onChain).to.equal(offChain)
  })

  it('RegisterDeckKeyIntent digest parity', async () => {
    const { zk, domain } = await deploy()
    const pkX = 111n
    const pkY = 222n
    const offChain = hashRegisterDeckKeyIntentN(domain, { tableId, pkX, pkY, nonce, deadline })
    const onChain = await zk.read.registerDeckKeyIntentDigest([tableId, pkX, pkY, nonce, deadline])
    expect(onChain).to.equal(offChain)
  })

  it('LeaveIntent digest parity', async () => {
    const { zk, domain } = await deploy()
    const offChain = hashLeaveIntentN(domain, { tableId, nonce, deadline })
    const onChain = await zk.read.leaveIntentDigest([tableId, nonce, deadline])
    expect(onChain).to.equal(offChain)
  })

  it('CancelIntent digest parity', async () => {
    const { zk, domain } = await deploy()
    const offChain = hashCancelIntentN(domain, { tableId, nonce, deadline })
    const onChain = await zk.read.cancelIntentDigest([tableId, nonce, deadline])
    expect(onChain).to.equal(offChain)
  })

  it('OpenDisputeIntent digest parity (stateHash bound via channelStateNStructHash)', async () => {
    const { zk, domain } = await deploy()
    const state: ChannelStateN = {
      tableId,
      nonce: 3n,
      balances: [viem.parseEther('1'), viem.parseEther('1'), viem.parseEther('1')],
      pot: viem.parseEther('0.2'),
      sidePots: [{ amount: viem.parseEther('0.1'), eligibleMask: 0b011n }],
      rakeAccrued: viem.parseEther('0.01'),
      deckCommitment: viem.keccak256(viem.toHex('deck')),
      phase: 2,
      gameStateHash: viem.keccak256(viem.toHex('gs')),
    }
    const stateHash = channelStateNStructHash(state)
    const demandSeat = 1
    const demandKind = 2
    const demandSlot = 7
    const offChain = hashOpenDisputeIntentN(domain, { tableId, stateHash, demandSeat, demandKind, demandSlot, nonce, deadline })
    const onChain = await zk.read.openDisputeIntentDigest([tableId, stateHash, demandSeat, demandKind, demandSlot, nonce, deadline])
    expect(onChain).to.equal(offChain)
  })

  it('RespondMoveIntent digest parity', async () => {
    const { zk, domain } = await deploy()
    const gameStateHash = viem.keccak256(viem.toHex('gs'))
    const moveHash = viem.keccak256(viem.toHex('move'))
    const offChain = hashRespondMoveIntentN(domain, { tableId, gameStateHash, moveHash, nonce, deadline })
    const onChain = await zk.read.respondWithMoveIntentDigest([tableId, gameStateHash, moveHash, nonce, deadline])
    expect(onChain).to.equal(offChain)
  })
})

// End-to-end: sign a StartIntent with viem's own signTypedData (via a local test account, not a
// hardhat network account) and relay it through the real `startFor` entrypoint from an UNRELATED
// address — closing the loop from "TS helper produces the right digest" to "a real signature
// this library produces is actually accepted on-chain when relayed." Mirrors ZkChannelSig.test.ts's
// own e2e block.
describe('ChannelN signed-intent relay — end-to-end', () => {
  // secp256k1 generator — HoldemTableN.create()/join() require an ON-CURVE deck key (unlike
  // ZkTable, which tolerates (0,0)); see EllipticCurve.isOnCurve's BadDeckKey guard.
  const GX = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n
  const GY = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n

  it('a viem-signed StartIntent is accepted when relayed by an unrelated account', async () => {
    const { privateKeyToAccount, generatePrivateKey } = await import('viem/accounts')
    const { zk, domain } = await deploy()
    const rules = await hre.viem.deployContract('MockGameRulesN')
    const token = await hre.viem.deployContract('MockX402')
    const { makeX402Domain, buildCreateAuthN, buildJoinAuthN } = await import('./x402')
    const [, , relayer] = await hre.viem.getWalletClients()
    const publicClient = await hre.viem.getPublicClient()
    const chainId = await publicClient.getChainId()
    const x402Domain = makeX402Domain(chainId, token.address)

    const aAccount = privateKeyToAccount(generatePrivateKey())
    const bAccount = privateKeyToAccount(generatePrivateKey())
    await token.write.mint([aAccount.address, viem.parseEther('10')])
    await token.write.mint([bAccount.address, viem.parseEther('10')])
    const aSigner = { address: aAccount.address, signTypedData: (args: any) => aAccount.signTypedData(args) }
    const bSigner = { address: bAccount.address, signTypedData: (args: any) => bAccount.signTypedData(args) }

    const createAuth = await buildCreateAuthN(zk, token.address, x402Domain, aSigner as any, {
      rules: rules.address, buyIn: viem.parseEther('1'), maxSeats: 3n, rakeBps: 0, rakeCap: 0n,
      clockBlocks: 60n, channelKey: viem.zeroAddress, deckKey: [GX, GY],
    })
    const createHash = await zk.write.create(
      [token.address, rules.address, viem.parseEther('1'), 3n, 0, 0n, 60n, viem.zeroAddress, [GX, GY], createAuth],
      { account: relayer!.account }, // relayer submits, never a or b
    )
    const receipt = await publicClient.waitForTransactionReceipt({ hash: createHash })
    const [created] = viem.parseEventLogs({ logs: receipt.logs, abi: zk.abi, eventName: 'TableCreated' })
    const tableId = created!.args.tableId!

    const joinAuth = await buildJoinAuthN(zk, x402Domain, bSigner as any, {
      tableId, stake: viem.parseEther('1'), channelKey: viem.zeroAddress, deckKey: [GX, GY],
    })
    await zk.write.join([tableId, viem.zeroAddress, [GX, GY], joinAuth], { account: relayer!.account })

    const intentNonce = 0n
    const intentDeadline = BigInt(Math.floor(Date.now() / 1000) + 3600)
    const sig = await signStartIntentN(aSigner as any, domain, { tableId, nonce: intentNonce, deadline: intentDeadline })

    await zk.write.startFor([tableId, intentNonce, intentDeadline, sig], { account: relayer!.account })
    const status = await zk.read.status([tableId])
    expect(status).to.equal(2) // Status.Live — started by the SIGNER (a), not the relayer
  })
})
