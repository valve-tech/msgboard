import * as viem from 'viem'
import { buildHeatLocations, type Info } from '@msgboard/games-core'
import { poolLocationFor } from './model/pools'
import { publicClientFor } from './wallet'
import type { GameDeployment } from './config'
import type { CoinFlipLobby } from './model/coinflip-lobby'
import type { RaffleRoundView } from './model/raffle-rounds'

/** Simulate-then-send (the duel-943 discipline), returning the receipt. Throws readable errors. */
export const sendGameTx = async (
  deployment: GameDeployment,
  walletClient: viem.WalletClient,
  call: { address: viem.Hex; abi: viem.Abi; functionName: string; args: readonly unknown[]; value?: bigint },
): Promise<viem.TransactionReceipt> => {
  const publicClient = publicClientFor(deployment.chainId, deployment.rpc)
  try {
    const { request } = await publicClient.simulateContract({
      ...call,
      account: walletClient.account!,
      value: call.value ?? 0n,
    })
    const hash = await walletClient.writeContract(request)
    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success') throw new Error(`${call.functionName} reverted on chain`)
    return receipt
  } catch (error) {
    throw new Error(translateError(error))
  }
}

/** Map raw revert noise to player language; UnableToService is the exhausted-preimage case. */
const translateError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('d3e0741d') || message.includes('UnableToService')) {
    return 'the validators have no fresh entropy left for this subset — they need to ink new preimages'
  }
  if (message.includes('User rejected')) return 'transaction rejected in the wallet'
  const short = message.split('\n').slice(0, 3).join(' ')
  return short.length > 300 ? `${short.slice(0, 300)}…` : short
}

/**
 * The heat locations for the canonical subset, pointing at the NEXT unconsumed preimage. Every
 * pairing (Heated) and arming (Armed) consumes exactly one preimage per validator from the
 * canonical pools, so the next slot is the count of prior heats, mapped through the
 * pool-rotation arithmetic (pools chain at base + n*poolSize; see model/pools.ts — the
 * off-chain actors keep the next pool inked). A stale slot (raced by a concurrent heat) fails
 * in simulation and the player just retries.
 */
export const nextHeatLocations = (
  deployment: GameDeployment,
  lobby: CoinFlipLobby,
  rounds: RaffleRoundView[],
): Info[] => {
  const consumed = BigInt(lobby.flips.length + rounds.filter((r) => r.phase !== 'filling').length)
  const poolSize = BigInt(deployment.poolSize)
  const offsets = Object.fromEntries(
    Object.entries(deployment.poolOffsets).map(([provider, base]) => {
      return [provider, poolLocationFor(consumed, BigInt(base), poolSize).offset]
    }),
  )
  return buildHeatLocations(deployment.canonicalSubset, offsets).map((location) => ({
    ...location,
    index: consumed % poolSize,
  }))
}
