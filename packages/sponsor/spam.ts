import { Worker, isMainThread } from 'node:worker_threads'
import { http, stringToHex } from 'viem'
import { mainnet, pulsechain, pulsechainV4 } from 'viem/chains'
import { Relayer, generatedSource, noopStore, submitMessageAction } from '@msgboard/relayer'
import { resolveWorkerCount } from './spam-workers.js'

type Post = { category: string; text: string }

const chainId = Number(process.env.SPAM_CHAIN_ID ?? 943)
const supported = new Set<number>([mainnet.id, pulsechain.id, pulsechainV4.id])
if (!supported.has(chainId)) {
  throw new Error(`spam: unsupported SPAM_CHAIN_ID ${chainId} (expected 1, 369, or 943)`)
}

const rpcUrl =
  process.env.SPAM_RPC ||
  process.env[`RPC_${chainId}`] ||
  process.env[`VITE_RPC_${chainId}`] ||
  'https://rpc.v4.testnet.pulsechain.com'

const intervalMs = Number(process.env.SPAM_INTERVAL_MS ?? 30_000)
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

const sentence = (): string => {
  const length = 6 + Math.floor(Math.random() * 9)
  const body = Array.from({ length }, () => pick(words)).join(' ')
  return `${body.charAt(0).toUpperCase()}${body.slice(1)}.`
}

const mode = process.env.SPAM_OBSERVE ? 'observe' : 'live'

// Proof-of-work grinding is CPU-bound and single-threaded per process. To keep a board
// full faster — and to use the box's idle cores — SPAM_WORKERS spawns that many worker
// threads, each running an independent grind→post loop against the same chain. Defaults
// to 1 (a single in-process grinder, the original behaviour).
const workerCount = resolveWorkerCount(process.env.SPAM_WORKERS)

/** Starts one independent grind→post loop. Runs in the main thread (1 worker) or in a worker thread. */
const startGrinder = (): void => {
  const relayer = new Relayer<Post>({
    node: { transport: http(rpcUrl) },
    mode,
    intervalMs,
    source: generatedSource(() => ({ category: pick(categoryNames), text: sentence() })),
    key: (post) => `${post.category}:${post.text}`,
    store: noopStore<Post>(),
    action: submitMessageAction<Post>({
      // direct utf8-encode the category into 32 bytes (e.g. "lorem") so the board stores a
      // readable name rather than keccak256(name) — categoryHash() leaves an already-hex
      // value untouched, so this skips the hashing path.
      category: (post) => stringToHex(post.category, { size: 32 }),
      data: (post) => post.text,
    }),
  })
  relayer.start()
}

if (isMainThread && workerCount > 1) {
  // Supervisor: fan out N worker threads, each re-running this module (isMainThread=false)
  // and starting its own grinder. The main thread only supervises.
  console.log(
    'spam: chain=%d launching %d parallel grinders every %dms under categories %o (mode=%s)',
    chainId,
    workerCount,
    intervalMs,
    categoryNames,
    mode,
  )
  for (let worker = 0; worker < workerCount; worker += 1) {
    new Worker(new URL(import.meta.url))
  }
} else {
  console.log(
    'spam: chain=%d posting every %dms under categories %o (mode=%s)',
    chainId,
    intervalMs,
    categoryNames,
    mode,
  )
  startGrinder()
}
