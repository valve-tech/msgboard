import { Menu } from './Menu'
import { useEffect, useState } from 'react'
import { keccak256, numberToHex, stringToHex } from 'viem'
import { Icon } from '@iconify/react'
import { Code } from './Code'
import { useChainStore, selectRpcUrl } from '../stores/chain'

const languages = ['typescript', 'shell'] as const
const methods = ['status', 'categories', 'content', 'addMessage', 'getMessage'] as const
type Method = (typeof methods)[number]
type Lang = (typeof languages)[number]

type ReqRes = { req: string; res: string }
type Situation = { shell: ReqRes; typescript: ReqRes }

const readSettings = (): { lang: Lang; method: Method } => {
  const fallback = { lang: 'typescript' as Lang, method: 'status' as Method }
  try {
    return JSON.parse(localStorage.getItem('docs') ?? JSON.stringify(fallback))
  } catch {
    return fallback
  }
}

const curlResponse = (response: object | string) =>
  JSON.stringify({ jsonrpc: '2.0', id: 1, result: response }, null, 2)

const gasMoneyCategory = stringToHex('gasmoneyplease', { size: 32 })

/**
 * Ported from `Docs.svelte` — the "Simple API" interactive request/response explorer.
 * Reads the active RPC url from the chain store (the Svelte `chain.rpcUrl` derived).
 */
export function Docs() {
  const rpcUrl = useChainStore((s) => selectRpcUrl(s))
  const initial = readSettings()
  const [lang, setLang] = useState<Lang>(initial.lang)
  const [method, setMethod] = useState<Method>(initial.method)

  useEffect(() => {
    localStorage.setItem('docs', JSON.stringify({ lang, method }))
  }, [lang, method])

  const curl = (m: string, code: unknown[]) => {
    const json = JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: code }, null, 2)
    return `curl -X POST -H "Content-Type: application/json" -d \`${json}\` ${rpcUrl}`
  }

  const code: Record<Method, Situation> = {
    status: {
      shell: {
        req: curl('msgboard_status', []),
        res: curlResponse({
          enabled: true,
          count: '0x0',
          size: '0x0',
          workMultiplier: '0x2710',
          workDivisor: '0xf4240',
        }),
      },
      typescript: {
        req: `const status = await client.status()`,
        res: `type Status {
  enabled: boolean;
  count: Hex;
  size: Hex;
  workMultiplier: Hex;
  workDivisor: Hex;
}`,
      },
    },
    categories: {
      shell: { req: curl('msgboard_categories', []), res: curlResponse([gasMoneyCategory]) },
      typescript: {
        req: `const categories = await client.categories()`,
        res: `type Categories = Hex[]`,
      },
    },
    content: {
      shell: { req: curl('msgboard_content', []), res: curlResponse({ [gasMoneyCategory]: [] }) },
      typescript: {
        req: `const content = await client.content()`,
        res: `type MessageSeed = {
  version: number
  blockHash: Hex
  category: Hex
  data: Hex
  nonce: bigint
  workMultiplier: bigint
  workDivisor: bigint
}
type Message = MessageSeed & {
  blockNumber: bigint;
  hash: Hex;
}
type RPCMessage = { [K in keyof Message]: Hex }
type Content = { [category: Hex]: RPCMessage[] }`,
      },
    },
    addMessage: {
      shell: {
        req: curl('msgboard_addMessage', []),
        res: curlResponse(keccak256(numberToHex(Date.now()))),
      },
      typescript: {
        req: `const work = await client.doPoW(category, data)
const hash = await client.addMessage(work.message)`,
        res: `type Hash = Hex`,
      },
    },
    getMessage: {
      shell: {
        req: curl('msgboard_getMessage', []),
        res: curlResponse({
          version: '0x1',
          blockHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
          category: '0x0000000000000000000000000000000000000000000000000000000000000000',
          data: '0x0000000000000000000000000000000000000000000000000000000000000000',
          nonce: '0x0',
          workMultiplier: '0x0',
          workDivisor: '0x0',
          blockNumber: '0x0',
          hash: '0x0000000000000000000000000000000000000000000000000000000000000000',
        }),
      },
      typescript: {
        req: `const message = await client.getMessage(hash)`,
        res: `type MessageSeed = {
  version: number
  blockHash: Hex
  category: Hex
  data: Hex
  nonce: bigint
  workMultiplier: bigint
  workDivisor: bigint
}
type Message = MessageSeed & {
  blockNumber: bigint;
  hash: Hex;
}`,
      },
    },
  }

  const current = code[method][lang]

  return (
    <div className="flex flex-col items-center justify-center px-4 py-16 gap-4 border-y border-gray-200 dark:border-gray-700 overflow-hidden bg-gray-50 dark:bg-gray-900">
      <h2 className="text-3xl font-bold font-mono p-4">Simple API = ❤️ Happy Devs 💻</h2>
      <div className="flex flex-row flex-wrap items-center justify-center gap-3">
        <a
          href="https://github.com/valve-tech/msgboard"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 text-sm font-medium text-gray-700 ring-1 ring-gray-300 transition hover:text-gray-900 hover:ring-gray-400 dark:text-gray-300 dark:ring-gray-600 dark:hover:text-white dark:hover:ring-gray-500">
          <Icon icon="mdi:github" className="size-5" />
          GitHub
        </a>
        <a
          href="https://www.npmjs.com/package/@msgboard/sdk"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 text-sm font-medium text-gray-700 ring-1 ring-gray-300 transition hover:text-gray-900 hover:ring-gray-400 dark:text-gray-300 dark:ring-gray-600 dark:hover:text-white dark:hover:ring-gray-500">
          <Icon icon="mdi:npm" className="size-5" />
          npm
        </a>
      </div>
      <div className="flex flex-row items-end gap-2">
        <Menu
          label="language"
          options={languages.map(String)}
          value={Math.max(0, languages.indexOf(lang))}
          onChange={(i) => setLang(languages[i]!)}
        />
        <Menu
          label="method"
          options={methods.map(String)}
          value={Math.max(0, methods.indexOf(method))}
          onChange={(i) => setMethod(methods[i]!)}
        />
      </div>
      <div className="flex flex-col gap-6 w-full max-w-144 items-center">
        <div className="flex w-full flex-col group relative">
          <span className="text-sm text-gray-500 dark:text-gray-400 italic w-full absolute opacity-0 group-hover:opacity-100 group-hover:-translate-y-full transition-all duration-200">
            Request:
          </span>
          <Code code={current.req} lang={lang} preBase="w-full" />
        </div>
        <div className="flex w-full flex-col group relative">
          <span className="text-sm text-gray-500 dark:text-gray-400 italic w-full absolute opacity-0 group-hover:opacity-100 group-hover:-translate-y-full transition-all duration-200">
            Response:
          </span>
          <Code code={current.res} lang={lang === 'shell' ? 'json' : lang} preBase="w-full" />
        </div>
      </div>
    </div>
  )
}
