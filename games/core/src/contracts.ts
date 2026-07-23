import * as viem from 'viem'
import RandomArtifact from '@gibs/random/artifacts/contracts/Random.sol/Random.json'
import CoinFlipArtifact from '@msgboard/games-contracts/artifacts/contracts/CoinFlip.sol/CoinFlip.json'
import RaffleArtifact from '@msgboard/games-contracts/artifacts/contracts/Raffle.sol/Raffle.json'
import { chains, defaultRpc, type GamesChainId } from './chains'

export const randomAbi = RandomArtifact.abi as viem.Abi
export const coinFlipAbi = CoinFlipArtifact.abi as viem.Abi
export const raffleAbi = RaffleArtifact.abi as viem.Abi
export const coinFlipBytecode = CoinFlipArtifact.bytecode as viem.Hex
export const raffleBytecode = RaffleArtifact.bytecode as viem.Hex

/** The PreimageLocation.Info tuple the contracts expect. */
export type Info = {
  provider: viem.Hex
  callAtChange: boolean
  durationIsTimestamp: boolean
  duration: bigint
  token: viem.Hex
  price: bigint
  offset: bigint
  index: bigint
}

export type Clients = {
  chainId: GamesChainId
  publicClient: viem.PublicClient
  walletClient?: viem.WalletClient
}

/** Build a read-only public client for a chain (optionally overriding the RPC URL). */
export const makePublicClient = (chainId: GamesChainId, rpcUrl = defaultRpc[chainId]): viem.PublicClient =>
  viem.createPublicClient({ chain: chains[chainId], transport: viem.http(rpcUrl) })

/** Build a wallet client for an account on a chain. */
export const makeWalletClient = (
  chainId: GamesChainId,
  account: viem.Account,
  rpcUrl = defaultRpc[chainId],
): viem.WalletClient =>
  viem.createWalletClient({ account, chain: chains[chainId], transport: viem.http(rpcUrl) })
