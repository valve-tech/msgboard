<script lang="ts">
  import Icon from '@iconify/svelte'
  import Copy from '../components/Copy.svelte'
  import Footer from '../components/Footer.svelte'

  // Source for every example lives in the @msgboard/examples workspace.
  const sourceBase = 'https://github.com/valve-tech/msgboard/blob/master/packages/examples/src'

  type Example = {
    title: string
    script: string
    file: string
    icon: string
    description: string
  }

  // Each card mirrors a runnable script in packages/examples and the matching
  // entry in the "Use cases" section of the home page.
  const examples: Example[] = [
    {
      title: 'Submit a message',
      script: 'submit-message',
      file: 'submit-message.ts',
      icon: 'mdi:send-outline',
      description:
        'The canonical write flow — solve proof of work locally with the software development kit, then post the message to a node.',
    },
    {
      title: 'Keep a message alive',
      script: 'keep-alive',
      file: 'keep-alive.ts',
      icon: 'mdi:timer-refresh-outline',
      description:
        'The board keeps only the last ~120 blocks. Watch your own message and re-post fresh work before it ages out of the pool.',
    },
    {
      title: 'Request and fulfill',
      script: 'request-fulfill',
      file: 'request-fulfill.ts',
      icon: 'mdi:gesture-tap-button',
      description:
        'Broadcast a signed request, watch for it, validate, and fulfill it — the shared skeleton behind intents, action requests, and account abstraction.',
    },
    {
      title: 'Multi-signature collector',
      script: 'multi-sig-collect',
      file: 'multi-sig-collect.ts',
      icon: 'mdi:account-multiple-check',
      description:
        'Collect M-of-N signatures off the board and assemble them once the threshold is met — no central server, nothing partial written on chain.',
    },
    {
      title: 'Antagonistic game',
      script: 'antagonistic-game',
      file: 'antagonistic-game.ts',
      icon: 'mdi:chess-queen',
      description:
        'A commit-reveal rock-paper-scissors match played over the board, using it as a neutral channel between players whose incentives are opposed.',
    },
    {
      title: 'Historical archive server',
      script: 'history-server',
      file: 'history-server.ts',
      icon: 'mdi:database-clock-outline',
      description:
        'Record every message as it flows by into Postgres and serve durable history over a read interface — the same pattern behind the hosted GraphQL archive below.',
    },
  ]

  const runCommand = (script: string) => `npm run ${script} --workspace @msgboard/examples`

  // The live GraphQL archive — the deployed version of the history-server example.
  const archiveUrl = 'https://archive.msgboard.xyz'
</script>

<div class="mx-auto max-w-5xl px-4 py-12">
  <div class="flex items-center justify-between text-sm">
    <a href="#/" class="text-indigo-600 dark:text-indigo-400 hover:underline">← Back to home</a>
    <a
      href={sourceBase}
      target="_blank"
      rel="noopener noreferrer"
      class="text-gray-500 dark:text-gray-400 hover:text-indigo-600 dark:hover:text-indigo-400 hover:underline"
      >Source ↗</a>
  </div>

  <header class="mt-8 text-center">
    <div
      class="mx-auto grid size-12 place-items-center rounded-full bg-amber-400/10 ring-1 ring-amber-400/40">
      <Icon icon="mdi:bullseye-arrow" class="size-7 text-amber-400" />
    </div>
    <h1 class="mt-4 text-3xl font-bold text-slate-900 dark:text-gray-100">Examples</h1>
    <p class="mx-auto mt-3 max-w-2xl text-slate-600 dark:text-gray-300">
      Runnable, self-contained scripts for every use case — from posting a single message to
      collecting multi-signature consent and serving durable history. Each one runs an offline
      demo out of the box, and switches to a live network when you set <code
        class="rounded bg-gray-200 px-1 py-0.5 text-sm dark:bg-gray-700">MSGBOARD_RPC</code
      >.
    </p>
  </header>

  <!-- Live GraphQL archive — the hosted, read-only version of the history example. -->
  <a
    href={archiveUrl}
    target="_blank"
    rel="noopener noreferrer"
    class="group mt-10 flex flex-col gap-4 rounded-2xl border border-amber-300/60 bg-gradient-to-br from-amber-50 to-orange-50 p-6 shadow-sm transition-all duration-200 hover:-translate-y-1 sm:flex-row sm:items-center dark:border-amber-500/30 dark:from-amber-950/30 dark:to-orange-950/20">
    <div
      class="grid size-12 shrink-0 place-items-center rounded-xl bg-amber-400/20 ring-1 ring-amber-400/40">
      <Icon icon="mdi:graphql" class="size-7 text-amber-600 dark:text-amber-400" />
    </div>
    <div class="flex-1">
      <h2 class="text-xl font-semibold text-slate-900 dark:text-gray-100">
        Live GraphQL archive
      </h2>
      <p class="mt-1 text-slate-600 dark:text-gray-300">
        Browse the live, multichain message history — Ethereum, PulseChain, and the v4 testnet —
        over GraphQL. Hosted, read-only, and public: the deployed version of the historical archive
        server example.
      </p>
    </div>
    <span
      class="inline-flex shrink-0 items-center gap-2 self-start rounded-full bg-amber-500 px-5 py-2.5 font-medium text-white transition-colors group-hover:bg-amber-600 sm:self-center">
      Open the explorer
      <Icon icon="mdi:arrow-top-right" class="size-5 transition-transform group-hover:translate-x-0.5" />
    </span>
  </a>

  <!-- Runnable example scripts. -->
  <div class="mt-8 grid grid-cols-1 gap-6 md:grid-cols-2">
    {#each examples as example}
      <div
        class="flex flex-col rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <div class="flex items-center gap-3">
          <div
            class="grid size-10 shrink-0 place-items-center rounded-lg bg-slate-100 dark:bg-gray-700/60">
            <Icon icon={example.icon} class="size-6 text-slate-600 dark:text-gray-300" />
          </div>
          <h3 class="text-lg font-semibold text-slate-900 dark:text-gray-100">{example.title}</h3>
        </div>
        <p class="mt-3 flex-1 text-sm text-slate-600 dark:text-gray-300">{example.description}</p>

        <div
          class="mt-4 flex items-center justify-between gap-2 rounded-lg bg-slate-900 px-3 py-2 font-mono text-xs text-amber-300 dark:bg-black">
          <span class="overflow-x-auto whitespace-nowrap">{runCommand(example.script)}</span>
          <Copy value={runCommand(example.script)} classes="shrink-0 text-gray-300 hover:text-white" />
        </div>

        <a
          href={`${sourceBase}/${example.file}`}
          target="_blank"
          rel="noopener noreferrer"
          class="mt-3 inline-flex items-center gap-1 text-sm text-indigo-600 hover:underline dark:text-indigo-400">
          View source
          <Icon icon="mdi:arrow-top-right" class="size-4" />
        </a>
      </div>
    {/each}
  </div>

  <p class="mt-8 text-center text-sm text-slate-500 dark:text-gray-400">
    Live mode needs a node that serves the <code
      class="rounded bg-gray-200 px-1 py-0.5 dark:bg-gray-700">msgboard_</code> methods. Point
    <code class="rounded bg-gray-200 px-1 py-0.5 dark:bg-gray-700">MSGBOARD_RPC</code> at one — for
    example a keyed
    <a
      href="https://valve.city"
      target="_blank"
      rel="noopener noreferrer"
      class="text-indigo-600 hover:underline dark:text-indigo-400">valve.city</a> endpoint (grab an
    API key there): <code class="rounded bg-gray-200 px-1 py-0.5 dark:bg-gray-700"
      >https://one.valve.city/rpc/&lt;key&gt;/evm/943</code
    >.
  </p>
</div>

<Footer />
