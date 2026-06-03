import { MsgBoardClient, type Provider, encodeData } from '@msgboard/sdk'
import { createPublicClient, http, stringToHex, type Chain } from 'viem'
import { mainnet, pulsechain, pulsechainV4 } from 'viem/chains'

/**
 * spam: posts random lorem-style messages to the msgboard so the board has
 * visible activity. Submission is proof-of-work gated (no wallet or gas needed) —
 * it only needs an RPC whose `msgboard_` namespace is enabled.
 *
 * Chain-agnostic: set SPAM_CHAIN_ID (1, 369, or 943) to choose which network this
 * writer targets, and run one process per network. The RPC comes from SPAM_RPC,
 * else RPC_<chainId>, else VITE_RPC_<chainId>, else a public fallback.
 *
 * NOTE: this is the demo/load writer. The bridge-crossing sponsor lives in
 * bridge.ts (run via `npm run bridge`), not here.
 */

/** the networks this writer can target, keyed by chain id */
const chainsById: Record<number, Chain> = {
  1: mainnet,
  369: pulsechain,
  943: pulsechainV4,
}

/** which network to post to (default: v4 testnet, preserving prior behaviour) */
const chainId = Number(process.env.SPAM_CHAIN_ID ?? 943)
const chain = chainsById[chainId]
if (!chain) {
  throw new Error(
    `spam: unsupported SPAM_CHAIN_ID ${chainId} (expected one of ${Object.keys(chainsById).join(', ')})`,
  )
}

/** msgboard RPC for the selected chain (must expose the msgboard_ namespace) */
const rpc =
  process.env.SPAM_RPC ||
  process.env[`RPC_${chainId}`] ||
  process.env[`VITE_RPC_${chainId}`] ||
  'https://rpc.v4.testnet.pulsechain.com'

/** milliseconds between posts */
const intervalMs = Number(process.env.SPAM_INTERVAL_MS ?? 30_000)

/** small rotating set of categories — a few distinct ones, with duplicates over time */
const categoryNames = (process.env.SPAM_CATEGORIES ?? 'lorem,musings,chatter')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

const words = (
  'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor ' +
  'incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud ' +
  'exercitation ullamco laboris nisi aliquip ex ea commodo consequat duis aute irure ' +
  'reprehenderit voluptate velit esse cillum eu fugiat nulla pariatur excepteur sint ' +
  'occaecat cupidatat non proident sunt in culpa qui officia deserunt mollit anim id est'
).split(' ')

const pick = <T>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)]

/** a lorem-style sentence of 6-14 words, capitalized and period-terminated */
const sentence = (): string => {
  const length = 6 + Math.floor(Math.random() * 9)
  const body = Array.from({ length }, () => pick(words)).join(' ')
  return `${body.charAt(0).toUpperCase()}${body.slice(1)}.`
}

const main = async () => {
  const provider = createPublicClient({
    chain,
    transport: http(rpc, { timeout: 30_000 }),
  })
  const client = new MsgBoardClient(provider as Provider)
  const status = await client.status()
  // match the node's current difficulty so submitted work is accepted
  client.setDifficultyFactors(BigInt(status.workMultiplier), BigInt(status.workDivisor))
  console.log(
    'spam: chain=%o (%d) msgboard enabled=%o; posting every %dms under categories %o',
    chain.name,
    chainId,
    status.enabled,
    intervalMs,
    categoryNames,
  )
  while (true) {
    try {
      const name = pick(categoryNames)
      const text = sentence()
      // direct (zero-padded) category so the name stays human-readable in the UI
      const category = stringToHex(name, { size: 32 })
      const work = await client.doPoW(category, encodeData(text))
      const hash = await client.addMessage(work.message)
      console.log('spam: posted category=%o text=%o hash=%o', name, text, hash)
    } catch (e) {
      console.error('spam: post failed, retrying: %o', e instanceof Error ? e.message : e)
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

main()
