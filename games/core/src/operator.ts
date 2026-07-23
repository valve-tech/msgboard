import * as viem from 'viem'
import { randomAbi, type Info } from './contracts'
import { type Secret } from './secrets'

/**
 * Build the heat selection for a declared validator subset: one location per subset member, in
 * subset order. This mirrors GameBase._heatBound's positional binding, so the contract accepts it.
 */
export const buildHeatLocations = (subset: viem.Hex[], poolOffsetByProvider: Record<string, bigint>): Info[] =>
  subset.map((provider) => ({
    provider,
    callAtChange: false,
    durationIsTimestamp: false,
    duration: 12n,
    token: viem.zeroAddress,
    price: 0n,
    offset: poolOffsetByProvider[provider.toLowerCase()] ?? 0n,
    index: 0n,
  }))

/**
 * Cast the revealed validator secrets in heat order to finalize the seed. Returns the cast tx hash.
 * The caller supplies locations and secrets in the SAME order used at heat (== subset order).
 */
export const castSeed = async (
  walletClient: viem.WalletClient,
  publicClient: viem.PublicClient,
  randomAddress: viem.Hex,
  key: viem.Hex,
  locations: Info[],
  secrets: viem.Hex[],
): Promise<viem.Hex> => {
  const { request } = await publicClient.simulateContract({
    address: randomAddress,
    abi: randomAbi,
    functionName: 'cast',
    args: [key, locations, secrets],
    account: walletClient.account!,
  })
  return walletClient.writeContract(request)
}

/** Ink a price-0 validator pool (one preimage) under the validator's own address. */
export const inkPool = async (
  walletClient: viem.WalletClient,
  publicClient: viem.PublicClient,
  randomAddress: viem.Hex,
  validator: viem.Hex,
  secret: Secret,
): Promise<viem.Hex> => {
  const section: Info = {
    provider: validator,
    callAtChange: false,
    durationIsTimestamp: false,
    duration: 12n,
    token: viem.zeroAddress,
    price: 0n,
    offset: 0n,
    index: 0n,
  }
  const { request } = await publicClient.simulateContract({
    address: randomAddress,
    abi: randomAbi,
    functionName: 'ink',
    args: [section, secret.preimage],
    account: walletClient.account!,
    value: 0n,
  })
  return walletClient.writeContract(request)
}

/**
 * Pool-rotation arithmetic shared by the web app and the off-chain actors. Pools are inked
 * back-to-back at a fixed size, and core Random assigns each new pool an offset equal to the
 * provider's cumulative preimage count — so the k-th heat since the deployment origin lands at
 * offset base + floor(k/poolSize)*poolSize, index k mod poolSize, with no config change when a
 * pool fills (the actors keep the next pool inked ahead of the boundary).
 */
export const poolLocationFor = (k: bigint, baseOffset: bigint, poolSize: bigint): { offset: bigint; index: bigint } => {
  if (poolSize <= 0n) throw new Error('poolSize must be positive')
  if (k < 0n) throw new Error('heat count cannot be negative')
  return {
    offset: baseOffset + (k / poolSize) * poolSize,
    index: k % poolSize,
  }
}
