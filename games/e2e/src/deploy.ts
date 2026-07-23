import * as viem from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import {
  local,
  makePublicClient,
  makeWalletClient,
  raffleAbi,
  raffleBytecode,
  coinFlipAbi,
  coinFlipBytecode,
  makeSecret,
  inkPool,
  type Info,
} from '@msgboard/games-core'
import RandomArtifact from '@gibs/random/artifacts/contracts/Random.sol/Random.json'

const TEST_MNEMONIC = 'test test test test test test test test test test test junk'

export type Deployment = {
  publicClient: viem.PublicClient
  caster: viem.WalletClient
  random: viem.Hex
  raffle: viem.Hex
  coinFlip: viem.Hex
  validators: { address: viem.Hex; location: Info; secret: viem.Hex }[]
  salt: viem.Hex
}

/**
 * Deploy core Random and the games to a local anvil node (chainId 31337, RPC 127.0.0.1:8545), set
 * up `validatorCount` allowlisted validators with one inked price-0 preimage each, and return the
 * handles a test or script needs. Account 0 of the standard anvil mnemonic is deployer + caster;
 * validators are further accounts of the same funded mnemonic.
 */
export const deployLocal = async (validatorCount = 3): Promise<Deployment> => {
  const account = mnemonicToAccount(TEST_MNEMONIC)
  const publicClient = makePublicClient(31337)
  const caster = makeWalletClient(31337, account)

  const deploy = async (abi: viem.Abi, bytecode: viem.Hex, args: unknown[]): Promise<viem.Hex> => {
    const hash = await caster.deployContract({ abi, bytecode, args, account, chain: local })
    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    if (!receipt.contractAddress) throw new Error('deploy reverted')
    return receipt.contractAddress
  }

  const random = await deploy(RandomArtifact.abi as viem.Abi, RandomArtifact.bytecode as viem.Hex, [])
  const raffle = await deploy(raffleAbi, raffleBytecode, [random])
  const coinFlip = await deploy(coinFlipAbi, coinFlipBytecode, [random])

  const salt = viem.bytesToHex(crypto.getRandomValues(new Uint8Array(32)))
  const validators: Deployment['validators'] = []
  for (let i = 0; i < validatorCount; i++) {
    // addressIndex (m/44'/60'/0'/0/N) — these are anvil's funded accounts, NOT accountIndex
    const v = mnemonicToAccount(TEST_MNEMONIC, { addressIndex: i + 1 })
    const vWallet = makeWalletClient(31337, v)
    const secret = makeSecret(`validator-${i}`, salt)
    // allowlist on both games (owner == account 0)
    for (const game of [raffle, coinFlip]) {
      const { request } = await publicClient.simulateContract({
        address: game,
        abi: raffleAbi,
        functionName: 'addValidator',
        args: [v.address],
        account,
      })
      await publicClient.waitForTransactionReceipt({ hash: await caster.writeContract(request) })
    }
    await publicClient.waitForTransactionReceipt({ hash: await inkPool(vWallet, publicClient, random, v.address, secret) })
    const location: Info = {
      provider: v.address,
      callAtChange: false,
      durationIsTimestamp: false,
      duration: 12n,
      token: viem.zeroAddress,
      price: 0n,
      offset: 0n,
      index: 0n,
    }
    validators.push({ address: v.address, location, secret: secret.secret })
  }

  return { publicClient, caster, random, raffle, coinFlip, validators, salt }
}
