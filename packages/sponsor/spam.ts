import { http } from 'viem'
import { mainnet, pulsechain, pulsechainV4 } from 'viem/chains'
import { Relayer, generatedSource, noopStore, submitMessageAction } from '@msgboard/relayer'

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

const relayer = new Relayer<Post>({
  node: { transport: http(rpcUrl) },
  mode,
  intervalMs,
  source: generatedSource(() => ({ category: pick(categoryNames), text: sentence() })),
  key: (post) => `${post.category}:${post.text}`,
  store: noopStore<Post>(),
  action: submitMessageAction<Post>({
    category: (post) => post.category,
    data: (post) => post.text,
  }),
})

console.log(
  'spam: chain=%d posting every %dms under categories %o (mode=%s)',
  chainId,
  intervalMs,
  categoryNames,
  mode,
)
relayer.start()
