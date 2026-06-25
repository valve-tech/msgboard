import { type Message, difficulty } from '@msgboard/sdk'
import { isAddress, type Hex } from 'viem'
import { BLOCK_RANGE_LIMIT, BLOCK_TIME_SECONDS } from './rpc'

export type Tree = {
  label: string
  children: Tree[]
  decodable: boolean
  isRoot: boolean
  meta?: string
}

/** formats remaining blocks as a human-readable time estimate */
export const formatBlocksRemaining = (blocksRemaining: bigint): string => {
  if (blocksRemaining <= 0n) return 'expired'
  const totalSeconds = Number(blocksRemaining) * BLOCK_TIME_SECONDS
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes > 0) return `~${minutes}m ${seconds}s`
  return `~${seconds}s`
}

/** builds a tree structure from a list of messages, optionally computing expiry estimates */
type WorkFactors = { workMultiplier: bigint; workDivisor: bigint }
export const toTree = ({
  list,
  latestBlockNumber,
  globalFactors,
}: {
  list: Message[]
  latestBlockNumber?: bigint
  globalFactors?: WorkFactors | null
}): Tree => {
  return list.reduce(
    (t, msg) => {
      let children = t.children
      if (!children) {
        children = []
        t.children = children
      }
      let group = children?.find((child) => child.label === msg.category)
      if (!group) {
        group = { label: msg.category, decodable: true, children: [], isRoot: true }
        children.push(group)
      }
      const meta =
        latestBlockNumber != null
          ? formatBlocksRemaining(BLOCK_RANGE_LIMIT - (latestBlockNumber - msg.blockNumber))
          : undefined
      group.children.push({
        label: msg.hash,
        decodable: false,
        children: keysToTreeLeaves(msg, globalFactors),
        isRoot: false,
        meta,
      })
      return t
    },
    { label: '', children: [], decodable: false, isRoot: true } as Tree,
  )
}

const bigints = new Set(['blockNumber', 'nonce'])
export const kvSeparator = ': '
export const keysToTreeLeaves = (msg: Message, globalFactors?: WorkFactors | null): Tree[] => {
  // one "stats" row of extracted metadata, shown first (below the message hash):
  // size, this message's work level + factors, and the current global threshold from status()
  const dataBytes = Math.max(0, (msg.data.length - 2) / 2)
  const work = difficulty(
    { workMultiplier: msg.workMultiplier, workDivisor: msg.workDivisor },
    dataBytes,
  )
  const parts = [
    `${dataBytes} bytes`,
    `work ${work}`,
    ...(globalFactors ? [`global ${difficulty(globalFactors, dataBytes)}`] : []),
    `mult ${msg.workMultiplier}`,
    `div ${msg.workDivisor}`,
  ]
  const stats: Tree[] = [
    {
      label: `stats${kvSeparator}${parts.join(' · ')}`,
      children: [],
      decodable: false,
      isRoot: false,
    },
  ]
  const fields = ['blockHash', 'blockNumber', 'nonce', 'data'].map((key) => {
    const val = msg[key as keyof Message]
    return {
      label: `${key}${kvSeparator}${bigints.has(key) ? BigInt(val as bigint) : val}`,
      children: [],
      decodable: key === 'data' && !isAddress(val as Hex),
      isRoot: false,
    }
  })
  return [...stats, ...fields]
}
