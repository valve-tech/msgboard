<script lang="ts">
  import { keccak256, numberToHex, stringToHex } from 'viem'
  import Code from './Code.svelte'
  import Icon from '@iconify/svelte'
  import { chain } from '../lib'
  const languages = ['typescript', 'shell'] as const
  const methods = ['status', 'categories', 'content', 'addMessage', 'getMessage'] as const
  type Method = (typeof methods)[number]
  type Lang = (typeof languages)[number]
  let settings = {
    lang: 'typescript',
    method: 'status',
  } as {
    lang: Lang
    method: Method
  }
  try {
    settings = JSON.parse(localStorage.getItem('docs') ?? JSON.stringify(settings))
  } catch {
    // do nothing
  }
  let lang: Lang = $state(settings.lang)
  let method: Method = $state(settings.method)
  $effect(() => {
    localStorage.setItem('docs', JSON.stringify({
      lang,
      method,
    }))
  })
  const rpcUrl = $derived(chain.rpcUrl)
  const curl = $derived((method: string, code: any[]) => {
    const json = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params: code,
    }, null, 2)
    return `curl -X POST -H "Content-Type: application/json" -d \`${json}\` ${rpcUrl}`
  })
  const curlResponse = (response: object | string) => {
    return JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: response
    }, null, 2)
  }
  type ReqRes = {
    req: string
    res: string
  }
  type Situation = {
    shell: ReqRes
    typescript: ReqRes
  }
  const gasMoneyCategory = stringToHex('gasmoneyplease', { size: 32 })
  const code = $derived({
    status: {
      shell: {
        req: curl('msgboard_status', []),
        res: curlResponse({"enabled":true,"count":"0x0","size":"0x0","workMultiplier":"0x2710","workDivisor":"0xf4240"})
      },
      typescript: {
        req: `const status = await client.status()`,
        res: `type Status {
  enabled: boolean;
  count: Hex;
  size: Hex;
  workMultiplier: Hex;
  workDivisor: Hex;
}`
      },
    },
    categories: {
      shell: {
        req: curl('msgboard_categories', []),
        res: curlResponse([gasMoneyCategory])
      },
      typescript: {
        req: `const categories = await client.categories()`,
        res: `type Categories = Hex[]`,
      },
    },
    content: {
      shell: {
        req: curl('msgboard_content', []),
        res: curlResponse({[gasMoneyCategory]: []})
      },
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
        res: curlResponse(keccak256(numberToHex(Date.now())))
      },
      typescript: {
        req: `const work = await client.doPoW(category, data)
const hash = await client.addMessage(work.message)`,
        res: `type Hash = Hex`
      },
    },
    getMessage: {
      shell: {
        req: curl('msgboard_getMessage', []),
        res: curlResponse({"version":"0x1","blockHash":"0x0000000000000000000000000000000000000000000000000000000000000000","category":"0x0000000000000000000000000000000000000000000000000000000000000000","data":"0x0000000000000000000000000000000000000000000000000000000000000000","nonce":"0x0","workMultiplier":"0x0","workDivisor":"0x0","blockNumber":"0x0","hash":"0x0000000000000000000000000000000000000000000000000000000000000000"})
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
}`
      },
    },
  } as Record<Method, Situation>)
  const current = $derived(code[method][lang])
</script>

<div class="flex flex-col items-center justify-center px-4 py-16 gap-4 border-y border-gray-200 dark:border-gray-700 overflow-hidden bg-gray-50 dark:bg-gray-900">
  <h2 class="text-3xl font-bold font-mono p-4">Simple API = ❤️ Happy Devs 💻</h2>
  <div class="flex flex-row flex-wrap items-center justify-center gap-3">
    <a
      href="https://github.com/valve-tech/msgboard"
      target="_blank"
      rel="noopener noreferrer"
      class="inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 text-sm font-medium text-gray-700 ring-1 ring-gray-300 transition hover:text-gray-900 hover:ring-gray-400 dark:text-gray-300 dark:ring-gray-600 dark:hover:text-white dark:hover:ring-gray-500">
      <Icon icon="mdi:github" class="size-5" />
      GitHub
    </a>
    <a
      href="https://www.npmjs.com/package/@msgboard/sdk"
      target="_blank"
      rel="noopener noreferrer"
      class="inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 text-sm font-medium text-gray-700 ring-1 ring-gray-300 transition hover:text-gray-900 hover:ring-gray-400 dark:text-gray-300 dark:ring-gray-600 dark:hover:text-white dark:hover:ring-gray-500">
      <Icon icon="mdi:npm" class="size-5" />
      npm
    </a>
  </div>
  <div class="flex flex-row items-end gap-2">
    <!-- <label for="location" class="block text-sm/6 font-medium text-gray-900">Network</label> -->
    <div class="grid grid-cols-1 gap-2 min-w-32">
      <select id="lang" name="lang" value={lang} class="col-start-1 row-start-1 w-full appearance-none rounded-md bg-white dark:bg-gray-800 dark:border-gray-600 dark:text-gray-100 py-1 pl-3 pr-8 text-base text-gray-900 outline-1 -outline-offset-1 outline-gray-300 dark:outline-gray-600 focus:-outline-offset-2 focus:outline-indigo-600 sm:text-sm/6" onchange={(e) => {
        const target = e.target as HTMLSelectElement
        lang = target.value as Lang
      }}>
        {#each languages as key}
          {#key key}
            <option value={key}>{key}</option>
          {/key}
        {/each}
      </select>
      <svg class="pointer-events-none col-start-1 row-start-1 mr-2 size-5 self-center justify-self-end text-gray-500 dark:text-gray-400 sm:size-4" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" data-slot="icon">
        <path fill-rule="evenodd" d="M4.22 6.22a.75.75 0 0 1 1.06 0L8 8.94l2.72-2.72a.75.75 0 1 1 1.06 1.06l-3.25 3.25a.75.75 0 0 1-1.06 0L4.22 7.28a.75.75 0 0 1 0-1.06Z" clip-rule="evenodd" />
      </svg>
    </div>
    <div class="grid grid-cols-1 min-w-32">
      <select id="method" name="method" value={method} class="col-start-1 row-start-1 w-full appearance-none rounded-md bg-white dark:bg-gray-800 dark:border-gray-600 dark:text-gray-100 py-1 pl-3 pr-8 text-base text-gray-900 outline-1 -outline-offset-1 outline-gray-300 dark:outline-gray-600 focus:-outline-offset-2 focus:outline-indigo-600 sm:text-sm/6" onchange={(e) => {
        const target = e.target as HTMLSelectElement
        method = target.value as Method
      }}>
        {#each methods as key}
          {#key key}
            <option value={key}>{key}</option>
          {/key}
        {/each}
      </select>
      <svg class="pointer-events-none col-start-1 row-start-1 mr-2 size-5 self-center justify-self-end text-gray-500 dark:text-gray-400 sm:size-4" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" data-slot="icon">
        <path fill-rule="evenodd" d="M4.22 6.22a.75.75 0 0 1 1.06 0L8 8.94l2.72-2.72a.75.75 0 1 1 1.06 1.06l-3.25 3.25a.75.75 0 0 1-1.06 0L4.22 7.28a.75.75 0 0 1 0-1.06Z" clip-rule="evenodd" />
      </svg>
    </div>
  </div>
  <div class="flex flex-col gap-6 w-full max-w-144 items-center">
    <div class="flex w-full flex-col group relative">
      <span class="text-sm text-gray-500 dark:text-gray-400 italic w-full absolute opacity-0 group-hover:opacity-100 group-hover:-translate-y-full transition-all duration-200">Request:</span>
      <Code code={current.req} {lang} preBase="w-full" />
    </div>
    <div class="flex w-full flex-col group relative">
      <span class="text-sm text-gray-500 dark:text-gray-400 italic w-full absolute opacity-0 group-hover:opacity-100 group-hover:-translate-y-full transition-all duration-200">Response:</span>
      <Code code={current.res} lang={lang === 'shell' ? 'json' : lang} preBase="w-full" />
    </div>
  </div>
</div>
