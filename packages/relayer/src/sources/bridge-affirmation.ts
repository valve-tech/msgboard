import {
  type Address,
  type Hex,
  type PublicClient,
  getAbiItem,
  parseAbi,
  parseEventLogs,
} from 'viem'
import type { RelayerSource } from '../types.js'

export type BridgeAffirmationSourceOptions = {
  /** The Arbitrary Message Bridge contract address on the watched chain. */
  bridgeAddress: Address
  /** How many blocks back from finalized to scan. Defaults to 1000. */
  lookback?: bigint
}

const bridgeAbi = parseAbi([
  'event AffirmationCompleted(address sender, address executor, bytes32 messageId, bool status)',
])

const transferAbi = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 amount)',
  'event Mint(address indexed to, uint256 amount)',
])

/**
 * Watches an Arbitrary Message Bridge for completed affirmations and yields the
 * recipient of the most recent bridged transfer (zero or one address per poll).
 * Reads at the finalized block, so results are reorg-safe.
 */
export const bridgeAffirmationSource = (
  options: BridgeAffirmationSourceOptions,
): RelayerSource<Address> => {
  const lookback = options.lookback ?? 1_000n
  return {
    poll: async (context) => {
      const provider = context.publicClient as PublicClient
      const finalized = await provider.getBlock({ blockTag: 'finalized' })
      const logs = await provider.getLogs({
        address: options.bridgeAddress,
        event: getAbiItem({ abi: bridgeAbi, name: 'AffirmationCompleted' }),
        fromBlock: finalized.number - lookback,
        toBlock: finalized.number,
      })
      if (logs.length === 0) return []
      const latestTx = logs[logs.length - 1].transactionHash as Hex
      const receipt = await provider.getTransactionReceipt({ hash: latestTx })
      const transfers = parseEventLogs({ abi: transferAbi, logs: receipt.logs })
      const recipient = transfers
        .map((event) => ('to' in event.args ? (event.args.to as Address) : undefined))
        .find((address): address is Address => Boolean(address))
      return recipient ? [recipient] : []
    },
  }
}
