import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import * as viem from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import {
  operatorSecret,
  operatorLocationsAt,
  inkValidatorStakedPool,
  erc20Abi,
} from '../scripts/actor-common'
import type { Deployment } from '../scripts/actor-common'
import RandomArtifact from '@gibs/random/artifacts/contracts/Random.sol/Random.json'
import RegistryArtifact from '@msgboard/games-contracts/artifacts/contracts/games/operator/OperatorRegistry.sol/OperatorRegistry.json'
import EscrowArtifact from '@msgboard/games-contracts/artifacts/contracts/games/operator/GameEscrow.sol/GameEscrow.json'
import GameArtifact from '@msgboard/games-contracts/artifacts/contracts/games/operator/OperatorCoinFlip.sol/OperatorCoinFlip.json'
import BondArtifact from '@msgboard/games-contracts/artifacts/contracts/games/operator/OperatorBond.sol/OperatorBond.json'
import VaultArtifact from '@msgboard/games-contracts/artifacts/contracts/games/operator/OperatorVault.sol/OperatorVault.json'
import FactoryArtifact from '@msgboard/games-contracts/artifacts/contracts/games/operator/OperatorVaultFactory.sol/OperatorVaultFactory.json'
import DefaultPolicyArtifact from '@msgboard/games-contracts/artifacts/contracts/games/operator/DefaultValidatorPolicy.sol/DefaultValidatorPolicy.json'
import ERC20Artifact from '@msgboard/games-contracts/artifacts/contracts/test/ERC20.sol/ERC20.json'

/**
 * Anvil integration test for the OperatorCoinFlip validator-forfeit loop against the REAL @gibs/random
 * Random (not the MockRandomStaking double). It proves the whole forfeit mechanism end to end: each
 * validator STAKES real ERC-20 when it self-inks its (token, tierPrice) pool, an honest reveal returns
 * that stake on cast, and a WITHHELD reveal is forfeited by chopAndRoute into the operator's bankroll
 * while the player is refunded. It exercises the exact helpers the cast-watcher uses (operatorSecret,
 * operatorLocationsAt, inkValidatorStakedPool), so the caster and the game agree on the derived key.
 */

const PORT = 8546
const RPC = `http://127.0.0.1:${PORT}`
const ANVIL = process.env.ANVIL || `${process.env.HOME}/.foundry/bin/anvil`
const MNEMONIC = 'test test test test test test test test test test test junk'
const SEEDS0 = 'seed seed seed seed seed seed seed seed seed seed seed sock'
const local = {
  id: 31337,
  name: 'anvil',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
} as const satisfies viem.Chain

const POOL_SIZE = 4
const PRICE = viem.parseEther('1') // single-tier table: tierPrice is always 1e18
const MULT = 196 // 1.96x
const BANKROLL = viem.parseEther('1000')
const FEES = viem.parseEther('100')

const account = (i: number) => mnemonicToAccount(MNEMONIC, { addressIndex: i })

describe('OperatorCoinFlip validator forfeit — real Random on anvil', () => {
  let anvil: ChildProcess
  let pc: viem.PublicClient
  const deployer = account(0) // deployer + owner + caster
  const validators = [account(1), account(2), account(3)]
  const operator = account(4)
  const player = account(5)
  const subset = validators.map((v) => v.address)

  const wallets = new Map<string, viem.WalletClient>()
  const walletFor = (a: viem.Account): viem.WalletClient => {
    const key = a.address.toLowerCase()
    if (!wallets.has(key)) wallets.set(key, viem.createWalletClient({ account: a, chain: local, transport: viem.http(RPC) }))
    return wallets.get(key)!
  }

  let random: viem.Hex
  let registry: viem.Hex
  let escrow: viem.Hex
  let game: viem.Hex
  let token: viem.Hex
  let tableId: viem.Hex
  let config: Deployment

  const send = async (
    a: viem.Account,
    call: { address: viem.Hex; abi: viem.Abi; functionName: string; args: readonly unknown[]; value?: bigint },
  ): Promise<viem.TransactionReceipt> => {
    const { request } = await pc.simulateContract({ ...call, account: a })
    const hash = await walletFor(a).writeContract(request)
    const receipt = await pc.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success') throw new Error(`${call.functionName} reverted`)
    return receipt
  }

  const deploy = async (artifact: { abi: unknown; bytecode: string }, args: unknown[] = []): Promise<viem.Hex> => {
    const hash = await walletFor(deployer).deployContract({
      abi: artifact.abi as viem.Abi,
      bytecode: artifact.bytecode as viem.Hex,
      args,
      account: deployer,
      chain: local,
    })
    const receipt = await pc.waitForTransactionReceipt({ hash })
    if (!receipt.contractAddress) throw new Error('deploy reverted')
    return receipt.contractAddress
  }

  const custodyOf = (a: viem.Hex): Promise<bigint> =>
    pc.readContract({ address: random, abi: RandomArtifact.abi as viem.Abi, functionName: 'balanceOf', args: [a, token] }) as Promise<bigint>
  const bankrollOf = (): Promise<bigint> =>
    pc.readContract({ address: escrow, abi: EscrowArtifact.abi as viem.Abi, functionName: 'bankrollOf', args: [operator.address, token] }) as Promise<bigint>
  const lockedOf = (): Promise<bigint> =>
    pc.readContract({ address: escrow, abi: EscrowArtifact.abi as viem.Abi, functionName: 'lockedOf', args: [operator.address, token] }) as Promise<bigint>
  const feeBalanceOf = (): Promise<bigint> =>
    pc.readContract({ address: game, abi: GameArtifact.abi as viem.Abi, functionName: 'feeBalance', args: [operator.address, token] }) as Promise<bigint>
  const tokenBal = (a: viem.Hex): Promise<bigint> =>
    pc.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [a] }) as Promise<bigint>
  const roundStatus = async (roundId: viem.Hex): Promise<number> => {
    const r = (await pc.readContract({ address: game, abi: GameArtifact.abi as viem.Abi, functionName: 'rounds', args: [roundId] })) as unknown[]
    return Number(r[8]) // Status is the 9th field
  }
  const keyOf = async (roundId: viem.Hex): Promise<viem.Hex> => {
    const r = (await pc.readContract({ address: game, abi: GameArtifact.abi as viem.Abi, functionName: 'rounds', args: [roundId] })) as unknown[]
    return r[6] as viem.Hex // key is the 7th field
  }

  const openRound = async (side: number, slot: bigint): Promise<{ roundId: viem.Hex; key: viem.Hex }> => {
    const locations = operatorLocationsAt(subset, slot, BigInt(POOL_SIZE), token, PRICE)
    const receipt = await send(player, {
      address: game,
      abi: GameArtifact.abi as viem.Abi,
      functionName: 'open',
      args: [tableId, side, PRICE, subset, locations],
    })
    const ev = viem.parseEventLogs({ abi: GameArtifact.abi as viem.Abi, eventName: 'RoundOpened', logs: receipt.logs })[0]
      ?.args as unknown as { roundId: viem.Hex; key: viem.Hex }
    return { roundId: ev.roundId, key: ev.key }
  }

  beforeAll(async () => {
    anvil = spawn(ANVIL, ['--port', String(PORT), '--silent'], { stdio: 'ignore' })
    pc = viem.createPublicClient({ chain: local, transport: viem.http(RPC) })
    // wait for the node to accept connections
    for (let i = 0; i < 50; i++) {
      try {
        await pc.getBlockNumber()
        break
      } catch {
        await new Promise((r) => setTimeout(r, 200))
      }
    }

    random = await deploy(RandomArtifact as { abi: unknown; bytecode: string })
    registry = await deploy(RegistryArtifact as { abi: unknown; bytecode: string })
    escrow = await deploy(EscrowArtifact as { abi: unknown; bytecode: string }, [registry])
    game = await deploy(GameArtifact as { abi: unknown; bytecode: string }, [random, escrow, registry])
    token = await deploy(ERC20Artifact as { abi: unknown; bytecode: string }, [false])
    // The rest of the substrate the brief lists — deployed to prove they co-deploy cleanly, though the
    // forfeit path runs entirely through registry/escrow/game.
    const bond = await deploy(BondArtifact as { abi: unknown; bytecode: string }, [registry])
    const vaultImpl = await deploy(VaultArtifact as { abi: unknown; bytecode: string })
    await deploy(FactoryArtifact as { abi: unknown; bytecode: string }, [vaultImpl, escrow])
    void bond

    // allowlist the three validators (owner is the deployer)
    for (const v of validators) {
      await send(deployer, { address: game, abi: GameArtifact.abi as viem.Abi, functionName: 'addValidator', args: [v.address] })
    }

    // mint: operator gets bankroll + fees; player gets a stake; each validator gets its stake capital
    const mint = (to: viem.Hex, amount: bigint) =>
      send(deployer, { address: token, abi: ERC20Artifact.abi as viem.Abi, functionName: 'mint', args: [to, amount] })
    await mint(operator.address, BANKROLL + FEES)
    await mint(player.address, viem.parseEther('10'))
    for (const v of validators) await mint(v.address, PRICE * BigInt(POOL_SIZE))

    // operator onboarding
    await send(operator, { address: registry, abi: RegistryArtifact.abi as viem.Abi, functionName: 'register', args: [] })
    await send(operator, { address: token, abi: ERC20Artifact.abi as viem.Abi, functionName: 'approve', args: [escrow, viem.maxUint256] })
    await send(operator, { address: token, abi: ERC20Artifact.abi as viem.Abi, functionName: 'approve', args: [game, viem.maxUint256] })
    await send(operator, { address: escrow, abi: EscrowArtifact.abi as viem.Abi, functionName: 'depositBankroll', args: [operator.address, token, BANKROLL] })
    await send(operator, { address: game, abi: GameArtifact.abi as viem.Abi, functionName: 'depositFees', args: [operator.address, token, FEES] })
    await send(operator, { address: escrow, abi: EscrowArtifact.abi as viem.Abi, functionName: 'authorizeGame', args: [game, true] })

    // player consent
    await send(player, { address: token, abi: ERC20Artifact.abi as viem.Abi, functionName: 'approve', args: [escrow, viem.maxUint256] })
    await send(player, { address: escrow, abi: EscrowArtifact.abi as viem.Abi, functionName: 'setPlayerGame', args: [game, true] })

    // single-tier table: minStake == maxStake == PRICE, so every stake maps to tierPrice PRICE
    const tableReceipt = await send(operator, {
      address: game,
      abi: GameArtifact.abi as viem.Abi,
      functionName: 'createTable',
      args: [token, MULT, PRICE, PRICE],
    })
    tableId = (viem.parseEventLogs({ abi: GameArtifact.abi as viem.Abi, eventName: 'TableCreated', logs: tableReceipt.logs })[0]
      ?.args as unknown as { tableId: viem.Hex }).tableId

    // Attach a real validator policy to the table: whitelist = the canonical subset, minCount 3. Every
    // round below uses that subset, so the hook passes — proving settle/forfeit are unchanged when a
    // policy gates open() (the policy runs pre-heat, after the hard floor). See the validator-policy plan.
    const policy = await deploy(DefaultPolicyArtifact as { abi: unknown; bytecode: string })
    await send(operator, { address: policy, abi: DefaultPolicyArtifact.abi as viem.Abi, functionName: 'setConfig', args: [game, tableId, 3n, false, subset] })
    await send(operator, { address: game, abi: GameArtifact.abi as viem.Abi, functionName: 'setValidatorPolicy', args: [tableId, policy] })

    config = {
      chainId: 31337,
      coinFlip: viem.zeroAddress,
      raffle: viem.zeroAddress,
      operatorCoinFlip: game,
      random,
      canonicalSubset: subset,
      poolOffsets: {},
      poolSize: POOL_SIZE,
      deployBlock: '0',
    }

    // each validator SELF-INKS its staked (token, PRICE) pool from its own key
    for (let i = 0; i < validators.length; i++) {
      const result = await inkValidatorStakedPool(pc, walletFor(validators[i]!), random, SEEDS0, i, token, PRICE, 0n, POOL_SIZE)
      expect(result, `validator ${i} inked`).toBe('inked')
    }
    // after inking, each validator's stake custody is fully committed (0 left)
    for (const v of validators) expect(await custodyOf(v.address)).toBe(0n)
  }, 120_000)

  afterAll(() => {
    anvil?.kill('SIGKILL')
  })

  it('SETTLE path: all three validators reveal → seed forms → round settles; validators keep stakes and exactly one earns the fee', async () => {
    const custodyBefore = await Promise.all(subset.map((a) => custodyOf(a)))
    const feeBefore = await feeBalanceOf()

    const { roundId, key } = await openRound(0 /* HEADS */, 0n)

    // caster reveals all three secrets in subset order → seed forms → onCast settles the round
    const locations = operatorLocationsAt(subset, 0n, BigInt(POOL_SIZE), token, PRICE)
    const secrets = subset.map((_a, i) => operatorSecret(SEEDS0, i, token, PRICE, 0n))
    const castReceipt = await send(deployer, { address: random, abi: RandomArtifact.abi as viem.Abi, functionName: 'cast', args: [key, locations, secrets] })
    const cast = viem.parseEventLogs({ abi: RandomArtifact.abi as viem.Abi, eventName: 'Cast', logs: castReceipt.logs })[0]
    expect(cast, 'seed was cast').toBeTruthy()

    expect(await roundStatus(roundId), 'round settled').toBe(2) // Status.Settled

    // every validator got its slot-0 stake (PRICE) back on reveal, and exactly one additionally earned
    // the round fee (n * PRICE) as the bonus.
    const custodyAfter = await Promise.all(subset.map((a) => custodyOf(a)))
    const deltas = custodyAfter.map((c, i) => c - custodyBefore[i]!)
    const totalDelta = deltas.reduce((s, d) => s + d, 0n)
    expect(totalDelta, 'stakes returned + fee paid').toBe(PRICE * 3n + PRICE * 3n) // 3 stakes + fee (3*PRICE)
    const bonusWinners = deltas.filter((d) => d === PRICE + PRICE * 3n)
    const plainReturns = deltas.filter((d) => d === PRICE)
    expect(bonusWinners.length, 'exactly one validator earned the fee').toBe(1)
    expect(plainReturns.length, 'the other two only got their stake back').toBe(2)

    // the game spent exactly one round fee (n * tierPrice) from the operator's pool
    expect(feeBefore - (await feeBalanceOf())).toBe(PRICE * 3n)
  })

  it('FORFEIT path: one validator withholds → chopAndRoute banks the forfeit, refunds the player, honest validators keep stakes', async () => {
    const bankrollBefore = await bankrollOf()
    const lockedBefore = await lockedOf()
    const feeBefore = await feeBalanceOf()
    const playerBefore = await tokenBal(player.address)
    const custodyBefore = await Promise.all(subset.map((a) => custodyOf(a)))

    const { roundId, key } = await openRound(1 /* TAILS */, 1n)
    expect(await keyOf(roundId)).toBe(key)

    // validators 0 and 1 reveal; validator 2 WITHHOLDS. The partial cast flicks the two honest stakes
    // back and returns MISSING_SECRET (no seed) — exactly what the cast-watcher's chop pass does first.
    const locations = operatorLocationsAt(subset, 1n, BigInt(POOL_SIZE), token, PRICE)
    const withheldSecrets = [operatorSecret(SEEDS0, 0, token, PRICE, 1n), operatorSecret(SEEDS0, 1, token, PRICE, 1n), viem.padHex('0x0', { size: 32 })]
    await send(deployer, { address: random, abi: RandomArtifact.abi as viem.Abi, functionName: 'cast', args: [key, locations, withheldSecrets] })
    // seed must NOT have formed (a secret is missing)
    const rnd = (await pc.readContract({ address: random, abi: RandomArtifact.abi as viem.Abi, functionName: 'randomness', args: [key] })) as { seed: viem.Hex }
    expect(rnd.seed, 'seed withheld').toBe(viem.padHex('0x0', { size: 32 }))

    // advance well past the cast window so the round is choppable
    await pc.request({ method: 'anvil_mine' as never, params: ['0x120' as never] }) // 288 blocks

    // chopAndRoute wraps Random.chop + forfeit routing
    const chopReceipt = await send(deployer, { address: game, abi: GameArtifact.abi as viem.Abi, functionName: 'chopAndRoute', args: [roundId, locations] })
    const forfeitEv = viem.parseEventLogs({ abi: GameArtifact.abi as viem.Abi, eventName: 'ForfeitRouted', logs: chopReceipt.logs })[0]
      ?.args as { forfeit: bigint } | undefined
    expect(forfeitEv?.forfeit, 'forfeit is exactly the tier price').toBe(PRICE)

    expect(await roundStatus(roundId), 'round refunded').toBe(3) // Status.Refunded

    // (a) the withheld stake (one tierPrice) landed in the operator's bankroll, net of the round's
    //     exposure lock/return (which nets to zero across open+refund).
    expect((await bankrollOf()) - bankrollBefore, 'forfeit banked to operator bankroll').toBe(PRICE)
    expect(await lockedOf(), 'exposure released').toBe(lockedBefore)

    // (b) the player was made whole (stake pulled at open, returned on refund)
    expect(await tokenBal(player.address), 'player refunded').toBe(playerBefore)

    // (c) the honest validators kept their stakes (returned on the partial cast); the withholder did not
    const custodyAfter = await Promise.all(subset.map((a) => custodyOf(a)))
    expect(custodyAfter[0]! - custodyBefore[0]!, 'validator 0 stake returned').toBe(PRICE)
    expect(custodyAfter[1]! - custodyBefore[1]!, 'validator 1 stake returned').toBe(PRICE)
    expect(custodyAfter[2]! - custodyBefore[2]!, 'withholder stake forfeited').toBe(0n)

    // (d) the operator's fee pool is whole again (open debited n*tierPrice, chop restored it)
    expect(await feeBalanceOf(), 'fee pool restored').toBe(feeBefore)
  })

  it('FRONT-RUN: a third party calls the public Random.chop first → chopAndRoute still routes the forfeit (no freeze)', async () => {
    const bankrollBefore = await bankrollOf()
    const feeBefore = await feeBalanceOf()
    const playerBefore = await tokenBal(player.address)

    const { roundId, key } = await openRound(1 /* TAILS */, 2n)

    // validators 0,1 reveal; validator 2 withholds → seed never forms
    const locations = operatorLocationsAt(subset, 2n, BigInt(POOL_SIZE), token, PRICE)
    const withheldSecrets = [operatorSecret(SEEDS0, 0, token, PRICE, 2n), operatorSecret(SEEDS0, 1, token, PRICE, 2n), viem.padHex('0x0', { size: 32 })]
    await send(deployer, { address: random, abi: RandomArtifact.abi as viem.Abi, functionName: 'cast', args: [key, locations, withheldSecrets] })
    await pc.request({ method: 'anvil_mine' as never, params: ['0x120' as never] }) // past the window

    // ATTACKER (the operator account, standing in for any third party) front-runs by calling the PUBLIC
    // Random.chop directly. This credits the game's custody and fires onReverse; the round stays Pending.
    await send(operator, { address: random, abi: RandomArtifact.abi as viem.Abi, functionName: 'chop', args: [key, locations] })
    expect(await roundStatus(roundId), 'round still pending after external chop').toBe(1) // Status.Pending

    // chopAndRoute must NOT revert (it sees the recorded credit and skips its own chop) and must route.
    const chopReceipt = await send(deployer, { address: game, abi: GameArtifact.abi as viem.Abi, functionName: 'chopAndRoute', args: [roundId, locations] })
    const forfeitEv = viem.parseEventLogs({ abi: GameArtifact.abi as viem.Abi, eventName: 'ForfeitRouted', logs: chopReceipt.logs })[0]
      ?.args as { forfeit: bigint } | undefined
    expect(forfeitEv?.forfeit, 'forfeit routed despite the front-run').toBe(PRICE)
    expect(await roundStatus(roundId), 'round refunded').toBe(3)
    expect((await bankrollOf()) - bankrollBefore, 'forfeit banked to operator bankroll').toBe(PRICE)
    expect(await tokenBal(player.address), 'player refunded').toBe(playerBefore)
    expect(await feeBalanceOf(), 'fee pool restored').toBe(feeBefore)
  })
})
