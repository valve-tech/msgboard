import * as viem from 'viem'
import RandomArtifact from '@gibs/random/artifacts/contracts/Random.sol/Random.json'
import CoinFlipArtifact from '@msgboard/games-contracts/artifacts/contracts/CoinFlip.sol/CoinFlip.json'
import CoinFlipTablesArtifact from '@msgboard/games-contracts/artifacts/contracts/games/CoinFlipTables.sol/CoinFlipTables.json'
import RaffleArtifact from '@msgboard/games-contracts/artifacts/contracts/Raffle.sol/Raffle.json'
import OperatorCoinFlipArtifact from '@msgboard/games-contracts/artifacts/contracts/games/operator/OperatorCoinFlip.sol/OperatorCoinFlip.json'
import GameEscrowArtifact from '@msgboard/games-contracts/artifacts/contracts/games/operator/GameEscrow.sol/GameEscrow.json'
import OperatorRegistryArtifact from '@msgboard/games-contracts/artifacts/contracts/games/operator/OperatorRegistry.sol/OperatorRegistry.json'
import DefaultValidatorPolicyArtifact from '@msgboard/games-contracts/artifacts/contracts/games/operator/DefaultValidatorPolicy.sol/DefaultValidatorPolicy.json'
import { chains, defaultRpc, type GamesChainId } from './chains'

export const randomAbi = RandomArtifact.abi as viem.Abi
export const coinFlipAbi = CoinFlipArtifact.abi as viem.Abi
export const coinFlipTablesAbi = CoinFlipTablesArtifact.abi as viem.Abi
export const raffleAbi = RaffleArtifact.abi as viem.Abi
export const coinFlipBytecode = CoinFlipArtifact.bytecode as viem.Hex
export const raffleBytecode = RaffleArtifact.bytecode as viem.Hex
// Backroom-B (operator security room) spot-truth reads. Same artifact-import pattern as the games
// above; the operator substrate has no other consumer package yet (operator-ops.ts reads the JSON
// artifact off disk directly), so this is the first shared export of these four ABIs.
export const operatorCoinFlipAbi = OperatorCoinFlipArtifact.abi as viem.Abi
export const gameEscrowAbi = GameEscrowArtifact.abi as viem.Abi
export const operatorRegistryAbi = OperatorRegistryArtifact.abi as viem.Abi
export const defaultValidatorPolicyAbi = DefaultValidatorPolicyArtifact.abi as viem.Abi

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
